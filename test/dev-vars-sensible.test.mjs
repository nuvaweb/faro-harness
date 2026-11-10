// #148 — .dev.vars (secretos locales de Cloudflare Workers) y sus variantes por entorno son ficheros
// sensibles; .dev.vars.example es la plantilla que se versiona y sigue exenta.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks', 'harness.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'faro-devvars-'));
const preDoc = (dir, rel) => spawnSync(process.execPath, [HARNESS, 'pre-doc'], {
  cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true,
  input: JSON.stringify({ tool_input: { file_path: path.join(dir, rel) } }),
  env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
});
const decision = (r) => {
  if (!r.stdout.trim()) return null;
  return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision || null;
};

for (const rel of ['.dev.vars', path.join('apps', 'api', '.dev.vars'), '.dev.vars.staging', path.join('apps', 'web', '.dev.vars.production')]) {
  test(`pre-doc bloquea escribir ${rel} (secretos de Workers)`, () => {
    const r = preDoc(tmp(), rel);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(decision(r), 'deny', `no bloqueó ${rel}: ${r.stdout}`);
  });
}

test('pre-doc NO trata .dev.vars.example como secreto (es la plantilla versionada)', () => {
  const r = preDoc(tmp(), path.join('apps', 'web', '.dev.vars.example'));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/secretos\/credenciales/.test(r.stdout), `bloqueó la plantilla como secreto: ${r.stdout}`);
});

test('id_rsa.pub sigue sin ser sensible (no amplía la lista a lo que no lo es)', () => {
  const r = preDoc(tmp(), 'id_rsa.pub');
  assert.ok(!/secretos\/credenciales/.test(r.stdout), r.stdout);
});
