import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconciliarTeams } from '../bin/flows/check.mjs';

test('reconciliarTeams: devuelve los equipos del repo si difieren de .faro.json', () => {
  assert.deepEqual(reconciliarTeams({ teams: ['ia'] }, ['ia', 'data']), ['data', 'ia']);
  assert.equal(reconciliarTeams({ teams: ['ia'] }, ['ia']), null);
  assert.equal(reconciliarTeams({}, []), null);
  assert.deepEqual(reconciliarTeams({ teams: ['ia', 'ia'] }, ['ia']), null, 'duplicados no cuentan');
});
