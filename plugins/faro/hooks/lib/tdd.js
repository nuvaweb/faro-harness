// lib/tdd.js — TDD VERIFICABLE (#133): el harness comprueba el orden rojo -> verde, no solo que
// "hay tests y pasan".
//
// Cuatro piezas, cada una un subcomando propio del harness cableado en hooks.json (no se cuelgan de
// pre-doc ni de stop-check: asi cada hook hace UNA cosa y se puede apagar por separado):
//   - tdd-post   (PostToolUse / PostToolUseFailure, Bash|PowerShell): si el comando ejecuto tests,
//                registra que ficheros de test quedaron en ROJO, con el hash de su contenido. Si un
//                test pasa a VERDE con el contenido cambiado desde su rojo, avisa: se cambio el test,
//                no el codigo.
//   - tdd-pre    (PreToolUse, Write|Edit): editar CODIGO sin un test rojo de ese modulo en la sesion
//                avisa una vez por modulo (modo aviso) o bloquea con exit 2 (modo bloqueo). Editar un
//                test que esta en rojo y aun no ha pasado a verde: "no debilites el test".
//   - tdd-stop   (Stop): NO ejecuta nada. Un hook corre FUERA del sistema de permisos de Claude Code y
//                el script 'test' es contenido del repo que el propio agente pudo escribir: lanzarlo
//                desde aqui seria ejecutar comandos sin aprobacion. Decide con la evidencia de tdd-post:
//                si una app tiene codigo editado sin una ejecucion de tests POSTERIOR en verde, devuelve
//                el control al agente (exit 2) con la orden exacta, que el lanza por Bash con sus
//                permisos. Si el MISMO pendiente ya se devolvio N veces, avisa al humano (systemMessage).
//   - tdd-revisar [base]: reglas DETERMINISTAS de tests debilitados en el diff (aserciones borradas,
//                skip/only, mock del propio modulo bajo prueba, tests sin aserciones). Lo usa revisor-code.
//
// La evidencia vive FUERA del repo (CLAUDE_PLUGIN_DATA, o el temporal del sistema), un fichero por
// repo y sesion: es estado efimero de la sesion, versionarlo no aporta nada.
//
// COSTE: estos hooks corren en CADA Write/Edit y en CADA Bash. harness.js los despacha al PRINCIPIO,
// antes de cargar el motor, y este modulo solo carga apps.js (fs/path). Sin nada que hacer, sale ya.
//
// Presupuesto de contexto: sin nada que decir, salida VACIA. Un aviso por modulo y sesion como maximo.
//
// Configuracion: .faro.json > "tdd": { "modo": "aviso"|"bloqueo"|"off", "codigo": [globs], "tests":
// [globs] }. El contrato (modos y valores por defecto) esta en faro-schema.json >
// enums.tdd; aqui solo el respaldo si el schema no se puede leer.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
// Carga PEREZOSA: el caso "nada que hacer" (la mayoria de los Write/Edit/Bash) no paga crypto,
// child_process ni apps.js.
const crypto = { createHash: (...a) => require('crypto').createHash(...a) };
const spawnSync = (cmd, args, op) => require('child_process').spawnSync(cmd, args, { ...op, windowsHide: true });
const appsLib = new Proxy({}, { get: (_, k) => require('./apps.js')[k] });
// Dominios de tests (#178): servicio unico en lib/dominios.js, carga perezosa (solo si el repo declara dominios).
const dominios = new Proxy({}, { get: (_, k) => require('./dominios.js')[k] });

const RESPALDO = {
  modos: ['aviso', 'bloqueo', 'off'],
  modo_defecto: 'aviso',
  codigo_defecto: ['src/**', 'apps/*/src/**', 'packages/*/src/**'],
  tests_defecto: ['test/**', 'tests/**', '**/__tests__/**', '**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/*_test.py', '**/*_test.go'],
  extensiones_codigo: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.vue', '.svelte', '.astro'],
  repeticiones_stop: 3,
};
const CLAVES = ['modo', 'codigo', 'tests'];

const leer = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } };
const leerJson = (abs) => { const t = leer(abs); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } };
const posix = (p) => String(p || '').replace(/\\/g, '/');
const sha = (txt, n) => crypto.createHash('sha256').update(String(txt)).digest('hex').slice(0, n || 64);
const hashFichero = (abs) => { const t = leer(abs); return t == null ? null : sha(t); };

// El schema se lee AQUI (mismo orden que faroSchema() del harness: el del repo en .claude/, si no el del
// plugin), porque el despacho temprano de harness.js no carga el motor.
const _schemas = new Map();
function schemaDe(root) {
  if (_schemas.has(root)) return _schemas.get(root);
  const propio = root ? path.join(root, '.claude', 'faro-schema.json') : null;
  const s = leerJson(propio && fs.existsSync(propio) ? propio : path.join(__dirname, '..', 'faro-schema.json'));
  _schemas.set(root, s);
  return s;
}
/** El contrato tdd: enums.tdd del schema (el que se pase, o el del repo/plugin) sobre el respaldo. */
function contrato(schema, root) {
  const s = ((schema || schemaDe(root) || {}).enums || {}).tdd || {};
  const out = { ...RESPALDO };
  for (const k of Object.keys(RESPALDO)) if (s[k] !== undefined && typeof s[k] === typeof RESPALDO[k] && Array.isArray(s[k]) === Array.isArray(RESPALDO[k])) out[k] = s[k];
  return out;
}

// ---------- globs ----------

