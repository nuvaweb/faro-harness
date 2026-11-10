import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMINIOS, dominiosVisibles } from '../bin/lib/model.mjs';

test('innovacion es un área más: no depende del rol', () => {
  assert.ok(dominiosVisibles(DOMINIOS, false).innovacion);
});

test('dominiosVisibles: owner ve innovacion', () => {
  const vis = dominiosVisibles(DOMINIOS, true);
  assert.ok(vis.innovacion, 'owner ve innovacion');
  assert.ok(vis.producto, 'owner ve producto');
});

