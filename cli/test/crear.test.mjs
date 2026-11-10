import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, coincideRepo } from '../bin/crear.mjs';
import { DOMINIOS } from '../bin/lib/model.mjs';
import { elige } from '../bin/lib/core.mjs';

test('domain: 11 áreas y mapeo ESTABLE', async () => {
  assert.equal(Object.keys(DOMINIOS).length, 11);
  for (const k of Object.keys(DOMINIOS)) assert.equal(await elige('t', DOMINIOS, k), k);
});

test('slugify normaliza acentos, espacios y símbolos', () => {
  assert.equal(slugify('Análisis de Red'), 'analisis-de-red');
  assert.equal(slugify('  Solución 360!!  '), 'solucion-360');
  assert.equal(slugify('---'), '');
});

test('coincideRepo: encuentra por nombre actual', () => {
  const r = { name: 'faro-solucion-360', topics: ['faro'] };
  assert.ok(coincideRepo(r, 'solucion'));
  assert.ok(coincideRepo(r, 'SOLUCION 360'));
  assert.ok(!coincideRepo(r, 'gratia'));
});

test('coincideRepo: encuentra por nombre ANTIGUO (topic antes-*)', () => {
  const r = { name: 'faro-solucion-360', topics: ['faro', 'antes-analisis-de-red'] };
  assert.ok(coincideRepo(r, 'analisis red'));      // con espacios y sin tildes
  assert.ok(coincideRepo(r, 'Análisis'));           // con tilde
  assert.ok(!coincideRepo(r, 'gestion'));
  assert.ok(!coincideRepo({ name: 'faro-x', topics: [] }, 'analisis'));
});
