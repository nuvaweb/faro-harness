// Gestion NATIVA de GitLab (0.20.0): hitos = fases, tiempo por tarea/hito, enlaces, modificadores de
// asignar-tarea y etiquetas con ambito. Se prueba EN PROCESO con la API simulada (fetch falso): asi
// cada comando se verifica de forma DETERMINISTA, llamada a llamada, sin red ni credencial real.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

// ---- API simulada: un enrutador metodo+ruta -> respuesta; registra cada llamada para poder afirmar sobre ella.
function apiFalsa(rutas) {
  const llamadas = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url).replace('https://gitlab.com/api/v4/', '');
    const metodo = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    llamadas.push({ metodo, ruta: u, body });
    for (const [re, fn] of rutas) {
      const m = u.match(re);
      if (m && (!fn.metodo || fn.metodo === metodo)) { const r = fn.resp(m, body, llamadas); return { ok: r.status < 400, status: r.status, json: async () => r.body }; }
    }
    return { ok: false, status: 404, json: async () => ({ message: '404 ' + u }) };
  };
  return llamadas;
}
const R = (re, resp, metodo) => [re, { resp, metodo }];

// Adaptador de GitLab EN PROCESO, con forja fija y credencial simulada.
async function adaptador(extra = {}) {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'forge-gitlab.js').replace(/\\/g, '/')}`);
  process.env.HOME = tmp('home'); process.env.USERPROFILE = process.env.HOME; process.env.FARO_CONFIG_PATH = path.join(process.env.HOME, '.faro.json');
  return mod.default({
    ROOT: tmp('root'), git: () => '', specBase: 'gestion/cambios',
    forge: () => ({ forge: 'gitlab', host: 'gitlab.com', owner: 'g', project: 'p', path: 'g/p' }),
    tokenPara: () => 'tok', guardarToken: () => {}, faroSchema: () => ({ enums: { labels: [{ slug: 'bug', color: 'D73A4A' }], ...(extra.schema || {}) } }),
    fases: () => extra.fases || [], isDone: (e) => e === 'done', isActive: (e) => e === 'in_progress',
  });
}
// Captura de salida y de process.exit (los comandos imprimen y salen).
async function correr(fn, argv) {
  const out = []; const log = console.log; const exit = process.exit;
  console.log = (...a) => out.push(a.join(' ')); let codigo = null;
  process.exit = (c) => { codigo = c; throw new Error('__exit__'); };
  process.argv = ['node', 'harness.js', ...argv];
  try { await fn(); } catch (e) { if (e.message !== '__exit__') throw e; } finally { console.log = log; process.exit = exit; }
  return { out: out.join('\n'), codigo };
}
const hito = (iid, title, state = 'active') => ({ id: 100 + iid, iid, title, state, web_url: `https://gitlab.com/g/p/-/milestones/${iid}` });

test('hito crear: es IDEMPOTENTE — la segunda vez no duplica', async () => {
  const hitos = [];
  const ll = apiFalsa([
    R(/^projects\/g%2Fp\/milestones\?/, () => ({ status: 200, body: hitos })),
    R(/^projects\/g%2Fp\/milestones$/, (_m, body) => { const h = hito(hitos.length + 1, body.title); hitos.push(h); return { status: 201, body: h }; }, 'POST'),
  ]);
  const a = await adaptador();
  const r1 = await correr(a.cmdHito, ['hito', 'crear', 'Fase 1 — Piloto']);
  const r2 = await correr(a.cmdHito, ['hito', 'crear', 'Fase 1 — Piloto']);
  assert.match(r1.out, /Hito creado/); assert.match(r2.out, /Ya existia/);
  assert.strictEqual(ll.filter((c) => c.metodo === 'POST').length, 1, 'solo un POST: no se duplica');
});

