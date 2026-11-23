// #22 — Guardas del harness APAGADAS por defecto: ningun hook bloquea, pregunta ni avisa al escribir o
// ejecutar; decide el desarrollador. FARO_GUARDAS=on las vuelve a encender (asi corre el resto de la suite).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');
const require = createRequire(import.meta.url);
const gm = require('../plugins/faro/hooks/lib/guardas-modo.js');

const hook = (cmd, payload, guardas) => spawnSync(process.execPath, [HARNESS, cmd], {
  cwd: RAIZ, encoding: 'utf8', timeout: 60000, windowsHide: true,
  input: JSON.stringify(payload),
  env: { ...process.env, FARO_GUARDAS: guardas, CLAUDE_PROJECT_DIR: RAIZ },
});
const BASH = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, session_id: 't-guardas' });

test('guardasActivas: apagadas salvo FARO_GUARDAS=on|1|true|si|estricto', () => {
  assert.strictEqual(gm.guardasActivas({}), false);
  assert.strictEqual(gm.guardasActivas({ FARO_GUARDAS: '' }), false);
  assert.strictEqual(gm.guardasActivas({ FARO_GUARDAS: 'off' }), false);
  for (const v of ['on', '1', 'true', 'si', 'estricto', ' ON ']) assert.strictEqual(gm.guardasActivas({ FARO_GUARDAS: v }), true, v);
});

test('hookSilenciado: los hooks de guarda callan; vigilar solo en el arranque; el resto no', () => {
  for (const c of gm.HOOKS_DE_GUARDA) assert.strictEqual(gm.hookSilenciado(c, [], {}), true, c);
  assert.strictEqual(gm.hookSilenciado('vigilar', [], {}), true);
  assert.strictEqual(gm.hookSilenciado('vigilar', ['--ahora'], {}), false);
  for (const c of ['session', 'prompt-context', 'validate', 'pr']) assert.strictEqual(gm.hookSilenciado(c, [], {}), false, c);
  assert.strictEqual(gm.hookSilenciado('pre-bash', [], { FARO_GUARDAS: 'on' }), false);
});

test('por defecto: un comando destructivo y un borrado pasan sin decision ni aviso', () => {
  for (const c of ['git reset --hard HEAD~1', 'rm -rf ./build', 'git push --force origin main']) {
    const r = hook('pre-bash', BASH(c), '');
    assert.strictEqual(r.status, 0, c + r.stderr);
    assert.strictEqual(r.stdout.trim(), '', `${c}: ${r.stdout}`);
  }
});

test('por defecto: escribir un fichero sensible no se bloquea ni se avisa', () => {
  const r = hook('pre-doc', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(RAIZ, '.env'), content: 'X=1' } }, '');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), '');
});

test('FARO_GUARDAS=on: vuelve el bloqueo de siempre', () => {
  const r = hook('pre-bash', BASH('git reset --hard HEAD~1'), 'on');
  assert.match(r.stdout, /"permissionDecision":"(deny|ask)"/, r.stdout + r.stderr);
});
