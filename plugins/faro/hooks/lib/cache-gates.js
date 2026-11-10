// lib/cache-gates.js — CACHE DE RESULTADOS DE GATES (#182): lo que no cambio, no se repite.
//
// CLAVE = sha256 de: version del gate + nombre del gate + forma exacta del comando + gestor + el CONTENIDO del
// arbol git de la app y de sus dependencias de workspace (indice de git `ls-files -s`, mas el contenido de lo
// modificado y de lo sin seguimiento, que git aun no ha registrado) + los ficheros globales de la raiz. Es
// contenido, no historia: commitear lo mismo no la cambia; tocar un fichero, la dependencia o el script, si.
// Solo se guarda el VERDE; un rojo se vuelve a ejecutar siempre.
//
// ALMACEN: <directorio privado por usuario de procesos.js>/cache/<hash>.json, un fichero por (repo, app, gate).
// SEGURIDAD: las entradas son datos NO confiables (esquema estricto, tamano maximo, sin symlinks, propias);
// las rutas llegan a git solo si cumplen un patron cerrado y detras de `--`; sin shell.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const P = require('./procesos.js');

const VERSION_GATE = 1;                                // subirla invalida toda la cache (cambia la semantica de un gate)
const MAX_EDAD_MS = 14 * 86400e3;
const CLAVES = ['v', 'clave', 'gate', 'app', 'resultado', 'cuando', 'ms', 'firma'];
const ENTORNO_RELEVANTE = ['NODE_ENV', 'CI', 'NODE_OPTIONS', 'TS_NODE_PROJECT', 'VITEST_MODE', 'BABEL_ENV'];   // variables que alteran el resultado de un gate
// Ficheros de la RAIZ que pueden alterar el resultado de cualquier gate: manifiestos, lockfiles (fijan las versiones de node,
// tsc, vitest…), tsconfig*.json, *.config.*, .*rc*, biome/turbo/wrangler, versiones de herramientas. Todo lo que no esta en una
// carpeta (README, LICENSE…) no cuenta.
const RE_RAIZ_GLOBAL = /^(?:package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json|tsconfig[\w.-]*\.json|[\w.-]*\.config\.[cm]?[jt]sx?|vitest\.workspace\.[cm]?[jt]s|\.[\w.-]*rc(?:\.[\w]+)?|biome\.jsonc?|turbo\.json|wrangler[\w.-]*\.(?:jsonc?|toml)|\.nvmrc|\.node-version|\.tool-versions|\.npmrc|\.yarnrc\.yml|\.pnpmfile\.cjs)$/;
const esGlobal = (p) => !p.includes('/') && RE_RAIZ_GLOBAL.test(p);
const EXCLUIR_RAIZ = ['faro', 'gestion', 'documentos', 'fuentes', 'borrador', 'flujos'];   // la gestion de FARO no es codigo de la app
const MAX_FICHERO_HASH = 8 * 1024 * 1024;

const rutaValida = (r) => typeof r === 'string' && r.length > 0 && r.length <= 200 && /^[A-Za-z0-9_.@][A-Za-z0-9_.@/-]*$/.test(r) && !r.split('/').includes('..') && !r.endsWith('/');
const nombreValido = (n) => typeof n === 'string' && /^[A-Za-z0-9_.@/:-]{1,80}$/.test(n);

function git(root, args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'buffer', windowsHide: true, timeout: 60000, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}
function hashFichero(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return `l:${fs.readlinkSync(abs)}`;
    if (!st.isFile()) return 'd';
    if (st.size > MAX_FICHERO_HASH) return `g:${st.size}:${Math.round(st.mtimeMs)}`;
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch { return 'borrado'; }
}

/**
 * INSTANTANEA del repo: Map ruta → sha de contenido de todo lo que git conoce o ve (3 llamadas a git en total, no 3 por gate).
 * Contenido, no historia: sha de blob del indice para lo limpio y hash-object (mismos filtros que git) para lo modificado o
 * sin seguimiento; lo borrado desaparece del conjunto. Commitear lo mismo no cambia nada. → Map | null (no es un repo git…).
 */
