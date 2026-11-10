// Cambio 'plugin-en-gitlab': el bloque de instalacion recomendado deja de tener GitHub cableado y
// pasa a depender de la forja del repo de trabajo (lib/forge.js -> marketplacePara/bloqueSettings),
// mas las funciones de GitLab (incluidas las de plan Premium/Ultimate: aprobacion, push rules,
// bloqueo de MRs) y la deteccion de un GitHub Enterprise autoalojado (host distinto de github.com).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const FORGE = path.join(HOOKS, 'lib', 'forge.js');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${name}-`));
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120000 });
const run = (args, cwd, env = {}) =>
  spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 });

// Instancia FARO normal (no motor, no template): con ESTADO.md, sin settings.json de plugin aun.
function instancia(name, remote) {
  const dir = tmp(name);
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: Test\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · Piloto — in_progress\n- [ ] tarea\n');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  return dir;
}

test('forge.marketplacePara: un repo de GitLab instala desde el MISMO origen publico (fuente github)', async () => {
  const { marketplacePara } = await import(`file://${FORGE.replace(/\\/g, '/')}`);
  const mk = marketplacePara('gitlab', () => '');
  assert.strictEqual(mk.source, 'github');
  assert.strictEqual(mk.repo, 'nuvaweb/faro-harness');
});

test('forge.marketplacePara: por defecto recomienda GitHub (fuente github) para un repo de GitHub', async () => {
  const { marketplacePara } = await import(`file://${FORGE.replace(/\\/g, '/')}`);
  const mk = marketplacePara('github', () => '');
  assert.strictEqual(mk.source, 'github');
  assert.strictEqual(mk.repo, 'nuvaweb/faro-harness');
});

test('forge.marketplacePara: una forja desconocida cae al defecto PRINCIPAL (GitHub), no a GitLab', async () => {
  const { marketplacePara } = await import(`file://${FORGE.replace(/\\/g, '/')}`);
  const mk = marketplacePara('desconocida', () => '');
  assert.strictEqual(mk.source, 'github');
  assert.strictEqual(mk.repo, 'nuvaweb/faro-harness');
});

test('forge.marketplacePara: git config faro.marketplaceUrl manda sobre el defecto de cualquier forja', async () => {
  const { marketplacePara } = await import(`file://${FORGE.replace(/\\/g, '/')}`);
  const propia = 'https://gitlab.miempresa.com/equipo/faro-espejo.git';
  const mk = marketplacePara('github', (...a) => (a[0] === 'config' && a[1] === 'faro.marketplaceUrl' ? propia : ''));
  assert.strictEqual(mk.source, 'git');
  assert.strictEqual(mk.url, propia);
});

// 'status' emite un payload de hook (JSON): el bloque recomendado vive DENTRO de additionalContext
// como texto, con las comillas escapadas por el propio JSON — hay que parsear antes de comparar.
function additionalContextDe(stdout) {
  const out = JSON.parse(stdout);
  return out.hookSpecificOutput && out.hookSpecificOutput.additionalContext || '';
}

test("status: un bloque 'url' que apunta a un repo .git se avisa para pasarlo a 'git'", () => {
  const dir = instancia('mk-url-git', 'git@gitlab.com:grupo/faro/plugin.git');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    extraKnownMarketplaces: { 'faro-marketplace': { source: { source: 'url', url: 'https://gitlab.com/g/plugin.git' }, autoUpdate: true } },
    enabledPlugins: { 'faro@faro-marketplace': true },
  }));
  const r = run([HARNESS, 'status'], dir, { CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: path.join(HOOKS, '..') });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(additionalContextDe(r.stdout), /cambiala a 'git'/);
});

