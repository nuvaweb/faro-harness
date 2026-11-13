// lib/dominios.js — TESTS POR DOMINIO (#178). Servicio UNICO que consumen el hook TDD (lib/tdd.js), validate,
// `harness.js tests-dominios` y los scripts npm del motor (scripts/test-afectados.js). Nada de esto se duplica.
//
// DOMINIO = FUNCIONALIDAD (no carpeta): puede abarcar varias carpetas y una carpeta puede servir a varios. Es una
// unidad ENCAPSULADA y valida por si sola:
//   - interior   : su codigo y sus tests;
//   - contrato   : lo que otros dominios importan de el (declarado en `contrato`, o deducido del grafo de imports);
//   - dependientes: los hermanos que usan su contrato (declarados en `dependientes` + deducidos del grafo).
// REGLA: cambio solo en el interior -> solo ese dominio · cambio en el contrato -> ese dominio + sus dependientes ·
// cambio TRANSVERSAL (esquema, config compartida...) -> todos los dominios que lo alcanzan por el grafo (o los que
// diga el mapa explicito) · la suite completa, solo en CI y en /faro:publicar.
//
// Se declara en `faro/config.json > tests`:
//   { "comando": "node --test",
//     "dominios": { "<nombre>": { "descripcion", "codigo": [globs], "tests": [globs], "contrato": [rutas],
//                                 "dependientes": [nombres], "lento": [globs de tests], "comando", "pendiente": [..] } },
//     "transversal": [globs] | { "<glob>": [nombres] | "*" },
//     "entradas": [rutas]   // puertas (CLI): lo que importan NO convierte al resto en dependiente
//     "codigo": [globs] }   // codigo extra a vigilar (ademas de tdd.codigo) para detectar codigo sin dominio
//
// SEGURIDAD: el harness NUNCA ejecuta un comando declarado en el repo. `comandoSeguro` acepta una lista CERRADA de
// formas (node --test · npx|pnpm|yarn vitest|jest · npm|pnpm|yarn|bun [run] test[:x]) con argumentos validados y
// sin metacaracteres de shell; el resultado es un argv (sin shell:true) que se MUESTRA para que lo lance el agente
// con sus permisos, o que un script propio ejecuta. Todo lo que viene del repo (rutas, nombres, descripciones) se
// valida con patron estricto y, si llega a un mensaje, va en UNA linea y recortado.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const tdd = require('./tdd.js');
const validado = require('./validado.js');

const spawnSync = (cmd, args, op) => require('child_process').spawnSync(cmd, args, { ...op, windowsHide: true });
const posix = (p) => String(p || '').replace(/\\/g, '/');
const leer = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } };
const leerJson = (abs) => { const t = leer(abs); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } };
const sha = (t, n) => require('crypto').createHash('sha256').update(String(t)).digest('hex').slice(0, n || 64);

const RE_NOMBRE = /^(?!constructor$|prototype$)[a-z0-9][a-z0-9-]{0,39}$/;   // sin nombres que colisionen con Object.prototype
const RE_RUTA = /^[\w@][\w@.+\/-]*$/;                       // ruta relativa segura (sin espacios, sin '-' inicial)
const RE_BASE = /^[\w@][\w@.\/-]*$/;
const CLAVES_DOMINIO = ['descripcion', 'codigo', 'tests', 'contrato', 'dependientes', 'lento', 'comando', 'pendiente'];
const CLAVES_TESTS = ['comando', 'dominios', 'transversal', 'entradas', 'codigo', 'afinar'];
const EXT_GRAFO = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx'];
const MAX_FICHEROS_GRAFO = 6000;

/** Una linea, recortada y sin control: para todo texto del repo que llegue a un mensaje. */
const unaLinea = (t, n = 120) => { const s = String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const rutaSegura = (r) => typeof r === 'string' && RE_RUTA.test(r) && !r.split('/').includes('..') && r.length <= 240;
const globSeguro = (g) => typeof g === 'string' && g.length > 0 && g.length <= 240 && (g.match(/\*\*/g) || []).length <= 3 && (g.match(/[*?]/g) || []).length <= 8 && !/[\u0000-\u001f]/.test(g) && !g.split('/').includes('..') && !/^([\\/]|[A-Za-z]:)/.test(g);
const listaDe = (v, ok) => Array.isArray(v) && v.every((x) => ok(x));

// ---------- ficheros ----------

function ficheros(root) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}
const casa = (globs, rel) => (globs || []).some((g) => tdd.globRe(g).test(rel));

// ---------- configuracion ----------

const VACIA = () => ({ declarado: false, afinar: false, comando: null, dominios: Object.create(null), transversal: [], transversalMapa: {}, entradas: [], codigo: [] });

/** Lee `faro/config.json > tests`. Normaliza; lo invalido se ignora aqui y lo avisa validarConfig. */
function config(root) {
  const t = (leerJson(require('./config-repo.js').rutaAbs(root)) || {}).tests;
  const out = VACIA();
  if (!t || typeof t !== 'object' || Array.isArray(t)) return out;
  const lista = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
  if (typeof t.comando === 'string') out.comando = t.comando;
  out.afinar = t.afinar === true;
  out.entradas = lista(t.entradas).filter(rutaSegura);
  out.codigo = lista(t.codigo).filter(globSeguro);
  if (Array.isArray(t.transversal)) out.transversal = lista(t.transversal).filter(globSeguro);
  else if (t.transversal && typeof t.transversal === 'object') for (const [g, v] of Object.entries(t.transversal)) if (globSeguro(g)) out.transversalMapa[g] = v === '*' ? '*' : lista(v);
  const ds = t.dominios;
  if (ds && typeof ds === 'object' && !Array.isArray(ds)) {
    for (const [n, d] of Object.entries(ds)) {
      if (!RE_NOMBRE.test(n) || !d || typeof d !== 'object' || Array.isArray(d)) continue;
      if (!Array.isArray(d.codigo) || !d.codigo.length || !d.codigo.every(globSeguro)) continue;   // un glob hostil descarta el dominio entero
      out.dominios[n] = {
        descripcion: typeof d.descripcion === 'string' ? unaLinea(d.descripcion, 200) : '',
        codigo: lista(d.codigo).filter(globSeguro),
        tests: lista(d.tests).filter(globSeguro),
        contrato: Array.isArray(d.contrato) ? lista(d.contrato).filter(rutaSegura) : null,
        dependientes: lista(d.dependientes).filter((x) => RE_NOMBRE.test(x)),
        lento: lista(d.lento).filter(globSeguro),
        comando: typeof d.comando === 'string' ? d.comando : null,
        pendiente: lista(d.pendiente).map((x) => unaLinea(x, 200)),
      };
    }
    out.declarado = Object.keys(out.dominios).length > 0;
  }
  return out;
}

