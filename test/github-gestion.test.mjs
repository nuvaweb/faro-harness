// Paridad de GitHub (0.23.0): hitos, miembros, peticiones por intencion, exigir pipeline y renombrar.
// Y lo mas importante: la deteccion HONESTA del limite de plan — en GitHub Free con repo PRIVADO no
// hay proteccion de ramas, asi que 'proteger' y 'exigir-pipeline' no pueden funcionar y el harness
// debe decirlo, no fallar con un error tecnico que haga creer que main esta protegida.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

function apiFalsa(rutas) {
  const llamadas = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url).replace('https://api.github.com/', ''); const metodo = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : null;
    llamadas.push({ metodo, ruta: u, body });
    for (const [re, fn] of rutas) { const m = u.match(re); if (m && (!fn.metodo || fn.metodo === metodo)) { const r = fn.resp(m, body); return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body), json: async () => r.body }; } }
    return { ok: false, status: 404, text: async () => '{}', json: async () => ({ message: 'Not Found' }) };
  };
  return llamadas;
}
const R = (re, resp, metodo) => [re, { resp, metodo }];
async function adaptador(fases = []) {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'github.js').replace(/\\/g, '/')}`);
  const home = tmp('home'); const cfg = path.join(home, '.faro.json');
  fs.writeFileSync(cfg, JSON.stringify({ tokens: { 'github.com': { token: 'tok', forja: 'github', user: { login: 'fer' } } } }));
  process.env.FARO_CONFIG_PATH = cfg; process.env.FARO_GITHUB_TOKEN = ''; process.env.GITHUB_TOKEN = '';
  return mod.default({
    ROOT: tmp('root'), IS_TEMPLATE: false, specBase: 'gestion/cambios',
    git: (...a) => (a[0] === 'remote' ? 'git@github.com:org/repo.git' : ''),
    forge: () => ({ forge: 'github', host: 'github.com', owner: 'org', project: 'repo', path: 'org/repo' }),
    fases: () => fases, isDone: (e) => e === 'done', isActive: (e) => e === 'in_progress',
  });
}
async function correr(fn, argv, ...args) {
  const out = []; const log = console.log; const wr = process.stdout.write.bind(process.stdout);
  const exit = process.exit; let codigo = null;
  console.log = (...a) => out.push(a.join(' '));
  process.stdout.write = (s) => { out.push(String(s).replace(/\n$/, '')); return true; };
  process.exit = (c) => { codigo = c; throw new Error('__exit__'); };
  if (argv) process.argv = ['node', 'harness.js', ...argv];
  try { await fn(...args); } catch (e) { if (e.message !== '__exit__') throw e; } finally { console.log = log; process.stdout.write = wr; process.exit = exit; }
  return { out: out.join('\n'), codigo };
}
const hito = (n, title, state = 'open') => ({ number: n, title, state, html_url: 'u', open_issues: 1, closed_issues: 2 });
// Lo que responde GitHub Free cuando el repo es PRIVADO y se pide proteccion de rama.
const LIMITE_PLAN = { status: 403, body: { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' } };

test('proteger: en GitHub Free privado NO falla con un error tecnico — explica el limite del plan y que el servidor no protege', async () => {
  apiFalsa([R(/^repos\/org\/repo\/branches\/main\/protection$/, () => LIMITE_PLAN, 'PUT')]);
  const a = await adaptador();
  const r = await correr(a.cmdProteger, ['proteger']);
  assert.match(r.out, /tu plan de GitHub NO lo permite en un repositorio PRIVADO/, r.out);
  assert.match(r.out, /GitHub Team o superior/);
  assert.match(r.out, /gates LOCALES del harness/, 'debe decir que queda como unico gobierno');
  assert.match(r.out, /El servidor NO impide/, 'debe ser explicito: nadie esta protegido');
});

test('exigir-pipeline: sin proteccion de rama explica que en GitHub vive DENTRO de ella', async () => {
  apiFalsa([R(/^repos\/org\/repo\/branches\/main\/protection$/, () => ({ status: 404, body: { message: 'Branch not protected' } }))]);
  const a = await adaptador();
  const r = await correr(a.cmdExigirPipeline, ['exigir-pipeline']);
  assert.match(r.out, /no tiene proteccion de rama/); assert.match(r.out, /harness\.js proteger main/);
});

test('exigir-pipeline: con proteccion, exige las comprobaciones que de verdad corrieron y RELEE', async () => {
  let checks = null;
  apiFalsa([
    R(/^repos\/org\/repo\/branches\/main\/protection$/, () => ({ status: 200, body: { enforce_admins: { enabled: true }, required_pull_request_reviews: { required_approving_review_count: 1 }, required_status_checks: checks } }), 'GET'),
    R(/^repos\/org\/repo\/commits\/main\/check-runs/, () => ({ status: 200, body: { check_runs: [{ name: 'gates' }, { name: 'gates' }] } })),
    R(/^repos\/org\/repo\/branches\/main\/protection$/, (_m, b) => { checks = b.required_status_checks; return { status: 200, body: {} }; }, 'PUT'),
  ]);
  const a = await adaptador();
  const r = await correr(a.cmdExigirPipeline, ['exigir-pipeline']);
  assert.match(r.out, /Pipeline OBLIGATORIO en 'main': gates/, r.out);
  assert.deepStrictEqual(checks.contexts, ['gates'], 'sin duplicados');
});

test('exigir-pipeline: si no hay ninguna comprobacion ejecutada, manda generar el pipeline antes', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/branches\/main\/protection$/, () => ({ status: 200, body: {} })),
    R(/^repos\/org\/repo\/commits\/main\/check-runs/, () => ({ status: 200, body: { check_runs: [] } })),
  ]);
  const a = await adaptador();
  const r = await correr(a.cmdExigirPipeline, ['exigir-pipeline']);
  assert.match(r.out, /No encuentro ninguna comprobacion/); assert.match(r.out, /harness\.js ci/);
});

test('hito crear: idempotente — la segunda vez no duplica', async () => {
  const hitos = [];
  const ll = apiFalsa([
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: hitos })),
    R(/^repos\/org\/repo\/milestones$/, (_m, b) => { const h = hito(hitos.length + 1, b.title); hitos.push(h); return { status: 201, body: h }; }, 'POST'),
  ]);
  const a = await adaptador();
  const r1 = await correr(a.cmdHito, ['hito', 'crear', 'Fase 1 — Piloto']);
  const r2 = await correr(a.cmdHito, ['hito', 'crear', 'Fase 1 — Piloto']);
  assert.match(r1.out, /Hito creado/); assert.match(r2.out, /Ya existia/);
  assert.strictEqual(ll.filter((c) => c.metodo === 'POST').length, 1);
});

test('hito sync: fase = hito; cierra el de la fase terminada (sin tareas abiertas) y releer confirma el estado', async () => {
  const hitos = [];
  // Hito recien creado SIN tareas abiertas (open_issues: 0): distinto del hito() generico de arriba
  // (que trae open_issues: 1 a proposito para probar el conteo de 'hito listar') — aqui se prueba el
  // cierre normal, el cierre FORZOSO con tareas abiertas tiene su propio test en cierre-forzoso-fase.test.mjs.
  const hitoNuevo = (n, title, state = 'open') => ({ number: n, title, state, html_url: 'u', open_issues: 0, closed_issues: 0 });
  apiFalsa([
    R(/^repos\/org\/repo\/milestones\?/, () => ({ status: 200, body: hitos })),
    R(/^repos\/org\/repo\/milestones$/, (_m, b) => { const h = hitoNuevo(hitos.length + 1, b.title); hitos.push(h); return { status: 201, body: h }; }, 'POST'),
    R(/^repos\/org\/repo\/milestones\/(\d+)$/, (m, b) => { const h = hitos.find((x) => x.number === Number(m[1])); if (b && b.state) h.state = b.state; return { status: 200, body: h }; }),
  ]);
  const a = await adaptador([{ num: 1, nombre: 'Piloto', estado: 'done' }, { num: 2, nombre: 'Despliegue', estado: 'in_progress' }]);
  const r = await correr(a.cmdHito, ['hito', 'sync']);
  assert.match(r.out, /\+ Fase 1 — Piloto: creado/); assert.match(r.out, /✓ Fase 1 — Piloto: cerrado/);
  assert.ok(!/Fase 2 — Despliegue: cerrado/.test(r.out));
});

test('miembro anadir: distingue invitacion PENDIENTE (201) de colaborador ya existente (204)', async () => {
  apiFalsa([R(/^repos\/org\/repo\/collaborators\/ana$/, () => ({ status: 201, body: {} }), 'PUT')]);
  const a = await adaptador();
  const r1 = await correr(a.cmdMiembro, ['miembro', 'anadir', 'ana', 'developer']);
  assert.match(r1.out, /Invitacion enviada a ana/); assert.match(r1.out, /cuando la ACEPTE/);
  apiFalsa([R(/^repos\/org\/repo\/collaborators\/ana$/, () => ({ status: 204, body: {} }), 'PUT')]);
  const b = await adaptador();
  const r2 = await correr(b.cmdMiembro, ['miembro', 'anadir', 'ana', 'maintainer']);
  assert.match(r2.out, /colaborador de org\/repo con permiso maintain/);
});

test('miembro anadir: rol invalido se rechaza SIN tocar la API', async () => {
  const ll = apiFalsa([]);
  const a = await adaptador();
  const r = await correr(a.cmdMiembro, ['miembro', 'anadir', 'ana', 'jefe']);
  assert.strictEqual(r.codigo, 1); assert.match(r.out, /Rol invalido/); assert.strictEqual(ll.length, 0);
});

test('pr ver: muestra estado, fusionabilidad y quien aprobo o pidio cambios', async () => {
  apiFalsa([
    R(/^repos\/org\/repo\/pulls\/7$/, () => ({ status: 200, body: { number: 7, title: 'T', state: 'open', draft: false, mergeable: true, mergeable_state: 'clean', head: { ref: 'feat/x' }, base: { ref: 'main' }, html_url: 'u' } })),
    R(/^repos\/org\/repo\/pulls\/7\/reviews/, () => ({ status: 200, body: [{ user: { login: 'ana' }, state: 'APPROVED' }, { user: { login: 'luis' }, state: 'CHANGES_REQUESTED' }] })),
  ]);
  const a = await adaptador();
  const r = await correr(a.cmdPrVer, null, '7');
  assert.match(r.out, /aprobaciones: ana/); assert.match(r.out, /CAMBIOS PEDIDOS por luis/);
});

test('pr aprobar: GitHub no deja aprobar lo tuyo — se explica y se ofrece la salida real', async () => {
  apiFalsa([R(/^repos\/org\/repo\/pulls\/7\/reviews$/, () => ({ status: 422, body: { message: 'Can not approve your own pull request' } }), 'POST')]);
  const a = await adaptador();
  const r = await correr(a.cmdPrAprobar, null, '7');
  assert.strictEqual(r.codigo, 1);
  assert.match(r.out, /NO deja aprobar tu propia peticion/);
  assert.match(r.out, /pr mergear <n> --confirmo/, 'debe decir como seguir si trabajas solo');
});

test('pr mergear: exige --confirmo; sin el no toca la API', async () => {
  const ll = apiFalsa([]);
  const a = await adaptador();
  const r = await correr(a.cmdPrMergear, null, '7', []);
  assert.strictEqual(r.codigo, 1); assert.match(r.out, /requiere --confirmo/); assert.strictEqual(ll.length, 0);
});

test('pr mergear --confirmo: fusiona, RELEE para confirmar y borra la rama', async () => {
  let merged = false; let borrada = false;
  apiFalsa([
    R(/^repos\/org\/repo$/, () => ({ status: 200, body: { permissions: { admin: true } } })),
    R(/^repos\/org\/repo\/pulls\/7$/, () => ({ status: 200, body: { number: 7, title: 'T', state: merged ? 'closed' : 'open', merged, mergeable: true, mergeable_state: 'clean', head: { ref: 'feat/x' }, base: { ref: 'main' }, html_url: 'u' } })),
    R(/^repos\/org\/repo\/pulls\/7\/reviews/, () => ({ status: 200, body: [] })),
    R(/^repos\/org\/repo\/pulls\/7\/merge$/, () => { merged = true; return { status: 200, body: { sha: 'abcdef1234', merged: true } }; }, 'PUT'),
    R(/^repos\/org\/repo\/git\/refs\/heads\/feat\/x$/, () => { borrada = true; return { status: 204, body: {} }; }, 'DELETE'),
  ]);
  const a = await adaptador();
  const r = await correr(a.cmdPrMergear, null, '7', ['--confirmo']);
  assert.match(r.out, /#7 FUSIONADA en main \(commit abcdef1\)/, r.out);
  assert.ok(borrada, 'debe borrar la rama de origen');
});

test('renombrar: renombra por API y actualiza el origin local', async () => {
  const remotos = [];
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'github.js').replace(/\\/g, '/')}`);
  const home = tmp('home'); const cfg = path.join(home, '.faro.json');
  fs.writeFileSync(cfg, JSON.stringify({ tokens: { 'github.com': { token: 'tok', forja: 'github' } } }));
  process.env.FARO_CONFIG_PATH = cfg;
  apiFalsa([R(/^repos\/org\/repo$/, (_m, b) => ({ status: 200, body: { name: b.name } }), 'PATCH')]);
  const a = mod.default({
    ROOT: tmp('root'), IS_TEMPLATE: false, specBase: 'x',
    git: (...ar) => { if (ar[0] === 'remote' && ar[1] === 'set-url') { remotos.push(ar[3]); return ''; } return ar[0] === 'remote' ? 'git@github.com:org/repo.git' : ''; },
    forge: () => ({ forge: 'github', host: 'github.com', owner: 'org', project: 'repo', path: 'org/repo' }),
    fases: () => [], isDone: () => false, isActive: () => false,
  });
  const r = await correr(a.cmdRenombrar, ['renombrar', 'repo-nuevo']);
  assert.match(r.out, /Renombrado: org\/repo -> org\/repo-nuevo/, r.out);
  assert.deepStrictEqual(remotos, ['git@github.com:org/repo-nuevo.git'], 'el origin local debe apuntar al nombre nuevo');
});

