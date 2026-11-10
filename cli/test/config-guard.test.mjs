import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { saveConfig, CONFIG_PATH } from '../bin/lib/core.mjs';

test('saveConfig NUNCA escribe ~/.faro.json bajo node --test (el fichero real del usuario es intocable)', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test marca NODE_TEST_CONTEXT en los procesos de test');
  const antes = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;
  saveConfig({ token: 'NO-DEBE-ESCRIBIRSE', tokens: {} });
  const despues = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;
  assert.equal(despues, antes);
});
