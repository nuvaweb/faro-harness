// #249 — en un monorepo con dominios, el Stop de TDD pedia `pnpm test` del repo entero aunque la app tocada
// acababa de pasar su propia bateria en verde: el verde de la app no cubria el dominio, y un dominio sin tests
// propios ordenaba el comando base solo (la suite completa).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');

const escribir = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const hook = (dir, cmd, payload, cwd = dir) => {
  const r = spawnSync(process.execPath, [HARNESS, cmd], {
    cwd: dir, encoding: 'utf8', timeout: 120000, windowsHide: true,
    input: JSON.stringify({ session_id: 'ses-1', cwd, ...payload }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: path.join(os.tmpdir(), 'faro-249-data', path.basename(dir)) },
  });
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
};
const preEdit = (dir, rel) => hook(dir, 'tdd-pre', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, rel), old_string: 'a', new_string: 'b' } });
const run = (dir, command, cwd, salida = ' Test Files  3 passed (3)\n      Tests  28 passed (28)\n') =>
  hook(dir, 'tdd-post', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: salida, stderr: '', interrupted: false } }, cwd);
const stop = (dir) => hook(dir, 'tdd-stop', { hook_event_name: 'Stop', stop_hook_active: false });

function monorepo(dominio) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-249-'));
  escribir(dir, 'ESTADO.md', '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\n---\n### Fase 1 · Una — in_progress\n');
  escribir(dir, '.faro.json', JSON.stringify({
    monorepo: { apps: { 'portal-demo': { rol: 'Portal' } } },
    tests: { comando: 'pnpm test', dominios: { portal: dominio } },
  }));
  escribir(dir, 'package.json', JSON.stringify({ name: 'mono', private: true, scripts: { test: 'pnpm -r test' } }));
  escribir(dir, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n');
  escribir(dir, 'apps/portal-demo/package.json', JSON.stringify({ name: 'portal-demo', version: '1.0.0', scripts: { test: 'vitest run' } }));
  escribir(dir, 'apps/portal-demo/src/cuadrante.ts', 'export const guardar = (x: number) => x;\n');
  escribir(dir, 'apps/portal-demo/src/cuadrante.test.ts', "import { guardar } from './cuadrante';\ntest('g', () => { expect(guardar(1)).toBe(1); });\n");
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T'); git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

const CON_TESTS = { descripcion: 'Portal', codigo: ['apps/portal-demo/src/**'], tests: ['apps/portal-demo/src/cuadrante.test.ts'] };
const SIN_TESTS = { descripcion: 'Portal', codigo: ['apps/portal-demo/src/**'], tests: [] };

test('el verde propio de la app, despues de editar, cubre su dominio: el Stop no pide nada', () => {
  const dir = monorepo(CON_TESTS);
  preEdit(dir, 'apps/portal-demo/src/cuadrante.ts');
  run(dir, 'pnpm test', path.join(dir, 'apps', 'portal-demo'));
  const s = stop(dir);
  assert.strictEqual(s.status, 0, s.err);
  assert.doesNotMatch(s.out + s.err, /pnpm test/);
});

test('un dominio sin tests propios nunca ordena la suite completa', () => {
  const dir = monorepo(SIN_TESTS);
  preEdit(dir, 'apps/portal-demo/src/cuadrante.ts');
  const s = stop(dir);
  assert.doesNotMatch(s.err, /ejecuta `pnpm test`/, s.err);
});

test('sin ejecutar nada, el dominio con tests sigue pidiendo SOLO sus tests', () => {
  const dir = monorepo(CON_TESTS);
  preEdit(dir, 'apps/portal-demo/src/cuadrante.ts');
  const s = stop(dir);
  assert.strictEqual(s.status, 2, s.err);
  assert.match(s.err, /pnpm test apps\/portal-demo\/src\/cuadrante\.test\.ts|cuadrante\.test\.ts/);
});

test('un rojo de la app despues de editar sigue bloqueando', () => {
  const dir = monorepo(SIN_TESTS);
  preEdit(dir, 'apps/portal-demo/src/cuadrante.ts');
  hook(dir, 'tdd-post', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm test' }, tool_response: { stdout: 'Tests  1 failed | 27 passed (28)\n', stderr: '', interrupted: false } }, path.join(dir, 'apps', 'portal-demo'));
  const s = stop(dir);
  assert.strictEqual(s.status, 2, s.out + s.err);
  assert.doesNotMatch(s.err, /ejecuta `pnpm test`/);
});
