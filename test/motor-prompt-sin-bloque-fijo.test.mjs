// #122 — En el repo MOTOR, el hook de cada prompt repetia el bloque fijo "MODO MOTOR / Flujo de
// desarrollo / Coherencia" (~1.040 caracteres identicos en cada mensaje), contra la spec viva
// reparto-contexto: lo que no cambia entre turnos se da al arrancar y no se repite.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');
const DATOS = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-plugin-data-'));

// El modo MOTOR se detecta por la forma del repo (marketplace.json + el propio harness): basta con
// correr sobre ESTE repo.
const enMotor = (sub, payload = {}) => {
  const r = spawnSync(process.execPath, [HARNESS, sub], {
    cwd: RAIZ, encoding: 'utf8', timeout: 120000, input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: RAIZ, CLAUDE_PLUGIN_DATA: DATOS },
  });
  const s = (r.stdout || '').trim();
  if (!s) return '';
  try { return JSON.parse(s).hookSpecificOutput.additionalContext || ''; } catch { return s; }
};

test('en el motor, prompt-context no repite el bloque fijo que ya da SessionStart', () => {
  const p = enMotor('prompt-context', { prompt: 'hola' });
  assert.ok(!/Flujo de desarrollo/.test(p), `el bloque fijo del motor sigue en cada prompt:\n${p}`);
  assert.ok(!/MODO MOTOR/.test(p), p);
});

test('el arranque del motor sigue dando la directiva completa', () => {
  const s = enMotor('session', { source: 'startup' });
  assert.match(s, /MODO MOTOR/);
  assert.match(s, /Flujo de desarrollo/);
});

test('tras compactar, el reancla del motor devuelve la directiva (el turno ya no la repite)', () => {
  const s = enMotor('session', { source: 'compact' });
  assert.match(s, /REANCLA TRAS COMPACTAR/, s.slice(0, 300));
  assert.match(s, /Flujo de desarrollo/, 'sin ella, tras compactar se perderia el flujo del motor');
});