test('hito sync: crea el hito de cada fase de ESTADO.md y CIERRA el de la fase terminada (releyendo el estado real)', async () => {
  const hitos = [];
  apiFalsa([
    R(/^projects\/g%2Fp\/milestones\?/, () => ({ status: 200, body: hitos })),
    R(/^projects\/g%2Fp\/milestones$/, (_m, body) => { const h = hito(hitos.length + 1, body.title); hitos.push(h); return { status: 201, body: h }; }, 'POST'),
    R(/^projects\/g%2Fp\/milestones\/(\d+)$/, (m, body) => { const h = hitos.find((x) => x.id === Number(m[1])); if (body && body.state_event === 'close') h.state = 'closed'; return { status: 200, body: h }; }),
  ]);
  const a = await adaptador({ fases: [{ num: 1, nombre: 'Piloto', estado: 'done' }, { num: 2, nombre: 'Despliegue', estado: 'in_progress' }] });
  const r = await correr(a.cmdHito, ['hito', 'sync']);
  assert.match(r.out, /\+ Fase 1 — Piloto: creado/); assert.match(r.out, /✓ Fase 1 — Piloto: cerrado/);
  assert.match(r.out, /\+ Fase 2 — Despliegue: creado/); assert.ok(!/Fase 2 — Despliegue: cerrado/.test(r.out));
  assert.strictEqual(hitos.find((h) => h.title.startsWith('Fase 1')).state, 'closed');
});

test('tiempo: registra consumo y estimacion por la API de tiempo; rechaza duraciones invalidas SIN llamar', async () => {
  const ll = apiFalsa([
    R(/^projects\/g%2Fp\/issues\/7\/add_spent_time$/, (_m, body) => ({ status: 201, body: { human_time_estimate: '4h', human_total_time_spent: body.duration, time_estimate: 14400, total_time_spent: 7200 } }), 'POST'),
    R(/^projects\/g%2Fp\/issues\/7\/time_estimate$/, () => ({ status: 200, body: { human_time_estimate: '1d', human_total_time_spent: '0h', time_estimate: 28800, total_time_spent: 0 } }), 'POST'),
  ]);
  const a = await adaptador();
  const r1 = await correr(a.cmdTiempo, ['tiempo', '7', '2h']);
  assert.match(r1.out, /Registradas 2h en #7/); assert.match(r1.out, /50%/, 'debe calcular consumido/estimado');
  const r2 = await correr(a.cmdTiempo, ['tiempo', '7', '--estimar', '1d']);
  assert.match(r2.out, /estimado 1d/);
  const antes = ll.length;
  const r3 = await correr(a.cmdTiempo, ['tiempo', '7', 'dos horas']);
  assert.strictEqual(r3.codigo, 1); assert.match(r3.out, /Duracion invalida/); assert.strictEqual(ll.length, antes, 'una duracion invalida no debe tocar la API');
});

test('tiempo sin argumentos: agrega estimado y consumido POR HITO a partir de las incidencias', async () => {
  apiFalsa([
    R(/^projects\/g%2Fp\/issues\?state=all/, () => ({ status: 200, body: [
      { state: 'closed', milestone: { title: 'Fase 1 — Piloto' }, time_stats: { time_estimate: 7200, total_time_spent: 3600 } },
      { state: 'opened', milestone: { title: 'Fase 1 — Piloto' }, time_stats: { time_estimate: 3600, total_time_spent: 0 } },
      { state: 'opened', milestone: null, time_stats: { time_estimate: 0, total_time_spent: 1800 } },
    ] })),
  ]);
  const a = await adaptador();
  const r = await correr(a.cmdTiempo, ['tiempo']);
  assert.match(r.out, /Fase 1 — Piloto: estimado 3\.0h · consumido 1\.0h · tareas 1\/2/);
  assert.match(r.out, /\(sin hito\): estimado 0\.0h · consumido 0\.5h/);
  assert.match(r.out, /TOTAL: estimado 3\.0h · consumido 1\.5h \(50%\)/);
});

test('enlazar bloquea: si GitLab lo guarda como "relates_to" (plan Free), se pide, se RELEE y se avisa', async () => {
  apiFalsa([
    R(/^projects\/g%2Fp\/issues\/3\/links$/, () => ({ status: 201, body: {} }), 'POST'),
    R(/^projects\/g%2Fp\/issues\/3\/links$/, () => ({ status: 200, body: [{ iid: 9, link_type: 'relates_to' }] })),
  ]);
  const a = await adaptador();
  const r = await correr(a.cmdEnlazar, ['enlazar', '3', 'bloquea', '9']);
  assert.match(r.out, /Enlace creado como 'relates_to' y no como 'blocks'/);
  assert.match(r.out, /Premium\/Ultimate/);
});

test('asignar-tarea --hito --estimacion: la incidencia nace en el hito, y despues se estima; etiqueta de tipo CON ambito (tipo::bug)', async () => {
  const ll = apiFalsa([
    R(/^projects\/g%2Fp\/members\?/, () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 30 }] })),
    R(/^projects\/g%2Fp\/members\/all\?/, () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 30 }] })),
    R(/^projects\/g%2Fp\/labels\?/, () => ({ status: 200, body: [] })),
    R(/^projects\/g%2Fp\/labels$/, (_m, body) => ({ status: 201, body: { name: body.name } }), 'POST'),
    R(/^projects\/g%2Fp\/milestones\?/, () => ({ status: 200, body: [hito(2, 'Fase 2 — Despliegue')] })),
    R(/^projects\/g%2Fp\/issues$/, (_m, body) => ({ status: 201, body: { iid: 42, web_url: 'https://gitlab.com/g/p/-/issues/42', milestone: { id: body.milestone_id } } }), 'POST'),
    R(/^projects\/g%2Fp\/issues\/42\/time_estimate$/, () => ({ status: 200, body: {} }), 'POST'),
  ]);
  const a = await adaptador();
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Montar API', 'ana', 'cambio-x', 'detalle', '--tipo', 'bug', '--hito', 'Fase 2 — Despliegue', '--estimacion', '4h']);
  assert.match(r.out, /Tarea #42 asignada a ana/, r.out);
  const post = ll.find((c) => c.metodo === 'POST' && c.ruta === 'projects/g%2Fp/issues');
  assert.strictEqual(post.body.milestone_id, 102, 'debe ir en el hito de su fase');
  assert.match(post.body.labels, /^tipo::bug$/, 'etiqueta de tipo con ambito');
  assert.ok(ll.some((c) => c.ruta === 'projects/g%2Fp/issues/42/time_estimate' && c.body.duration === '4h'), 'debe estimar tras crear');
  assert.match(r.out, /estimacion 4h/);
});

