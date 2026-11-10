// El motor no envia ni guarda datos de uso (#253): requisito previo para publicar su codigo.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(RAIZ, 'plugins', 'faro');
const HOOKS = path.join(PLUGIN, 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');

function ficheros(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? ficheros(p) : [p];
  });
}

function repoVacio() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-sin-telemetria-'));
  spawnSync('git', ['init'], { cwd: dir, windowsHide: true });
  return dir;
}

function harness(args, cwd, input = '') {
  const env = { ...process.env, FARO_METRICS_URL: 'http://127.0.0.1:9/no-debe-llamarse' };
  return spawnSync(process.execPath, [HARNESS, ...args], { cwd, input, env, encoding: 'utf8', windowsHide: true });
}

test('el plugin no incluye modulos de metricas', () => {
  assert.ok(!fs.existsSync(path.join(HOOKS, 'lib', 'metrics.js')));
  assert.ok(!fs.existsSync(path.join(HOOKS, 'lib', 'metrics-send.js')));
});

test('el codigo distribuido no contiene el panel ni su credencial', () => {
  const conPanel = ficheros(PLUGIN).filter((f) => /faro-panel\.|FARO_METRICS_TOKEN|faro\.metricsToken/.test(fs.readFileSync(f, 'latin1')));
  assert.deepStrictEqual(conPanel, []);
});

test('ningun hook se dispara para metricas', () => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  assert.strictEqual(hooks.SessionEnd, undefined);
});

test('harness.js ya no tiene el comando metrics', () => {
  const r = harness(['metrics', '--example', '--no-post'], repoVacio());
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /subcomando desconocido 'metrics'/);
});

test('una sesion completa no crea .metrics', () => {
  const dir = repoVacio();
  harness(['session'], dir);
  harness(['stop-check'], dir, JSON.stringify({ session_id: 's1', transcript_path: path.join(dir, 'no-existe.jsonl') }));
  assert.ok(!fs.existsSync(path.join(dir, '.metrics')));
});

// #261: fuera webhooks, n8n y los restos de .metrics/. FARO no envia nada a ningun sitio.
test('el repo no trae flujos de webhooks ni la guia del gestor retirado', () => {
  assert.ok(!fs.existsSync(path.join(RAIZ, 'n8n')));
  assert.ok(!fs.existsSync(path.join(RAIZ, 'CLICKUP.md')));
});

test('el plugin no habla de webhooks propios', () => {
  const con = ficheros(PLUGIN).filter((f) => /webhook/i.test(fs.readFileSync(f, 'latin1'))).map((f) => path.relative(RAIZ, f));
  assert.deepStrictEqual(con, []);
});

test('validate ya no vigila .metrics/: no queda nada que lo cree', () => {
  const dir = repoVacio();
  fs.mkdirSync(path.join(dir, '.metrics'));
  fs.writeFileSync(path.join(dir, '.metrics', 'uso.jsonl'), '{}\n');
  spawnSync('git', ['add', '-A', '-f'], { cwd: dir, windowsHide: true });
  const r = harness(['validate'], dir);
  assert.doesNotMatch(r.stdout + r.stderr, /\.metrics/);
});

test('el esqueleto del wizard no reserva .metrics/ en el .gitignore', () => {
  const gi = fs.readFileSync(path.join(RAIZ, 'cli', 'bin', 'esqueleto', 'gitignore'), 'utf8');
  assert.doesNotMatch(gi, /metrics|telemetria/i);
});
