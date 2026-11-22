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

// ---- Regresiones de la ronda 1 (clasificar) ----
test('clasificar: un test llamado "billing" que falla es test, no cuota; "runner timeout" tambien', () => {
  const c = CF.clasificar({ status: 'completed', conclusion: 'failure' }, 'not ok 1 - billing: spending limit se aplica\n  error: expected 1 got 2\n');
  assert.strictEqual(c.estado, 'test');
  assert.strictEqual(CF.clasificar({ status: 'completed', conclusion: 'failure' }, 'not ok 2 - runner timed out se reintenta\n').estado, 'test');
});
test('clasificar: waiting, requested y pending dan pendiente; manual (GitLab) tambien', () => {
  for (const status of ['waiting', 'requested', 'pending', 'manual']) assert.strictEqual(CF.clasificar({ status, esperaAgotada: true }, '').estado, 'pendiente', status);
});
test('clasificar: timed_out es infra; cancelled es infra con motivo cancelado', () => {
  assert.strictEqual(CF.clasificar({ status: 'completed', conclusion: 'timed_out' }, '').estado, 'infra');
  const c = CF.clasificar({ status: 'completed', conclusion: 'cancelled' }, '');
  assert.strictEqual(c.estado, 'infra'); assert.match(c.motivo, /cancelado/);
});
test('limpiar: quita ANSI y caracteres de control; el ANSI no esconde un test fallido', () => {
  assert.strictEqual(CF.limpiar('\u001b[31mrojo\u001b[0m\u0007\u0000x'), 'rojox');
  assert.strictEqual(CF.clasificar({ status: 'completed', conclusion: 'failure' }, '\u001b[31mnot ok 1 - a\u001b[0m').estado, 'test');
});

// ---- Orquestacion: el estado viene del contrato de forja (estadoCiCommit); gh/glab solo dan el detalle ----
const SHA = 'abc1234def5678';
function repoTmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-cifallos-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'test:afectados': 'x' } }));
  return root;
}
const exGithub = (runs, log = '') => (cmd, args) => {
  const a = args.join(' ');
  assert.strictEqual(cmd, 'gh');
  assert.ok(!/rerun|cancel|comment/.test(a), 'solo lectura');
  if (a.startsWith('run list')) { assert.ok(a.includes(`--commit ${SHA}`), 'consulta por el sha de HEAD'); return { ok: true, out: JSON.stringify(runs) }; }
  if (a.includes('--log-failed')) return { ok: true, out: log };
  if (a.startsWith('pr view')) { assert.ok(args.includes('--') && args.indexOf('--') < args.length - 1, 'rama tras --'); return { ok: true, out: '{"number":42}' }; }
  return { ok: false, out: '' };
};
const base = (root, extra = {}) => {
  const salida = []; const durmio = []; let red = 0;
  return {
    salida, durmio, redLlamadas: () => red,
    deps: { root, forja: 'github', rama: 'feat/x', sha: SHA, args: [], salida: (l) => salida.push(l), ahora: () => 1000, dormir: async (ms) => { durmio.push(ms); }, redMinima: () => { red++; return { ok: true }; }, ramaExiste: () => true, estadoCommit: async () => ({ ok: true, estado: 'verde', fallidos: [] }), ...extra },
  };
};

test('fallos: sin sesion -> sin-acceso con instruccion; error de red -> error, no sin-acceso', async () => {
  let b = base(repoTmp(), { estadoCommit: async () => ({ ok: false, sinToken: true }) });
  let r = await CF.fallos(b.deps);
  assert.strictEqual(r.estado, 'sin-acceso'); assert.strictEqual(r.codigo, 0);
  assert.match(b.salida.join('\n'), /! gh auth login/);
  b = base(repoTmp(), { forja: 'gitlab', estadoCommit: async () => ({ ok: false, sinToken: true }) });
  await CF.fallos(b.deps);
  assert.match(b.salida.join('\n'), /! glab auth login/);
  b = base(repoTmp(), { estadoCommit: async () => ({ ok: false, msg: 'HTTP 502' }) });
  r = await CF.fallos(b.deps);
  assert.strictEqual(r.estado, 'error'); assert.strictEqual(r.codigo, 1);
  assert.doesNotMatch(b.salida.join('\n'), /auth login/);
});

test('fallos: verde; sin runs para el sha no es verde', async () => {
  let b = base(repoTmp());
  assert.strictEqual((await CF.fallos(b.deps)).estado, 'verde');
  b = base(repoTmp(), { estadoCommit: async () => ({ ok: true, estado: 'sin-ci', fallidos: [] }) });
  const r = await CF.fallos(b.deps);
  assert.strictEqual(r.estado, 'sin-ci'); assert.notStrictEqual(r.estado, 'verde');
});