// La estimacion es FLEXIBLE en su valor (se reajusta libremente si cambia el alcance) y NUNCA
// bloquea -- pero si falta en una tarea de PLAN (va a una fase), se avisa: es la unica senal de
// cuanto pesa el trabajo planificado, y hoy se olvida en silencio si no se pasa el flag.
test("asignar-tarea de tipo PLAN sin --estimacion: avisa (no bloquea, nace igual)", async () => {
  const ll = apiFalsa([
    R(/^projects\/g%2Fp\/members\?/, () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 30 }] })),
    R(/^projects\/g%2Fp\/members\/all\?/, () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 30 }] })),
    R(/^projects\/g%2Fp\/labels\?/, () => ({ status: 200, body: [] })),
    R(/^projects\/g%2Fp\/labels$/, (_m, body) => ({ status: 201, body: { name: body.name } }), 'POST'),
    R(/^projects\/g%2Fp\/milestones\?/, () => ({ status: 200, body: [hito(2, 'Fase 2 — Despliegue')] })),
    R(/^projects\/g%2Fp\/issues$/, (_m, body) => ({ status: 201, body: { iid: 42, web_url: 'u', milestone: { id: body.milestone_id } } }), 'POST'),
  ]);
  const a = await adaptador({ schema: { labels: [{ slug: 'tarea', color: '000', ciclo: 'plan' }] } });
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Montar API', 'ana', 'cambio-x', 'detalle', '--tipo', 'tarea', '--hito', 'Fase 2 — Despliegue']);
  assert.match(r.out, /Tarea #42 asignada a ana/, r.out);
  assert.match(r.out, /sin --estimacion/i, `debe avisar de la estimacion que falta: ${r.out}`);
  assert.ok(!ll.some((c) => c.ruta.includes('time_estimate')), 'no debe llamar a time_estimate: no se paso nada que estimar');
});

test("asignar-tarea de tipo SURGE (bug) sin --estimacion: NO avisa (no estaba planificado, no se espera estimar de entrada)", async () => {
  const ll = apiFalsa([
    R(/^projects\/g%2Fp\/members\?/, () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 30 }] })),
    R(/^projects\/g%2Fp\/members\/all\?/, () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 30 }] })),
    R(/^projects\/g%2Fp\/labels\?/, () => ({ status: 200, body: [] })),
    R(/^projects\/g%2Fp\/labels$/, (_m, body) => ({ status: 201, body: { name: body.name } }), 'POST'),
    R(/^projects\/g%2Fp\/issues$/, () => ({ status: 201, body: { iid: 7, web_url: 'u' } }), 'POST'),
  ]);
  const a = await adaptador({ schema: { labels: [{ slug: 'bug', color: 'D73A4A', ciclo: 'surge' }] } });
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'T', 'ana', '', '', '--tipo', 'bug']);
  assert.match(r.out, /Tarea #7 asignada a ana/, r.out);
  assert.ok(!/sin --estimacion/i.test(r.out), `un bug no deberia pedir estimacion: ${r.out}`);
  void ll;
});

