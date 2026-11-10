// Un BUG tiene su propia plantilla: lo que hace falta para arreglarlo sin preguntar es COMO se
// reproduce, QUE se esperaba y QUE paso. Antes era la plantilla comun con los pasos metidos en una
// linea de 'Contexto', y nadie echaba en falta nada propio de un bug (#65).
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { plantillaIssue, huecosDeIssue } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

// #134: actual / esperado / lo que NO debe cambiar / pasos ('Comportamiento obtenido' es su alias).
const SECCIONES_BUG = ['Comportamiento actual', 'Comportamiento esperado', 'Lo que NO debe cambiar', 'Pasos para reproducir', 'Entorno', 'Evidencia'];

test('la plantilla de bug trae sus secciones propias, ademas de las comunes', () => {
  for (const tipo of ['bug', 'bugfix', 'hotfix']) {
    const p = plantillaIssue(tipo);
    for (const s of [...SECCIONES_BUG, 'Objetivo', 'Alcance', 'Fuera de alcance', 'Criterios de aceptacion']) {
      assert.match(p, new RegExp(`^## ${s}$`, 'm'), `${tipo}: falta '${s}'`);
    }
    assert.match(p, /regresion|test que/i, 'el criterio de un bug incluye el test que evita que vuelva');
  }
});

test('la plantilla de una tarea NO lleva secciones de bug', () => {
  const p = plantillaIssue('tarea');
  for (const s of SECCIONES_BUG) assert.doesNotMatch(p, new RegExp(`^## ${s}$`, 'm'));
});

test('un bug relleno con la plantilla comun esta INCOMPLETO: le faltan los pasos, el esperado y el obtenido', () => {
  const comun = plantillaIssue('tarea').replace(/<[^>]+>/g, 'algo');
  const h = huecosDeIssue(comun, 'bug');
  for (const s of ['Pasos para reproducir', 'Comportamiento esperado', 'Comportamiento actual', 'Lo que NO debe cambiar']) {
    assert.ok(h.some((x) => x.includes(s)), `debe echar en falta '${s}': ${h.join(' | ')}`);
  }
});

test('una tarea sin secciones de bug NO se marca incompleta por eso', () => {
  const comun = plantillaIssue('tarea').replace(/<[^>]+>/g, 'algo');
  assert.deepStrictEqual(huecosDeIssue(comun, 'tarea'), []);
  assert.deepStrictEqual(huecosDeIssue(comun), [], 'sin tipo, criterio comun (compatibilidad)');
});

// #134: 'Comportamiento obtenido' (lo que manda Userback y llevan los bugs anteriores) cuenta como
// 'Comportamiento actual': no se marca como hueco.
test('un bug con "Comportamiento obtenido" ya tiene su comportamiento actual', () => {
  const viejo = plantillaIssue('bug').replace('## Comportamiento actual', '## Comportamiento obtenido').replace(/<[^>]+>/g, 'algo');
  assert.deepStrictEqual(huecosDeIssue(viejo, 'bug'), []);
});

test('un bug con todas sus secciones rellenas esta completo', () => {
  const lleno = plantillaIssue('bug').replace(/<[^>]+>/g, 'algo');
  assert.deepStrictEqual(huecosDeIssue(lleno, 'bug'), []);
});
