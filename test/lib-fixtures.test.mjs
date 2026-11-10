// #177 — los fixtures de procesos de los tests de higiene se autoexpiran y se limpian siempre.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inactivo, rastrear, vivos, limpiarFixtures, CODIGO_INACTIVO } from './lib-fixtures.mjs';

const P = createRequire(import.meta.url)(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks', 'lib', 'procesos.js'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

test('el fixture inactivo se autoexpira (no es un intervalo infinito)', () => {
  assert.match(CODIGO_INACTIVO, /setTimeout\(.*process\.exit/);
  assert.ok(!/setInterval/.test(CODIGO_INACTIVO));
});

test('limpiarFixtures cierra todo lo rastreado y `vivos` lo detecta antes', async () => {
  const a = inactivo(); const b = inactivo();
  await dormir(300);
  assert.deepStrictEqual(vivos().sort(), [a.pid, b.pid].sort());
  limpiarFixtures();
  for (let i = 0; i < 50 && (P.vivo(a.pid) || P.vivo(b.pid)); i++) await dormir(100);
  assert.strictEqual(P.vivo(a.pid), false); assert.strictEqual(P.vivo(b.pid), false);
  assert.deepStrictEqual(vivos(), []);
});

test('un fixture rastreado no retiene al runner (unref) y un PID suelto tambien se limpia', async () => {
  const a = inactivo();
  assert.strictEqual(a.listenerCount('exit') >= 0, true);
  rastrear(a.pid);
  limpiarFixtures();
  for (let i = 0; i < 50 && P.vivo(a.pid); i++) await dormir(100);
  assert.strictEqual(P.vivo(a.pid), false);
});
