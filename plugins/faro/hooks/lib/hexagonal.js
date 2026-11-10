// lib/hexagonal.js — DOMINIO de la verificacion hexagonal (#280): ¿las dependencias reales del codigo
// respetan las capas que ARCHITECTURE.md declara?
//
// Por que existe: «el dominio no importa de infraestructura» era un ejemplo de invariante y lo
// revisaba un agente a ojo. Un dominio que importa la base de datos, hace fetch o lee process.env
// pasaba todos los gates en verde. Esto lo convierte en una regla DETERMINISTA, que puede bloquear.
//
// Lo declarado es lo exigible: las capas no se adivinan por nombres de carpeta; las dice la seccion
// '## Hexagonal' de ARCHITECTURE.md. Sin seccion, solo se puede proponer (planMigracion).
//
// PURO por diseno (y lo comprueba un test): recibe textos, la declaracion y los ficheros YA extraidos
// (imports y usos de E/S, de lib/hexagonal-lenguajes.js). No lee disco, no carga modulos, no mira el
// entorno. La lectura vive en lib/hexagonal-fuentes.js y el cableado en harness.js.
'use strict';

const CAPAS = ['dominio', 'aplicacion', 'puertos', 'adaptadores'];
// A que capas puede depender cada una. Adaptadores y composicion: a todo (son el borde).
const PERMITIDO = {
  dominio: ['dominio', 'puertos'],
  puertos: ['dominio', 'puertos'],
  aplicacion: ['dominio', 'puertos', 'aplicacion'],
  adaptadores: CAPAS,
};
// Capas que NO pueden tocar el mundo: ni E/S ni paquetes externos fuera de 'permitidos'.
const PURAS = ['dominio', 'puertos'];

// Modulos del sistema. Los de E/S nunca entran en el dominio; los puros (calculo, tipos) si.
const JS_ES = new Set(['fs', 'http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'child_process', 'cluster',
  'worker_threads', 'os', 'readline', 'inspector', 'v8', 'process', 'module', 'repl', 'perf_hooks', 'stream', 'zlib', 'sqlite']);
const JS_PURO = new Set(['path', 'url', 'util', 'crypto', 'events', 'assert', 'buffer', 'string_decoder', 'querystring', 'punycode']);
const PY_ES = new Set(['os', 'sys', 'subprocess', 'socket', 'http', 'urllib', 'shutil', 'pathlib', 'sqlite3', 'ftplib',
  'smtplib', 'io', 'glob', 'tempfile', 'asyncio', 'logging', 'ssl', 'select', 'signal', 'threading', 'multiprocessing',
  'pickle', 'shelve']);
const PY_PURO = new Set(['__future__', 'abc', 'dataclasses', 'typing', 'enum', 'decimal', 'fractions', 'datetime', 're',
  'math', 'statistics', 'json', 'collections', 'functools', 'itertools', 'operator', 'uuid', 'copy', 'string', 'textwrap',
  'numbers', 'contextlib', 'types', 'hashlib', 'hmac', 'base64', 'bisect', 'heapq', 'random', 'secrets', 'time', 'zoneinfo',
  'unicodedata', 'warnings', 'csv']);

