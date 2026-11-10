import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esNombreGenerico, sugerirLibres, parecidosA } from '../bin/lib/model.mjs';

test('esNombreGenerico: < 5 chars caen por longitud', () => {
  assert.equal(esNombreGenerico('app'), true);
  assert.equal(esNombreGenerico('test'), true);
  assert.equal(esNombreGenerico('web'), true);
  assert.equal(esNombreGenerico('api'), true);
  assert.equal(esNombreGenerico('repo'), true);
  assert.equal(esNombreGenerico('crm'), true);
});

test('esNombreGenerico: comunes de 5+ letras poco específicos', () => {
  assert.equal(esNombreGenerico('prueba'), true);
  assert.equal(esNombreGenerico('proyecto'), true);
  assert.equal(esNombreGenerico('panel'), true);
  assert.equal(esNombreGenerico('sistema'), true);
  assert.equal(esNombreGenerico('portal'), true);
});

test('esNombreGenerico: nombres descriptivos pasan', () => {
  assert.equal(esNombreGenerico('copiloto'), false);
  assert.equal(esNombreGenerico('analisis-de-red'), false);
  assert.equal(esNombreGenerico('gratia'), false);
});

test('sugerirLibres: propone sufijos que no colisionan', () => {
  const libres = sugerirLibres('analisis-de-red', ['analisis-de-red', 'analisis-de-red-2'], 2);
  assert.deepEqual(libres, ['analisis-de-red-3', 'analisis-de-red-4']);
});

test('sugerirLibres: si el base está libre no lo sugiere (solo alternativas)', () => {
  const libres = sugerirLibres('gratia', ['otro'], 2);
  assert.deepEqual(libres, ['gratia-2', 'gratia-3']);
});

test('parecidosA: encuentra similares sin incluir el exacto', () => {
  const repos = [
    { name: 'analisis-de-red', topics: ['faro'] },
    { name: 'analisis-de-redes', topics: ['faro'] },
    { name: 'gratia', topics: ['faro'] },
  ];
  const par = parecidosA('analisis-de-red', repos);
  assert.ok(par.includes('analisis-de-redes'), 'incluye el parecido');
  assert.ok(!par.includes('analisis-de-red'), 'excluye el exacto');
  assert.ok(!par.includes('gratia'), 'no incluye no-relacionados');
});