test('fallos: rojo -> test (codigo 1, sin red minima, salida <= 40 lineas)', async () => {
  const log = LOG_TEST + '\n' + Array.from({ length: 200 }, (_, i) => `not ok ${i + 5} - t${i}\n  error: e${i}`).join('\n');
  const b = base(repoTmp(), { estadoCommit: async () => ({ ok: true, estado: 'rojo', fallidos: ['build'] }), ex: exGithub([{ databaseId: 7, status: 'completed', conclusion: 'failure' }], log) });
  const r = await CF.fallos(b.deps);
  assert.strictEqual(r.estado, 'test'); assert.strictEqual(r.codigo, 1);
  assert.match(b.salida.join('\n'), /suma de negativos/);
  assert.ok(b.salida.join('\n').split('\n').length <= 40);
  assert.strictEqual(b.redLlamadas(), 0);
});

test('fallos: rojo con un test "billing" que falla -> test y no cuota', async () => {
  const b = base(repoTmp(), { estadoCommit: async () => ({ ok: true, estado: 'rojo', fallidos: ['build'] }), ex: exGithub([{ databaseId: 7, status: 'completed', conclusion: 'failure' }], 'not ok 1 - billing: spending limit\n  error: expected 1') });
  assert.strictEqual((await CF.fallos(b.deps)).estado, 'test');
});

test('fallos: rojo por timed_out -> infra; cancelled -> infra cancelado; ambos codigo 1 sin reintento', async () => {
  let b = base(repoTmp(), { estadoCommit: async () => ({ ok: true, estado: 'rojo', fallidos: ['build'] }), ex: exGithub([{ databaseId: 7, status: 'completed', conclusion: 'timed_out' }]) });
  let r = await CF.fallos(b.deps);
  assert.strictEqual(r.estado, 'infra'); assert.strictEqual(r.codigo, 1);
  b = base(repoTmp(), { estadoCommit: async () => ({ ok: true, estado: 'rojo', fallidos: ['build'] }), ex: exGithub([{ databaseId: 7, status: 'completed', conclusion: 'cancelled' }]) });
  r = await CF.fallos(b.deps);
  assert.strictEqual(r.estado, 'infra'); assert.strictEqual(r.codigo, 1);
  assert.match(b.salida.join('\n'), /cancelado/);
});

// El fixture de GitHub pasa por el adaptador REAL (github-contrato + estado-ci): run failure sin log y con la
// anotacion de facturacion en el check-run -> cuota, codigo 0.
test('fallos: GitHub run failure sin log con anotacion de pagos fallidos -> cuota y codigo 0 (adaptador real)', async () => {
  const ghApi = async (ruta) => {
    if (/check-runs\?/.test(ruta)) return { ok: true, status: 200, body: { check_runs: [{ id: 99, name: 'build', status: 'completed', conclusion: 'failure' }] } };
    if (/\/status$/.test(ruta)) return { ok: true, status: 200, body: { statuses: [] } };
    if (/check-runs\/99\/annotations/.test(ruta)) return { ok: true, status: 200, body: [{ message: 'The job was not started because recent account payments have failed or your spending limit needs to be increased.' }] };
    return { ok: false, status: 404, body: null };
  };
  const contrato = createRequire(import.meta.url)(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'github-contrato.js'))({ ghApi, ghRepo: () => ({ org: 'o', repo: 'r' }), ghToken: () => 't', ghHost: () => 'github.com', ensureUser: async () => ({}) });
  const root = repoTmp();
  const b = base(root, { estadoCommit: contrato.estadoCiCommit, ex: () => ({ ok: true, out: '' }) });
  const r = await CF.fallos(b.deps);
  assert.strictEqual(r.estado, 'cuota'); assert.strictEqual(r.codigo, 0);
  assert.match(b.salida.join('\n'), /pendiente de validar en CI/);
  assert.strictEqual(b.redLlamadas(), 1);
  assert.strictEqual(CF.leerPendientes(root)[0].sha, SHA);
});

test('fallos: cuota -> linea en ci-pendientes.jsonl; sin red minima avisa de que no se valido nada', async () => {
  const root = repoTmp();
  const b = base(root, { estadoCommit: async () => ({ ok: true, estado: 'sin-cuota', fallidos: ['build'] }), ex: exGithub([]), redMinima: () => ({ ok: true, omitida: true }) });
  const r = await CF.fallos(b.deps);
  assert.strictEqual(r.estado, 'cuota'); assert.strictEqual(r.codigo, 0);
  assert.match(b.salida.join('\n'), /sin tests locales que correr/);
  const l = CF.leerPendientes(root);
  assert.deepStrictEqual({ rama: l[0].rama, sha: l[0].sha, pr: l[0].pr, motivo: l[0].motivo }, { rama: 'feat/x', sha: SHA, pr: 42, motivo: 'cuota' });
  assert.ok(l[0].fecha);
});