function instantanea(root) {
  try {
    root = path.resolve(String(root));
    const mapa = new Map();
    for (const reg of git(root, ['ls-files', '-s', '-z']).toString('utf8').split('\0').filter(Boolean)) {
      const m = reg.match(/^\d+ ([0-9a-f]{40,64}) \d+\t([\s\S]+)$/);
      if (m) mapa.set(m[2], m[1]);
    }
    const sucios = new Set(git(root, ['ls-files', '-m', '-o', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean));
    const presentes = [];
    for (const x of sucios) {
      if (!fs.existsSync(path.join(root, x))) { mapa.delete(x); continue; }
      if (/[\r\n]/.test(x)) { mapa.set(x, 'h:' + hashFichero(path.join(root, x))); continue; }
      presentes.push(x);
    }
    if (presentes.length) {
      const shas = execFileSync('git', ['hash-object', '--stdin-paths'], { cwd: root, input: presentes.join('\n') + '\n', encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
      if (shas.length !== presentes.length) return null;
      presentes.forEach((x, i) => mapa.set(x, shas[i]));
    }
    return mapa;
  } catch { return null; }
}

/**
 * Clave de un gate o null (sin cache: ruta no valida, no es un repo git, git falla).
 * op: { root, rutas: ['apps/api', 'packages/shared'|'.'], gate, forma: [cmd, ...args, textoDelScript?], pm, extra?, instantanea? (de instantanea(root)) }
 */
function clave(op) {
  try {
    const rutas = [...new Set((op.rutas && op.rutas.length ? op.rutas : ['.']).map((r) => (r === '.' ? '.' : String(r).replace(/\/+$/, ''))))].sort();
    if (!rutas.every((r) => r === '.' || rutaValida(r))) return null;
    if (!nombreValido(op.gate) || !Array.isArray(op.forma)) return null;
    const snap = op.instantanea || instantanea(op.root);
    if (!snap) return null;
    const enRaiz = rutas.includes('.');
    const dentro = (p) => (enRaiz ? !EXCLUIR_RAIZ.some((e) => p === e || p.startsWith(e + '/')) : (esGlobal(p) || rutas.some((r) => p === r || p.startsWith(r + '/'))));
    const h = crypto.createHash('sha256');
    h.update(JSON.stringify({ v: VERSION_GATE, gate: op.gate, forma: op.forma.map(String), pm: String(op.pm || ''), extra: String(op.extra || ''), rutas, node: String(op.node || process.version), entorno: ENTORNO_RELEVANTE.map((k) => [k, String((op.entorno || process.env)[k] || '')]) }));
    const sel = [...snap.entries()].filter(([p]) => dentro(p)).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    h.update(JSON.stringify(sel));
    return h.digest('hex');
  } catch { return null; }
}

// ───────────────────────── almacen ─────────────────────────
const nombreEntrada = (root, app, gate) => `${crypto.createHash('sha1').update(`${path.resolve(String(root))}\0${app}\0${gate}`).digest('hex').slice(0, 24)}.json`;
const dirCache = (env = process.env) => (env.FARO_CACHE_DIR ? path.resolve(env.FARO_CACHE_DIR) : path.join(P.dirRegistro(env), 'cache'));
// SECRETO por usuario (HMAC de cada entrada): vive en el directorio privado, se crea en exclusiva (wx, 0600) y no se deriva del
// repo. Quien pueda escribir entradas pero no leer el secreto (un repo o PR hostil, otro proceso) no puede fabricar un verde.
const FICH_SECRETO = 'hmac.key';
function secreto(dir, { crear = false } = {}) {
  const ruta = path.join(dir, FICH_SECRETO);
  const leerSec = () => {
    try {
      const st = fs.lstatSync(ruta);
      if (!st.isFile() || st.isSymbolicLink() || st.size < 32 || st.size > 256) return null;
      if (process.platform !== 'win32' && (st.uid !== process.getuid() || (st.mode & 0o077) !== 0)) return null;
      return fs.readFileSync(ruta);
    } catch { return null; }
  };
  const s = leerSec();
  if (s || !crear) return s;
  try { const fd = fs.openSync(ruta, 'wx', 0o600); try { fs.writeSync(fd, crypto.randomBytes(48)); } finally { fs.closeSync(fd); } } catch { /* otro proceso lo creo, o hay algo en su sitio */ }
  return leerSec();
}
const firmar = (sec, e) => crypto.createHmac('sha256', sec).update(JSON.stringify([e.v, e.clave, e.gate, e.app, e.resultado, e.cuando, e.ms])).digest('hex');
const firmaOk = (sec, e) => {
  if (!sec || typeof e.firma !== 'string' || !/^[0-9a-f]{64}$/.test(e.firma)) return false;
  return crypto.timingSafeEqual(Buffer.from(firmar(sec, e), 'hex'), Buffer.from(e.firma, 'hex'));
};
function preparar(env) {
  const d = dirCache(env);
  if (!env.FARO_CACHE_DIR && !P.dirSeguro(P.dirRegistro(env), { crear: true })) return null;
  return P.dirSeguro(d, { crear: true }) ? d : null;
}
function entradaValida(e) {
  return !!e && typeof e === 'object' && !Array.isArray(e)
    && Object.keys(e).length === CLAVES.length && CLAVES.every((k) => k in e)
    && e.v === VERSION_GATE && typeof e.clave === 'string' && /^[0-9a-f]{64}$/.test(e.clave)
    && nombreValido(e.gate) && typeof e.app === 'string' && e.app.length <= 80
    && e.resultado === 'pass' && Number.isFinite(e.cuando) && Number.isFinite(e.ms) && e.ms >= 0
    && typeof e.firma === 'string' && /^[0-9a-f]{64}$/.test(e.firma);
}
function leerFichero(ruta) {
  try {
    const st = fs.lstatSync(ruta);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1024) return null;
    if (process.platform !== 'win32' && st.uid !== process.getuid()) return null;
    const e = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    return entradaValida(e) ? e : null;
  } catch { return null; }
}

/** → { cuando, ms } si hay un verde con ESA clave; null si no (o `ignorar`: --sin-cache). */
function leer(env, root, app, gate, claveActual, { ignorar = false } = {}) {
  if (ignorar || !claveActual || !nombreValido(gate)) return null;
  const dir = dirCache(env);
  if (!P.dirSeguro(dir)) return null;
  const e = leerFichero(path.join(dir, nombreEntrada(root, app, gate)));
  if (e && !firmaOk(secreto(dir), e)) return null;     // no verifica = miss, nunca se acepta
  if (!e || e.clave !== claveActual || e.gate !== gate || e.app !== String(app).slice(0, 80)) return null;
  if (e.cuando > Date.now() + 60e3 || Date.now() - e.cuando > MAX_EDAD_MS) return null;
  return { cuando: e.cuando, ms: e.ms };
}
/** Guarda un verde. → true si quedo escrito. */
function escribir(env, root, app, gate, claveActual, { ms = 0 } = {}) {
  if (!claveActual || !nombreValido(gate)) return false;
  const dir = preparar(env);
  if (!dir) return false;
  const sec = secreto(dir, { crear: true });
  if (!sec) return false;
  const e = { v: VERSION_GATE, clave: claveActual, gate, app: String(app).slice(0, 80), resultado: 'pass', cuando: Date.now(), ms: Math.max(0, Math.round(Number(ms) || 0)) };
  e.firma = firmar(sec, e);
  const ruta = path.join(dir, nombreEntrada(root, app, gate));
  const tmp = `${ruta}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, JSON.stringify(e)); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, ruta);                              // atomico: un lector nunca ve una entrada a medias
    return true;
  } catch { try { fs.unlinkSync(tmp); } catch {} return false; }
}
function ficheros(env) {
  const dir = dirCache(env);
  if (!P.dirSeguro(dir)) return [];
  try { return fs.readdirSync(dir).filter((f) => /^[0-9a-f]{24}\.json$/.test(f) || /\.json$/.test(f)).map((f) => path.join(dir, f)); } catch { return []; }
}
/** { n, bytes } de la cache. */
function resumen(env = process.env) {
  let n = 0; let bytes = 0;
  for (const f of ficheros(env)) { try { const st = fs.lstatSync(f); if (st.isFile()) { n++; bytes += st.size; } } catch {} }
  return { n, bytes };
}
/** Retira lo caducado o invalido (o todo con `todo`). Sin `confirmo` solo cuenta. → { n } */
function limpiar(env = process.env, { confirmo = false, todo = false } = {}) {
  let n = 0;
  for (const f of ficheros(env)) {
    const e = leerFichero(f);
    if (todo || !e || Date.now() - e.cuando > MAX_EDAD_MS) { n++; if (confirmo) { try { fs.unlinkSync(f); } catch {} } }
  }
  return { n };
}

module.exports = { VERSION_GATE, instantanea, clave, leer, escribir, resumen, limpiar, rutaValida, dirCache };
