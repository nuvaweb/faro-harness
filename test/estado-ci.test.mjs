// Estado del CI de un PR/MR normalizado por forja (#289): verde, rojo, pendiente, sin-ci, sin-cuota.
// Dominio puro (lib/estado-ci.js) y los dos adaptadores con la API simulada: sin red.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const url = (rel) => `file://${path.join(HOOKS, ...rel.split('/')).replace(/\\/g, '/')}`;
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));
const dominio = async () => (await import(url('lib/estado-ci.js'))).default;

const GH = 'https://api.github.com/';
const GL = 'https://gitlab.com/api/v4/';

function apiFalsa(base, rutas) {
  const llamadas = [];
  globalThis.fetch = async (u, opts = {}) => {
    const ruta = String(u).replace(base, ''); const metodo = (opts.method || 'GET').toUpperCase();
    llamadas.push({ metodo, ruta });
    for (const [re, resp] of rutas) if (re.test(ruta) && metodo === 'GET') { const r = resp(); return { ok: r.status < 400, status: r.status, json: async () => r.body }; }
    return { ok: false, status: 404, json: async () => ({ message: `404 ${ruta}` }) };
  };
  return llamadas;
}

async function github() {
  const mod = (await import(url('lib/github.js'))).default;
  const cfg = path.join(tmp('home'), '.faro.json');
  fs.writeFileSync(cfg, JSON.stringify({ tokens: { 'github.com': { token: 'tok', forja: 'github', user: { login: 'fer' } } } }));
  process.env.FARO_CONFIG_PATH = cfg; process.env.FARO_GITHUB_TOKEN = ''; process.env.GITHUB_TOKEN = '';
  return mod({
    ROOT: tmp('root'), IS_TEMPLATE: false, specBase: 'gestion/cambios',
    git: (...a) => (a[0] === 'remote' ? 'https://github.com/org/repo.git' : ''),
    forge: () => ({ forge: 'github', host: 'github.com', owner: 'org', project: 'repo', path: 'org/repo' }),
    fases: () => [], isDone: () => false, isActive: () => false, faroSchema: () => ({}),
  });
}
async function gitlab() {
  const mod = (await import(url('lib/forge-gitlab.js'))).default;
  process.env.FARO_CONFIG_PATH = path.join(tmp('home'), '.faro.json');
  return mod({
    ROOT: tmp('root'), git: () => '', specBase: 'x',
    forge: () => ({ forge: 'gitlab', host: 'gitlab.com', owner: 'g', project: 'p', path: 'g/p' }),
    tokenPara: () => 'tok', guardarToken: () => {}, faroSchema: () => ({}),
    fases: () => [], isDone: () => false, isActive: () => false,
  });
}

const run = (o = {}) => ({ id: 1, name: 'test', status: 'completed', conclusion: 'success', ...o });
const FACTURACION = 'The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the \'Billing & plans\' section in your settings';

// ---- Dominio puro: GitHub ----

test('GitHub: todos los checks en éxito, neutros u omitidos → verde', async () => {
  const { normalizarGithub } = await dominio();
  const r = normalizarGithub({ checkRuns: [run(), run({ id: 2, conclusion: 'neutral' }), run({ id: 3, conclusion: 'skipped' })], statuses: [] });
  assert.strictEqual(r.estado, 'verde');
});

test('GitHub: sin check-runs ni estados → sin-ci', async () => {
  const { normalizarGithub } = await dominio();
  assert.strictEqual(normalizarGithub({ checkRuns: [], statuses: [] }).estado, 'sin-ci');
});

test('GitHub: un check en cola o en curso → pendiente', async () => {
  const { normalizarGithub } = await dominio();
  assert.strictEqual(normalizarGithub({ checkRuns: [run(), run({ id: 2, status: 'in_progress', conclusion: null })], statuses: [] }).estado, 'pendiente');
  assert.strictEqual(normalizarGithub({ checkRuns: [], statuses: [{ context: 'ci/x', state: 'pending' }] }).estado, 'pendiente');
});