// #182: los gates gobernados escriben turnos y cache en el directorio privado del usuario: en los tests, a un temporal.
process.env.FARO_PROC_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "faro-proc-t-"));
process.env.FARO_MEM_MIN_MB = "0";   // estos tests prueban la logica de los gates, no la memoria de la maquina

// #262: la fusion manda el SHA de cabeza que se acaba de leer; si la rama cambio entre medias, la forja
// responde 409 y el harness lo explica en vez de fusionar algo no revisado.
test('pr mergear --confirmo: manda el SHA de cabeza leido (no fusiona una rama que cambio)', async () => {
  const ll = apiFalsa([
    R(/^repos\/org\/repo$/, () => ({ status: 200, body: { permissions: { admin: true } } })),
    R(/^repos\/org\/repo\/pulls\/7$/, () => ({ status: 200, body: { number: 7, title: 'T', state: 'open', merged: false, mergeable: true, mergeable_state: 'clean', head: { ref: 'feat/x', sha: 'cafe1234' }, base: { ref: 'main' }, html_url: 'u' } })),
    R(/^repos\/org\/repo\/pulls\/7\/reviews/, () => ({ status: 200, body: [] })),
    R(/^repos\/org\/repo\/pulls\/7\/merge$/, () => ({ status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } }), 'PUT'),
  ]);
  const a = await adaptador();
  const r = await correr(a.cmdPrMergear, null, '7', ['--confirmo']);
  assert.strictEqual(ll.find((l) => l.metodo === 'PUT').body.sha, 'cafe1234');
  assert.strictEqual(r.codigo, 1);
  assert.match(r.out, /la rama cambi/i, r.out);
});
