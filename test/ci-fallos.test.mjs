// Task 10: `harness.js ci fallos`. Fixtures de GitHub y GitLab, reloj y sleep inyectados: sin red ni esperas.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CF = createRequire(import.meta.url)(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'ci-fallos.js'));

const LOG_TEST = [
  'build\tTest\t2026-11-22T10:00:00.0Z # Subtest: suma',
  'build\tTest\t2026-11-22T10:00:01.0Z not ok 3 - suma de negativos',
  'build\tTest\t2026-11-22T10:00:01.0Z   error: \'Expected values to be equal: 1 !== 2\'',
  'build\tTest\t2026-11-22T10:00:01.0Z   at test/suma.test.mjs:12:5',
].join('\n');

test('clasificar: verde', () => {
  assert.strictEqual(CF.clasificar({ status: 'completed', conclusion: 'success' }, '').estado, 'verde');
  assert.strictEqual(CF.clasificar({ status: 'completed', conclusion: 'success', fallidos: [] }, '').estado, 'verde');
});

test('clasificar: test (GitHub) con test, error y fichero', () => {
  const c = CF.clasificar({ status: 'completed', conclusion: 'failure' }, LOG_TEST);
  assert.strictEqual(c.estado, 'test');
  assert.strictEqual(c.test, 'suma de negativos');
  assert.match(c.error, /Expected values/);
  assert.strictEqual(c.fichero, 'test/suma.test.mjs');
});

test('clasificar: test (GitLab, ✖ y FAIL) y tope de 40 lineas', () => {
  const c = CF.clasificar({ status: 'completed', conclusion: 'failure', fallidos: [{ failure_reason: 'script_failure' }] }, '✖ falla uno (3ms)\n  AssertionError: x\nFAIL src/a.test.ts\n');
  assert.strictEqual(c.estado, 'test');
  assert.strictEqual(c.test, 'falla uno (3ms)');
  const enorme = Array.from({ length: 500 }, (_, i) => `not ok ${i} - t${i}\n  error: e${i}`).join('\n');
  const g = CF.clasificar({ status: 'completed', conclusion: 'failure' }, enorme);
  assert.ok(g.fallos.length <= 40 && g.fallos.length * 2 <= 42);
});

test('clasificar: cuota por startup_failure, por patrones y por GitLab', () => {
  assert.strictEqual(CF.clasificar({ status: 'completed', conclusion: 'startup_failure' }, '').estado, 'cuota');
  for (const t of ['billing', 'spending limit', 'account is locked', 'minutes quota', 'compute minutes', 'No more CI minutes']) {
    assert.strictEqual(CF.clasificar({ status: 'completed', conclusion: 'failure' }, `x ${t} y`).estado, 'cuota', t);
    assert.strictEqual(CF.clasificar({ status: 'completed', conclusion: 'failure', anotaciones: [t] }, '').estado, 'cuota', `anotacion ${t}`);
  }
  assert.strictEqual(CF.clasificar({ status: 'completed', conclusion: 'failure', fallidos: [{ failure_reason: 'ci_quota_exceeded' }] }, '').estado, 'cuota');
});

test('clasificar: pendiente (pasada la espera o atascado) y en-curso antes', () => {
  assert.strictEqual(CF.clasificar({ status: 'queued', esperaAgotada: true }, '').estado, 'pendiente');
  assert.strictEqual(CF.clasificar({ status: 'in_progress', esperaAgotada: true }, '').estado, 'pendiente');
  assert.strictEqual(CF.clasificar({ status: 'queued', stuck: true }, '').estado, 'pendiente');
  assert.strictEqual(CF.clasificar({ status: 'in_progress' }, '').estado, 'en-curso');
});

