// lib/ci-fallos.js — `harness.js ci fallos`: lee el CI del PR/MR de la rama actual, clasifica el fallo y,
// si el CI no puede correr (cuota o atascado), NO insiste: red minima local y anotacion en
// faro/.cache/ci-pendientes.jsonl. Solo lectura en la forja (nada de re-run, cancel ni comentarios).
// El CI de tests no usa credenciales: aqui solo se lee con la sesion de `gh` / `glab` del usuario.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RE_FACTURACION } = require('./estado-ci.js');

const MAX_LINEAS = 40;
const ESPERA_MIN = 15;
const SONDEO_MS = 60000;
const FICHERO_PENDIENTES = path.join('faro', '.cache', 'ci-pendientes.jsonl');
const RE_INFRA = /runner_system_failure|stuck_or_timeout_failure|runner.{0,40}(time ?out|timed out|lost)|received a shutdown signal/i;
const RE_FALLO = /^\s*(not ok\b|✖|FAIL\b)/;
const RE_ERROR = /(error|expected|assert|received|actual)/i;
const RE_FICHERO = /([\w./\\-]+\.(?:m?[jt]sx?|py|go|rs|rb|java|php))(?::\d+(?::\d+)?)?/;
const recortar = (s, n = 200) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
const sinMarcas = (l) => String(l).replace(/^\S+\t[^\t]*\t(?:\d{4}-\d\d-\d\dT\S+\s)?/, '');

/** Extrae los tests que fallan de un log; nunca devuelve el log completo (maximo 40 lineas en total). */
function extraerFallos(log) {
  const lineas = String(log || '').split(/\r?\n/).map(sinMarcas);
  const fallos = []; let usadas = 0;
  for (let i = 0; i < lineas.length && usadas < MAX_LINEAS; i++) {
    if (!RE_FALLO.test(lineas[i])) continue;
    const test = recortar(lineas[i].replace(/^\s*(not ok\s*\d*\s*-?|✖|FAIL)\s*/, '')) || recortar(lineas[i]);
    let error = ''; let fichero = (RE_FICHERO.exec(lineas[i]) || [])[1] || '';
    for (let j = i + 1; j < Math.min(i + 8, lineas.length); j++) {
      if (RE_FALLO.test(lineas[j])) break;
      if (!error && RE_ERROR.test(lineas[j])) error = recortar(lineas[j]);
      if (!fichero) fichero = (RE_FICHERO.exec(lineas[j]) || [])[1] || '';
    }
    fallos.push({ test, error, fichero });
    usadas += 1 + (error ? 1 : 0);
  }
  return fallos;
}

const RE_ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const RE_CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** Quita codigos ANSI y caracteres de control (salvo \n y \t): lo que sale del log nunca llega crudo a la terminal. */
const limpiar = (t) => String(t == null ? '' : t).replace(/\r/g, '').replace(RE_ANSI, '').replace(RE_CTRL, '');

const ACTIVOS = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending', 'running', 'manual', 'created', 'preparing', 'scheduled', 'waiting_for_resource']);
const RE_SHA = /^[0-9a-f]{7,40}$/;
const rutaRamaValida = (r) => typeof r === 'string' && r.length > 0 && r.length <= 250 && !r.startsWith('-') && !/[\u0000-\u001f\u007f\s]/.test(r);

/**
 * Funcion pura. run: { status?, conclusion?, conclusiones?: string[], stuck?, esperaAgotada?, anotaciones?: string[],
 * fallidos?: [{failure_reason}] }. cuota e infra se deciden por conclusion, razon y anotaciones; el log solo cuenta
 * si NO hay lineas de test fallidas (un test llamado "billing" que falla es un fallo de test).
 * -> { estado: 'verde'|'test'|'cuota'|'pendiente'|'infra'|'en-curso', ... }
 */