/** Glob -> RegExp sobre rutas relativas con '/': '**' cruza carpetas, '*' y '?' no, '{a,b}' alterna. */
function globRe(glob) {
  let re = '';
  const g = posix(glob).replace(/^\.\//, '').replace(/(\*\*\/)+/g, '**/');   // colapsar: cada '**/' repetido era backtracking exponencial
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const fin = g.indexOf('}', i); if (fin < 0) { re += '\\{'; continue; } re += `(?:${g.slice(i + 1, fin).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`; i = fin; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const casa = (globs, rel) => globs.some((g) => globRe(g).test(rel));

// ---------- configuracion ----------

const esRepoFaro = (root) => ['.faro.json', 'ESTADO.md', 'INICIATIVA.md'].some((f) => fs.existsSync(path.join(root, f)));
const listaDeTextos = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim());

/** {modo, codigo, tests, repeticiones, extensiones, activo}. 'activo' = repo FARO y modo != off. */
function config(root, { schema } = {}) {
  const c = contrato(schema, root);
  const t = ((leerJson(path.join(root, '.faro.json')) || {}).tdd) || {};
  const modo = c.modos.includes(t.modo) ? t.modo : c.modo_defecto;
  return {
    modo,
    codigo: listaDeTextos(t.codigo) ? t.codigo : c.codigo_defecto,
    tests: listaDeTextos(t.tests) ? t.tests : c.tests_defecto,
    repeticiones: c.repeticiones_stop,
    extensiones: c.extensiones_codigo,
    activo: modo !== 'off' && esRepoFaro(root),
  };
}

/** Lo que .faro.json > tdd incumple del contrato (para validate; avisa, no bloquea). */
function validarConfig(root, { schema } = {}) {
  const t = (leerJson(path.join(root, '.faro.json')) || {}).tdd;
  if (t === undefined) return [];
  const c = contrato(schema, root);
  if (!t || typeof t !== 'object' || Array.isArray(t)) return ['.faro.json > tdd debe ser un objeto { "modo": "aviso" }.'];
  const out = [];
  for (const k of Object.keys(t)) if (!CLAVES.includes(k)) out.push(`.faro.json > tdd.${k}: clave desconocida (válidas: ${CLAVES.join(', ')}).`);
  if (t.modo !== undefined && !c.modos.includes(t.modo)) out.push(`.faro.json > tdd.modo '${t.modo}' no es válido (válidos: ${c.modos.join(', ')}; por defecto '${c.modo_defecto}').`);
  for (const k of ['codigo', 'tests']) if (t[k] !== undefined && !listaDeTextos(t[k])) out.push(`.faro.json > tdd.${k} debe ser una lista de globs (p. ej. ${JSON.stringify(k === 'codigo' ? c.codigo_defecto.slice(0, 2) : c.tests_defecto.slice(0, 2))}).`);
  return out;
}

// ---------- clasificacion de ficheros ----------

/** Ruta -> relativa a la raiz con '/', o null si cae fuera del repo. */
function relativa(root, ruta) {
  if (!ruta) return null;
  const abs = path.isAbsolute(String(ruta)) ? String(ruta) : path.join(root, String(ruta));
  const r = posix(path.relative(root, abs));
  return !r || r.startsWith('..') || path.isAbsolute(r) ? null : r;
}

/** 'test' | 'codigo' | null. Un test colocado dentro de src/ es test: los globs de tests mandan. */
function clasificar(root, rel, cfg) {
  const c = cfg || config(root);
  if (!rel || /(^|\/)(node_modules|dist|build|\.git)\//.test(rel) || /\.d\.[cm]?ts$/.test(rel)) return null;
  if (!c.extensiones.includes(path.extname(rel).toLowerCase())) return null;
  if (casa(c.tests, rel)) return 'test';
  if (casa(c.codigo, rel)) return 'codigo';
  return null;
}

/** Nombre del modulo: 'src/a.ts' -> 'a'; 'src/a.test.ts', 'tests/test_a.py', 'a_test.go' -> 'a'. */
function baseModulo(rel) {
  let b = path.basename(posix(rel));
  b = b.replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/i, '').replace(/^test_/i, '').replace(/_test$/i, '');
  return b.toLowerCase();
}

// Ficheros del repo (versionados + nuevos sin ignorar): para encontrar el test de un modulo.
const _listas = new Map();
function ficherosRepo(root) {
  if (_listas.has(root)) return _listas.get(root);
  const r = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const lista = r.status === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  _listas.set(root, lista);
  return lista;
}
const testsDelRepo = (root, cfg) => ficherosRepo(root).filter((f) => clasificar(root, f, cfg) === 'test');

// App de una ruta (id) en monorepo; '.' en un repo simple o fuera de toda app.
function appDe(root, rel) {
  try { const a = appsLib.appDeRuta(root, rel); return a ? a.id : '.'; } catch { return '.'; }
}

/** Tests del repo que corresponden por NOMBRE al modulo 'rel' (misma app). */
function testsDe(root, rel, cfg) {
  const base = baseModulo(rel);
  const app = appDe(root, rel);
  return testsDelRepo(root, cfg).filter((t) => baseModulo(t) === base && appDe(root, t) === app);
}

function sugerirTest(rel) {
  const dir = path.posix.dirname(rel);
  const ext = path.extname(rel);
  const base = path.basename(rel, ext);
  if (ext === '.py') return `tests/test_${base}.py`;
  if (ext === '.go') return `${dir}/${base}_test.go`;
  return `${dir}/${base}.test${ext}`;
}

// ---------- evidencia de la sesion ----------

function rutaEstado(root, sesion) {
  const base = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'faro');
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* sin carpeta: leer/guardar fallan en silencio */ }
  const repo = sha(path.resolve(root).toLowerCase(), 12);
  const ses = String(sesion || 'sin-sesion').replace(/[^\w.-]+/g, '-').slice(0, 80);
  return path.join(base, `tdd-${repo}-${ses}.json`);
}
function leerEstado(root, sesion) {
  const e = leerJson(rutaEstado(root, sesion)) || {};
  // 'seq' ordena los sucesos de la sesion (edicion de codigo, ejecucion de tests) sin depender del reloj.
  return { seq: e.seq || 0, rojos: e.rojos || {}, rojosApp: e.rojosApp || {}, avisados: e.avisados || {}, codigo: e.codigo || {}, ejecuciones: e.ejecuciones || {}, fallosStop: e.fallosStop || {}, tests: e.tests || {}, baterias: e.baterias || [] };
}
function guardarEstado(root, sesion, est) {
  try { fs.writeFileSync(rutaEstado(root, sesion), JSON.stringify(est)); } catch { /* sin evidencia: el hook no rompe el turno */ }
}