test("asignar-tarea de tipo PLAN CON --estimacion: no avisa (ya la tiene)", async () => {
  apiFalsa([
    R(/^projects\/g%2Fp\/members\?/, () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 30 }] })),
    R(/^projects\/g%2Fp\/members\/all\?/, () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 30 }] })),
    R(/^projects\/g%2Fp\/labels\?/, () => ({ status: 200, body: [] })),
    R(/^projects\/g%2Fp\/labels$/, (_m, body) => ({ status: 201, body: { name: body.name } }), 'POST'),
    R(/^projects\/g%2Fp\/milestones\?/, () => ({ status: 200, body: [hito(2, 'Fase 2 — Despliegue')] })),
    R(/^projects\/g%2Fp\/issues$/, (_m, body) => ({ status: 201, body: { iid: 8, web_url: 'u', milestone: { id: body.milestone_id } } }), 'POST'),
    R(/^projects\/g%2Fp\/issues\/8\/time_estimate$/, () => ({ status: 200, body: {} }), 'POST'),
  ]);
  const a = await adaptador({ schema: { labels: [{ slug: 'tarea', color: '000', ciclo: 'plan' }] } });
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Montar API', 'ana', 'cambio-x', 'detalle', '--tipo', 'tarea', '--hito', 'Fase 2 — Despliegue', '--estimacion', '3h']);
  assert.ok(!/sin --estimacion/i.test(r.out), `ya trae estimacion, no debe avisar: ${r.out}`);
});

test('etiquetas con ambito se pueden DESACTIVAR desde faro-schema.json (vuelve a faro:<slug>)', async () => {
  const ll = apiFalsa([
    R(/^projects\/g%2Fp\/members\?/, () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 30 }] })),
    R(/^projects\/g%2Fp\/members\/all\?/, () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 30 }] })),
    R(/^projects\/g%2Fp\/labels\?/, () => ({ status: 200, body: [] })),
    R(/^projects\/g%2Fp\/labels$/, (_m, body) => ({ status: 201, body: { name: body.name } }), 'POST'),
    R(/^projects\/g%2Fp\/issues$/, () => ({ status: 201, body: { iid: 1, web_url: 'u' } }), 'POST'),
  ]);
  const a = await adaptador({ schema: { gitlab: { etiquetas_con_ambito: false } } });
  await correr(a.cmdAsignarTarea, ['asignar-tarea', 'T', 'ana', '--tipo', 'bug']);
  const post = ll.find((c) => c.metodo === 'POST' && c.ruta === 'projects/g%2Fp/issues');
  assert.strictEqual(post.body.labels, 'faro:bug');
});

// ---- Enrutado real por proceso (sin credencial): los comandos existen y responden con criterio.
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 120000 });
function instancia(remote) {
  const dir = tmp('inst');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · P — in_progress\n- [ ] t\n');
  git(dir, 'init', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T'); git(dir, 'config', 'commit.gpgsign', 'false');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base');
  return dir;
}
const spawn = (args, dir) => { const h = tmp('h'); return spawnSync(process.execPath, [HARNESS, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HOME: h, USERPROFILE: h, FARO_CONFIG_PATH: path.join(h, '.faro.json'), FARO_GITLAB_TOKEN: '', GITLAB_TOKEN: '' } }); };