const sinAcentos = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const limpiarRuta = (s) => s.replace(/`/g, '').replace(/^\.\//, '').trim();

// ---------- la declaracion ----------

// Lee la seccion '## Hexagonal' (hasta el siguiente '## '). Cada linea '- clave: valor[, valor]'.
// Acepta backticks, acentos (aplicación, composición) y un comentario tras ' — ' o ' # '.
function leerDeclaracion(texto) {
  const d = { declarada: false, capas: { dominio: [], aplicacion: [], puertos: [], adaptadores: [] }, composicion: [], permitidos: [], errores: [] };
  const m = String(texto || '').match(/^##[ \t]+Hexagonal\b[^\n]*\n([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/m);
  if (!m) return d;
  d.declarada = true;
  for (const linea of m[1].split(/\r?\n/)) {
    const kv = linea.match(/^\s*[-*]\s*`?([\wÀ-ÿ]+)`?\s*:\s*(.*)$/);
    if (!kv) continue;
    const clave = sinAcentos(kv[1].toLowerCase());
    const valores = kv[2].split(/\s+(?:—|#)\s+/)[0].split(/[,\s]+/).map(limpiarRuta).filter(Boolean);
    if (CAPAS.includes(clave)) d.capas[clave].push(...valores.map((v) => (/\.\w+$/.test(v) || v.endsWith('/') ? v : `${v}/`)));
    else if (clave === 'composicion') d.composicion.push(...valores);
    else if (clave === 'permitidos') d.permitidos.push(...valores);
  }
  if (!d.capas.dominio.length) d.errores.push("la seccion '## Hexagonal' no declara la carpeta de 'dominio' (- dominio: src/dominio/)");
  return d;
}

// ---------- rutas ----------

function normalizar(ruta) {
  const out = [];
  for (const seg of ruta.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}
const dirDe = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const bajo = (rel, entrada) => (entrada.endsWith('/') ? `${rel}/`.startsWith(entrada) || rel.startsWith(entrada) : rel === entrada || rel.startsWith(`${entrada}/`));

// La capa de una ruta: la entrada declarada mas larga que la contiene (una carpeta anidada gana).
function capaDe(rel, decl) {
  let mejor = null; let largo = -1;
  for (const capa of CAPAS) {
    for (const e of decl.capas[capa]) if (bajo(rel, e) && e.length > largo) { mejor = capa; largo = e.length; }
  }
  return mejor;
}
const esComposicion = (rel, decl) => decl.composicion.some((e) => bajo(rel, e));
const esTest = (rel) => /(^|\/)(tests?|__tests__|spec)\//.test(rel) || /\.(test|spec)\.\w+$/.test(rel) || /(^|\/)test_[^/]+\.py$|_test\.py$/.test(rel);

// Que es un import: { tipo: 'interno', ruta } | { tipo: 'es' | 'puro' | 'externo', nombre } | { tipo: 'alias' }.
function clasificar(spec, rel, lenguaje, decl) {
  if (lenguaje === 'py') {
    if (spec.startsWith('.')) {
      const puntos = spec.match(/^\.+/)[0].length;
      let base = dirDe(rel);
      for (let i = 1; i < puntos; i++) base = dirDe(base);
      return { tipo: 'interno', ruta: normalizar(`${base}/${spec.slice(puntos).replace(/\./g, '/')}`) };
    }
    const ruta = spec.replace(/\./g, '/');
    for (const r of [ruta, `src/${ruta}`]) if (capaDe(r, decl) || esComposicion(r, decl)) return { tipo: 'interno', ruta: r };
    const nombre = spec.split('.')[0];
    if (PY_ES.has(nombre)) return { tipo: 'es', nombre };
    if (PY_PURO.has(nombre)) return { tipo: 'puro', nombre };
    return { tipo: 'externo', nombre };
  }
  if (spec.startsWith('.')) return { tipo: 'interno', ruta: normalizar(`${dirDe(rel)}/${spec}`) };
  // Alias internos (tsconfig paths, imports de package.json): fuera de alcance, no se juzgan.
  if (/^(@\/|~\/|#)/.test(spec)) return { tipo: 'alias' };
  const prot = spec.match(/^([a-z]+):(.*)$/);
  if (prot && prot[1] !== 'node') return { tipo: 'es', nombre: spec };
  const s = prot ? prot[2] : spec;
  const nombre = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
  if (JS_ES.has(nombre)) return { tipo: 'es', nombre };
  if (JS_PURO.has(nombre)) return { tipo: 'puro', nombre };
  if (prot) return { tipo: 'es', nombre: spec };
  return { tipo: 'externo', nombre };
}

// ---------- la comprobacion ----------

// ficheros: [{ rel, lenguaje, imports: [{ spec, linea }], es: [{ uso, linea }] }], rel relativo a la
// base (raiz del repo o carpeta de la app), igual que las rutas de la declaracion.
function comprobar(decl, ficheros) {
  const violaciones = [];
  const sinCapa = [];
  for (const f of ficheros || []) {
    if (!f.lenguaje || esTest(f.rel) || esComposicion(f.rel, decl)) continue;
    const capa = capaDe(f.rel, decl);
    if (!capa) { sinCapa.push(f.rel); continue; }
    const pura = PURAS.includes(capa);
    if (pura) for (const u of f.es || []) violaciones.push({ rel: f.rel, linea: u.linea, regla: `${capa} hace E/S`, detalle: u.uso });
    for (const imp of f.imports || []) {
      const c = clasificar(imp.spec, f.rel, f.lenguaje, decl);
      if (c.tipo === 'interno') {
        if (esComposicion(c.ruta, decl)) continue;
        const destino = capaDe(c.ruta, decl);
        if (destino && !PERMITIDO[capa].includes(destino)) violaciones.push({ rel: f.rel, linea: imp.linea, regla: `${capa} → ${destino}`, detalle: imp.spec });
      } else if (pura && c.tipo === 'es' && !decl.permitidos.includes(c.nombre)) {
        violaciones.push({ rel: f.rel, linea: imp.linea, regla: `${capa} hace E/S`, detalle: imp.spec });
      } else if (pura && c.tipo === 'externo' && !decl.permitidos.includes(c.nombre)) {
        violaciones.push({ rel: f.rel, linea: imp.linea, regla: `${capa} usa paquete externo`, detalle: imp.spec });
      }
    }
  }
  const conforme = decl.declarada && !decl.errores.length && !violaciones.length;
  return { conforme, violaciones, errores: decl.errores.slice(), sinCapa };
}

// ---------- el plan de migracion (repos sin seccion) ----------

const PUNTO_ENTRADA = /(^|\/)(index|main|app|server|worker|__main__)\.\w+$/;

// Clasifica el codigo actual: lo que hace E/S va a adaptadores, el punto de entrada a composicion y
// lo puro a dominio. Es una PROPUESTA: no sabe de negocio, asi que el equipo la revisa antes de mover.
function planMigracion(ficheros) {
  const vacia = { declarada: false, capas: { dominio: [], aplicacion: [], puertos: [], adaptadores: [] }, composicion: [], permitidos: [], errores: [] };
  const dominio = []; const adaptadores = []; const composicion = [];
  const codigo = (ficheros || []).filter((f) => f.lenguaje && !esTest(f.rel));
  for (const f of codigo) {
    const haceES = (f.es || []).length > 0
      || (f.imports || []).some((i) => clasificar(i.spec, f.rel, f.lenguaje, vacia).tipo === 'es');
    if (PUNTO_ENTRADA.test(f.rel) && f.rel.split('/').length <= 2) composicion.push(f.rel);
    else if (haceES) adaptadores.push(f.rel);
    else dominio.push(f.rel);
  }
  const raiz = codigo.length && codigo.filter((f) => f.rel.startsWith('src/')).length * 2 >= codigo.length ? 'src/' : '';
  const comp = composicion[0] || `${raiz}index.ts`;
  const seccion = [
    '## Hexagonal',
    `- dominio: ${raiz}dominio/`,
    `- aplicacion: ${raiz}aplicacion/`,
    `- puertos: ${raiz}puertos/`,
    `- adaptadores: ${raiz}adaptadores/`,
    `- composicion: ${comp}`,
    '- permitidos:',
  ].join('\n');
  const lista = (xs) => (xs.length ? xs.join(', ') : '(ninguno)');
  const pasos = [
    `Crea ${raiz}dominio/, ${raiz}aplicacion/, ${raiz}puertos/ y ${raiz}adaptadores/.`,
    `Mueve a ${raiz}dominio/ lo que no hace E/S (revisa que sea regla de negocio): ${lista(dominio)}.`,
    `Por cada E/S que el negocio necesita (datos, red, colas, entorno), define un puerto (interfaz) en ${raiz}puertos/ y que el dominio o la aplicación dependan de él.`,
    `Mueve a ${raiz}adaptadores/ lo que hace E/S, implementando esos puertos: ${lista(adaptadores)}.`,
    `Deja la composición en ${comp}: es el único sitio que importa adaptadores y los inyecta.`,
    'Pega la sección en ARCHITECTURE.md (lista en «permitidos» los paquetes puros que use el dominio) y valida con harness.js hexagonal.',
  ];
  return { dominio, adaptadores, composicion, seccion, pasos };
}

// ---------- informe ----------

function pintar(donde, decl, res) {
  const out = [];
  if (!decl.declarada) {
    out.push(`hexagonal ${donde}: sin declarar en ARCHITECTURE.md. Propuesta y pasos: harness.js hexagonal --plan`);
    return out;
  }
  for (const e of res.errores) out.push(`hexagonal ${donde}: declaración — ${e}`);
  if (res.conforme) out.push(`hexagonal ${donde}: OK — las dependencias respetan las capas declaradas.`);
  else if (res.violaciones.length) {
    out.push(`hexagonal ${donde}: ${res.violaciones.length} violación(es):`);
    for (const v of res.violaciones) out.push(`  - ${v.rel}:${v.linea} ${v.regla} (${v.detalle})`);
  }
  if (res.sinCapa.length) out.push(`  (fuera de las capas declaradas, no se juzgan: ${res.sinCapa.slice(0, 5).join(', ')}${res.sinCapa.length > 5 ? ' …' : ''})`);
  return out;
}

function pintarPlan(donde, plan) {
  return [
    `Plan de migración a hexagonal (${donde}) — propuesta, no se mueve nada:`,
    '',
    plan.seccion,
    '',
    'Pasos:',
    ...plan.pasos.map((p, i) => `${i + 1}. ${p}`),
  ];
}

module.exports = { leerDeclaracion, comprobar, planMigracion, pintar, pintarPlan, capaDe, CAPAS };
