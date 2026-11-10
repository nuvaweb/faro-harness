// Smoke tests del plugin faro — red de seguridad MINIMA previa al refactor del harness.
// No prueban lógica fina: prueban que el motor arranca, no casca y respeta el modo plugin.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const run = (args, cwd, env = {}) =>
  spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${name}-`));
// Hooks PreToolUse (pre-doc/pre-bash) leen el payload por STDIN (formato hook de Claude Code), no por argv.
const runHook = (subcmd, toolInput, cwd) =>
  spawnSync(process.execPath, [HARNESS, subcmd], {
    cwd, encoding: 'utf8', timeout: 120000,
    input: JSON.stringify({ tool_input: toolInput }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });

test('sintaxis: todos los módulos del harness compilan', () => {
  for (const f of fs.readdirSync(HOOKS).filter((x) => x.endsWith('.js'))) {
    const r = run(['--check', path.join(HOOKS, f)]);
    assert.strictEqual(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('manifiestos: plugin.json / marketplace.json / hooks.json / faro-schema.json son JSON válidos', () => {
  const base = path.join(HOOKS, '..');
  for (const f of [
    path.join(base, '.claude-plugin', 'plugin.json'),
    path.join(base, '..', '..', '.claude-plugin', 'marketplace.json'),
    path.join(HOOKS, 'hooks.json'),
    path.join(HOOKS, 'faro-schema.json'),
  ]) JSON.parse(fs.readFileSync(f, 'utf8'));
});

test('session en repo vacío: arranca, no casca y pide onboarding', () => {
  const dir = tmp('vacio');
  const r = run([HARNESS, 'session'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.length > 0, 'sin salida');
  assert.ok(!/TypeError|ReferenceError|SyntaxError/.test(r.stderr), r.stderr);
});

test('modo plugin: las auto-referencias se reescriben a la ruta real del motor', () => {
  const dir = tmp('rutas');
  const r = run([HARNESS, 'session'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.ok(!/node \.claude\/hooks\/harness\.js/.test(r.stdout),
    'la salida aún referencia la ruta legada .claude/hooks/harness.js');
});

test('copia legada presente: el plugin se INHIBE en hooks (gobierna la copia)', () => {
  const dir = tmp('legado');
  fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'harness.js'), '// copia legada\n');
  const r = run([HARNESS, 'session'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(/INHIBIDO/.test(r.stdout), `esperaba aviso de inhibición, salió: ${r.stdout.slice(0, 200)}`);
  const p = run([HARNESS, 'prompt-context'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(p.status, 0);
  assert.strictEqual(p.stdout.trim(), '', 'prompt-context debe callar con copia legada');
});

test('validate en repo vacío: falla con mensaje útil, sin crash', () => {
  const dir = tmp('validate');
  const r = run([HARNESS, 'validate'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.notStrictEqual(r.status, 0, 'validate debería fallar sin ESTADO.md');
  assert.ok(!/TypeError|ReferenceError/.test(r.stderr), r.stderr);
});

const ESTADO_CON_CLAVE = (clave) => `---
iniciativa: Test
clave: ${clave}
fases_total: 1
fase_actual: 1
owner: tester
---
# Estado