// ---------- deteccion de ejecuciones de tests ----------

const RE_COMANDO_TESTS = new RegExp([
  String.raw`\b(vitest|jest|mocha|ava|pytest|tap)\b`,
  String.raw`\bplaywright\s+test\b`,
  String.raw`\bnode\b[^|;&\n]*\s--test\b`,
  String.raw`\b(npm|pnpm|yarn|bun)\b[^|;&\n]*?\s(run\s+)?test(:[\w:-]+)?(\s|$)`,
  String.raw`\b(go|cargo|deno|bun|dotnet)\s+test\b`,
  String.raw`\bpython3?\s+-m\s+(pytest|unittest)\b`,
].join('|'));
const esComandoTests = (cmd) => RE_COMANDO_TESTS.test(String(cmd || ''));

// Linea que senala un fallo (vitest/jest 'FAIL', node --test '✖' y 'test at', TAP 'not ok', pytest 'FAILED').
const RE_LINEA_FALLO = /\bFAIL(ED)?\b|✖|✗|×|\bnot ok\b|\bfailed\b|^\s*test at |AssertionError|\bError\b/;
const RE_RESUMEN_FALLO = /\b[1-9]\d* (failed|failing)\b|^# fail [1-9]|ℹ fail [1-9]|\bFAILED\b|^\s*FAIL\s/m;

/** {texto, fallo, interrumpido} de un payload PostToolUse / PostToolUseFailure. */
function resultado(payload) {
  const tr = payload.tool_response;
  const partes = [];
  if (typeof tr === 'string') partes.push(tr);
  else if (tr && typeof tr === 'object') for (const k of ['stdout', 'stderr', 'output']) if (tr[k]) partes.push(String(tr[k]));
  const err = payload.error && (typeof payload.error === 'string' ? payload.error : payload.error.message || JSON.stringify(payload.error));
  if (err) partes.push(err);
  const texto = partes.join('\n');
  let codigo = null;
  if (tr && typeof tr === 'object') for (const k of ['exitCode', 'exit_code', 'code', 'returnCode']) if (Number.isInteger(tr[k])) { codigo = tr[k]; break; }
  if (codigo === null) { const m = /Exit code (\d+)/i.exec(err || ''); if (m) codigo = Number(m[1]); }
  const fallo = payload.hook_event_name === 'PostToolUseFailure' || (codigo !== null ? codigo !== 0 : RE_RESUMEN_FALLO.test(texto));
  return { texto, fallo, interrumpido: Boolean((tr && tr.interrupted) || payload.is_interrupt) };
}