test('fallos: en curso espera con sleep inyectado y acaba pendiente sin esperar de verdad', async () => {
  let t = 0;
  const b = base(repoTmp(), { estadoCommit: async () => ({ ok: true, estado: 'pendiente', fallidos: [] }), ex: exGithub([]), ahora: () => t, dormir: async (ms) => { t += ms; } });
  const r = await CF.fallos(b.deps);
  assert.strictEqual(r.estado, 'pendiente'); assert.strictEqual(r.codigo, 0);
  assert.ok(t >= 15 * 60000 && t <= 16 * 60000, `espero ${t} ms simulados`);
  assert.strictEqual(b.redLlamadas(), 1);
});

test('fallos: GitLab rojo con runner_system_failure -> infra; sin-cuota del contrato -> cuota', async () => {
  const exGl = (jobs) => (cmd, args) => {
    const a = args.join(' ');
    assert.strictEqual(cmd, 'glab');
    if (/pipelines\?sha=/.test(a)) return { ok: true, out: '[{"id":1}]' };
    if (/\/jobs\?/.test(a)) return { ok: true, out: JSON.stringify(jobs) };
    return { ok: true, out: '' };
  };
  let b = base(repoTmp(), { forja: 'gitlab', estadoCommit: async () => ({ ok: true, estado: 'rojo', fallidos: ['t'] }), ex: exGl([{ id: 5, name: 't', failure_reason: 'runner_system_failure' }]) });
  assert.strictEqual((await CF.fallos(b.deps)).estado, 'infra');
  b = base(repoTmp(), { forja: 'gitlab', estadoCommit: async () => ({ ok: true, estado: 'sin-cuota', fallidos: ['t'] }), ex: exGl([]) });
  assert.strictEqual((await CF.fallos(b.deps)).estado, 'cuota');
});

test('fallos --pendientes: consulta por el sha anotado; quita verdes y ramas desaparecidas; deduplica por rama', async () => {
  const root = repoTmp();
  const SA = 'aaaaaaa1'; const SA2 = 'aaaaaaa2'; const SB = 'bbbbbbb1'; const SC = 'ccccccc1';
  CF.escribirPendientes(root, [
    { rama: 'a', sha: SA, pr: 1, motivo: 'cuota', fecha: 'f' },
    { rama: 'a', sha: SA2, pr: 1, motivo: 'cuota', fecha: 'f2' },
    { rama: 'b', sha: SB, pr: 2, motivo: 'pendiente', fecha: 'f' },
    { rama: 'c', sha: SC, pr: 3, motivo: 'cuota', fecha: 'f' },
    { rama: '--web', sha: SA, pr: 4, motivo: 'cuota', fecha: 'f' },
    { rama: 'd', sha: 'no-es-sha', pr: 5, motivo: 'cuota', fecha: 'f' },
  ]);
  const consultados = [];
  const estadoCommit = async (sha) => { consultados.push(sha); return { ok: true, estado: sha === SA2 ? 'verde' : 'pendiente', fallidos: [] }; };
  const b = base(root, { args: ['--pendientes'], estadoCommit, ramaExiste: (r) => r !== 'c' });
  const r = await CF.fallos(b.deps);
  assert.strictEqual(r.codigo, 0);
  assert.deepStrictEqual(consultados.sort(), [SA2, SB].sort());
  assert.deepStrictEqual(CF.leerPendientes(root).map((e) => e.rama), ['b']);
  assert.strictEqual(b.durmio.length, 0);
  assert.strictEqual(b.redLlamadas(), 0);
});

test('validacion: rama --web y sha no hexadecimal se descartan; la rama nunca llega a gh como opcion', async () => {
  assert.strictEqual(CF.rutaRamaValida('--web'), false);
  assert.strictEqual(CF.rutaRamaValida('feat/ok'), true);
  assert.strictEqual(CF.rutaRamaValida('a\nb'), false);
  const root = repoTmp(); const llamadas = [];
  const b = base(root, { rama: '--web', estadoCommit: async () => ({ ok: true, estado: 'sin-cuota', fallidos: [] }), ex: (c, a) => { llamadas.push(a.join(' ')); return { ok: true, out: '' }; } });
  await CF.fallos(b.deps);
  assert.deepStrictEqual(llamadas, []);
  assert.deepStrictEqual(CF.leerPendientes(root), []);
  const b2 = base(repoTmp(), { sha: '--oops' });
  const r = await CF.fallos(b2.deps);
  assert.strictEqual(r.codigo, 1);
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