### Fase 1 · Piloto — in_progress
Objetivo: 2026-08-01
- [ ] Tarea de prueba
`;

test('docref: la CLAVE declarada NO se trunca (regresión del bug slice(0,6))', () => {
  const dir = tmp('docref-clave-larga');
  fs.mkdirSync(path.join(dir, 'documentos'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO_CON_CLAVE('PLANETA')); // 7 caracteres
  const r = run([HARNESS, 'docref', 'ARQ'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'PLANETA-ARQ-001', `salió truncado: ${r.stdout}`);
});

test('docref: acepta el límite superior de CLAVE (10 caracteres)', () => {
  const dir = tmp('docref-clave-10');
  fs.mkdirSync(path.join(dir, 'documentos'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO_CON_CLAVE('PLANETAAPI')); // 10 caracteres
  const r = run([HARNESS, 'docref', 'ARQ'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'PLANETAAPI-ARQ-001', `salió truncado: ${r.stdout}`);
});

test('docref: correlativo sube al detectar un doc_id previo del mismo tipo', () => {
  const dir = tmp('docref-correlativo');
  fs.mkdirSync(path.join(dir, 'documentos', 'arquitectura'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO_CON_CLAVE('PLANETA'));
  fs.writeFileSync(
    path.join(dir, 'documentos', 'arquitectura', 'PLANETA-ARQ-001-arquitectura.md'),
    '---\ndoc_id: PLANETA-ARQ-001\ntitle: Arquitectura\nversion: 1.0\n---\n',
  );
  const r = run([HARNESS, 'docref', 'ARQ'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'PLANETA-ARQ-002', `no subió el correlativo: ${r.stdout}`);
});

test('validate: acepta doc_id con CLAVE de 7-10 caracteres (regresión del regex {2,6})', () => {
  const dir = tmp('validate-clave-larga');
  fs.mkdirSync(path.join(dir, 'documentos', 'arquitectura'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), ESTADO_CON_CLAVE('PLANETA'));
  fs.writeFileSync(
    path.join(dir, 'documentos', 'arquitectura', 'PLANETA-ARQ-001-arquitectura.md'),
    [
      '---',
      'doc_id: PLANETA-ARQ-001',
      'title: Arquitectura',
      'version: 1.0',
      'date: 2026-07-30',
      'status: draft',
      'author: tester',
      'classification: internal',
      '---',
      '# Arquitectura',
    ].join('\n'),
  );
  const r = run([HARNESS, 'validate'], dir, { CLAUDE_PROJECT_DIR: dir });
  assert.ok(!/no cumple CLAVE-TIPO-NNN/.test(r.stdout), `rechazó una CLAVE válida de 7 chars: ${r.stdout}`);
});

// --- Guardarrails de seguridad (pre-bash / pre-doc): comandos destructivos y ficheros de secretos ---

const destructivos = [
  ['rm -rf /tmp/algo', 'rm -rf'],
  ['git push --force origin main', 'git push --force'],
  ['git reset --hard HEAD~1', 'git reset --hard'],
  ['git clean -fd', 'git clean -fd'],
];
for (const [cmd, label] of destructivos) {
  test(`pre-bash bloquea comando destructivo: ${label}`, () => {
    const dir = tmp('prebash-destructivo');
    const r = runHook('pre-bash', { command: cmd }, dir);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny', `no bloqueó "${cmd}": ${r.stdout}`);
  });
}

test('pre-bash NO bloquea git push --force-with-lease (no es igual de destructivo)', () => {
  const dir = tmp('prebash-lease');
  const r = runHook('pre-bash', { command: 'git push --force-with-lease origin main' }, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), '', `bloqueó force-with-lease sin deber: ${r.stdout}`);
});

test('pre-bash NO bloquea comandos normales (ls, npm install)', () => {
  const dir = tmp('prebash-normal');
  for (const cmd of ['ls -la', 'npm install', 'git status']) {
    const r = runHook('pre-bash', { command: cmd }, dir);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), '', `bloqueó "${cmd}" sin deber: ${r.stdout}`);
  }
});

const secretos = ['.env', '.env.production', '.env.local', 'secrets.json', 'id_rsa', 'id_ed25519', 'server.pem'];
for (const nombre of secretos) {
  test(`pre-doc bloquea escritura en fichero de secretos: ${nombre}`, () => {
    const dir = tmp('predoc-secreto');
    const r = runHook('pre-doc', { file_path: path.join(dir, nombre) }, dir);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny', `no bloqueó "${nombre}": ${r.stdout}`);
  });
}

test('pre-doc NO bloquea un documento normal por el guard de secretos', () => {
  const dir = tmp('predoc-normal');
  const r = runHook('pre-doc', { file_path: path.join(dir, 'documentos', 'funcional', 'brief.md') }, dir);
  assert.strictEqual(r.status, 0, r.stderr);
  if (r.stdout.trim()) {
    const out = JSON.parse(r.stdout);
    assert.ok(
      !/secretos\/credenciales/.test(out.hookSpecificOutput?.permissionDecisionReason || ''),
      `bloqueó un doc normal como si fuera secreto: ${r.stdout}`,
    );
  }
});