test('clasificar: infra', () => {
  assert.strictEqual(CF.clasificar({ status: 'completed', conclusion: 'runner_system_failure' }, '').estado, 'infra');
  assert.strictEqual(CF.clasificar({ status: 'completed', conclusion: 'failure', fallidos: [{ failure_reason: 'runner_system_failure' }] }, '').estado, 'infra');
  assert.strictEqual(CF.clasificar({ status: 'completed', conclusion: 'failure' }, 'The runner has received a shutdown signal').estado, 'infra');
});

// ---- Orquestacion con gh/glab simulados ----
function repoTmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-cifallos-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'test:afectados': 'x' } }));
  return root;
}
const exGithub = (run, log = '') => (cmd, args) => {
  const a = args.join(' ');
  assert.strictEqual(cmd, 'gh');
  assert.ok(!/rerun|cancel|comment/.test(a), 'solo lectura');
  if (a.startsWith('run list')) return { ok: true, out: JSON.stringify([{ databaseId: 7, status: run.status, conclusion: run.conclusion, headSha: 'abc123' }]) };
  if (a.includes('--log-failed')) return { ok: true, out: log };
  if (a.startsWith('run view')) return { ok: true, out: JSON.stringify({ status: run.status, conclusion: run.conclusion, jobs: [{ name: 'build', conclusion: run.conclusion }] }) };
  if (a.startsWith('pr view')) return { ok: true, out: '{"number":42}' };
  return { ok: false, out: '' };
};
const base = (root, extra = {}) => {
  const salida = []; let relojes = 0; const durmio = []; let red = 0;
  return {
    salida, durmio, redLlamadas: () => red,
    deps: { root, forja: 'github', rama: 'feat/x', args: [], salida: (l) => salida.push(l), ahora: () => (relojes += 0) + 1000, dormir: async (ms) => { durmio.push(ms); }, redMinima: () => { red++; return { ok: true }; }, ...extra },
  };
};

test('fallos: sin gh o sin sesion -> sin-acceso con instruccion, codigo 0', async () => {
  const b = base(repoTmp(), { ex: () => ({ ok: false, falta: true, out: '' }) });
  const r = await CF.fallos(b.deps);
  assert.strictEqual(r.estado, 'sin-acceso'); assert.strictEqual(r.codigo, 0);
  assert.match(b.salida.join('\n'), /! gh auth login/);
  const b2 = base(repoTmp(), { forja: 'gitlab', ex: () => ({ ok: false, out: '' }) });
  await CF.fallos(b2.deps);
  assert.match(b2.salida.join('\n'), /! glab auth login/);
});

test('fallos: verde y test (codigo 1, sin red minima)', async () => {
  let b = base(repoTmp(), { ex: exGithub({ status: 'completed', conclusion: 'success' }) });
  assert.strictEqual((await CF.fallos(b.deps)).estado, 'verde');
  b = base(repoTmp(), { ex: exGithub({ status: 'completed', conclusion: 'failure' }, LOG_TEST) });
  const r = await CF.fallos(b.deps);
  assert.strictEqual(r.estado, 'test'); assert.strictEqual(r.codigo, 1);
  assert.match(b.salida.join('\n'), /suma de negativos/);
  assert.strictEqual(b.redLlamadas(), 0);
});

test('fallos: cuota -> red minima, linea en ci-pendientes.jsonl, codigo 0', async () => {
  const root = repoTmp();
  const b = base(root, { ex: exGithub({ status: 'completed', conclusion: 'startup_failure' }) });
  const r = await CF.fallos(b.deps);
  assert.strictEqual(r.estado, 'cuota'); assert.strictEqual(r.codigo, 0);
  assert.strictEqual(b.redLlamadas(), 1);
  assert.match(b.salida.join('\n'), /pendiente de validar en CI/);
  const l = CF.leerPendientes(root);
  assert.strictEqual(l.length, 1);
  assert.deepStrictEqual({ rama: l[0].rama, sha: l[0].sha, pr: l[0].pr, motivo: l[0].motivo }, { rama: 'feat/x', sha: 'abc123', pr: 42, motivo: 'cuota' });
  assert.ok(l[0].fecha);
});

