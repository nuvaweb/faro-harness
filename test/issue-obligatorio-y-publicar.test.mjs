// Todo trabajo nace de un ISSUE — un fallo detectado se declara como bug antes de abrir su rama —,
// tambien en el MOTOR y tambien si la rama se crea a mano. Y a main se llega PUBLICANDO
// (/faro:publicar): el nombre "aprobar" se retiro en 0.37.0 y los avisos no pueden seguir usandolo.
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
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 60000 });
const env = (cwd) => ({ ...process.env, CLAUDE_PROJECT_DIR: cwd });
const correr = (args, cwd) => spawnSync(process.execPath, [HARNESS, ...args], { cwd, encoding: 'utf8', timeout: 60000, env: env(cwd) });
const preBash = (command, cwd) => spawnSync(process.execPath, [HARNESS, 'pre-bash'], { cwd, encoding: 'utf8', timeout: 60000, input: JSON.stringify({ tool_input: { command } }), env: env(cwd) });
const decision = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision; } catch { return null; } };

const ESTADO = `---
nombre: proyecto
clave: PRU
objetivo: Prueba
estado: in_progress
fases_total: 1
fase_actual: 1
owner: tester
---
### Fase 1 · Fundamentos — in_progress
- [ ] #1 · algo — @tester
`;

function repo(nombre, { estado = true, motor = false } = {}) {
  const dir = tmp(nombre);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  if (estado) fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO);
  if (motor) {
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), '{}');
    fs.mkdirSync(path.join(dir, 'plugins', 'faro', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugins', 'faro', 'hooks', 'harness.js'), '');
  }
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'base');
  git(dir, 'switch', '-c', 'develop');
  return dir;
}

test('rama fix/ creada A MANO sin numero de issue: bloqueada, y dice como declararla', () => {
  const dir = repo('mano-sin-issue');
  for (const cmd of ['git switch -c fix/login-roto', 'git checkout -b fix/login-roto develop']) {
    const r = preBash(cmd, dir);
    assert.strictEqual(decision(r), 'deny', `${cmd}\n${r.stdout}`);
    assert.match(r.stdout, /--tipo bug/, 'un fix es un bug');
    assert.match(r.stdout, /--issue <N>/);
  }
});

test('rama a mano CON su numero, o de gestion (chore): pasa', () => {
  const dir = repo('mano-con-issue');
  assert.notStrictEqual(decision(preBash('git switch -c fix/12-login-roto', dir)), 'deny');
  assert.notStrictEqual(decision(preBash('git checkout -b chore/bump-version', dir)), 'deny');
});

test('repo ajeno (sin ESTADO.md, no motor): no se gobierna', () => {
  const dir = repo('ajeno', { estado: false });
  assert.notStrictEqual(decision(preBash('git switch -c fix/algo', dir)), 'deny');
});

test('MOTOR (sin ESTADO.md): la rama tambien exige issue — por comando y a mano', () => {
  const dir = repo('motor', { estado: false, motor: true });
  const r = correr(['rama', 'fix', 'cierre de clickup'], dir);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stdout, /falta el ISSUE/);
  assert.match(r.stdout, /--tipo bug/);
  assert.strictEqual(decision(preBash('git switch -c fix/cierre-clickup', dir)), 'deny');
});

test("pendientes: develop -> main se PUBLICA, no se 'aprueba' con un merge a mano", () => {
  const dir = repo('pendientes');
  fs.writeFileSync(path.join(dir, 'b.txt'), '2');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'trabajo integrado');
  const r = correr(['pendientes'], dir);
  assert.match(r.stdout, /pendiente de PUBLICAR/, r.stdout);
  assert.match(r.stdout, /\/faro:publicar/);
  assert.doesNotMatch(r.stdout, /aprob/i, r.stdout);
  assert.doesNotMatch(r.stdout, /git merge --no-ff develop/, 'no se ensena el merge a mano como via');
});
