// pr ver / aprobar / mergear por la API de GitLab (0.21.0). En proceso, con API simulada: gates de
// rol y --confirmo, relectura tras escribir, y mensajes utiles cuando GitLab se niega.
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
    const u = String(url).replace('https://gitlab.com/api/v4/', ''); const metodo = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null; llamadas.push({ metodo, ruta: u, body });
    for (const [re, fn] of rutas) { const m = u.match(re); if (m && (!fn.metodo || fn.metodo === metodo)) { const r = fn.resp(m, body); return { ok: r.status < 400, status: r.status, json: async () => r.body }; } }
    return { ok: false, status: 404, json: async () => ({ message: '404 ' + u }) };
  };
  return llamadas;
}
const R = (re, resp, metodo) => [re, { resp, metodo }];
async function adaptador(nivel = 50) {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'forge-gitlab.js').replace(/\\/g, '/')}`);
  const home = tmp('home'); process.env.FARO_CONFIG_PATH = path.join(home, '.faro.json');
  return mod.default({ ROOT: tmp('root'), git: () => '', specBase: 'x', forge: () => ({ forge: 'gitlab', host: 'gitlab.com', owner: 'g', project: 'p', path: 'g/p' }), tokenPara: () => 'tok', guardarToken: () => {}, faroSchema: () => ({}), fases: () => [], isDone: () => false, isActive: () => false, _nivel: nivel });
}
async function correr(fn, ...args) {
  const out = []; const log = console.log; const exit = process.exit; let codigo = null;
  console.log = (...a) => out.push(a.join(' ')); process.exit = (c) => { codigo = c; throw new Error('__exit__'); };
  try { await fn(...args); } catch (e) { if (e.message !== '__exit__') throw e; } finally { console.log = log; process.exit = exit; }
  return { out: out.join('\n'), codigo };
}
const MR = (extra = {}) => ({ iid: 7, title: 'T', source_branch: 'feat/x', target_branch: 'main', state: 'opened', web_url: 'u', head_pipeline: { status: 'success' }, detailed_merge_status: 'mergeable', ...extra });
const rutasBase = (nivel, aprobaciones) => [
  R(/^user$/, () => ({ status: 200, body: { id: 1, username: 'fer' } })),
  R(/^projects\/g%2Fp\/members\/all\/1$/, () => ({ status: 200, body: { access_level: nivel } })),
  R(/^projects\/g%2Fp\/merge_requests\/7\/approvals$/, () => ({ status: 200, body: aprobaciones })),
];

test('pr ver: muestra estado, pipeline, aprobaciones y quien es elegible', async () => {
  apiFalsa([...rutasBase(50, { approved: false, approvals_left: 1, approvals_required: 1, approved_by: [], rules: [{ name: 'ACME', approvals_required: 1, eligible_approvers: [{ username: 'ana' }] }] }),
    R(/^projects\/g%2Fp\/merge_requests\/7$/, () => ({ status: 200, body: MR() }))]);
  const a = await adaptador();
  const r = await correr(a.cmdPrVer, '7');
  assert.match(r.out, /pipeline: success/); assert.match(r.out, /aprobaciones: pendientes \(requeridas 1, faltan 1\)/); assert.match(r.out, /elegibles: ana/);
});

test('pr aprobar: si GitLab se niega (autor sin autoaprobacion), lo explica y sale 1', async () => {
  apiFalsa([...rutasBase(50, {}), R(/^projects\/g%2Fp\/merge_requests\/7\/approve$/, () => ({ status: 401, body: { message: '401 Unauthorized' } }), 'POST')]);
  const a = await adaptador();
  const r = await correr(a.cmdPrAprobar, '7');
  assert.strictEqual(r.codigo, 1); assert.match(r.out, /No pude aprobar !7 \(HTTP 401\)/); assert.match(r.out, /autoaprobacion/);
});

test('pr mergear: exige --confirmo; sin el no toca la API', async () => {
  const ll = apiFalsa(rutasBase(50, {}));
  const a = await adaptador();
  const r = await correr(a.cmdPrMergear, '7', []);
  assert.strictEqual(r.codigo, 1); assert.match(r.out, /requiere --confirmo/); assert.strictEqual(ll.length, 0);
});

test('pr mergear: un Developer (nivel 30) no puede, aunque confirme', async () => {
  const ll = apiFalsa(rutasBase(30, {}));
  const a = await adaptador(30);
  const r = await correr(a.cmdPrMergear, '7', ['--confirmo']);
  assert.strictEqual(r.codigo, 1); assert.match(r.out, /no puede fusionar/);
  assert.ok(!ll.some((c) => /\/merge$/.test(c.ruta)), 'no debe intentar el merge');
});

test('pr mergear --confirmo: Owner fusiona, y se RELEE para confirmar que quedo merged', async () => {
  let estado = 'opened';
  const ll = apiFalsa([...rutasBase(50, { approved: true, approvals_left: 0, approvals_required: 0, approved_by: [], rules: [] }),
    R(/^projects\/g%2Fp\/merge_requests\/7$/, () => ({ status: 200, body: MR({ state: estado, merge_commit_sha: 'abcdef1234' }) })),
    R(/^projects\/g%2Fp\/merge_requests\/7\/merge$/, () => { estado = 'merged'; return { status: 200, body: {} }; }, 'PUT')]);
  const a = await adaptador();
  const r = await correr(a.cmdPrMergear, '7', ['--confirmo']);
  assert.strictEqual(r.codigo, null, r.out); assert.match(r.out, /!7 FUSIONADA en main \(commit abcdef1\)/);
  const put = ll.find((c) => c.metodo === 'PUT'); assert.strictEqual(put.body.should_remove_source_branch, true);
});

test('pr mergear: si GitLab rechaza (aprobaciones o pipeline), muestra el estado real y sale 1', async () => {
  apiFalsa([...rutasBase(50, { approved: false, approvals_left: 1, approvals_required: 1, approved_by: [], rules: [] }),
    R(/^projects\/g%2Fp\/merge_requests\/7$/, () => ({ status: 200, body: MR({ detailed_merge_status: 'not_approved' }) })),
    R(/^projects\/g%2Fp\/merge_requests\/7\/merge$/, () => ({ status: 405, body: { message: '405 Method Not Allowed' } }), 'PUT')]);
  const a = await adaptador();
  const r = await correr(a.cmdPrMergear, '7', ['--confirmo']);
  assert.strictEqual(r.codigo, 1); assert.match(r.out, /GitLab NO fusiono !7 \(HTTP 405\)/); assert.match(r.out, /fusionable: not_approved/);
});

// #262: los grupos nuevos de GitLab exigen 'sha' al fusionar (require_sha_for_merge): sin el, «SHA must be
// provided when merging». Se manda el SHA de cabeza de la MR leida justo antes; asi tampoco se fusiona
// una rama que cambio tras revisarla.
test('pr mergear manda el SHA de cabeza de la MR (require_sha_for_merge)', async () => {
  const ll = apiFalsa([...rutasBase(50, { approved: true, approvals_left: 0, approvals_required: 0, approved_by: [], rules: [] }),
    R(/^projects\/g%2Fp\/merge_requests\/7$/, () => ({ status: 200, body: MR({ sha: 'cafe1234', diff_refs: { head_sha: 'cafe1234' } }) })),
    R(/^projects\/g%2Fp\/merge_requests\/7\/merge$/, () => ({ status: 200, body: {} }), 'PUT')]);
  const a = await adaptador();
  await correr(a.cmdPrMergear, '7', ['--confirmo']);
  const put = ll.find((c) => c.metodo === 'PUT');
  assert.strictEqual(put.body.sha, 'cafe1234');
});

test('pr mergear: un 409 por SHA distinto se explica (la rama cambio tras revisarla)', async () => {
  apiFalsa([...rutasBase(50, {}),
    R(/^projects\/g%2Fp\/merge_requests\/7$/, () => ({ status: 200, body: MR({ sha: 'cafe1234' }) })),
    R(/^projects\/g%2Fp\/merge_requests\/7\/merge$/, () => ({ status: 409, body: { message: 'SHA does not match HEAD of source branch: beef' } }), 'PUT')]);
  const a = await adaptador();
  const r = await correr(a.cmdPrMergear, '7', ['--confirmo']);
  assert.strictEqual(r.codigo, 1);
  assert.match(r.out, /la rama cambi/i, r.out);
});