test('status: repo de GitLab sin settings.json recomienda el bloque del origen publico', () => {
  const dir = instancia('mk-gitlab', 'git@gitlab.com:grupo/faro/plugin.git');
  const r = run([HARNESS, 'status'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  const ctx = additionalContextDe(r.stdout);
  assert.match(ctx, /"source":"github","repo":"nuvaweb\/faro-harness"/, ctx);
});

test('status: repo de GitHub sin settings.json recomienda el bloque de fuente github (comportamiento previo intacto)', () => {
  const dir = instancia('mk-github', 'git@github.com:org/otra-instancia.git');
  const r = run([HARNESS, 'status'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  const ctx = additionalContextDe(r.stdout);
  assert.match(ctx, /"source":"github","repo":"nuvaweb\/faro-harness"/, ctx);
});

test('status: un bloque ya declarado con fuente url (marketplace de GitLab) NO se marca como incompleto', () => {
  const dir = instancia('mk-ok', 'git@gitlab.com:grupo/proyecto.git');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    extraKnownMarketplaces: { 'faro-marketplace': { source: { source: 'git', url: 'https://gitlab.com/grupo/faro/plugin.git' }, autoUpdate: true } },
    enabledPlugins: { 'faro@faro-marketplace': true },
  }));
  const r = run([HARNESS, 'status'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/settings del repo INCOMPLETO/.test(r.stdout), r.stdout);
});

test('forge.detect: un GitHub Enterprise autoalojado (otro host, NO github.com) se detecta como github + selfHosted', async () => {
  const { detect } = await import(`file://${path.join(HOOKS, 'lib', 'forge.js').replace(/\\/g, '/')}`);
  const d = detect(() => 'git@github.miempresa.com:equipo/repo.git');
  assert.strictEqual(d.forge, 'github');
  assert.strictEqual(d.selfHosted, true);
  assert.strictEqual(d.host, 'github.miempresa.com');
  assert.strictEqual(d.owner, 'equipo');
  assert.strictEqual(d.project, 'repo');
});

test('lib/github.js: expone cmdProteger (proteccion de rama, misma intencion que forge-gitlab.js)', async () => {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'github.js').replace(/\\/g, '/')}`);
  const ctx = { ROOT: tmp('gh-ctx'), git: () => '', IS_TEMPLATE: false, specBase: 'gestion/cambios', forge: () => ({ forge: 'github', host: 'github.com' }) };
  const inst = mod.default(ctx);
  assert.strictEqual(typeof inst.cmdProteger, 'function');
});

test('lib/forge-gitlab.js: expone las funciones Premium (cmdProteger, cmdReglasPush, cmdBloquearMr)', async () => {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'forge-gitlab.js').replace(/\\/g, '/')}`);
  const ctx = {
    ROOT: tmp('gl-ctx'), git: () => '', forge: () => ({ forge: 'gitlab', host: 'gitlab.com', owner: 'g', project: 'p', path: 'g/p' }),
    tokenPara: () => null, guardarToken: () => {}, faroSchema: () => ({}), specBase: 'gestion/cambios',
  };
  const inst = mod.default(ctx);
  for (const fn of ['cmdProteger', 'cmdReglasPush', 'cmdBloquearMr']) {
    assert.strictEqual(typeof inst[fn], 'function', `falta ${fn} en el adaptador de GitLab`);
  }
});

test('dispatcher: reglas-push y bloquear-pr (Premium de GitLab) dicen "sin adaptador" en un repo de GitHub, sin reventar', () => {
  const dir = instancia('premium-en-github', 'git@github.com:acme-org/x.git');
  for (const cmd of ['reglas-push', 'bloquear-pr']) {
    const r = run([HARNESS, cmd], dir, { CLAUDE_PROJECT_DIR: dir });
    assert.strictEqual(r.status, 0, `${cmd}: ${r.stderr}`);
    assert.match(r.stdout, /no hay adaptador/i, `${cmd} deberia explicar que no aplica en GitHub, no fallar: ${r.stdout}`);
  }
});

test('dispatcher: proteger en un repo sin forja reconocida no revienta (SIN_FORJA en llano)', () => {
  const dir = instancia('proteger-desconocida', null);
  const r = run([HARNESS, 'proteger'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /no hay adaptador/i, r.stdout);
});
