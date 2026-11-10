import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esPlanDePago } from '../bin/lib/github.mjs';

test('esPlanDePago: team/enterprise/pro son de pago', () => {
  assert.equal(esPlanDePago('team'), true);
  assert.equal(esPlanDePago('enterprise'), true);
  assert.equal(esPlanDePago('pro'), true);
  assert.equal(esPlanDePago('Business'), true);   // case-insensitive
});

test('esPlanDePago: free y desconocido NO son de pago', () => {
  assert.equal(esPlanDePago('free'), false);
  assert.equal(esPlanDePago(''), false);
  assert.equal(esPlanDePago(null), false);
  assert.equal(esPlanDePago(undefined), false);
});
