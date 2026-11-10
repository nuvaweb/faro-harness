// Cierre de huecos del plugin (0.19.0): el rol del gate sale de la CACHE de 'harness.js role' y no de
// los CLI gh/glab (que el motor prohibe y que en un GitLab privado no estan); la identidad se valida
// contra la credencial guardada del host; 'renombrar' existe en GitLab; y las listas de arranque
// que crecian sin limite llevan tope.
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
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 120000 });

// HOME aislado: ~/.faro.json es el almacen del harness y NO se toca el del desarrollador.
function home(contenido) {
  const h = tmp('home');
  if (contenido) fs.writeFileSync(path.join(h, '.faro.json'), JSON.stringify(contenido));
  return h;
}
const env = (h, dir) => ({
  ...process.env, CLAUDE_PROJECT_DIR: dir, HOME: h, USERPROFILE: h, FARO_CONFIG_PATH: path.join(h, '.faro.json'),
  FARO_GITHUB_TOKEN: '', GITHUB_TOKEN: '', FARO_GITLAB_TOKEN: '', GITLAB_TOKEN: '',
});
const run = (args, dir, h, input) =>
  spawnSync(process.execPath, [HARNESS, ...args], { cwd: dir, encoding: 'utf8', env: env(h, dir), timeout: 60000, ...(input ? { input } : {}) });
const preBash = (command, dir, h) => run(['pre-bash'], dir, h, JSON.stringify({ tool_input: { command } }));

// Instancia FARO en la rama que se indique, SIN 'maintainers:' declarados (asi el rol sale de la cache).
function instancia(name, remote, rama = 'main', estadoExtra = '') {
  const dir = tmp(name);
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), `---\niniciativa: Test\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · Piloto — in_progress\n- [ ] tarea\n${estadoExtra}`);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  if (rama !== 'main') git(dir, 'switch', '-c', rama);
  return dir;
}
const decision = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision; } catch { return null; } };
const cache = (rol, tsDelta = 0) => ({ rol_cache: { 'gitlab.com/grupo/proyecto': { rol, forja: 'GitLab', detalle: 'nivel 30', ts: Date.now() - tsDelta } } });

test('gate: con rol DEVELOPER en la cache de harness.js role, el push a main se DENIEGA (sin CLI gh/glab)', () => {
  const dir = instancia('rol-dev', 'git@gitlab.com:grupo/proyecto.git');
  const r = preBash('git push origin main', dir, home(cache('developer')));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(decision(r), 'deny', `esperaba deny para developer: ${r.stdout}`);
  assert.match(r.stdout, /cache de harness\.js role/, 'la via del rol debe ser la cache, no un CLI');
});

test('gate: con rol MAINTAINER en la cache, el push a main NO se deniega (pide confirmacion)', () => {
  const dir = instancia('rol-maint', 'git@gitlab.com:grupo/proyecto.git');
  const r = preBash('git push origin main', dir, home(cache('maintainer')));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.notStrictEqual(decision(r), 'deny', `un maintainer no debe quedar bloqueado: ${r.stdout}`);
});

test('gate: una cache CADUCADA (>24h) no cuenta — el rol queda indeterminado y NO se deniega a ciegas', () => {
  const dir = instancia('rol-caduco', 'git@gitlab.com:grupo/proyecto.git');
  const r = preBash('git push origin main', dir, home(cache('developer', 25 * 3600 * 1000)));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.notStrictEqual(decision(r), 'deny', `una cache vieja no debe denegar: ${r.stdout}`);
});

test('arranque: la lista de tareas bloqueadas lleva TOPE (8) y dice cuantas quedan y donde', () => {
  const bloqueadas = Array.from({ length: 12 }, (_, i) => `- [ ] tarea bloqueada ${i + 1} [bloq: motivo ${i + 1}]`).join('\n') + '\n';
  const dir = instancia('topes', 'git@gitlab.com:grupo/proyecto.git', 'main', bloqueadas);
  const r = run(['status'], dir, home());
  assert.strictEqual(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /TAREAS BLOQUEADAS \(12\)/, ctx);
  assert.match(ctx, /… y 4 más \(detalle completo: ESTADO\.md\)/, 'debe recortar a 8 y remitir al detalle');
  assert.ok(!/⛔ motivo 12/.test(ctx), 'la ultima fila de la lista de bloqueadas no debe inyectarse: esta detras del tope');
});

test('renombrar: en un repo de GitLab sin credencial responde SIN_TOKEN (el comando existe y enruta)', () => {
  const dir = instancia('ren-gl', 'git@gitlab.com:grupo/proyecto.git');
  const r = run(['renombrar', 'Nombre Nuevo'], dir, home());
  assert.strictEqual(r.status, 2, `esperaba salida 2 (SIN_TOKEN): ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /SIN_TOKEN/);
});

test('renombrar: en GitHub tambien es nativo (0.23.0) y sin credencial pide conectarse', () => {
  const dir = instancia('ren-gh', 'git@github.com:org/repo.git');
  const r = run(['renombrar', 'Nombre Nuevo'], dir, home());
  assert.strictEqual(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /SIN_TOKEN/);
});

test('stats: la identidad se valida contra la credencial GUARDADA del host, tambien en GitLab', () => {
  const dir = instancia('ident-gl', 'git@gitlab.com:grupo/proyecto.git');
  const h = home({ tokens: { 'gitlab.com': { token: 'x', forja: 'gitlab', user: { login: 'fer', email: 't@t' } } } });
  const r = run(['stats'], dir, h);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Identidad OK: .*GitLab/, `debe validar con la cuenta guardada de GitLab:\n${r.stdout}`);
});