function clasificar(run, logCrudo = '') {
  const r = run || {};
  const log = limpiar(logCrudo);
  const conc = r.conclusiones || (r.conclusion ? [r.conclusion] : []);
  const razones = (r.fallidos || []).map((j) => j.failure_reason);
  const anot = (r.anotaciones || []).map(limpiar);
  const CUOTA = { estado: 'cuota', motivo: 'la forja no tiene minutos o credito de CI (no es un fallo del codigo)' };
  if (conc.includes('startup_failure') || razones.includes('ci_quota_exceeded') || anot.some((a) => RE_FACTURACION.test(a))) return CUOTA;
  const falla = conc.includes('failure');
  if (!falla) {
    if (conc.includes('runner_system_failure') || conc.includes('timed_out')) return { estado: 'infra', motivo: 'fallo del runner o timeout de infraestructura (no es un fallo del codigo)' };
    if (conc.includes('cancelled')) return { estado: 'infra', motivo: 'cancelado: el CI se cancelo, no es un fallo del codigo' };
  }
  if (r.stuck) return { estado: 'pendiente', motivo: 'el CI esta atascado sin runner' };
  if (ACTIVOS.has(r.status)) return r.esperaAgotada ? { estado: 'pendiente', motivo: 'el CI sigue en curso tras la espera' } : { estado: 'en-curso' };
  if (conc.length && conc.every((c) => c === 'success' || c === 'skipped' || c === 'neutral')) return { estado: 'verde' };
  const fallos = extraerFallos(log);
  if (fallos.length) return { estado: 'test', test: fallos[0].test, error: fallos[0].error, fichero: fallos[0].fichero, fallos };
  if (RE_FACTURACION.test(log)) return CUOTA;
  if (razones.includes('runner_system_failure') || razones.includes('stuck_or_timeout_failure') || RE_INFRA.test(log)) return { estado: 'infra', motivo: 'fallo del runner o timeout de infraestructura (no es un fallo del codigo)' };
  return { estado: 'test', test: '', error: 'el CI fallo y el log no muestra tests concretos', fichero: '', fallos: [] };
}

// ---- Lectura de detalle (solo lo que el contrato de forja no da: conclusion por run y log de los jobs fallidos) ----

/** Lanza gh/glab sin shell. -> { ok, out } | { ok:false, falta:true } cuando la CLI no existe. */
function ejecutar(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { ok: false, falta: r.error.code === 'ENOENT', out: '' };
  return { ok: r.status === 0, out: r.stdout || '', err: r.stderr || '' };
}
const json = (r) => { try { return JSON.parse(r.out); } catch { return null; } };
const LOGIN = { github: '! gh auth login', gitlab: '! glab auth login' };
const CLI = { github: 'gh', gitlab: 'glab' };
const ultimas = (t, n) => String(t).split(/\r?\n/).slice(-n).join('\n');

/** GitHub: todos los runs del commit; log solo de los que no terminaron bien. -> { run, log } */
function detalleGithub(sha, ex) {
  const l = json(ex('gh', ['run', 'list', '--commit', sha, '--json', 'databaseId,status,conclusion', '--limit', '30']));
  if (!Array.isArray(l) || !l.length) return { run: {}, log: '' };
  const malos = l.filter((x) => x.status === 'completed' && x.conclusion && !['success', 'skipped', 'neutral'].includes(x.conclusion));
  const log = malos.filter((x) => x.conclusion === 'failure').slice(0, 3).map((x) => ex('gh', ['run', 'view', String(x.databaseId), '--log-failed']).out).map((t) => ultimas(t, 3000)).join('\n');
  return { run: { conclusiones: malos.map((x) => x.conclusion) }, log };
}
/** GitLab: jobs fallidos del ultimo pipeline del commit (razon + traza). */
function detalleGitlab(sha, ex) {
  const ps = json(ex('glab', ['api', `projects/:id/pipelines?sha=${sha}&order_by=id&sort=desc&per_page=1`]));
  if (!Array.isArray(ps) || !ps[0]) return { run: {}, log: '' };
  const jobs = json(ex('glab', ['api', `projects/:id/pipelines/${ps[0].id}/jobs?scope[]=failed&per_page=100`])) || [];
  const log = jobs.slice(0, 5).map((j) => ultimas(ex('glab', ['api', `projects/:id/jobs/${j.id}/trace`]).out, 1500)).join('\n');
  return { run: { conclusion: 'failure', fallidos: jobs.map((j) => ({ name: j.name, failure_reason: j.failure_reason })) }, log };
}
const detalle = (forja, sha, ex) => (forja === 'gitlab' ? detalleGitlab(sha, ex) : detalleGithub(sha, ex));

/** Numero del PR/MR de la rama (solo informativo). Rama validada y tras `--`. */
function numeroPr(forja, rama, ex) {
  if (!rutaRamaValida(rama)) return null;
  if (forja === 'gitlab') { const m = json(ex('glab', ['api', `projects/:id/merge_requests?source_branch=${encodeURIComponent(rama)}&state=opened`])); return Array.isArray(m) && m[0] ? m[0].iid : null; }
  const p = json(ex('gh', ['pr', 'view', '--json', 'number', '--', rama]));
  return p ? p.number : null;
}

