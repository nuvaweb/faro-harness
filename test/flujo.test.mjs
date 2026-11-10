// Tests del CICLO git obligatorio (0.9.1): la proteccion de ramas principales debe aplicar a TODA
// instancia FARO, tambien en MODO PLUGIN (sin copia legada .claude/hooks/harness.js) — bug real:
// esFaro exigia la copia legada y los repos plugin-mode quedaban sin bloqueo de main/develop.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { umbral, plazo, conReintento } from './lib-tiempo.mjs';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${name}-`));
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: plazo(120000) });
const runHook = (toolInput, cwd) =>
  spawnSync(process.execPath, [HARNESS, 'pre-bash'], {
    cwd, encoding: 'utf8', timeout: plazo(120000),
    input: JSON.stringify({ tool_input: toolInput }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });

// Instancia FARO en MODO PLUGIN: tiene ESTADO.md pero NO la copia legada .claude/hooks/harness.js.
function instancia(name, rama) {
  const dir = tmp(name);
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: Test\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · Piloto — in_progress\n- [ ] tarea\n');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  // La firma de commits heredada de la config global (gpg/1Password/ssh-sign) puede fallar o
  // pedir interaccion y dejar el repo de prueba SIN COMMITS: entonces el harness no tiene nada
  // que gobernar y el test falla por el entorno. Se apaga solo aqui, no en la config del usuario.
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  if (rama !== 'main') git(dir, 'switch', '-c', rama);
  return dir;
}

test('pre-bash BLOQUEA git commit directo en main en instancia MODO PLUGIN (sin copia legada)', () => {
  const dir = instancia('flujo-main', 'main');
  const r = runHook({ command: 'git commit -m "cambio directo"' }, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim(), 'el hook no dijo nada: el commit directo en main paso sin bloqueo');
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny', `no bloqueo el commit en main: ${r.stdout}`);
});

test('pre-bash BLOQUEA git commit directo en develop en instancia MODO PLUGIN', () => {
  const dir = instancia('flujo-develop', 'develop');
  const r = runHook({ command: 'git commit -m "cambio directo"' }, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim(), 'el hook no dijo nada: el commit directo en develop paso sin bloqueo');
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny', `no bloqueo el commit en develop: ${r.stdout}`);
});

test('pre-bash NO bloquea git commit en rama de trabajo (feature/<tema>)', () => {
  const dir = instancia('flujo-feature', 'feature/mi-tema');
  const r = runHook({ command: 'git commit -m "trabajo normal"' }, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  if (r.stdout.trim()) {
    const out = JSON.parse(r.stdout);
    assert.notStrictEqual(out.hookSpecificOutput?.permissionDecision, 'deny', `bloqueo una rama de trabajo: ${r.stdout}`);
  }
});

test('ramas protegidas EXTENSIBLES por metadato: .faro.json ramas_protegidas bloquea commit en demo', () => {
  const dir = instancia('flujo-demo', 'main');
  fs.writeFileSync(path.join(dir, '.faro.json'), JSON.stringify({ ramas_protegidas: ['demo', 'pre'] }));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'metadato');
  git(dir, 'switch', '-c', 'demo');
  const r = runHook({ command: 'git commit -m "cambio directo en demo"' }, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim(), 'el hook no dijo nada: el commit directo en demo (protegida por metadato) paso sin bloqueo');
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny', `no bloqueo el commit en demo: ${r.stdout}`);
});

test('deteccion robusta: el settings del repo declarando el plugin faro basta para gobernar (sin ESTADO.md aun)', () => {
  const dir = tmp('flujo-settings');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'faro@faro-marketplace': true } }));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  const r = runHook({ command: 'git commit -m "cambio directo"' }, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.trim(), 'el hook no dijo nada: repo con plugin faro declarado sin gobernar');
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny', `no bloqueo main con settings faro: ${r.stdout}`);
});

test('pre-bash NO gobierna un repo ajeno (sin ESTADO.md ni harness): no es FARO', () => {
  const dir = tmp('flujo-ajeno');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Repo ajeno\n');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  const r = runHook({ command: 'git commit -m "cambio"' }, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), '', `gobernо un repo que no es FARO: ${r.stdout}`);
});