// Rutas de test citadas en un texto: se tokeniza y cada token se resuelve contra cwd, la raiz o, si
// es un sufijo (vitest habla relativo a la app), contra el UNICO test del repo que acabe asi.
function testsCitados(root, cwd, texto, cfg) {
  const out = new Set();
  const lista = testsDelRepo(root, cfg);
  for (let tok of String(texto || '').split(/[\s'"`()[\],;|<>]+/)) {
    tok = tok.replace(/^file:\/\/\/?/, '').replace(/::.*$/, '').replace(/(:\d+)+$/, '').replace(/[.:]+$/, '');
    if (!tok || !/\.[a-z]+$/i.test(tok)) continue;
    const cands = [];
    if (path.isAbsolute(tok) || /^[A-Za-z]:[\\/]/.test(tok)) cands.push(relativa(root, tok));
    else { cands.push(relativa(root, path.resolve(cwd || root, tok))); cands.push(relativa(root, tok)); }
    let hecho = false;
    for (const c of cands) if (c && clasificar(root, c, cfg) === 'test' && fs.existsSync(path.join(root, c))) { out.add(c); hecho = true; break; }
    if (hecho) continue;
    const suf = `/${posix(tok).replace(/^\.\//, '')}`;
    const sufijos = lista.filter((f) => `/${f}`.endsWith(suf));
    if (sufijos.length === 1) out.add(sufijos[0]);
  }
  return [...out];
}

// ---------- tdd-post ----------

let _apps;
const appsRepo = (root) => (_apps !== undefined ? _apps : (_apps = (() => { try { return appsLib.apps(root); } catch { return []; } })()));
const limpiarRuta = (x) => String(x || '').replace(/^['"]|['"]$/g, '');

/** Apps a las que se atribuye una ejecucion de tests (ids, '.' en repo simple, '*' = todas). */
function appsDeEjecucion(root, cwd, cmd, citados) {
  const ids = new Set(citados.map((t) => appDe(root, t)));
  if (ids.size) return [...ids];
  const lista = appsRepo(root);
  const c = String(cmd || '');
  for (const m of c.matchAll(/--filter[= ]+(\S+)/g)) {
    const sel = limpiarRuta(m[1]).replace(/^\.{3}|\.{3}$/g, '').replace(/^\{|\}$/g, '').replace(/^\.\//, '');
    const a = lista.find((x) => x.paquete === sel || x.id === sel || x.ruta === sel);
    if (a) ids.add(a.id);
  }
  for (const m of c.matchAll(/yarn\s+workspace\s+(\S+)/g)) { const a = lista.find((x) => x.paquete === limpiarRuta(m[1])); if (a) ids.add(a.id); }
  for (const m of c.matchAll(/(?:\s-C|--dir|--cwd|--prefix|\s-w|--workspace)[= ]+(\S+)|\bcd\s+([^\s&;|]+)/g)) {
    const rel = relativa(root, path.resolve(cwd || root, limpiarRuta(m[1] || m[2])));
    if (rel) { const app = appDe(root, rel); if (app !== '.') ids.add(app); }
  }
  if (ids.size) return [...ids];
  const app = appDe(root, relativa(root, cwd || root) || '.');
  return [app === '.' ? '*' : app];
}

// Dominios (#178) a los que se atribuye una ejecucion: los de los tests citados. [] si el repo no los declara.
function dominiosDeEjecucion(root, citados) {
  if (!citados.length) return [];
  try {
    const cfgD = dominios.config(root);
    if (!cfgD.declarado) return [];
    const ctx = dominios.contexto(root, { cfg: cfgD });
    return [...new Set(citados.flatMap((t) => dominios.dominiosDe(ctx, t)))];
  } catch { return []; }
}

// PRESUPUESTO visible (#178): cada ejecucion deja nº de tests y tiempo; encadenar baterias COMPLETAS caras se avisa
// una vez por sesion. Devuelve {contexto} o null. Las baterias pequenas no molestan (umbral en tests o tiempo).
const UMBRAL_TESTS = 100;
const UMBRAL_MS = 30000;
function presupuesto(est, texto, completa) {
  const m = dominios.medirEjecucion(texto);
  est.baterias.push({ seq: est.seq, tests: m.tests, ms: m.ms, completa });
  if (est.baterias.length > 50) est.baterias.splice(0, est.baterias.length - 50);
  const completas = est.baterias.filter((b) => b.completa);
  const tests = completas.reduce((a, b) => a + (b.tests || 0), 0);
  const ms = completas.reduce((a, b) => a + (b.ms || 0), 0);
  if (completas.length < 2 || (tests < UMBRAL_TESTS && ms < UMBRAL_MS) || est.avisados.presupuesto) return null;
  est.avisados.presupuesto = 1;
  return { contexto: `Presupuesto de tests: ${completas.length} baterías completas en esta sesión (${tests} tests, ${Math.round(ms / 1000)} s). Mientras trabajas ejecuta solo el dominio afectado (harness.js tests-dominios --afectados); la suite completa la corren CI y /faro:publicar — no la lances salvo que el usuario la pida expresamente.` };
}

/** Registra rojos/verdes. Devuelve {contexto} si un test paso a verde con su contenido cambiado. */
function post(root, payload, cfg) {
  if (!cfg.activo) return null;
  const cmd = payload.tool_input && payload.tool_input.command;
  if (!esComandoTests(cmd)) return null;
  const { texto, fallo, interrumpido } = resultado(payload);
  if (interrumpido) return null;
  const cwd = payload.cwd || root;
  const est = leerEstado(root, payload.session_id);
  const enCmd = testsCitados(root, cwd, cmd, cfg);
  const ahora = new Date().toISOString();
  // La ejecucion cuenta para las apps de los tests citados; si no se ve ninguno, para la que diga la
  // orden (--filter, -C, workspace, cd) o el cwd; corrida desde la raiz sin mas = todas ('*').
  est.seq += 1;
  const citados = [...new Set([...enCmd, ...testsCitados(root, cwd, texto, cfg)])];
  for (const app of appsDeEjecucion(root, cwd, cmd, citados)) est.ejecuciones[app] = { seq: est.seq, verde: !fallo };
  // Dominios (#178): la ejecucion cuenta para el dominio de cada test citado. Y PRESUPUESTO visible: nº de tests y
  // tiempo de cada ejecucion; sin tests citados es una bateria COMPLETA, y encadenarlas se avisa una vez.
  const dd = dominiosDeEjecucion(root, citados);
  for (const n of dd) est.ejecuciones[`d:${n}`] = { seq: est.seq, verde: !fallo };
  const aviso = presupuesto(est, texto, !enCmd.length);
  if (fallo) {
    const lineasFallo = texto.split('\n').filter((l) => RE_LINEA_FALLO.test(l)).join('\n');
    let rojos = testsCitados(root, cwd, lineasFallo, cfg);
    if (!rojos.length) rojos = enCmd;
    if (!rojos.length) rojos = testsCitados(root, cwd, texto, cfg);
    // Rojo sin fichero identificable ('npm test' que no lista rutas): cuenta como rojo de la app.
    if (!rojos.length) est.rojosApp[appDe(root, relativa(root, cwd) || '.')] = ahora;
    for (const rel of rojos) est.rojos[rel] = { hash: hashFichero(path.join(root, rel)), app: appDe(root, rel), verde: false, ts: ahora };
    guardarEstado(root, payload.session_id, est);
    return aviso;
  }
  // VERDE: los citados; sin rutas en comando ni salida = paso la bateria entera.
  let verdes = citados;
  if (!verdes.length) verdes = Object.keys(est.rojos);
  const cambiados = [];
  for (const rel of verdes) {
    const r = est.rojos[rel];
    if (!r || r.verde) continue;
    if (r.hash && hashFichero(path.join(root, rel)) !== r.hash) cambiados.push(rel);
    r.verde = true;
  }
  guardarEstado(root, payload.session_id, est);
  if (!cambiados.length) return aviso;
  const msg = `TDD: ${cambiados.join(', ')} pasó a verde con el test cambiado desde su rojo. Comprueba que no lo has debilitado (aserciones quitadas o rebajadas): lo que debe cambiar para que pase es el código.`;
  return { contexto: aviso ? `${msg} ${aviso.contexto}` : msg };
}

// ---------- tdd-pre ----------

function tieneRojo(root, rel, est, cfg) {
  const base = baseModulo(rel);
  const app = appDe(root, rel);
  const rojos = Object.entries(est.rojos);
  if (rojos.some(([t, r]) => r.app === app && baseModulo(t) === base)) return true;
  if (testsDe(root, rel, cfg).length) return false;          // tiene test propio: vale SU rojo
  return Boolean(est.rojosApp[app]) || rojos.some(([, r]) => r.app === app);
}

/** {contexto} (aviso) | {bloquear} (exit 2) | null (silencio). */
function pre(root, payload, cfg) {
  if (!cfg.activo) return null;
  const ti = payload.tool_input || {};
  const rel = relativa(root, ti.file_path || ti.path);
  const tipo = rel && clasificar(root, rel, cfg);
  if (!tipo) return null;
  const sesion = payload.session_id;
  const est = leerEstado(root, sesion);
  const unaVez = (clave, msg) => {
    if (est.avisados[clave]) return null;
    est.avisados[clave] = 1;
    return { contexto: msg };
  };
  let res = null;
  if (tipo === 'test') {
    est.seq += 1; est.tests[rel] = est.seq;                  // la sesion toca este test: el Stop contrasta su diff (#178)
    const r = est.rojos[rel];
    if (!r || r.verde) { guardarEstado(root, sesion, est); return null; }   // antes de su rojo, o ya en verde: libre
    const msg = `TDD: ${rel} está en rojo y aún no ha pasado a verde: no debilites el test para que pase — cambia el código. Si el test estaba mal, díselo al humano antes de tocarlo.`;
    res = cfg.modo === 'bloqueo' ? { bloquear: msg } : unaVez(`test:${rel}`, msg);
  } else {
    if (!tieneRojo(root, rel, est, cfg)) {
      const propios = testsDe(root, rel, cfg);
      const test = propios[0] || sugerirTest(rel);
      const base = baseModulo(rel);
      res = cfg.modo === 'bloqueo'
        ? { bloquear: `TDD (modo bloqueo): para editar ${rel} hace falta antes un test en rojo de «${base}» en esta sesión. Escribe o amplía ${test}, ejecútalo y comprueba que falla; después vuelve a editar ${rel}. Si este cambio no admite test, pide al humano que lo decida (.faro.json > tdd.modo).` }
        : unaVez(`codigo:${rel}`, `TDD: vas a editar ${rel} sin un test en rojo de «${base}» en esta sesión. Primero el test (${test}): ejecútalo y comprueba que falla; después el código.`);
    }
    if (!res || !res.bloquear) { est.seq += 1; est.codigo[rel] = est.seq; }   // lo que se edita de verdad, para el Stop
    // Dominios (#178): codigo que ningun dominio cubre = hueco de cobertura funcional (aviso una vez por fichero).
    const hueco = codigoSinDominio(root, rel);
    if (hueco && !est.avisados[`dom:${rel}`]) {
      est.avisados[`dom:${rel}`] = 1;
      const msg = `TDD: ${rel} no pertenece a ningún dominio de tests (.faro.json > tests.dominios): hueco de cobertura funcional. Decide su dominio con /faro:tests.`;
      res = res && res.contexto ? { contexto: `${res.contexto} ${msg}` } : (res || { contexto: msg });
    }
  }
  guardarEstado(root, sesion, est);
  return res;
}

// ---------- tdd-stop ----------

const tieneTest = (root, ruta) => { const p = leerJson(path.join(root, ruta, 'package.json')); return Boolean(p && p.scripts && p.scripts.test); };

const ORDEN_AFECTADOS = 'harness.js tests-dominios --afectados';

// ---- dominios en el Stop (#178) ----

/** true si 'rel' es codigo que ningun dominio cubre (solo si el repo declara dominios). Barato: globs. */
function codigoSinDominio(root, rel) {
  try {
    const cfgD = dominios.config(root);
    return cfgD.declarado && dominios.sinDominio(dominios.contexto(root, { cfg: cfgD }), rel);
  } catch { return false; }
}

/**
 * Ejecucion que decide el estado de una app/dominio (#241): su verde propio posterior a la ultima edicion de su codigo
 * manda sobre un rojo de la raiz ('*') sin atribuir (timeout, salida sin tests citados). Sin ejecucion propia que
 * cubra la edicion, vale la mas reciente de las dos.
 */
function ejecucionDe(est, clave, seqEdicion) {
  const propia = est.ejecuciones[clave];
  if (propia && propia.verde && propia.seq >= seqEdicion) return propia;
  return [propia, est.ejecuciones['*']].filter(Boolean).sort((x, y) => y.seq - x.seq)[0];
}

/**
 * Pendientes por dominio: { pendientes: [{nombre, estado, orden, firma}], sinDominio: Set<rel> } o null si el repo no
 * declara dominios. Un dominio esta pendiente si su codigo se edito despues de su ultima ejecucion en verde.
 */
function pendientesDeDominios(root, est) {
  try {
    const cfgD = dominios.config(root);
    const editados = Object.keys(est.codigo).slice(0, 200);   // tope de CPU por Stop
    if (!cfgD.declarado || !editados.length) return null;
    const ctx = dominios.contexto(root, { cfg: cfgD });
    const r = dominios.resolver(root, editados, { ctx });
    const sinDominio = new Set(r.sinDominio);
    const pendientes = [];
    for (const a of r.afectados) {
      const o = dominios.ordenDominio(root, a.dominio, { ctx, tests: r.tests.filter((t) => ctx.dominios[a.dominio].testsF.includes(t)) });
      if (!o.argv && !/\S/.test((ctx.dominios[a.dominio].comando || cfgD.comando || ''))) { a.ficheros.forEach((f) => sinDominio.add(f)); continue; }   // sin comando: se pide por app
      // Sin tests que acotarlo, la orden seria el comando base solo = la suite completa: se pide por app (#249, #237).
      if (!o.tests.length) { a.ficheros.forEach((f) => sinDominio.add(f)); continue; }
      const seq = Math.max(...a.ficheros.map((f) => Number(est.codigo[f]) || 0));
      // El verde propio de la app que contiene lo editado, posterior a la edicion, cubre el dominio (#249).
      const apps = [...new Set(a.ficheros.map((f) => appDe(root, f)))];
      const cubiertoPorApp = !apps.includes('.') && apps.every((app) => { const e = est.ejecuciones[app]; return e && e.verde && e.seq >= seq; });
      if (cubiertoPorApp) continue;
      const run = ejecucionDe(est, `d:${a.dominio}`, seq);
      const estado = !run || run.seq < seq ? 'sin ejecutar desde la última edición' : (!run.verde ? 'en rojo' : null);
      if (!estado) continue;
      pendientes.push({
        nombre: `el dominio ${a.dominio}${/^dependiente/.test(a.motivo) ? ' (hermano afectado)' : ''}`, estado,
        orden: o.argv ? o.texto : `${o.texto} — comando no permitido en la lista cerrada: que lo ejecute el usuario`,
        firma: `d:${a.dominio}:${seq}:${run ? run.seq : 0}`,
      });
    }
    return { pendientes, sinDominio };
  } catch { return null; }
}

// Lo ultimo que dijo el agente: el campo del payload del Stop o, si no viene, el final de su transcripcion (JSONL).
function ultimaAfirmacion(payload) {
  if (typeof payload.last_assistant_message === 'string') return payload.last_assistant_message;
  try {
    const tp = payload.transcript_path;
    if (typeof tp !== 'string' || !path.isAbsolute(tp)) return '';
    const fd = fs.openSync(tp, 'r');
    try {
      const tam = fs.fstatSync(fd).size;
      const n = Math.min(tam, 262144);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, tam - n);
      const lineas = buf.toString('utf8').split(String.fromCharCode(10)).filter(Boolean).reverse();
      for (const l of lineas) {
        let o; try { o = JSON.parse(l); } catch { continue; }
        const m = o && (o.message || o);
        if (!m || (m.role || o.type) !== 'assistant') continue;
        const c = m.content;
        const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ') : '';
        if (txt) return txt;
      }
    } finally { fs.closeSync(fd); }
  } catch { /* sin transcripcion: sin afirmacion que contrastar */ }
  return '';
}

/** Gate de integridad en el Stop: {bloquear} | {humano} | null. Una vez por hallazgo distinto. */
function integridadStop(root, payload, est, cfg) {
  if (!Object.keys(est.tests).length) return null;
  let r;
  try { r = dominios.integridad(root, { afirmacion: ultimaAfirmacion(payload) }); } catch { return null; }
  if (r.veredicto === 'ok') return null;
  const firma = `int:${sha(JSON.stringify([r.hallazgos.map((h) => `${h.fichero}|${h.regla}`), r.contradicciones.length]), 12)}`;
  const veces = est.fallosStop[firma] || 0;
  est.fallosStop[firma] = veces + 1;
  guardarEstado(root, payload.session_id, est);
  if (veces > 0) return null;
  const reglas = [...new Set(r.hallazgos.map((h) => h.regla))].slice(0, 4).join(', ');
  const fichero = dominios.unaLinea(r.hallazgos[0].fichero, 60);
  const msg = `TDD · integridad de tests: ${r.hallazgos.length} hallazgo(s) en los tests que has tocado (${reglas}; p. ej. ${fichero}). ${r.contradicciones[0] || ''} Justifícalo al usuario o restaura lo quitado (harness.js tests-dominios --integridad).`.replace(/\s+/g, ' ');
  return r.veredicto === 'bloquear' || cfg.modo === 'bloqueo' ? { bloquear: msg } : { humano: msg };
}

/** {bloquear} (exit 2) | {humano} (systemMessage) | null. No ejecuta nada: decide con la evidencia. */
function stop(root, payload, cfg) {
  if (!cfg.activo) return null;
  const sesion = payload.session_id;
  const est = leerEstado(root, sesion);
  const integ = integridadStop(root, payload, est, cfg);       // #178: el diff de los tests tocados, contra lo que se afirma
  if (integ) return integ;
  // Dominios (#178): el codigo editado se pide por DOMINIO (con sus hermanos si cambia el contrato); lo que ningun
  // dominio cubre sigue el camino de siempre (por app), sin esconderse.
  const porDominio = pendientesDeDominios(root, est);
  let archivos = Object.entries(est.codigo);
  if (porDominio) archivos = archivos.filter(([rel]) => porDominio.sinDominio.has(rel));
  const ultima = new Map();                                   // app -> seq de su ultima edicion de codigo
  for (const [rel, seq] of archivos) { const app = appDe(root, rel); ultima.set(app, Math.max(ultima.get(app) || 0, Number(seq) || 0)); }
  if (!ultima.size && !(porDominio && porDominio.pendientes.length)) return null;
  const lista = appsRepo(root);
  const pendientes = porDominio ? [...porDominio.pendientes] : [];
  for (const [app, seq] of ultima) {
    const a = app === '.' ? null : lista.find((x) => x.id === app);
    if (app !== '.' && !(a && a.ruta)) continue;
    if (!tieneTest(root, a ? a.ruta : '.')) continue;          // sin script de tests: nada que pedir
    const run = ejecucionDe(est, app, seq);
    const estado = !run || run.seq < seq ? 'sin ejecutar desde la última edición' : (!run.verde ? 'en rojo' : null);
    // Sin dominio que lo acote, NUNCA se ordena la suite completa (#237): solo se exige arreglar un rojo ya visto y se
    // relanza lo afectado. «Sin ejecutar» no bloquea: la suite completa la corren CI y /faro:publicar.
    if (estado === 'en rojo') pendientes.push({ nombre: a ? `la app ${a.id}` : 'el repo', estado, orden: ORDEN_AFECTADOS, firma: `${app}:${seq}:${run.seq}` });
  }
  if (!pendientes.length) return null;
  const firma = sha(pendientes.map((p) => p.firma).join('|'), 16);
  const veces = est.fallosStop[firma] || 0;
  est.fallosStop[firma] = veces + 1;
  guardarEstado(root, sesion, est);
  if (veces > cfg.repeticiones) return null;                   // ya se aviso al humano: no repetir
  if (veces === cfg.repeticiones) {
    return { humano: `TDD: ${pendientes.map((p) => p.nombre).join(', ')} sigue sin tests en verde tras ${veces} avisos al agente; revísalo tú (${pendientes.map((p) => p.orden).join(' · ')}).` };
  }
  return { bloquear: `TDD: antes de terminar, deja en verde los tests del código que has tocado (arregla el código, no el test):\n${pendientes.map((p) => `- ${p.nombre}: ${p.estado} → ejecuta \`${p.orden}\``).join('\n')}` };
}

// ---------- tdd-revisar ----------

const RE_ASERCION = /\bexpect\s*\(|\bassert\w*\s*[.(]|\bassert\s+\S|\.should\b|\bt\.(is|not|deepEqual|true|false|throws|equal|ok|snapshot|like)\s*\(|\bself\.assert\w+\s*\(|\bpytest\.raises\b|\bsinon\.assert\b/;
const REGLAS_DESACTIVAR = [
  [/\b(describe|it|test|context|suite)\.skip\s*\(/, '.skip añadido'],
  [/\b(describe|it|test|context|suite)\.only\s*\(/, '.only añadido (el resto de la suite deja de correr)'],
  [/(^|[^\w.])x(it|describe|test)\s*\(/, 'xit/xdescribe añadido'],
  [/(^|[^\w.])f(it|describe)\s*\(/, 'fit/fdescribe añadido (el resto de la suite deja de correr)'],
  [/\b(it|test)\.todo\s*\(/, '.todo añadido'],
  [/\{\s*(skip|todo)\s*:\s*(true|['"`])/, '{ skip: true } añadido'],
  [/@pytest\.mark\.skip|\bpytest\.skip\s*\(|@unittest\.skip/, 'skip de pytest/unittest añadido'],
  [/\bt\.skip\s*\(/, 't.skip() añadido'],
];
const RE_MOCK = /\b(?:vi|jest)\.(?:mock|doMock)\s*\(\s*['"`]([^'"`]+)['"`]|\bmock\.module\s*\(\s*['"`]([^'"`]+)['"`]|\bpatch\s*\(\s*['"]([\w.]+)['"]/g;
// Inicio de un test: it/test con modificador (.only, .skip, .each(...)...) o prefijo x/f; def test_ en Python.
const RE_BLOQUE = /^[ \t]*(x|f)?(?:it|test)(\.\w+(?:\([^)]*\))?)?\s*\(\s*(['"`])(.*?)\3|^[ \t]*def\s+(test_\w+)/gm;

const gitOut = (root, args) => {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
};
function ramaBase(root) {
  return ['origin/develop', 'develop'].find((r) => gitOut(root, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`]) !== null) || 'HEAD';
}

// Umbrales y expect RELAJADOS (#178): la misma linea (numeros aparte) con el numero aflojado, o la misma
// asercion con un matcher mas debil sobre el mismo sujeto. Apretar un umbral no cuenta.
const RE_MAX = /<=?|toBeLessThan(?:OrEqual)?|toBeAtMost|timeout|retries|maxDuration|delay|tolerance|epsilon|\bmax\w*/i;
const RE_MIN = />=?|toBeGreaterThan(?:OrEqual)?|toBeAtLeast|coverage|thresholds?|lines|branches|functions|statements|\bmin\w*/i;
const RE_FUERTE = /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveLength|toContain|toMatch)\(|\bassert\.(?:strictEqual|deepStrictEqual|deepEqual|equal|match|throws)\(/;
const RE_DEBIL = /\.(?:toBeTruthy|toBeFalsy|toBeDefined)\(\)|\.not\.(?:toBeNull|toBeUndefined)\(\)|expect\.anything\(|\bassert\.ok\(|\bassert\(/;
const sujetoAsercion = (l) => { const m = /expect\((.+?)\)\s*\./.exec(l) || /\bassert(?:\.\w+)?\(\s*([^,)]+)/.exec(l); return m ? m[1].trim() : null; };
const RE_NUM = /-?\d+(?:\.\d+)?/g;
function relajados(quitadas, anadidas) {
  const out = [];
  const usadas = new Set();
  const nums = (l) => (l.match(RE_NUM) || []).map(Number);
  const clave = (l) => l.replace(/=>/g, '').replace(RE_NUM, '#').replace(/\s+/g, ' ').trim();
  for (const q of quitadas) {
    const nq = nums(q);
    if (!nq.length) continue;
    const k = clave(q);
    const i = anadidas.findIndex((a, j) => !usadas.has(j) && a !== q && clave(a) === k && nums(a).length === nq.length);
    if (i < 0) continue;
    usadas.add(i);
    const na = nums(anadidas[i]);
    const ctx = q.replace(/=>/g, '');
    const max = RE_MAX.test(ctx); const min = RE_MIN.test(ctx);
    if (max === min) continue;                                  // ambiguo: no se adivina
    if (nq.some((n, j) => (max ? na[j] > n : na[j] < n))) out.push({ regla: 'umbral relajado', detalle: `${q.trim()}  →  ${anadidas[i].trim()}` });
  }
  for (const q of quitadas) {
    if (!RE_FUERTE.test(q)) continue;
    const s = sujetoAsercion(q);
    if (!s) continue;
    const i = anadidas.findIndex((a, j) => !usadas.has(j) && RE_DEBIL.test(a) && !RE_FUERTE.test(a) && sujetoAsercion(a) === s);
    if (i < 0) continue;
    usadas.add(i);
    out.push({ regla: 'expect debilitado', detalle: `${q.trim()}  →  ${anadidas[i].trim()}` });
  }
  return out;
}

/** Hallazgos de tests debilitados en el diff contra 'base' (incluye lo sin commitear). */
function revisar(root, base, cfg) {
  const c = cfg || config(root);
  const b = base || ramaBase(root);
  const cambiados = (gitOut(root, ['diff', '--name-only', b]) || '').split('\n').filter(Boolean);
  const nuevos = (gitOut(root, ['ls-files', '--others', '--exclude-standard']) || '').split('\n').filter(Boolean);
  const hallazgos = [];
  for (const rel of [...new Set([...cambiados, ...nuevos])]) {
    if (clasificar(root, rel, c) !== 'test') continue;
    const actual = leer(path.join(root, rel));
    if (actual == null) continue;                              // borrado entero: lo ve quien revisa el diff
    const anadidas = []; const quitadas = []; const lineasNuevas = new Set();
    if (nuevos.includes(rel) && !cambiados.includes(rel)) actual.split('\n').forEach((l, i) => { anadidas.push(l); lineasNuevas.add(i + 1); });
    else {
      let n = 0;
      for (const l of (gitOut(root, ['diff', '-U0', b, '--', rel]) || '').split('\n')) {
        const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
        if (h) { n = Number(h[1]); continue; }
        if (l.startsWith('+++') || l.startsWith('---')) continue;
        if (l.startsWith('+')) { anadidas.push(l.slice(1)); lineasNuevas.add(n); n++; } else if (l.startsWith('-')) quitadas.push(l.slice(1));
      }
    }
    const add = (regla, detalle) => hallazgos.push({ fichero: rel, regla, detalle });
    const asQ = quitadas.filter((l) => RE_ASERCION.test(l)).length;
    const asA = anadidas.filter((l) => RE_ASERCION.test(l)).length;
    if (asQ > asA) add('aserciones eliminadas', `${asQ} eliminada(s) y ${asA} añadida(s)`);
    for (const h of relajados(quitadas, anadidas)) add(h.regla, h.detalle);
    for (const l of anadidas) for (const [re, regla] of REGLAS_DESACTIVAR) if (re.test(l)) add(regla, l.trim());
    const base = baseModulo(rel);
    for (const l of anadidas) for (const m of l.matchAll(RE_MOCK)) {
      const objetivo = m[1] || m[2] || m[3];
      const nombre = m[3] ? objetivo.split('.').slice(-2, -1)[0] || objetivo : baseModulo(objetivo);
      if (nombre && nombre.toLowerCase() === base) add('mock del propio módulo bajo prueba', `${objetivo} — el test deja de probar el código real`);
    }
    // Tests (bloques it/test/def test_) tocados en el diff que no contienen ninguna asercion.
    // Los desactivados (skip/todo/x) delimitan pero no se reportan: ya tienen su propia regla.
    const bloques = [...actual.matchAll(RE_BLOQUE)].map((m) => ({ nombre: m[4] || m[5], off: m[1] === 'x' || /^\.(skip|todo)/.test(m[2] || ''), ini: actual.slice(0, m.index).split('\n').length, idx: m.index }));
    bloques.forEach((bl, i) => {
      const fin = i + 1 < bloques.length ? bloques[i + 1].idx : actual.length;
      const texto = actual.slice(bl.idx, fin);
      const finLinea = bl.ini + texto.split('\n').length - 1;
      const tocado = [...lineasNuevas].some((n) => n >= bl.ini && n <= finLinea);
      if (tocado && !bl.off && !RE_ASERCION.test(texto)) add('test sin aserciones', `'${bl.nombre}'`);
    });
  }
  return { base: b, hallazgos };
}

// ---------- CLI (lo despacha harness.js) ----------

function leerStdin(cb) {
  let entrada = '';
  process.stdin.on('data', (d) => { entrada += d; });
  process.stdin.on('error', () => cb(null));
  process.stdin.on('end', () => { let p = null; try { p = JSON.parse(entrada); } catch { /* sin payload: silencio */ } cb(p); });
}
const responder = (res, evento) => {
  if (!res) return;
  if (res.bloquear) { process.stderr.write(`${res.bloquear}\n`); process.exitCode = 2; return; }
  if (res.humano) { process.stdout.write(`${JSON.stringify({ systemMessage: res.humano })}\n`); return; }
  if (res.contexto) {
    const out = { hookSpecificOutput: { hookEventName: evento, additionalContext: res.contexto } };
    if (evento === 'PostToolUse') out.systemMessage = res.contexto;   // test cambiado para pasar: lo sabe tambien el humano
    process.stdout.write(`${JSON.stringify(out)}\n`);
  }
};

function cli(cmd, root, { schema, argv = [], payload } = {}) {
  const cfg = config(root, { schema });
  if (cmd === 'tdd-revisar') {
    const json = argv.includes('--json');
    const { base, hallazgos } = revisar(root, argv.find((a) => !a.startsWith('--')), cfg);
    if (json) process.stdout.write(`${JSON.stringify({ base, hallazgos }, null, 2)}\n`);
    else if (!hallazgos.length) process.stdout.write(`Sin tests debilitados en el diff contra ${base}.\n`);
    else process.stdout.write(`TESTS DEBILITADOS (diff contra ${base}):\n${hallazgos.map((h) => `- ${h.fichero}: ${h.regla} — ${h.detalle}`).join('\n')}\n`);
    process.exitCode = hallazgos.length ? 1 : 0;
    return;
  }
  const fn = { 'tdd-pre': pre, 'tdd-post': post, 'tdd-stop': stop }[cmd];
  if (!fn || !cfg.activo) return;
  const atender = (p) => {
    if (!p || !Object.keys(p).length) return;
    let res = null;
    try { res = fn(root, p, cfg); } catch { res = null; }   // un fallo del motor nunca bloquea el turno
    responder(res, cmd === 'tdd-pre' ? 'PreToolUse' : 'PostToolUse');
  };
  // El harness ya puede haber leido stdin (raiz por fichero, #136): se reutiliza ese payload.
  if (payload !== undefined) atender(payload); else leerStdin(atender);
}

module.exports = {
  config, validarConfig, contrato, clasificar, baseModulo, globRe, esComandoTests, resultado,
  testsDe, testsCitados, rutaEstado, leerEstado, pre, post, stop, revisar, cli,
};