// ---- Fichero de pendientes ----
function leerPendientes(root) {
  try {
    return fs.readFileSync(path.join(root, FICHERO_PENDIENTES), 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function escribirPendientes(root, entradas) {
  const f = path.join(root, FICHERO_PENDIENTES);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, entradas.map((e) => JSON.stringify(e)).join('\n') + (entradas.length ? '\n' : ''));
}

/** Red minima: `npm run test:afectados` si el package.json lo declara; si no, `npm test`. */
function comandoRedMinima(root) {
  try {
    const sc = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {};
    if (sc['test:afectados']) return { cmd: 'npm', args: ['run', 'test:afectados'] };
    if (sc.test) return { cmd: 'npm', args: ['test'] };
  } catch { /* sin package.json */ }
  return null;
}
function redMinimaPorDefecto(root) {
  const c = comandoRedMinima(root);
  if (!c) return { ok: true, omitida: true };
  const X = require('./ejecutar-pesado.js');
  const l = X.lanzador(c.cmd, c.args);
  if (l.error) return { ok: false, motivo: l.error };
  const r = spawnSync(l.file, l.argv, { cwd: root, stdio: 'inherit', windowsHide: true });
  return { ok: r.status === 0, comando: `${c.cmd} ${c.args.join(' ')}` };
}
const ramaExistePorDefecto = (root) => (rama) => ['refs/heads/', 'refs/remotes/origin/'].some((p) => spawnSync('git', ['rev-parse', '--verify', '--quiet', p + rama], { cwd: root, windowsHide: true }).status === 0);

/** Pendientes validos: rama y sha bien formados, una entrada por rama (la ultima). */
function pendientesValidos(root) {
  const porRama = new Map();
  for (const e of leerPendientes(root)) if (rutaRamaValida(e.rama) && RE_SHA.test(String(e.sha))) { porRama.delete(e.rama); porRama.set(e.rama, e); }
  return [...porRama.values()];
}

/**
 * Estado del CI del commit (contrato de forja) esperando si esta en curso. Reloj y sleep inyectables.
 * estadoCommit(sha) -> { ok, estado, fallidos } | { ok:false, sinToken } | { ok:false, msg }
 */
async function consultar({ sha, esperarMin = ESPERA_MIN, estadoCommit, ahora, dormir }) {
  const t0 = ahora();
  for (;;) {
    const r = await estadoCommit(sha);
    if (!r || r.sinToken || !r.ok) return { fallo: r || { ok: false, msg: 'sin respuesta de la forja' } };
    const agotada = (ahora() - t0) >= esperarMin * 60000;
    if (r.estado !== 'pendiente' || agotada) return { r, agotada };
    await dormir(SONDEO_MS);
  }
}

/**
 * Orquestacion. deps: { root, forja, rama, sha, args, estadoCommit, ex?, ahora?, dormir?, redMinima?, ramaExiste?, salida? }
 * -> { codigo, estado }
 */
async function fallos(deps) {
  const root = deps.root;
  const emitidas = [];
  const out = (l) => { for (const x of limpiar(l).split('\n')) { if (emitidas.length < MAX_LINEAS) { emitidas.push(x); (deps.salida || console.log)(x); } } };
  const ex = deps.ex || ((c, a) => ejecutar(c, a, root));
  const ahora = deps.ahora || Date.now;
  const dormir = deps.dormir || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const redMinima = deps.redMinima || (() => redMinimaPorDefecto(root));
  const ramaExiste = deps.ramaExiste || ramaExistePorDefecto(root);
  const args = deps.args || [];
  const forja = deps.forja;
  if (!CLI[forja] || typeof deps.estadoCommit !== 'function') { out(`ci fallos: forja '${forja}' sin soporte (GitHub o GitLab).`); return { codigo: 0, estado: 'sin-acceso' }; }
  const espArg = args.find((a) => a.startsWith('--esperar='));
  const esperarMin = espArg && Number(espArg.split('=')[1]) >= 0 ? Number(espArg.split('=')[1]) : ESPERA_MIN;
  const sinSesion = () => { out(`ci fallos: sin sesion en la forja. Inicia sesion con: ${LOGIN[forja]}`); return { codigo: 0, estado: 'sin-acceso' }; };
  const errorForja = (f) => { out(`ci fallos: no pude leer el CI de la forja (${limpiar((f && f.msg) || 'error de red o de la API')}). No es un problema de sesion.`); return { codigo: 1, estado: 'error' }; };

  if (args.includes('--pendientes')) {
    const entradas = pendientesValidos(root);
    if (!entradas.length) { escribirPendientes(root, []); out('ci fallos: no hay CI pendientes de validar.'); return { codigo: 0, estado: 'sin-pendientes' }; }
    const quedan = [];
    for (const e of entradas) {
      if (!ramaExiste(e.rama)) { out(`✓ ${e.rama}: la rama ya no existe, se quita de pendientes.`); continue; }
      const c = await consultar({ sha: e.sha, esperarMin: 0, estadoCommit: deps.estadoCommit, ahora, dormir });
      if (c.fallo) { if (c.fallo.sinToken) return sinSesion(); quedan.push(e); out(`? ${e.rama}: no pude consultar (${limpiar(c.fallo.msg || 'error')}).`); continue; }
      if (c.r.estado === 'verde') { out(`✓ ${e.rama}: CI en verde en ${e.sha.slice(0, 7)}, se quita de pendientes.`); continue; }
      quedan.push(e);
      out(`… ${e.rama} (${e.motivo}, ${e.fecha}): ahora ${c.r.estado}.`);
    }
    escribirPendientes(root, quedan);
    return { codigo: 0, estado: 'pendientes', quedan: quedan.length };
  }

  const sha = String(deps.sha || '');
  if (!RE_SHA.test(sha)) { out('ci fallos: no pude determinar el commit HEAD.'); return { codigo: 1, estado: 'error' }; }
  const c = await consultar({ sha, esperarMin, estadoCommit: deps.estadoCommit, ahora, dormir });
  if (c.fallo) return c.fallo.sinToken ? sinSesion() : errorForja(c.fallo);
  const { r, agotada } = c;
  if (r.estado === 'sin-ci') { out(`ci fallos: el commit ${sha.slice(0, 7)} no tiene ejecuciones de CI en la forja (no es verde).`); return { codigo: 0, estado: 'sin-ci' }; }
  if (r.estado === 'verde') { out('ci fallos: CI en verde.'); return { codigo: 0, estado: 'verde' }; }

  let cl;
  if (r.estado === 'sin-cuota') cl = clasificar({ conclusion: 'startup_failure' }, '');
  else if (r.estado === 'pendiente') cl = clasificar({ status: 'in_progress', esperaAgotada: agotada }, '');
  else { const d = detalle(forja, sha, ex); cl = clasificar({ conclusion: 'failure', ...d.run }, d.log); if (cl.estado === 'test' && !cl.fallos.length && (r.fallidos || []).length) cl.error = `fallan: ${r.fallidos.join(', ')}`; }

  if (cl.estado === 'test') {
    const l = [`ci fallos: fallan tests del codigo.${cl.test ? `\n  test: ${cl.test}` : ''}${cl.error ? `\n  error: ${cl.error}` : ''}${cl.fichero ? `\n  fichero: ${cl.fichero}` : ''}`];
    for (const f of (cl.fallos || []).slice(1)) l.push(`  - ${f.test}${f.fichero ? ` (${f.fichero})` : ''}`);
    out(l.join('\n'));
    return { codigo: 1, estado: 'test', clasificacion: cl };
  }
  if (cl.estado === 'infra') { out(`ci fallos: ${cl.motivo}. No reintento desde aqui: relanza el job en la forja si procede.`); return { codigo: 1, estado: 'infra' }; }
  if (cl.estado !== 'cuota' && cl.estado !== 'pendiente') { out('ci fallos: estado de CI no reconocido.'); return { codigo: 1, estado: 'error' }; }

  // cuota | pendiente: no se insiste; red minima local y anotacion.
  out(`ci fallos: ${cl.motivo}. No reintento.`);
  const red = redMinima();
  const entradas = pendientesValidos(root).filter((e) => e.rama !== deps.rama);
  if (rutaRamaValida(deps.rama)) entradas.push({ rama: deps.rama, sha, pr: numeroPr(forja, deps.rama, ex), motivo: cl.estado, fecha: new Date(ahora()).toISOString() });
  escribirPendientes(root, entradas);
  if (red && red.omitida) out('sin tests locales que correr: nada se ha validado en local.');
  if (red && red.ok === false) { out(`ci fallos: la red minima local ha fallado${red.comando ? ` (${red.comando})` : ''}: corrige antes de seguir. Queda pendiente de validar en CI.`); return { codigo: 1, estado: cl.estado }; }
  out('pendiente de validar en CI');
  return { codigo: 0, estado: cl.estado };
}

module.exports = { clasificar, limpiar, rutaRamaValida, pendientesValidos, extraerFallos, fallos, consultar, leerPendientes, escribirPendientes, comandoRedMinima, FICHERO_PENDIENTES, ESPERA_MIN, SONDEO_MS, MAX_LINEAS };