test('GitHub: un check fallido por código → rojo, y dice cuál', async () => {
  const { normalizarGithub } = await dominio();
  const r = normalizarGithub({ checkRuns: [run(), run({ id: 2, name: 'lint', conclusion: 'failure' })], statuses: [], anotaciones: { 2: [{ message: 'error TS2345' }] } });
  assert.strictEqual(r.estado, 'rojo');
  assert.deepStrictEqual(r.fallidos, ['lint']);
  assert.strictEqual(normalizarGithub({ checkRuns: [], statuses: [{ context: 'ext', state: 'error' }] }).estado, 'rojo');
});

test('GitHub: el rojo de código manda sobre lo pendiente', async () => {
  const { normalizarGithub } = await dominio();
  assert.strictEqual(normalizarGithub({ checkRuns: [run({ conclusion: 'failure' }), run({ id: 2, status: 'queued', conclusion: null })], statuses: [] }).estado, 'rojo');
});

test('GitHub: job no iniciado por facturación o presupuesto → sin-cuota, no rojo', async () => {
  const { normalizarGithub } = await dominio();
  const r = normalizarGithub({ checkRuns: [run({ conclusion: 'failure' })], statuses: [], anotaciones: { 1: [{ message: FACTURACION }] } });
  assert.strictEqual(r.estado, 'sin-cuota');
  const b = normalizarGithub({ checkRuns: [run({ conclusion: 'failure' })], statuses: [], anotaciones: { 1: [{ message: 'The job was not started because an Actions budget is preventing further use.' }] } });
  assert.strictEqual(b.estado, 'sin-cuota');
});

// ---- Dominio puro: GitLab ----

test('GitLab: pipeline success → verde; en curso → pendiente; sin pipeline → sin-ci', async () => {
  const { normalizarGitlab } = await dominio();
  assert.strictEqual(normalizarGitlab({ pipeline: { id: 9, status: 'success' } }).estado, 'verde');
  for (const s of ['created', 'pending', 'running', 'preparing', 'waiting_for_resource', 'scheduled', 'manual']) {
    assert.strictEqual(normalizarGitlab({ pipeline: { id: 9, status: s } }).estado, 'pendiente', s);
  }
  assert.strictEqual(normalizarGitlab({ pipeline: null }).estado, 'sin-ci');
});

test('GitLab: pipeline fallido por código → rojo con los jobs; por cuota → sin-cuota', async () => {
  const { normalizarGitlab } = await dominio();
  const r = normalizarGitlab({ pipeline: { id: 9, status: 'failed' }, jobsFallidos: [{ name: 'test', failure_reason: 'script_failure' }] });
  assert.strictEqual(r.estado, 'rojo');
  assert.deepStrictEqual(r.fallidos, ['test']);
  const q = normalizarGitlab({ pipeline: { id: 9, status: 'failed' }, jobsFallidos: [{ name: 'test', failure_reason: 'ci_quota_exceeded' }, { name: 'lint', failure_reason: 'ci_quota_exceeded' }] });
  assert.strictEqual(q.estado, 'sin-cuota');
  const mixto = normalizarGitlab({ pipeline: { id: 9, status: 'failed' }, jobsFallidos: [{ name: 'a', failure_reason: 'ci_quota_exceeded' }, { name: 'b', failure_reason: 'script_failure' }] });
  assert.strictEqual(mixto.estado, 'rojo', 'si algún job falló por código, es rojo');
});

// ---- Adaptadores ----

test('adaptador GitHub: lee el head SHA del PR, sus checks y las anotaciones de los fallidos', async () => {
  const ll = apiFalsa(GH, [
    [/^repos\/org\/repo\/pulls\/5$/, () => ({ status: 200, body: { number: 5, head: { sha: 'abc' } } })],
    [/^repos\/org\/repo\/commits\/abc\/check-runs/, () => ({ status: 200, body: { total_count: 1, check_runs: [run({ id: 77, conclusion: 'failure' })] } })],
    [/^repos\/org\/repo\/commits\/abc\/status$/, () => ({ status: 200, body: { state: 'pending', total_count: 0, statuses: [] } })],
    [/^repos\/org\/repo\/check-runs\/77\/annotations$/, () => ({ status: 200, body: [{ message: FACTURACION }] })],
  ]);
  const r = await (await github()).estadoCi(5);
  assert.ok(r.ok);
  assert.strictEqual(r.estado, 'sin-cuota');
  assert.strictEqual(r.sha, 'abc');
  assert.ok(ll.some((l) => /check-runs\/77\/annotations/.test(l.ruta)));
});