/** Lo que `faro/config.json > tests` incumple (para validate): una linea por problema, sin ejecutar nada. */
function validarConfig(root) {
  const t = (leerJson(require('./config-repo.js').rutaAbs(root)) || {}).tests;
  if (t === undefined) return [];
  const w = [];
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['faro/config.json > tests debe ser un objeto { "dominios": { ... } }.'];
  for (const k of Object.keys(t)) if (!CLAVES_TESTS.includes(k)) w.push(`faro/config.json > tests.${unaLinea(k, 40)}: clave desconocida (válidas: ${CLAVES_TESTS.join(', ')}).`);
  if (t.comando !== undefined && (typeof t.comando !== 'string' || !comandoSeguro(t.comando))) w.push('faro/config.json > tests.comando no es una forma permitida (node --test · npx|pnpm|yarn vitest|jest · npm|pnpm|yarn test…): no se ejecuta, solo se muestra.');
  if (t.entradas !== undefined && !listaDe(t.entradas, rutaSegura)) w.push('faro/config.json > tests.entradas debe ser una lista de rutas relativas.');
  if (t.codigo !== undefined && !listaDe(t.codigo, globSeguro)) w.push('faro/config.json > tests.codigo debe ser una lista de globs relativos.');
  if (t.transversal !== undefined) {
    const ok = Array.isArray(t.transversal) ? listaDe(t.transversal, globSeguro)
      : t.transversal && typeof t.transversal === 'object' && Object.entries(t.transversal).every(([g, v]) => globSeguro(g) && (v === '*' || listaDe(v, (x) => RE_NOMBRE.test(x))));
    if (!ok) w.push('faro/config.json > tests.transversal debe ser una lista de globs o un mapa { "<glob>": ["<dominio>"] | "*" }.');
  }
  const ds = t.dominios;
  if (ds === undefined) return w;
  if (!ds || typeof ds !== 'object' || Array.isArray(ds)) return [...w, 'faro/config.json > tests.dominios debe ser un objeto { "<dominio>": { "codigo": [...], "tests": [...] } }.'];
  const nombres = Object.keys(ds).filter((n) => RE_NOMBRE.test(n));
  for (const [n, d] of Object.entries(ds)) {
    const e = unaLinea(n, 40);
    if (!RE_NOMBRE.test(n)) { w.push(`faro/config.json > tests.dominios: el nombre '${e}' no es válido (minúsculas, números y guiones, máx. 40).`); continue; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) { w.push(`faro/config.json > tests.dominios.${e} debe ser un objeto.`); continue; }
    for (const k of Object.keys(d)) if (!CLAVES_DOMINIO.includes(k)) w.push(`faro/config.json > tests.dominios.${e}.${unaLinea(k, 40)}: clave desconocida (válidas: ${CLAVES_DOMINIO.join(', ')}).`);
    if (!Array.isArray(d.codigo) || !d.codigo.length || !listaDe(d.codigo, globSeguro)) w.push(`faro/config.json > tests.dominios.${e}.codigo debe ser una lista de globs no vacía (p. ej. ["src/${e}/**"]).`);
    for (const k of ['tests', 'lento']) if (d[k] !== undefined && !listaDe(d[k], globSeguro)) w.push(`faro/config.json > tests.dominios.${e}.${k} debe ser una lista de globs.`);
    if (d.contrato !== undefined && !listaDe(d.contrato, rutaSegura)) w.push(`faro/config.json > tests.dominios.${e}.contrato debe ser una lista de rutas relativas.`);
    if (d.dependientes !== undefined) {
      if (!listaDe(d.dependientes, (x) => typeof x === 'string')) w.push(`faro/config.json > tests.dominios.${e}.dependientes debe ser una lista de nombres de dominio.`);
      else for (const x of d.dependientes) if (!nombres.includes(x)) w.push(`faro/config.json > tests.dominios.${e}.dependientes cita '${unaLinea(x, 40)}', que no es un dominio declarado.`);
    }
    if (d.comando !== undefined && (typeof d.comando !== 'string' || !comandoSeguro(d.comando))) w.push(`faro/config.json > tests.dominios.${e}.comando no es una forma permitida (lista cerrada: node --test · npx|pnpm|yarn vitest|jest · npm|pnpm|yarn test…): no se ejecuta, solo se muestra.`);
    if (d.pendiente !== undefined && !listaDe(d.pendiente, (x) => typeof x === 'string')) w.push(`faro/config.json > tests.dominios.${e}.pendiente debe ser una lista de textos.`);
  }
  return w;
}

// ---------- comandos: lista cerrada ----------

const TOK = /^[\w@][\w@.\/:=,+-]*$/;
const FLAG = /^--?[\w][\w-]*(=[\w@.\/:,+-]+)?$/;
const FLAGS_OK = [/^--run$/, /^--reporter=(dot|spec|tap|default|verbose)$/, /^--test-reporter=(dot|spec|tap)$/, /^--coverage$/, /^--watch=false$/, /^--bail$/, /^--ci$/, /^--test-concurrency=\d{1,2}$/];
const sinEscape = (t) => TOK.test(t) && !t.split('/').includes('..') && !/^([A-Za-z]:|\/)/.test(t);

/**
 * Argv base de un comando de tests, o null si no es una forma de la lista cerrada. Nunca se pasa por shell.
 * Formas: node --test [flags] · (npx|pnpm|yarn|pnpm exec) (vitest|jest) [run] [flags] ·
 *         (npm|pnpm|yarn|bun) [--filter X|-C X|-w X] [run] test[:x] [flags] · yarn workspace X test[:x].
 */
function comandoSeguro(cmd) {
  const s = String(cmd == null ? '' : cmd);
  if (!s.trim() || s.length > 200 || /[^\x20-\x7e]/.test(s)) return null;
  const t = s.trim().split(/ +/);
  if (!t.every((x) => sinEscape(x) || FLAG.test(x))) return null;
  // LISTA CERRADA de flags: ninguno carga ni ejecuta codigo del repo (--import, --require, --config, --reporter=./x…).
  const flags = (arr) => {
    for (let k = 0; k < arr.length; k++) {
      const x = arr[k];
      if (x === '-t') { if (!/^[\w][\w-]*$/.test(arr[k + 1] || '')) return false; k += 1; continue; }
      if (!FLAGS_OK.some((re) => re.test(x))) return false;
    }
    return true;
  };
  const [a, b, ...resto] = t;
  if (a === 'node') return b === '--test' && flags(resto) ? t : null;
  if (a === 'npx') return /^(vitest|jest)$/.test(b || '') && (resto[0] === 'run' ? flags(resto.slice(1)) : flags(resto)) ? t : null;
  if (!/^(npm|pnpm|yarn|bun)$/.test(a)) return null;
  let i = 1;
  if (a === 'pnpm' && b === 'exec') i = 2;
  const runner = t[i];
  if (/^(vitest|jest)$/.test(runner || '') && a !== 'npm' && a !== 'bun') { const r = t.slice(i + 1); return (r[0] === 'run' ? flags(r.slice(1)) : flags(r)) ? t : null; }
  if (a === 'yarn' && b === 'workspace' && t[2] && sinEscape(t[2]) && !FLAG.test(t[2])) i = 3;
  else if (['--filter', '-C', '-w', '--workspace', '--dir', '--cwd', '--prefix'].includes(t[i])) { if (!t[i + 1] || FLAG.test(t[i + 1]) || !sinEscape(t[i + 1])) return null; i += 2; }
  if (t[i] === 'run') i += 1;
  if (!/^test(:[\w-]+)?$/.test(t[i] || '')) return null;
  return flags(t.slice(i + 1)) ? t : null;
}
const esDeScript = (t) => /^(npm|pnpm|yarn|bun)$/.test(t[0]) && !/^(vitest|jest)$/.test(t[1] === 'exec' ? t[2] : t[1]) && !(t[0] === 'yarn' && /^(vitest|jest)$/.test(t[1]));

// ---------- grafo de imports ----------