test('fallos: en curso espera con sleep inyectado y acaba pendiente sin esperar de verdad', async () => {
  const root = repoTmp(); let t = 0;
  const b = base(root, { ex: exGithub({ status: 'in_progress', conclusion: null }), ahora: () => t, dormir: async (ms) => { t += ms; } });
  const r = await CF.fallos(b.deps);
  assert.strictEqual(r.estado, 'pendiente'); assert.strictEqual(r.codigo, 0);
  assert.ok(t >= 15 * 60000 && t <= 16 * 60000, `espero ${t} ms simulados`);
  assert.strictEqual(b.redLlamadas(), 1);
});

test('fallos: GitLab con ci_quota_exceeded y pipeline atascado', async () => {
  const exGl = (pipeline, jobs) => (cmd, args) => {
    const a = args.join(' ');
    assert.strictEqual(cmd, 'glab');
    if (/pipelines\?ref/.test(a)) return { ok: true, out: JSON.stringify([pipeline]) };
    if (/\/jobs\?/.test(a)) return { ok: true, out: JSON.stringify(jobs) };
    if (/merge_requests/.test(a)) return { ok: true, out: '[{"iid":9}]' };
    return { ok: true, out: '' };
  };
  let b = base(repoTmp(), { forja: 'gitlab', ex: exGl({ id: 1, status: 'failed', sha: 's1' }, [{ id: 5, name: 't', status: 'failed', failure_reason: 'ci_quota_exceeded' }]) });
  assert.strictEqual((await CF.fallos(b.deps)).estado, 'cuota');
  b = base(repoTmp(), { forja: 'gitlab', ex: exGl({ id: 2, status: 'pending', sha: 's2' }, [{ id: 6, name: 't', status: 'pending', stuck: true }]) });
  assert.strictEqual((await CF.fallos(b.deps)).estado, 'pendiente');
});

test('fallos --pendientes: quita las en verde y conserva el resto', async () => {
  const root = repoTmp();
  CF.escribirPendientes(root, [
    { rama: 'a', sha: 's1', pr: 1, motivo: 'cuota', fecha: 'f' },
    { rama: 'b', sha: 's2', pr: 2, motivo: 'pendiente', fecha: 'f' },
  ]);
  const ex = (cmd, args) => {
    const a = args.join(' '); const rama = args[args.indexOf('--branch') + 1];
    if (a.startsWith('run list')) return { ok: true, out: JSON.stringify([{ databaseId: 1, status: rama === 'a' ? 'completed' : 'queued', conclusion: rama === 'a' ? 'success' : null, headSha: rama === 'a' ? 's1' : 's2' }]) };
    return { ok: true, out: '{"jobs":[]}' };
  };
  const b = base(root, { ex, args: ['--pendientes'] });
  const r = await CF.fallos(b.deps);
  assert.strictEqual(r.codigo, 0);
  assert.deepStrictEqual(CF.leerPendientes(root).map((e) => e.rama), ['b']);
  assert.strictEqual(b.durmio.length, 0);
  assert.strictEqual(b.redLlamadas(), 0);
});

test('comandoRedMinima: test:afectados, o npm test, o nada', () => {
  const root = repoTmp();
  assert.deepStrictEqual(CF.comandoRedMinima(root), { cmd: 'npm', args: ['run', 'test:afectados'] });
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"x"}}');
  assert.deepStrictEqual(CF.comandoRedMinima(root), { cmd: 'npm', args: ['test'] });
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  assert.strictEqual(CF.comandoRedMinima(root), null);
});

test('el lib no usa credenciales ni secretos', () => {
  const src = fs.readFileSync(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'ci-fallos.js'), 'utf8');
  assert.ok(!/secrets\.|GITHUB_TOKEN|process\.env/.test(src));
});