test('dispatcher: hito, tiempo y enlazar existen y en GitLab sin credencial responden SIN_TOKEN', () => {
  const dir = instancia('git@gitlab.com:g/p.git');
  for (const args of [['hito'], ['tiempo', '1'], ['tiempo', '1', '2h']]) {
    const r = spawn(args, dir);
    assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`); assert.match(r.stdout, /SIN_TOKEN/);
  }
  const r = spawn(['enlazar', '1', 'rompe', '2'], dir);
  assert.strictEqual(r.status, 1); assert.match(r.stdout, /Uso: harness\.js enlazar/);
});

test('dispatcher: en GitHub, hito EXISTE (0.23.0) y pide credencial; tiempo y enlazar explican que GitHub NO los tiene', () => {
  const dir = instancia('git@github.com:o/r.git');
  // 'hito' es nativo en las dos forjas -> sin credencial, SIN_TOKEN (salida 2), no "sin adaptador".
  const h = spawn(['hito'], dir);
  assert.strictEqual(h.status, 2, h.stdout + h.stderr); assert.match(h.stdout, /SIN_TOKEN/);
  // Tiempo y enlaces de bloqueo NO existen en GitHub en ningun plan: se dice, y se sale en 0.
  const t = spawn(['tiempo'], dir);
  assert.strictEqual(t.status, 0, t.stderr); assert.match(t.stdout, /GitHub NO tiene estimacion ni horas/);
  const e = spawn(['enlazar', '1', 'bloquea', '2'], dir);
  assert.strictEqual(e.status, 0, e.stderr); assert.match(e.stdout, /GitHub NO tiene enlaces de BLOQUEO/);
});

test('atomicidad: ningun modulo del adaptador de GitLab supera las 400 lineas', () => {
  for (const f of ['forge-gitlab.js', 'forge-gitlab-gestion.js', 'forge-gitlab-proyecto.js']) {
    const n = fs.readFileSync(path.join(HOOKS, 'lib', f), 'utf8').split('\n').length;
    assert.ok(n <= 400, `${f}: ${n} lineas`);
  }
});

// #217: el --hito de GitLab acepta los MISMOS valores que el de GitHub (numero de fase, backlog o
// titulo), y --fase sigue valiendo como alias con aviso.
test('asignar-tarea --fase N (alias) en GitLab: avisa y resuelve el numero al hito de esa fase de ESTADO.md', async () => {
  const ll = apiFalsa([
    R(/^projects\/g%2Fp\/members\?/, () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 30 }] })),
    R(/^projects\/g%2Fp\/members\/all\?/, () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 30 }] })),
    R(/^projects\/g%2Fp\/labels\?/, () => ({ status: 200, body: [] })),
    R(/^projects\/g%2Fp\/labels$/, (_m, body) => ({ status: 201, body: { name: body.name } }), 'POST'),
    R(/^projects\/g%2Fp\/milestones\?/, () => ({ status: 200, body: [hito(7, 'Fase 2 — Despliegue'), hito(8, 'Backlog')] })),
    R(/^projects\/g%2Fp\/issues$/, (_m, body) => ({ status: 201, body: { iid: 42, web_url: 'u', milestone: { id: body.milestone_id } } }), 'POST'),
  ]);
  const a = await adaptador({ fases: [{ num: 2, nombre: 'Despliegue', estado: 'in_progress' }] });
  const r = await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Montar API', 'ana', '', '', '--tipo', 'bug', '--fase', '2']);
  assert.match(r.out, /se llama --hito/, r.out);
  const post = ll.find((c) => c.metodo === 'POST' && c.ruta === 'projects/g%2Fp/issues');
  assert.strictEqual(post.body.milestone_id, 107, 'el 2 es la Fase 2, no el milestone de iid 2');
  const ll2 = apiFalsa([
    R(/^projects\/g%2Fp\/members\?/, () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 30 }] })),
    R(/^projects\/g%2Fp\/members\/all\?/, () => ({ status: 200, body: [{ id: 5, username: 'ana', access_level: 30 }] })),
    R(/^projects\/g%2Fp\/labels\?/, () => ({ status: 200, body: [] })),
    R(/^projects\/g%2Fp\/labels$/, (_m, body) => ({ status: 201, body: { name: body.name } }), 'POST'),
    R(/^projects\/g%2Fp\/milestones\?/, () => ({ status: 200, body: [hito(7, 'Fase 2 — Despliegue'), hito(8, 'Backlog')] })),
    R(/^projects\/g%2Fp\/issues$/, (_m, body) => ({ status: 201, body: { iid: 43, web_url: 'u', milestone: { id: body.milestone_id } } }), 'POST'),
  ]);
  await correr(a.cmdAsignarTarea, ['asignar-tarea', 'Idea', 'ana', '', '', '--tipo', 'bug', '--hito', 'backlog']);
  assert.strictEqual(ll2.find((c) => c.metodo === 'POST' && c.ruta === 'projects/g%2Fp/issues').body.milestone_id, 108);
});