test('adaptador GitHub: sin checks → sin-ci (el estado combinado vacío no es pendiente)', async () => {
  apiFalsa(GH, [
    [/^repos\/org\/repo\/pulls\/5$/, () => ({ status: 200, body: { number: 5, head: { sha: 'abc' } } })],
    [/^repos\/org\/repo\/commits\/abc\/check-runs/, () => ({ status: 200, body: { total_count: 0, check_runs: [] } })],
    [/^repos\/org\/repo\/commits\/abc\/status$/, () => ({ status: 200, body: { state: 'pending', total_count: 0, statuses: [] } })],
  ]);
  assert.strictEqual((await (await github()).estadoCi(5)).estado, 'sin-ci');
});

test('adaptador GitHub: PR inexistente → ok false con motivo', async () => {
  apiFalsa(GH, []);
  const r = await (await github()).estadoCi(5);
  assert.strictEqual(r.ok, false);
  assert.match(r.msg, /HTTP 404/);
});

test('adaptador GitLab: lee head_pipeline del MR y los jobs fallidos', async () => {
  const ll = apiFalsa(GL, [
    [/^projects\/g%2Fp\/merge_requests\/7$/, () => ({ status: 200, body: { iid: 7, sha: 'def', head_pipeline: { id: 9, status: 'failed' } } })],
    [/^projects\/g%2Fp\/pipelines\/9\/jobs/, () => ({ status: 200, body: [{ name: 'test', status: 'failed', failure_reason: 'ci_quota_exceeded' }] })],
  ]);
  const r = await (await gitlab()).estadoCi(7);
  assert.ok(r.ok);
  assert.strictEqual(r.estado, 'sin-cuota');
  assert.strictEqual(r.sha, 'def');
  assert.ok(ll.some((l) => /pipelines\/9\/jobs/.test(l.ruta)));
});

test('adaptador GitLab: MR sin pipeline → sin-ci sin pedir jobs', async () => {
  const ll = apiFalsa(GL, [[/^projects\/g%2Fp\/merge_requests\/7$/, () => ({ status: 200, body: { iid: 7, sha: 'def', head_pipeline: null } })]]);
  const r = await (await gitlab()).estadoCi(7);
  assert.strictEqual(r.estado, 'sin-ci');
  assert.ok(!ll.some((l) => /jobs/.test(l.ruta)));
});

test('adaptador GitHub: estadoCiCommit lee el CI de un commit (develop al publicar)', async () => {
  apiFalsa(GH, [
    [/^repos\/org\/repo\/commits\/fed\/check-runs/, () => ({ status: 200, body: { total_count: 1, check_runs: [run({ id: 3, conclusion: 'failure', name: 'lint' })] } })],
    [/^repos\/org\/repo\/commits\/fed\/status$/, () => ({ status: 200, body: { state: 'pending', total_count: 0, statuses: [] } })],
    [/^repos\/org\/repo\/check-runs\/3\/annotations$/, () => ({ status: 200, body: [{ message: 'Process completed with exit code 1.' }] })],
  ]);
  const r = await (await github()).estadoCiCommit('fed');
  assert.deepStrictEqual([r.ok, r.estado, r.fallidos], [true, 'rojo', ['lint']]);
});

test('adaptador GitLab: estadoCiCommit toma el último pipeline del commit; sin pipeline, sin-ci', async () => {
  const ll = apiFalsa(GL, [[/^projects\/g%2Fp\/pipelines\?sha=fed/, () => ({ status: 200, body: [{ id: 4, status: 'success' }] })]]);
  const r = await (await gitlab()).estadoCiCommit('fed');
  assert.deepStrictEqual([r.ok, r.estado], [true, 'verde']);
  assert.ok(ll.some((l) => /order_by=id/.test(l.ruta)));
  apiFalsa(GL, [[/^projects\/g%2Fp\/pipelines\?sha=fed/, () => ({ status: 200, body: [] })]]);
  assert.strictEqual((await (await gitlab()).estadoCiCommit('fed')).estado, 'sin-ci');
});
