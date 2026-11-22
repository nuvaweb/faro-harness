// lib/ci-fallos.js — `harness.js ci fallos`: lee el CI del PR/MR de la rama actual, clasifica el fallo y,
// si el CI no puede correr (cuota o atascado), NO insiste: red minima local y anotacion en
// faro/estado/ci-pendientes.jsonl. Solo lectura en la forja (nada de re-run, cancel ni comentarios).
// El CI de tests no usa credenciales: aqui solo se lee con la sesion de `gh` / `glab` del usuario.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RE_FACTURACION } = require('./estado-ci.js');

const MAX_LINEAS = 40;
const ESPERA_MIN = 15;
const SONDEO_MS = 60000;
const FICHERO_PENDIENTES = path.join('faro', 'estado', 'ci-pendientes.jsonl');
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

/**
 * Funcion pura. run: { status, conclusion, stuck?, esperaAgotada?, anotaciones?: string[], fallidos?: [{failure_reason}] }.
 * -> { estado: 'verde'|'test'|'cuota'|'pendiente'|'infra'|'en-curso', ... }
 */
function clasificar(run, log = '') {
  const r = run || {};
  const texto = [log, ...(r.anotaciones || [])].join('\n');
  const razones = (r.fallidos || []).map((j) => j.failure_reason);
  if (r.conclusion === 'startup_failure' || razones.includes('ci_quota_exceeded') || RE_FACTURACION.test(texto)) {
    return { estado: 'cuota', motivo: 'la forja no tiene minutos o credito de CI (no es un fallo del codigo)' };
  }
  if (r.conclusion === 'runner_system_failure' || razones.includes('runner_system_failure') || razones.includes('stuck_or_timeout_failure') || RE_INFRA.test(texto)) {
    return { estado: 'infra', motivo: 'fallo del runner o timeout de infraestructura (no es un fallo del codigo)' };
  }
  if (r.stuck) return { estado: 'pendiente', motivo: 'el CI esta atascado sin runner' };
  if (r.status === 'queued' || r.status === 'in_progress' || r.status === 'pending' || r.status === 'running') {
    return r.esperaAgotada ? { estado: 'pendiente', motivo: 'el CI sigue en curso tras la espera' } : { estado: 'en-curso' };
  }
  if (r.conclusion === 'success') return { estado: 'verde' };
  const fallos = extraerFallos(log);
  if (fallos.length) return { estado: 'test', test: fallos[0].test, error: fallos[0].error, fichero: fallos[0].fichero, fallos };
  return { estado: 'test', test: '', error: 'el CI fallo y el log no muestra tests concretos', fichero: '', fallos: [] };
}

// ---- Adaptadores de lectura (solo lectura; sin shell; la salida se inyecta en los tests) ----

/** Lanza gh/glab sin shell. -> { ok, out } | { ok:false, falta:true } cuando la CLI no existe. */
function ejecutar(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { ok: false, falta: r.error.code === 'ENOENT', out: '' };
  return { ok: r.status === 0, out: r.stdout || '', err: r.stderr || '' };
}
const json = (r) => { try { return JSON.parse(r.out); } catch { return null; } };
const LOGIN = { github: '! gh auth login', gitlab: '! glab auth login' };
const CLI = { github: 'gh', gitlab: 'glab' };

