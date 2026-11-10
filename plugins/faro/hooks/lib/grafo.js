// lib/grafo.js — GRAFO DE DEPENDENCIAS INTERNAS: ciclos y modulos huerfanos.
//
// Por que existe: 'atomico' cuenta LINEAS, y contar lineas dice que un fichero es grande, no que el
// diseno este mal. Las dos senales que si describen un defecto OBJETIVO son:
//   · CICLO      -> a importa b, b importa a. Ningun modulo del ciclo se entiende ni se prueba por
//                   separado: para leer uno hay que leer todos. Es un DEFECTO, no una opinion.
//   · HUERFANO   -> nadie lo importa. Suele ser codigo muerto que sigue costando mantenimiento.
// Ambas se calculan leyendo los propios ficheros, SIN instalar nada (el harness no impone tooling).
//
// ALCANCE DELIBERADO: solo dependencias INTERNAS por ruta RELATIVA ('./x', '../y'). No resuelve
// alias de tsconfig, no entra en node_modules y no sustituye a una herramienta dedicada
// (dependency-cruiser y similares). Es una senal barata que viaja con el plugin.
'use strict';

module.exports = function (ctx) {
  const { fs, path, ROOT, faroSchema } = ctx;
  // Lista UNICA de generados, compartida con atomico.js (#126): un routeTree.gen.ts no es un nodo.
  const generados = require('./generados.js');

  const EXT_RESOLVER = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '/index.js', '/index.ts'];

  function cfg() {
    const s = faroSchema();
    const a = (s && s.enums && s.enums.atomicidad) || {};
    return {
      extensiones: Array.isArray(a.extensiones) && a.extensiones.length ? a.extensiones : ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'],
      excluir: Array.isArray(a.excluir) ? a.excluir : ['node_modules/', 'dist/', 'build/', '.git/', 'vendor/'],
      // Puntos de ENTRADA: nadie los importa POR DISENO (los invoca el harness, el CI o el usuario).
      // Listarlos como huerfanos seria ruido puro, asi que se declaran en el contrato.
      entradas: Array.isArray(a.entradas) ? a.entradas : ['harness.js', 'self-hint.js', 'index.js', 'main.js', 'cli.js'],
    };
  }

  function ficheros(c) {
    const out = [];
    (function rec(dir, depth) {
      if (depth > 8) return;
      let entries;
      try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.claude') continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (generados.excluidoPorRuta(rel)) continue;
        if (c.excluir.some((x) => (`${rel}/`).includes(x) || rel.includes(x))) continue;
        if (e.isDirectory()) { rec(rel, depth + 1); continue; }
        if (c.extensiones.some((x) => e.name.toLowerCase().endsWith(x))) out.push(rel);
      }
    })('', 0);
    return generados.depurar(ROOT, out, fs, path);
  }

  // Importaciones RELATIVAS de un fichero: require('./x'), import ... from './x', import('./x').
  // Se ignora todo lo que no empiece por '.' (paquetes: no son dependencia interna).
  const RE_IMPORT = /(?:require\s*\(\s*|import\s*\(\s*|from\s+)['"](\.[^'"]+)['"]/g;
  // RUTA CALCULADA: path.join(__dirname, 'lib', 'base.js'). Es el idioma del propio motor, y sin
  // contemplarlo el grafo daba 16 falsos huerfanos (todo lib/ salia como codigo muerto). Se captura
  // la expresion SUELTA, no solo dentro de require(), porque el patron habitual es guardarla en una
  // variable —const mod = path.join(...); require(mod)— y ahi el literal no toca al require.
  const RE_JOIN = /path\.(?:join|resolve)\s*\(\s*__dirname\s*,\s*((?:['"][^'"]+['"]\s*,\s*)*['"][^'"]+['"])\s*\)/g;
  const segmentosDe = (grupo) => [...grupo.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);

  function resolver(desde, spec, existentes) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(desde), spec));
    for (const ext of EXT_RESOLVER) {
      const cand = (base + ext).replace(/^\.\//, '');
      if (existentes.has(cand)) return cand;
    }
    return null; // apunta fuera del repo o a algo que no existe: no es arista del grafo interno
  }

  // grafo() -> { nodos, aristas: Map<fichero, Set<fichero>>, entrantes: Map<fichero, n> }
  function grafo() {
    const c = cfg();
    const nodos = ficheros(c);
    const existentes = new Set(nodos);
    const aristas = new Map();
    const entrantes = new Map(nodos.map((n) => [n, 0]));
    for (const f of nodos) {
      const dest = new Set();
      let txt;
      try { txt = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { aristas.set(f, dest); continue; }
      const anadir = (spec) => {
        const r = resolver(f, spec, existentes);
        if (r && r !== f) { dest.add(r); entrantes.set(r, (entrantes.get(r) || 0) + 1); }
      };
      for (const m of txt.matchAll(RE_IMPORT)) anadir(m[1]);
      // __dirname es la carpeta DEL PROPIO fichero, asi que los segmentos son relativos a el.
      for (const m of txt.matchAll(RE_JOIN)) anadir('./' + segmentosDe(m[1]).join('/'));
      aristas.set(f, dest);
    }
    return { c, nodos, aristas, entrantes };
  }

  // Ciclos por DFS con pila de recorrido. Se normaliza cada ciclo (rotado a su menor elemento) para
  // no reportar el MISMO ciclo varias veces segun por donde se entre.
  function ciclos(g) {
    const visitado = new Set();
    const enPila = new Set();
    const pila = [];
    const encontrados = new Map();
    function dfs(n) {
      visitado.add(n); enPila.add(n); pila.push(n);
      for (const d of (g.aristas.get(n) || [])) {
        if (enPila.has(d)) {
          const ciclo = pila.slice(pila.indexOf(d));
          const min = ciclo.indexOf([...ciclo].sort()[0]);
          const norm = [...ciclo.slice(min), ...ciclo.slice(0, min)];
          encontrados.set(norm.join(' -> '), norm);
        } else if (!visitado.has(d)) dfs(d);
      }
      enPila.delete(n); pila.pop();
    }
    for (const n of g.nodos) if (!visitado.has(n)) dfs(n);
    return [...encontrados.values()];
  }

  // Huerfanos: nadie los importa. Se excluyen tests (por diseno nadie los importa: los ejecuta el
  // runner) y los puntos de entrada declarados en el contrato.
  function huerfanos(g) {
    const esTest = (f) => /(^|\/)(test|tests|__tests__|spec)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f);
    const esEntrada = (f) => g.c.entradas.includes(f.split('/').pop());
    return g.nodos.filter((n) => (g.entrantes.get(n) || 0) === 0 && !esTest(n) && !esEntrada(n));
  }

  function analizar() {
    const g = grafo();
    return { total: g.nodos.length, ciclos: ciclos(g), huerfanos: huerfanos(g) };
  }

  // Sesion: SOLO los ciclos. Un ciclo es un defecto verificable y merece interrumpir; los huerfanos
  // exigen criterio humano (puede ser un script suelto legitimo) y se quedan en el informe.
  function grafoLines() {
    let r;
    try { r = analizar(); } catch { return []; }
    if (!r.ciclos.length) return [];
    const muestra = r.ciclos.slice(0, 2).map((c) => c.join(' → ')).join('  ·  ');
    return [
      `CICLOS DE DEPENDENCIA: ${r.ciclos.length} en el codigo — ${muestra}${r.ciclos.length > 2 ? ` (+${r.ciclos.length - 2} mas)` : ''}. ` +
      'Ningun modulo de un ciclo se entiende ni se prueba por separado. Detalle: node .claude/hooks/harness.js codigo.',
    ];
  }

  return { analizar, grafo, ciclos, huerfanos, grafoLines };
};