const RE_IMPORT = [
  /\brequire\s*\(\s*(['"`])(\.{1,2}\/[^'"`\n]*|\.{1,2})\1\s*\)/g,
  /\bfrom\s*(['"`])(\.{1,2}\/[^'"`\n]*|\.{1,2})\1/g,
  /\bimport\s*\(\s*(['"`])(\.{1,2}\/[^'"`\n]*|\.{1,2})\1\s*\)/g,
  /\bimport\s*(['"`])(\.{1,2}\/[^'"`\n]*)\1/g,
];

/** Grafo require/import relativo entre ficheros del repo: {aristas: Map<fichero, Set<fichero>>, inversas}. */
function grafo(root, lista, { universo = lista == null } = {}) {
  const todos = lista || ficheros(root);
  const set = new Set(todos);
  const aristas = new Map();
  const inversas = new Map();
  const candidatos = (base) => [base, ...EXT_GRAFO.map((e) => base + e), ...EXT_GRAFO.map((e) => `${base}/index${e}`), base.replace(/\.(m?js|cjs)$/, '.ts'), base.replace(/\.(m?js|cjs)$/, '.tsx')];
  for (const f of todos.slice(0, MAX_FICHEROS_GRAFO)) {
    if (!EXT_GRAFO.includes(path.extname(f).toLowerCase())) continue;
    const txt = leer(path.join(root, f));
    if (!txt || txt.length > 1.5e6) continue;
    const dir = path.posix.dirname(f);
    for (const re of RE_IMPORT) {
      re.lastIndex = 0;
      for (const m of txt.matchAll(re)) {
        const destino = candidatos(path.posix.normalize(path.posix.join(dir, m[2]))).find((c) => set.has(c));
        if (!destino || destino === f) continue;
        if (!aristas.has(f)) aristas.set(f, new Set());
        aristas.get(f).add(destino);
        if (!inversas.has(destino)) inversas.set(destino, new Set());
        inversas.get(destino).add(f);
      }
    }
  }
  // Modo sombra (#298): compara con el indice nuevo y deja la diferencia; el resultado sigue siendo este.
  // Solo con el universo completo (`universo`: lista nula, o la que contexto calcula sin opts.lista); una lista parcial daria diferencias falsas.
  if (universo) { try { require('./grafo/sombra.js').registrar(root, { aristas }); } catch { /* opcional */ } }
  return { aristas, inversas };
}

/** Ficheros que un fichero MENCIONA como literal ('lib/x.js', 'x.js') y que existen en el repo (nombre unico). */
function menciones(root, rel, lista) {
  const txt = leer(path.join(root, rel));
  if (!txt) return new Set();
  const porBase = new Map();
  for (const f of lista) { if (!EXT_GRAFO.includes(path.extname(f))) continue; const b = path.posix.basename(f); porBase.set(b, porBase.has(b) ? null : f); }
  const out = new Set();
  for (const m of txt.matchAll(/['"`]([\w@.\/-]+\.(?:m?js|cjs|tsx?|jsx))['"`]/g)) { const f = porBase.get(path.posix.basename(m[1])); if (f && f !== rel) out.add(f); }
  return out;
}

// ---------- resolucion: que dominios afecta un cambio ----------

function contexto(root, opts = {}) {
  const cfg = opts.cfg || config(root);
  const cacheGlob = new Map();
  const glob = (globs, rel) => globs.some((x) => { let re = cacheGlob.get(x); if (!re) { re = tdd.globRe(x); cacheGlob.set(x, re); } return re.test(rel); });
  const ctx = { root, cfg, glob, dominios: Object.create(null), tddCfg: tdd.config(root) };
  // lista de ficheros y grafo: PEREZOSOS (los hooks por edicion solo necesitan los globs).
  const memo = (nombre, fn) => { let v; let hecho = false; Object.defineProperty(ctx, nombre, { get() { if (!hecho) { v = fn(); hecho = true; } return v; }, enumerable: true }); };
  memo('lista', () => opts.lista || ficheros(root));
  memo('g', () => opts.grafo || grafo(root, ctx.lista, { universo: !opts.lista }));
  for (const [n, d] of Object.entries(cfg.dominios)) {
    const o = { ...d, nombre: n };
    for (const [k, gl] of [['codigoF', d.codigo], ['testsF', d.tests], ['lentoF', d.lento]]) {
      let v; Object.defineProperty(o, k, { get() { return v || (v = ctx.lista.filter((f) => glob(gl, f))); }, enumerable: true });
    }
    ctx.dominios[n] = o;
  }
  return ctx;
}

const dominiosDe = (ctx, rel) => Object.values(ctx.dominios).filter((d) => ctx.glob(d.codigo, rel) || ctx.glob(d.tests, rel)).map((d) => d.nombre);
const esEntrada = (ctx, f) => ctx.cfg.entradas.includes(f);

/** Contrato de un dominio: el declarado o los ficheros de su codigo que importa alguien de fuera (sin contar puertas). */
function contratoDe(ctx, d) {
  if (d.contrato) return d.contrato;
  const propios = new Set([...d.codigoF, ...d.testsF]);
  return d.codigoF.filter((f) => [...(ctx.g.inversas.get(f) || [])].some((o) => !propios.has(o) && !esEntrada(ctx, o)));
}

/** Dependientes directos de un dominio: declarados + los que importan su contrato (desde su codigo o sus tests). */
function dependientesDe(ctx, d) {
  const con = new Set(contratoDe(ctx, d));
  const out = new Set(d.dependientes.filter((x) => ctx.dominios[x]));
  for (const o of Object.values(ctx.dominios)) {
    if (o.nombre === d.nombre) continue;
    for (const f of [...o.codigoF, ...o.testsF]) {
      if (esEntrada(ctx, f)) continue;
      if ([...(ctx.g.aristas.get(f) || [])].some((x) => con.has(x))) { out.add(o.nombre); break; }
    }
  }
  return [...out];
}

/** Ficheros que alcanzan a 'rel' siguiendo imports hacia atras (transitivo). */
function alcanzan(ctx, rel) {
  const vistos = new Set([rel]);
  const cola = [rel];
  while (cola.length) for (const o of ctx.g.inversas.get(cola.shift()) || []) if (!vistos.has(o)) { vistos.add(o); cola.push(o); }
  vistos.delete(rel);
  return vistos;
}

/** Codigo que merece dominio: lo que tdd clasifica como codigo (o tests.codigo) y no es test. */
function esCodigoVigilado(ctx, rel) {
  if (tdd.clasificar(ctx.root, rel, ctx.tddCfg) === 'codigo') return true;
  return ctx.cfg.codigo.length > 0 && ctx.glob(ctx.cfg.codigo, rel) && tdd.clasificar(ctx.root, rel, { ...ctx.tddCfg, codigo: [...ctx.tddCfg.codigo, ...ctx.cfg.codigo] }) === 'codigo';
}
function esTest(ctx, rel) { return tdd.clasificar(ctx.root, rel, ctx.tddCfg) === 'test' || Object.values(ctx.dominios).some((d) => d.testsF.includes(rel)); }

/** true si 'rel' es codigo vigilado que ningun dominio (ni transversal ni puerta) cubre. Barato: solo globs. */
function sinDominio(ctx, rel) {
  if (dominiosDe(ctx, rel).length || esEntrada(ctx, rel)) return false;
  if (ctx.glob(ctx.cfg.transversal, rel) || Object.keys(ctx.cfg.transversalMapa).some((g) => ctx.glob([g], rel))) return false;
  return esCodigoVigilado(ctx, rel);
}

/**
 * Tests de un dominio afectado. Un dominio afectado solo porque DEPENDE de otro (y `tests.afinar`) ejecuta los tests que
 * ejercitan lo que cambio: los que importan o mencionan el fichero cambiado o a quien lo importa en ese dominio. Si ninguno
 * lo ejercita directamente, todos (no se adivina). Su propio interior y lo transversal siempre van completos.
 */
function testsDe(ctx, d, a) {
  if (!ctx.cfg.afinar || !a.dependiente) return d.testsF;
  const objetivo = new Set(a.ficheros);
  for (const f of [...d.codigoF, ...d.testsF]) if ([...(ctx.g.aristas.get(f) || [])].some((x) => a.ficheros.includes(x))) objetivo.add(f);
  const directos = d.testsF.filter((t) => [...(ctx.g.aristas.get(t) || []), ...menciones(ctx.root, t, ctx.lista)].some((x) => objetivo.has(x)));
  return directos.length ? directos : d.testsF;
}

/**
 * Dominios afectados por un conjunto de ficheros cambiados.
 * -> { afectados: [{dominio, motivo, ficheros}], sinDominio: [rel], tests: [rel], lentosOmitidos: [rel],
 *      apps: [raiz de app tocada], preguntas: [{tipo:'app'|'dominio', texto, opciones:[{valor, descripcion}], ficheros?}] }
 * opts.app ('apps/api'): acota los DOMINIOS a esa app (monorepo); 'todas' = sin acotar y sin preguntar. El cambio NO
 * se filtra: un fichero transversal de la raiz o de una raiz compartida (packages/x) sigue alcanzando a esa app.
 */
function resolver(root, cambiados, opts = {}) {
  const ctx = opts.ctx || contexto(root, opts);
  const elegida = opts.app ? posix(opts.app).replace(/\/+$/, '') : null;
  const app = elegida && elegida !== 'todas' ? elegida : null;
  const afectados = new Map();
  const sinDominio = [];
  const marca = (n, motivo, f) => {
    if (!ctx.dominios[n]) return;
    if (app && !appsDeDominio(ctx.dominios[n]).includes(app)) return;
    const a = afectados.get(n) || { dominio: n, motivo, ficheros: [], dependiente: /^dependiente/.test(motivo) };
    if (!/^dependiente/.test(motivo)) a.dependiente = false;
    if (motivo === 'contrato' && a.motivo === 'interior') a.motivo = 'contrato';
    if (!a.ficheros.includes(f)) a.ficheros.push(f);
    afectados.set(n, a);
  };
  for (const f of (cambiados || []).map(posix)) {
    const propios = dominiosDe(ctx, f);
    const mapa = Object.entries(ctx.cfg.transversalMapa).find(([g]) => ctx.glob([g], f));
    const transversal = mapa || ctx.glob(ctx.cfg.transversal, f);
    for (const n of propios) {
      const d = ctx.dominios[n];
      // un contrato que solo cambia en textos (cadenas, comentarios) es interior: no arrastra dependientes (#198)
      const enContrato = !d.testsF.includes(f) && !(opts.soloTexto && opts.soloTexto.has(f)) && contratoDe(ctx, d).includes(f);
      marca(n, enContrato ? 'contrato' : 'interior', f);
      if (enContrato) for (const dep of dependientesDe(ctx, d)) marca(dep, `dependiente de ${n}`, f);
    }
    if (transversal) {
      let alcanzados;
      if (mapa) alcanzados = mapa[1] === '*' ? Object.keys(ctx.dominios) : mapa[1];
      else {
        const doms = new Set();
        for (const o of alcanzan(ctx, f)) for (const n of dominiosDe(ctx, o)) doms.add(n);
        alcanzados = doms.size ? [...doms] : Object.keys(ctx.dominios);
      }
      for (const n of alcanzados) marca(n, 'transversal', f);
    } else if (!propios.length && esCodigoVigilado(ctx, f) && !esEntrada(ctx, f)) sinDominio.push(f);
  }
  // tests a ejecutar: los del dominio, sin los marcados `lento` salvo que se toque su modulo (o el propio test)
  const tests = new Set();
  const lentosOmitidos = new Set();
  const cambiadosSet = new Set((cambiados || []).map(posix));
  for (const a of afectados.values()) {
    const d = ctx.dominios[a.dominio];
    for (const t of testsDe(ctx, d, a)) {
      if (!d.lentoF.includes(t)) { tests.add(t); continue; }
      const deps = new Set([...(ctx.g.aristas.get(t) || []), ...menciones(root, t, ctx.lista)]);
      if (cambiadosSet.has(t) || [...deps].some((x) => cambiadosSet.has(x))) tests.add(t); else lentosOmitidos.add(t);
    }
  }
  for (const t of tests) lentosOmitidos.delete(t);
  const lista = [...afectados.values()];
  const apps = [...new Set((cambiados || []).map((f) => raizApp(posix(f))).filter(Boolean))].sort();
  // con --app, el codigo sin dominio de OTRAS apps no es asunto de esta ejecucion (el de la raiz si)
  const sinDominioVisto = app ? sinDominio.filter((f) => [app, ''].includes(raizApp(f))) : sinDominio;
  return { afectados: lista, sinDominio: sinDominioVisto, tests: [...tests].sort(), lentosOmitidos: [...lentosOmitidos].sort(), apps, preguntas: preguntas(ctx, { afectados: lista, sinDominio: sinDominioVisto, apps, app: elegida }) };
}

// ---------- preguntas: lo que el comando NO puede deducir ----------

/** Apps (raiz) que toca un dominio por su codigo y sus tests; [] en un repo simple. */
const appsDeDominio = (d) => [...new Set([...d.codigoF, ...d.testsF].map(raizApp).filter(Boolean))].sort();
/** Todas las apps del repo (raices bajo apps/, packages/, libs/, services/). */
const appsDelRepo = (ctx) => [...new Set(ctx.lista.map(raizApp).filter(Boolean))].sort();
/** Mensaje de error si `--app` vino y no es una app del repo ni 'todas'; '' si vale (o no vino). */
function appInvalida(ctx, vino, app) {
  if (!vino) return '';
  const a = posix(app || '').replace(/\/+$/, '');
  if (a === 'todas' || appsDelRepo(ctx).includes(a)) return '';
  return `La app '${unaLinea(app || '', 60)}' no existe. Apps: ${appsDelRepo(ctx).join(', ') || '(repo sin apps)'} (o --app todas).`;
}

/**
 * Decisiones que el comando no toma por su cuenta (determinista: solo las DETECTA). El agente las pregunta al
 * usuario y repite el comando con la respuesta (--app <ruta>, o el dominio declarado con /faro:tests).
 */
function preguntas(ctx, { afectados, sinDominio, apps, app }) {
  const out = [];
  if (!app && apps.length > 1) {
    out.push({
      tipo: 'app',
      texto: `El cambio toca ${apps.length} apps. ¿Cuál quieres probar ahora?`,
      opciones: [
        ...apps.map((a) => ({ valor: a, descripcion: `dominios: ${afectados.filter((x) => appsDeDominio(ctx.dominios[x.dominio]).includes(a)).map((x) => x.dominio).join(', ') || '(ninguno)'}` })),
        { valor: 'todas', descripcion: 'todos los dominios afectados de todas las apps (--app todas)' },
      ],
    });
  }
  const porApp = new Map();
  for (const f of sinDominio) { const a = raizApp(f); porApp.set(a, [...(porApp.get(a) || []), f]); }
  for (const [a, ficheros] of [...porApp].sort()) {
    const candidatos = Object.values(ctx.dominios).filter((d) => { const ap = appsDeDominio(d); return a ? ap.includes(a) : !ap.length; }).map((d) => d.nombre).sort();
    out.push({
      tipo: 'dominio',
      texto: `${ficheros.length} fichero(s) de código${a ? ` de ${a}` : ''} sin dominio de tests. ¿A qué funcionalidad pertenecen?`,
      ficheros,
      opciones: [...candidatos.map((n) => ({ valor: n, descripcion: unaLinea(ctx.cfg.dominios[n].descripcion || '', 80) })), { valor: 'nuevo', descripcion: 'un dominio nuevo (decláralo con /faro:tests)' }],
    });
  }
  return out;
}

/** Bloque de texto para el agente: la pregunta y como repetir el comando con la respuesta. */
function textoPreguntas(lista, { repetir } = {}) {
  if (!lista.length) return '';
  const l = ['PREGUNTA AL USUARIO (AskUserQuestion) antes de seguir; el comando no lo deduce:'];
  for (const p of lista) {
    l.push(`  · ${p.texto}${p.ficheros ? ` (${p.ficheros.slice(0, 4).map((x) => unaLinea(x, 60)).join(', ')}${p.ficheros.length > 4 ? ', …' : ''})` : ''}`);
    for (const o of p.opciones) l.push(`      - ${o.valor}: ${o.descripcion}`);
    if (p.tipo === 'app' && repetir) l.push(`    Con la respuesta: ${repetir} --app <${p.opciones.map((o) => o.valor).join('|')}>  (p. ej. --app ${p.opciones[0].valor})`);
    if (p.tipo === 'dominio') l.push('    Con la respuesta: añade el fichero a ese dominio en faro/config.json > tests.dominios (o /faro:tests para uno nuevo).');
  }
  return l.join('\n');
}

// ---------- trozos: la suite completa repartida para correr en paralelo (CI) ----------

/** '2/4' -> { i: 2, n: 4 } · null si no es un trozo valido (1 <= i <= n <= 64). */
function trozoDe(s) {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const i = Number(m[1]); const n = Number(m[2]);
  return i >= 1 && n >= 1 && i <= n && n <= 64 ? { i, n } : null;
}

/**
 * Parte i de n de la lista, repartida por PESO (p. ej. tamaño del fichero) para que los trozos tarden parecido.
 * Determinista: no depende del orden de entrada. La union de los n trozos es la lista entera, sin repetidos.
 */
function trozo(lista, i, n, peso = () => 1) {
  if (!Number.isInteger(i) || !Number.isInteger(n) || n < 1 || i < 1 || i > n) throw new Error(`trozo invalido: ${i}/${n} (usa i/n con 1 <= i <= n)`);
  const orden = [...new Set(lista)].map((f) => ({ f, p: Number(peso(f)) || 0 })).sort((a, b) => b.p - a.p || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
  const cubos = Array.from({ length: n }, () => ({ p: 0, f: [] }));
  for (const x of orden) { const c = cubos.reduce((m, c2) => (c2.p < m.p ? c2 : m), cubos[0]); c.p += x.p; c.f.push(x.f); }
  return cubos[i - 1].f.sort();
}

// ---------- orden de ejecucion ----------

/**
 * La orden de tests de un dominio. { dominio, argv|null, texto, aviso?, tests }.
 * argv solo existe si el comando es de la lista cerrada y todas las rutas pasan el patron estricto.
 */
function ordenDominio(root, nombre, opts = {}) {
  const ctx = opts.ctx || contexto(root, opts);
  const d = ctx.dominios[nombre];
  if (!d) return { dominio: nombre, argv: null, texto: '', aviso: `El dominio '${unaLinea(nombre, 40)}' no existe.`, tests: [] };
  const lista = (opts.tests || d.testsF.filter((t) => !d.lentoF.includes(t))).filter((t) => rutaSegura(t) && RE_BASE.test(t));
  const crudo = d.comando || ctx.cfg.comando;
  let base = comandoSeguro(crudo);
  // npx NO descarga: solo se acepta si el ejecutor ya esta instalado en el repo.
  const instalado = !base || base[0] !== 'npx' || ['', '.cmd'].some((e) => fs.existsSync(path.join(root, 'node_modules', '.bin', `${base[1]}${e}`)));
  if (base && !instalado) base = null;
  if (!base) {
    const mostrado = unaLinea(crudo || '', 120);
    const aviso = crudo
      ? `El comando declarado para '${nombre}' no es una forma permitida (lista cerrada): no se ejecuta; si es correcto, que lo lance el usuario.`
      : `El dominio '${nombre}' no declara comando de tests (faro/config.json > tests.comando): no hay nada que ejecutar.`;
    return { dominio: nombre, argv: null, texto: unaLinea(`${mostrado}${lista.length ? ` ${lista.join(' ')}` : ''}`, 200), aviso, tests: lista };
  }
  const argv = [...base];
  if (lista.length) { if (esDeScript(base)) argv.push('--'); argv.push(...lista); }
  return { dominio: nombre, argv, texto: argv.join(' '), tests: lista };
}

// ---------- encapsulacion ----------

/** Tests que necesitan codigo de OTRO dominio para pasar (sin atravesar el codigo del propio): dominios mal delimitados. */
function cruces(root, opts = {}) {
  const ctx = opts.ctx || contexto(root, opts);
  const out = [];
  for (const d of Object.values(ctx.dominios)) {
    const propio = new Set(d.codigoF);
    for (const t of d.testsF) {
      const vistos = new Set([t]);
      const cola = [t];
      const ajenos = new Set();
      while (cola.length) {
        for (const x of ctx.g.aristas.get(cola.shift()) || []) {
          if (vistos.has(x)) continue;
          vistos.add(x);
          if (propio.has(x)) continue;                         // lo propio se ejercita, no se atraviesa
          const otros = Object.values(ctx.dominios).filter((o) => o.nombre !== d.nombre && o.codigoF.includes(x) && !d.codigoF.includes(x)).map((o) => o.nombre);
          if (otros.length) otros.forEach((o) => ajenos.add(o)); else cola.push(x);
        }
      }
      for (const o of ajenos) out.push({ test: t, dominio: d.nombre, usa: o });
    }
  }
  return out;
}

/** Avisos de cobertura funcional, UNA linea cada uno: codigo sin dominio y dominios cuyo test depende de otro. */
function avisosCobertura(root, opts = {}) {
  const cfg = opts.cfg || config(root);
  if (!cfg.declarado) return [];
  const ctx = contexto(root, { ...opts, cfg });
  const out = [];
  const huecos = ctx.lista.filter((f) => !dominiosDe(ctx, f).length && esCodigoVigilado(ctx, f) && !esEntrada(ctx, f) && !ctx.glob(ctx.cfg.transversal, f) && !Object.keys(ctx.cfg.transversalMapa).some((g) => ctx.glob([g], f)));
  if (huecos.length) out.push(`${huecos.length} fichero(s) de código no pertenecen a ningún dominio de tests (p. ej. ${huecos.slice(0, 3).map((x) => unaLinea(x, 60)).join(', ')}): hueco de cobertura funcional — decide su dominio con /faro:tests.`);
  const por = new Map();
  for (const c of cruces(root, { ctx })) { const k = `${c.dominio}>${c.usa}`; por.set(k, (por.get(k) || 0) + 1); }
  for (const [k, n] of por) { const [a, b] = k.split('>'); out.push(`el dominio '${a}' tiene ${n} test(s) que necesitan código del dominio '${b}': violación de encapsulación (¿dominios mal delimitados?) — delimítalos o decláralo con dependientes.`); }
  for (const d of Object.values(ctx.dominios)) if (d.pendiente.length) out.push(`el dominio '${d.nombre}' tiene decisiones pendientes (${d.pendiente.length}): revísalas con /faro:tests y quita 'pendiente' al resolverlas.`);
  return out;
}

// ---------- integridad de tests ----------

const RE_SIN_REBAJA = /\bno\s+(?:he\s+)?(?:rebaj|elimin|quit|debilit|borr|relaj)\p{L}*(?:\s+\p{L}+){0,3}|\bsin\s+(?:rebajar|quitar|eliminar|debilitar|borrar|relajar)(?:\s+\p{L}+){0,3}|\bsolo\s+(?:he\s+)?a[ñn]ad\p{L}*(?:\s+\p{L}+){0,5}|\bonly\s+(?:added|add|created)(?:\s+\p{L}+){0,5}|\b(?:didn'?t|did not|without)\s+(?:remov|weaken|lower|delet|relax)\p{L}*(?:\s+\p{L}+){0,3}/giu;
const REGLAS_NO_DEBILITAN = /^(test sin aserciones|mock del propio)/;

/**
 * Gate de integridad sobre el diff de ficheros de test: aserciones eliminadas, .skip/.only, umbrales o expect
 * relajados (reglas de tdd.revisar) contrastadas con lo que el agente afirma.
 * -> { base, hallazgos, contradicciones, veredicto: 'ok'|'justificar'|'bloquear' }
 */
function integridad(root, { base, afirmacion } = {}) {
  const b = base && RE_BASE.test(base) ? base : undefined;
  const r = tdd.revisar(root, b);
  const debilitan = r.hallazgos.filter((h) => !REGLAS_NO_DEBILITAN.test(h.regla));
  const contradicciones = [];
  const frases = afirmacion ? [...new Set([...String(afirmacion).slice(0, 4000).matchAll(RE_SIN_REBAJA)].map((x) => unaLinea(x[0], 60)))].slice(0, 2) : [];
  if (frases.length && debilitan.length) {
    const reglas = [...new Set(debilitan.map((h) => h.regla))].slice(0, 4).join(', ');
    contradicciones.push(`Afirmas «${frases.join(' / ')}» pero el diff de tests muestra: ${reglas} (${unaLinea(debilitan[0].fichero, 60)}${debilitan.length > 1 ? ` y ${debilitan.length - 1} más` : ''}).`);
  }
  return { base: r.base, hallazgos: r.hallazgos, contradicciones, veredicto: !r.hallazgos.length ? 'ok' : contradicciones.length ? 'bloquear' : 'justificar' };
}

// ---------- proponer / aplicar (migracion de repos existentes) ----------

const RE_EVIDENCIA = /^[ \t*_]*(?:Evidencia|Evidence)[ \t*_]*:[ \t]*(.+)$/gim;   // una sola clase: sin el cubico de espacios hostiles
const MAX_SPEC = 200 * 1024;
const leerTope = (abs) => { const t = leer(abs); return t == null ? null : t.slice(0, MAX_SPEC); };
const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function carpetaDeCodigo(rel) {
  const p = rel.split('/');
  const i = p.indexOf('src');
  if (i < 0 || i + 2 >= p.length) return null;                 // suelto directamente en src/ o sin src
  return p.slice(0, i + 2).join('/');
}
// Raiz de app de una ruta ('apps/api', 'packages/x') o '' en un repo simple: la convencion de nombres no cruza apps.
const raizApp = (rel) => { const p = rel.split('/'); return /^(apps|packages|libs|services)$/.test(p[0]) && p.length > 2 ? p.slice(0, 2).join('/') : ''; };
function adivinarComando(root) {
  const pkg = leerJson(path.join(root, 'package.json')) || {};
  const dev = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (dev.vitest) return 'npx vitest run';
  if (dev.jest) return 'npx jest';
  return 'node --test';
}
const descripcionDe = (txt, n) => { const m = /^#\s+(.+)$/m.exec(txt || ''); return unaLinea(m ? m[1] : `Funcionalidad ${n}`, 100); };

/** Borrador de dominios para un repo existente. SOLO LECTURA. */
function proponer(root) {
  const cfg = config(root);
  const ctx = contexto(root, { cfg });
  const lista = ctx.lista;
  const existentes = new Set(Object.keys(cfg.dominios));
  const propuestos = {};
  const decisiones = [];
  // 1) cadena issue -> cambio -> requisitos -> Evidencia: -> tests; el codigo sale del grafo de imports de esos tests
  const specs = lista.filter((f) => /(^|\/)specs\/[\w.-]+\/spec\.md$/.test(f));
  const porCap = new Map();
  for (const f of specs) {
    const cap = slug(f.split('/').slice(-2, -1)[0]);
    if (!RE_NOMBRE.test(cap)) continue;
    const txt = leerTope(path.join(root, f)) || '';
    const ev = porCap.get(cap) || { tests: new Set(), desc: descripcionDe(txt, cap) };
    for (const m of txt.matchAll(RE_EVIDENCIA)) for (const x of m[1].split(',').map((s) => s.trim().replace(/^[`'"*_\s]+|[`'"*_\s]+$/g, ''))) if (rutaSegura(x) && lista.includes(x) && esTest(ctx, x)) ev.tests.add(x);
    porCap.set(cap, ev);
  }
  const alcanceDeTests = (tests) => {
    const vistos = new Set(tests);
    const cola = [...tests];
    while (cola.length) for (const x of ctx.g.aristas.get(cola.shift()) || []) if (!vistos.has(x)) { vistos.add(x); cola.push(x); }
    return [...vistos].filter((x) => !tests.includes(x) && !esTest(ctx, x) && esCodigoVigilado(ctx, x));
  };
  const usadoPor = new Map();                                    // fichero de codigo -> capacidades que lo alcanzan
  const borrador = [];
  for (const [cap, ev] of porCap) {
    if (existentes.has(cap) || !ev.tests.size) continue;
    const tests = [...ev.tests].sort();
    const codigo = alcanceDeTests(tests);
    for (const c of codigo) usadoPor.set(c, new Set([...(usadoPor.get(c) || []), cap]));
    borrador.push({ cap, ev, tests, codigo });
  }
  const compartidos = new Set([...usadoPor].filter(([, s]) => s.size > 1).map(([f]) => f));
  const globsDe = (ficheros) => {
    const dirs = [...new Set(ficheros.map((f) => path.posix.dirname(f)))].sort();
    const out = [];
    for (const d of dirs) if (d && d !== '.' && !out.some((o) => d === o || d.startsWith(`${o}/`))) out.push(d);
    return out.map((d) => `${d}/**`).concat(ficheros.filter((f) => path.posix.dirname(f) === '.'));
  };
  for (const { cap, ev, tests, codigo } of borrador) {
    const propios = codigo.filter((c) => !compartidos.has(c));
    propuestos[cap] = {
      descripcion: ev.desc, codigo: globsDe(propios), tests, origen: 'specs',
      pendiente: ['Dominio deducido de la Evidencia: de las specs y del grafo de imports: confirma que delimita una funcionalidad completa.'],
    };
    if (!propios.length) { propuestos[cap].pendiente.push('No se encontró código propio alcanzado por sus tests: indica sus rutas.'); propuestos[cap].codigo = []; }
  }
  // 2) respaldo por carpeta + convencion de nombre para el codigo que ninguna spec cubre
  const cubre = (f) => existentes.size && dominiosDe(ctx, f).length || Object.values(propuestos).some((p) => p.codigo.some((g) => tdd.globRe(g).test(f)) || p.tests.includes(f));
  const sueltos = lista.filter((f) => esCodigoVigilado(ctx, f) && !cubre(f) && !compartidos.has(f) && !esEntrada(ctx, f));
  const porCarpeta = new Map();
  const huecosCodigo = [];
  for (const f of sueltos) { const c = carpetaDeCodigo(f); if (c) porCarpeta.set(c, [...(porCarpeta.get(c) || []), f]); else huecosCodigo.push(f); }
  const todosTests = lista.filter((f) => esTest(ctx, f));
  for (const [carpeta, fs_] of porCarpeta) {
    const nombre = slug(carpeta.split('/').pop());
    const set = new Set(fs_);
    const tests = todosTests.filter((t) => [...(ctx.g.aristas.get(t) || [])].some((x) => set.has(x)) || (raizApp(t) === raizApp(carpeta) && fs_.some((x) => tdd.baseModulo(x) === tdd.baseModulo(t))));
    if (!tests.length || !RE_NOMBRE.test(nombre) || existentes.has(nombre) || propuestos[nombre]) { huecosCodigo.push(...fs_); continue; }
    propuestos[nombre] = { descripcion: `Funcionalidad de ${unaLinea(carpeta, 60)}`, codigo: [`${carpeta}/**`], tests: tests.sort(), origen: 'carpeta', pendiente: ['Dominio deducido solo de la carpeta y de la convención de nombres: confirma que es una funcionalidad y no un trozo de otra.'] };
  }
  // 3) huecos y cruces
  const asignado = (f) => Object.values(propuestos).some((p) => p.tests.includes(f) || p.codigo.some((g) => tdd.globRe(g).test(f))) || dominiosDe(ctx, f).length > 0;
  const testsSinDominio = todosTests.filter((t) => !asignado(t));
  const testsCruzados = [];
  for (const t of todosTests) {
    const doms = new Set();
    for (const x of alcanceDeTests([t])) for (const [n, p] of Object.entries(propuestos)) if (p.codigo.some((g) => tdd.globRe(g).test(x))) doms.add(n);
    if (doms.size > 1) testsCruzados.push({ test: t, dominios: [...doms].sort() });
  }
  const comando = adivinarComando(root);
  if (!cfg.comando) decisiones.push(`Comando de tests por defecto deducido: «${comando}». Confírmalo o declara tests.comando.`);
  for (const [n, p] of Object.entries(propuestos)) decisiones.push(`${n} (${p.origen}): ${p.pendiente[0]}`);
  if (compartidos.size) decisiones.push(`${compartidos.size} fichero(s) de código lo usan varias funcionalidades (p. ej. ${[...compartidos].slice(0, 3).map((x) => unaLinea(x, 60)).join(', ')}): ¿son transversales o contrato de un dominio?`);
  if (testsCruzados.length) decisiones.push(`${testsCruzados.length} test(s) cruzan dominios (p. ej. ${unaLinea(testsCruzados[0].test, 60)}): divídelos o declara la dependencia.`);
  if (huecosCodigo.length) decisiones.push(`${huecosCodigo.length} fichero(s) de código sin dominio: asígnalos a uno o crea el dominio.`);
  return {
    comando, dominios: propuestos, transversalSugerido: [...compartidos].sort(),
    huecos: { codigoSinDominio: [...new Set(huecosCodigo)].sort(), testsSinDominio: testsSinDominio.sort(), testsCruzados },
    decisiones,
  };
}

const BLOQUE_INI = '<!-- faro:tests -->';
const BLOQUE_FIN = '<!-- /faro:tests -->';
const BLOQUE = `${BLOQUE_INI}
## Tests por dominio (FARO)
Durante el trabajo ejecuta SOLO los tests del dominio que has tocado: \`harness.js tests-dominios --afectados\` te dice cuáles. Si su salida trae «PREGUNTA AL USUARIO» (el cambio toca varias apps, o hay código sin dominio), pregúntalo con AskUserQuestion y repite con la respuesta (\`--app <ruta>\` o \`--app todas\`); no lo decidas tú. No lances la suite completa: queda para CI y para \`/faro:publicar\`, salvo petición expresa del usuario. Razona por funcionalidad (qué dominio tocas), no por «qué tests corro». Si dejas de cubrir un comportamiento, di cuál; no rebajes aserciones para que pase. Esta regla sustituye a cualquier instrucción anterior de lanzar la batería completa en cada cambio.
${BLOQUE_FIN}
`;

/** Escribe `faro/config.json > tests.dominios` con lo propuesto (sin pisar lo declarado) y, opcional, la regla en CLAUDE.md. */
const esEnlace = (abs) => { try { return fs.lstatSync(abs).isSymbolicLink(); } catch { return false; } };

function aplicar(root, { confirmo, claudeMd } = {}) {
  if (!confirmo) return { escrito: false, motivo: 'Falta --confirmo: la migración de un repo existente nunca es silenciosa.' };
  const ruta = require('./config-repo.js').rutaAbs(root);
  if (esEnlace(ruta) || (claudeMd && esEnlace(path.join(root, 'CLAUDE.md')))) return { escrito: false, motivo: 'Un fichero destino (faro/config.json o CLAUDE.md) es un enlace simbólico: no se escribe a través de enlaces.' };
  const txt = leer(ruta);
  let j = {};
  if (txt != null) { try { j = JSON.parse(txt); } catch { return { escrito: false, motivo: 'faro/config.json no es JSON válido: no se toca.' }; } }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { escrito: false, motivo: 'faro/config.json no es un objeto: no se toca.' };
  const p = proponer(root);
  if (!j.tests || typeof j.tests !== 'object' || Array.isArray(j.tests)) j.tests = {};
  if (!j.tests.dominios || typeof j.tests.dominios !== 'object') j.tests.dominios = {};
  const nuevos = [];
  for (const [n, d] of Object.entries(p.dominios)) {
    if (j.tests.dominios[n] !== undefined) continue;
    const { origen, ...resto } = d;
    j.tests.dominios[n] = resto;
    nuevos.push(n);
  }
  if (!j.tests.comando && nuevos.length) j.tests.comando = p.comando;
  if (nuevos.length) fs.writeFileSync(ruta, `${JSON.stringify(j, null, 2)}\n`);
  let claude = null;
  if (claudeMd) {
    const cm = path.join(root, 'CLAUDE.md');
    const t = leer(cm);
    if (t != null) {
      const i = t.indexOf(BLOQUE_INI); const f = t.indexOf(BLOQUE_FIN);
      const nuevo = i >= 0 && f > i ? `${t.slice(0, i)}${BLOQUE}${t.slice(f + BLOQUE_FIN.length).replace(/^\r?\n/, '')}` : `${t.replace(/\s*$/, '')}\n\n${BLOQUE}`;
      if (nuevo !== t) fs.writeFileSync(cm, nuevo);
      claude = 'CLAUDE.md';
    } else claude = null;
  }
  return { escrito: nuevos.length > 0, nuevos, pendientes: p.decisiones, claudeMd: claude };
}

// ---------- arranque tras actualizar ----------

/** Una linea (con marca de version para no repetirla) si el repo tiene codigo y no declara dominios; '' si no. */
function avisoArranque(root, { version, dir } = {}) {
  try {
    if (!version || config(root).declarado) return '';
    const cfgT = tdd.config(root);
    const hayCodigo = ficheros(root).some((f) => tdd.clasificar(root, f, cfgT) === 'codigo');
    if (!hayCodigo) return '';
    const base = dir || process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'faro');
    fs.mkdirSync(base, { recursive: true });
    const marca = path.join(base, `tests-aviso-${sha(path.resolve(root).toLowerCase(), 12)}.json`);
    const previa = leerJson(marca) || {};
    if (previa.version === String(version)) return '';
    fs.writeFileSync(marca, JSON.stringify({ version: String(version) }));
    return `Tests por dominio (v${unaLinea(version, 20)}): este repo aún no los declara y el agente puede lanzar la suite completa en cada cambio — ejecuta /faro:tests (aviso único por versión).`;
  } catch { return ''; }
}

// ---------- presupuesto ----------

/** { tests, ms } de la salida de node --test, vitest, jest o pytest (null si no se reconoce). */
function medirEjecucion(texto) {
  const t = String(texto || '');
  let tests = null; let ms = null;
  let m;
  if ((m = /^\s*ℹ tests (\d+)/m.exec(t))) tests = Number(m[1]);
  else if ((m = /^\s*Tests\s+(?:\d+ failed \| )?(\d+) passed.*?\((\d+)\)/m.exec(t))) tests = Number(m[2]);
  else if ((m = /^\s*Tests:.*?(\d+) total/m.exec(t))) tests = Number(m[1]);
  else if ((m = /\b(\d+) passed(?:, \d+ \w+)* in [\d.]+\s*s/.exec(t))) tests = Number(m[1]);
  if ((m = /^\s*ℹ duration_ms ([\d.]+)/m.exec(t))) ms = Math.round(Number(m[1]));
  else if ((m = /^\s*Duration\s+([\d.]+)\s*(ms|s)\b/m.exec(t))) ms = Math.round(Number(m[1]) * (m[2] === 's' ? 1000 : 1));
  else if ((m = /^\s*Time:\s+([\d.]+)\s*(ms|s)\b/m.exec(t))) ms = Math.round(Number(m[1]) * (m[2] === 's' ? 1000 : 1));
  else if ((m = /\bin ([\d.]+)\s*s\b/.exec(t))) ms = Math.round(Number(m[1]) * 1000);
  return { tests, ms };
}

// ---------- CLI: harness.js tests-dominios ----------

function baseDiff(root) {
  const ok = (r) => spawnSync('git', ['rev-parse', '--verify', '--quiet', `${r}^{commit}`], { cwd: root, encoding: 'utf8', windowsHide: true }).status === 0;
  const ref = ['origin/develop', 'develop', 'origin/main', 'main'].find(ok);
  if (!ref) return 'HEAD';
  const mb = spawnSync('git', ['merge-base', 'HEAD', ref], { cwd: root, encoding: 'utf8', windowsHide: true });
  return mb.status === 0 && /^[0-9a-f]{40}$/.test(mb.stdout.trim()) ? mb.stdout.trim() : ref;
}
const baseEfectiva = (root, base) => (base && RE_BASE.test(base) ? base : baseDiff(root));
/**
 * Lo que falta por validar contra la base (#198): sin lo que ya paso en verde y no ha cambiado, y marcando los
 * ficheros que solo cambian en textos. Con una --base explicita no se descuenta lo validado.
 * -> { todos, cambiados, validados, soloTexto }
 */
function porValidar(root, base) {
  const todos = cambiadosContra(root, base);
  const explicita = Boolean(base && RE_BASE.test(base));
  return { todos, ...validado.pendientes(root, todos, baseEfectiva(root, base), { verde: !explicita }) };
}
/** Ficheros cambiados contra la base (incluye lo sin commitear y lo nuevo). */
function cambiadosContra(root, base) {
  const b = baseEfectiva(root, base);
  const g = (a) => { const r = spawnSync('git', ['-c', 'core.quotepath=false', ...a], { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }); return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : []; };
  return [...new Set([...g(['diff', '--name-only', b, '--']), ...g(['ls-files', '--others', '--exclude-standard'])])];
}

function cli(argv, root) {
  const flag = (n) => argv.includes(n);
  const valor = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const json = flag('--json');
  const out = (t) => process.stdout.write(`${t}\n`);
  if (flag('--proponer')) {
    const p = proponer(root);
    if (json) return out(JSON.stringify(p, null, 2));
    out(`PROPUESTA DE DOMINIOS (solo lectura; nada se ha escrito) · comando: ${p.comando}`);
    for (const [n, d] of Object.entries(p.dominios)) out(`- ${n} [${d.origen}] ${d.descripcion}\n    código: ${d.codigo.join(', ') || '(sin deducir)'}\n    tests: ${d.tests.join(', ')}`);
    if (!Object.keys(p.dominios).length) out('- (no se dedujo ningún dominio: sin Evidencia: en las specs ni tests por carpeta)');
    const h = p.huecos;
    if (h.codigoSinDominio.length) out(`Código sin dominio (${h.codigoSinDominio.length}): ${h.codigoSinDominio.slice(0, 8).join(', ')}`);
    if (h.testsSinDominio.length) out(`Tests sin dominio (${h.testsSinDominio.length}): ${h.testsSinDominio.slice(0, 8).join(', ')}`);
    for (const c of h.testsCruzados.slice(0, 8)) out(`Test que cruza dominios: ${c.test} → ${c.dominios.join(', ')}`);
    if (p.decisiones.length) out(`Necesita decisión humana:\n${p.decisiones.map((x) => `  · ${x}`).join('\n')}`);
    return out('Para escribirlo: harness.js tests-dominios --aplicar --confirmo [--claude-md]  (o /faro:tests para hacerlo conversando).');
  }
  if (flag('--aplicar')) {
    const r = aplicar(root, { confirmo: flag('--confirmo'), claudeMd: flag('--claude-md') });
    if (!flag('--confirmo')) { process.stderr.write(`${r.motivo} Repite con --confirmo (revisa antes con --proponer).\n`); process.exitCode = 2; return undefined; }
    if (r.escrito === false && r.motivo) { process.stderr.write(`${r.motivo}\n`); process.exitCode = 1; return undefined; }
    out(r.escrito ? `Escrito faro/config.json > tests.dominios: ${r.nuevos.join(', ')}.` : 'Nada nuevo que escribir (los dominios ya estaban declarados).');
    if (r.claudeMd) out(`Regla de tests por dominio escrita en ${r.claudeMd}.`);
    if (r.pendientes && r.pendientes.length) out(`Quedan ${r.pendientes.length} decisión(es) humana(s) marcadas como 'pendiente' (validate las lista).`);
    return undefined;
  }
  if (flag('--integridad')) {
    const r = integridad(root, { base: valor('--base'), afirmacion: valor('--afirmacion') });
    if (json) out(JSON.stringify(r, null, 2));
    else if (r.veredicto === 'ok') out(`Tests íntegros contra ${r.base}.`);
    else {
      out(`INTEGRIDAD DE TESTS (diff contra ${r.base}): ${r.veredicto}`);
      for (const h of r.hallazgos) out(`- ${unaLinea(h.fichero, 80)}: ${h.regla} — ${unaLinea(h.detalle, 100)}`);
      for (const c of r.contradicciones) out(`! ${c}`);
    }
    process.exitCode = r.veredicto === 'ok' ? 0 : 1;
    return undefined;
  }
  const cfg = config(root);
  if (flag('--afectados')) {
    if (!cfg.declarado) return out('Este repo no declara tests.dominios: ejecuta `harness.js tests-dominios --proponer` o /faro:tests.');
    const pv = porValidar(root, valor('--base'));
    const ctx = contexto(root, { cfg });
    const app = valor('--app');
    const malApp = appInvalida(ctx, flag('--app'), app);
    if (malApp) { process.stderr.write(`${malApp}\n`); process.exitCode = 2; return undefined; }
    const r = resolver(root, pv.cambiados, { ctx, app, soloTexto: pv.soloTexto });
    if (json) return out(JSON.stringify({ ...r, ordenes: r.afectados.map((a) => ordenDominio(root, a.dominio, { ctx, tests: r.tests.filter((t) => ctx.dominios[a.dominio].testsF.includes(t)) })) }, null, 2));
    for (const a of r.afectados) {
      const o = ordenDominio(root, a.dominio, { ctx, tests: r.tests.filter((t) => ctx.dominios[a.dominio].testsF.includes(t)) });
      out(`- ${a.dominio} (${a.motivo}): ${o.texto || o.aviso}`);
      if (o.aviso && o.texto) out(`    ⚠ ${o.aviso}`);
    }
    if (r.sinDominio.length) out(`⚠ ${r.sinDominio.length} fichero(s) de código sin dominio (${r.sinDominio.slice(0, 3).map((x) => unaLinea(x, 60)).join(', ')}): no se esconde ejecutándolo todo; asígnalos con /faro:tests.`);
    if (r.lentosOmitidos.length) out(`ⓘ ${r.lentosOmitidos.length} test(s) lentos fuera (se tocan solo si cambia su módulo).`);
    if (pv.validados.length) out(`ⓘ ${pv.validados.length} fichero(s) ya validados en verde y sin cambios desde entonces: fuera.`);
    if (pv.soloTexto.size) out(`ⓘ ${pv.soloTexto.size} fichero(s) solo cambian en textos (cadenas, comentarios): cuentan como interior, sin arrastrar dependientes.`);
    const pq = textoPreguntas(r.preguntas, { repetir: 'harness.js tests-dominios --afectados' });
    if (pq) out(pq);
    return undefined;
  }
  const nombre = valor('--dominio');
  if (nombre) {
    const o = ordenDominio(root, nombre, {});
    return out(o.argv ? o.texto : (o.aviso || o.texto));
  }
  if (!cfg.declarado) return out('Este repo no declara tests.dominios. `harness.js tests-dominios --proponer` deduce un borrador (solo lectura); /faro:tests lo hace conversando.');
  out(`DOMINIOS DE TESTS (${Object.keys(cfg.dominios).length})`);
  for (const [n, d] of Object.entries(cfg.dominios)) out(`- ${n}: ${d.descripcion || '(sin descripción)'}${d.pendiente.length ? ` · ${d.pendiente.length} decisión(es) pendiente(s)` : ''}`);
  const av = [...validarConfig(root), ...avisosCobertura(root, { cfg })];
  for (const a of av) out(`⚠ ${a}`);
  return undefined;
}

module.exports = {
  config, validarConfig, ficheros, grafo, contexto, dominiosDe, sinDominio, contratoDe, dependientesDe, resolver, ordenDominio, comandoSeguro,
  cruces, avisosCobertura, integridad, proponer, aplicar, avisoArranque, medirEjecucion, cambiadosContra, porValidar, baseDiff, unaLinea, cli,
  preguntas, textoPreguntas, appsDelRepo, appInvalida, trozo, trozoDe,
};