/** GitHub: gh run list/view. -> { run, log, sha, pr } | { sinAcceso } | { sinRun } */
function leerGithub(rama, ex) {
  const l = ex('gh', ['run', 'list', '--branch', rama, '--limit', '1', '--json', 'databaseId,status,conclusion,headSha']);
  if (!l.ok) return { sinAcceso: true };
  const runs = json(l);
  if (!Array.isArray(runs) || !runs.length) return { sinRun: true };
  const r0 = runs[0];
  const v = json(ex('gh', ['run', 'view', String(r0.databaseId), '--json', 'status,conclusion,jobs'])) || {};
  const fallidos = (v.jobs || []).filter((j) => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped');
  const run = { status: r0.status, conclusion: r0.conclusion || v.conclusion, fallidos: [], anotaciones: [] };
  let log = '';
  if (run.status === 'completed' && run.conclusion !== 'success' && fallidos.length) {
    const g = ex('gh', ['run', 'view', String(r0.databaseId), '--log-failed']);
    log = g.out.split(/\r?\n/).slice(-3000).join('\n');
  }
  const pr = json(ex('gh', ['pr', 'view', rama, '--json', 'number']));
  return { run, log, sha: r0.headSha, pr: pr ? pr.number : null };
}

/** GitLab: glab api sobre el pipeline mas reciente de la rama. */
function leerGitlab(rama, ex) {
  const l = ex('glab', ['api', `projects/:id/pipelines?ref=${encodeURIComponent(rama)}&per_page=1`]);
  if (!l.ok) return { sinAcceso: true };
  const ps = json(l);
  if (!Array.isArray(ps) || !ps.length) return { sinRun: true };
  const p = ps[0];
  const jobs = json(ex('glab', ['api', `projects/:id/pipelines/${p.id}/jobs?per_page=100`])) || [];
  const enCurso = ['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled'].includes(p.status);
  const fallidos = jobs.filter((j) => j.status === 'failed');
  const run = {
    status: enCurso ? (p.status === 'running' ? 'in_progress' : 'queued') : 'completed',
    conclusion: p.status === 'success' ? 'success' : (enCurso ? null : 'failure'),
    stuck: jobs.some((j) => j.stuck && j.status === 'pending'),
    fallidos: fallidos.map((j) => ({ name: j.name, failure_reason: j.failure_reason })),
    anotaciones: [],
  };
  let log = '';
  if (run.status === 'completed' && run.conclusion !== 'success') {
    log = fallidos.slice(0, 5).map((j) => ex('glab', ['api', `projects/:id/jobs/${j.id}/trace`]).out.split(/\r?\n/).slice(-1500).join('\n')).join('\n');
  }
  const mr = json(ex('glab', ['api', `projects/:id/merge_requests?source_branch=${encodeURIComponent(rama)}&state=opened`]));
  return { run, log, sha: p.sha, pr: Array.isArray(mr) && mr[0] ? mr[0].iid : null };
}

const leerForja = (forja, rama, ex) => (forja === 'gitlab' ? leerGitlab(rama, ex) : leerGithub(rama, ex));

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

/** Consulta la forja hasta que el CI termina o se agota la espera. Reloj y sleep inyectables. */
async function consultar({ forja, rama, esperarMin = ESPERA_MIN, ex, ahora, dormir }) {
  const t0 = ahora();
  for (;;) {
    const lec = leerForja(forja, rama, ex);
    if (lec.sinAcceso || lec.sinRun) return lec;
    lec.run.esperaAgotada = (ahora() - t0) >= esperarMin * 60000;
    const c = clasificar(lec.run, lec.log);
    if (c.estado !== 'en-curso') return { ...lec, clasificacion: c };
    await dormir(SONDEO_MS);
  }
}

/**
 * Orquestacion. deps: { root, forja, rama, sha?, args, ex?, ahora?, dormir?, redMinima?, salida? }
 * -> { codigo, estado }
 */
async function fallos(deps) {
  const root = deps.root;
  const out = deps.salida || ((l) => console.log(l));
  const ex = deps.ex || ((c, a) => ejecutar(c, a, root));
  const ahora = deps.ahora || Date.now;
  const dormir = deps.dormir || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const redMinima = deps.redMinima || (() => redMinimaPorDefecto(root));
  const args = deps.args || [];
  const forja = deps.forja;
  const cli = CLI[forja];
  if (!cli) { out(`ci fallos: forja '${forja}' sin soporte (GitHub o GitLab).`); return { codigo: 0, estado: 'sin-acceso' }; }
  const sinAcceso = () => { out(`ci fallos: sin acceso a ${cli} (no esta instalada o no hay sesion). Inicia sesion con: ${LOGIN[forja]}`); return { codigo: 0, estado: 'sin-acceso' }; };
  const espArg = args.find((a) => a.startsWith('--esperar='));
  const esperarMin = espArg && Number(espArg.split('=')[1]) >= 0 ? Number(espArg.split('=')[1]) : ESPERA_MIN;

  if (args.includes('--pendientes')) {
    const entradas = leerPendientes(root);
    if (!entradas.length) { out('ci fallos: no hay CI pendientes de validar.'); return { codigo: 0, estado: 'sin-pendientes' }; }
    const quedan = [];
    for (const e of entradas) {
      const r = await consultar({ forja, rama: e.rama, esperarMin: 0, ex, ahora, dormir });
      if (r.sinAcceso) return sinAcceso();
      const estado = r.clasificacion ? r.clasificacion.estado : 'sin-run';
      if (estado === 'verde' && (!e.sha || !r.sha || r.sha === e.sha)) { out(`✓ ${e.rama}: CI en verde, se quita de pendientes.`); continue; }
      quedan.push(e);
      out(`… ${e.rama} (${e.motivo}, ${e.fecha}): ahora ${estado}.`);
    }
    escribirPendientes(root, quedan);
    return { codigo: 0, estado: 'pendientes', quedan: quedan.length };
  }

  const r = await consultar({ forja, rama: deps.rama, esperarMin, ex, ahora, dormir });
  if (r.sinAcceso) return sinAcceso();
  if (r.sinRun) { out(`ci fallos: ${deps.rama} no tiene ejecuciones de CI en la forja.`); return { codigo: 0, estado: 'sin-ci' }; }
  const c = r.clasificacion;
  if (c.estado === 'verde') { out('ci fallos: CI en verde.'); return { codigo: 0, estado: 'verde' }; }
  if (c.estado === 'test') {
    out(`ci fallos: fallan tests del codigo.${c.test ? `\n  test: ${c.test}` : ''}${c.error ? `\n  error: ${c.error}` : ''}${c.fichero ? `\n  fichero: ${c.fichero}` : ''}`);
    for (const f of (c.fallos || []).slice(1, MAX_LINEAS)) out(`  - ${f.test}${f.fichero ? ` (${f.fichero})` : ''}`);
    return { codigo: 1, estado: 'test', clasificacion: c };
  }
  if (c.estado === 'infra') {
    out(`ci fallos: ${c.motivo}. No reintento desde aqui: relanza el job en la forja si procede.`);
    return { codigo: 1, estado: 'infra' };
  }
  // cuota | pendiente: no se insiste; red minima local y anotacion.
  out(`ci fallos: ${c.motivo}. No reintento.`);
  const red = redMinima();
  const entradas = leerPendientes(root).filter((e) => !(e.rama === deps.rama && e.sha === r.sha));
  entradas.push({ rama: deps.rama, sha: r.sha || deps.sha || null, pr: r.pr || null, motivo: c.estado, fecha: new Date(ahora()).toISOString() });
  escribirPendientes(root, entradas);
  if (red && red.ok === false) { out(`ci fallos: la red minima local ha fallado${red.comando ? ` (${red.comando})` : ''}: corrige antes de seguir. Queda pendiente de validar en CI.`); return { codigo: 1, estado: c.estado }; }
  out('pendiente de validar en CI');
  return { codigo: 0, estado: c.estado };
}

module.exports = { clasificar, extraerFallos, fallos, consultar, leerPendientes, escribirPendientes, comandoRedMinima, FICHERO_PENDIENTES, ESPERA_MIN, SONDEO_MS, MAX_LINEAS };
