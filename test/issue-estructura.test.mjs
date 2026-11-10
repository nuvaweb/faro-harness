// ESTRUCTURA del issue: autocontenido, para que un agente lo ejecute sin reconstruir contexto.
//
// La industria converge en un esqueleto (objetivo / contexto / alcance / fuera de alcance /
// subtareas / criterios de aceptacion observables), y sobre agentes hay un hallazgo que manda aqui:
// los criterios escritos para humanos FALLAN con un agente, porque no hay dialogo — el agente los lee
// LITERALMENTE y rellena los huecos suposiendo. De ahi que 'fuera de alcance' sea tan importante como
// el alcance: es lo que evita que se expanda solo.
//
// Vale para los TRES tipos, con acentos distintos: un bug necesita reproduccion y esperado-vs-real;
// una feature, el problema y a quien sirve; una tarea, el entregable. El esqueleto no cambia.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { plantillaIssue, huecosDeIssue } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

// ---------- la plantilla, por tipo ----------

test('plantillaIssue: el esqueleto comun sale en cualquier tipo', () => {
  for (const tipo of ['tarea', 'bug', 'requerimiento']) {
    const p = plantillaIssue(tipo);
    for (const sec of ['Objetivo', 'Contexto', 'Alcance', 'Fuera de alcance', 'Criterios de aceptacion']) {
      assert.match(p, new RegExp(`## ${sec}`, 'i'), `'${tipo}' debe traer '${sec}':\n${p}`);
    }
  }
});

test('plantillaIssue: un BUG pide reproduccion y esperado-vs-real', () => {
  const p = plantillaIssue('bug');
  assert.match(p, /reproduc/i, p);
  assert.match(p, /esperado/i, p);
  assert.match(p, /real|actual/i, p);
});

test('plantillaIssue: un REQUERIMIENTO pide el problema y a quien sirve', () => {
  const p = plantillaIssue('requerimiento');
  assert.match(p, /problema|necesidad/i, p);
  assert.match(p, /quien|usuario/i, p);
});

test('plantillaIssue: una TAREA no arrastra sesgo de bug ni de feature', () => {
  const p = plantillaIssue('tarea');
  assert.doesNotMatch(p, /pasos para reproducir/i, 'una tarea no se reproduce');
});

test('plantillaIssue: un tipo desconocido cae al esqueleto generico, no rompe', () => {
  const p = plantillaIssue('loquesea');
  assert.match(p, /## Objetivo/i, p);
});

// ---------- validacion: que le FALTA a un issue ----------

const completo = `## Objetivo

Que el portal muestre la planta instalada.

## Contexto

Leer \`src/routes/planta.tsx\` y la spec \`specs/pantallas/spec.md\`.

## Alcance

- La pantalla y su tabla.

## Fuera de alcance

- La API real (Fase 2).

## Subtareas

- [ ] Tabla de contadores

## Criterios de aceptacion

- [ ] Al abrir /planta se ven los 4 contadores con datos de ejemplo.
`;

test('huecosDeIssue: un issue completo no tiene huecos', () => {
  assert.deepStrictEqual(huecosDeIssue(completo), []);
});

test('huecosDeIssue: nombra las secciones que faltan, no dice solo "esta mal"', () => {
  const h = huecosDeIssue('Hay que hacer la pantalla de planta.');
  assert.ok(h.length >= 3, `deberia listar varias: ${JSON.stringify(h)}`);
  assert.ok(h.some((x) => /objetivo/i.test(x)), JSON.stringify(h));
  assert.ok(h.some((x) => /criterio/i.test(x)), JSON.stringify(h));
});

test('huecosDeIssue: criterios de aceptacion VACIOS cuentan como hueco', () => {
  // La seccion existe pero sin nada dentro: es el fallo tipico, y un agente sin criterios inventa.
  const sinCriterios = completo.replace('- [ ] Al abrir /planta se ven los 4 contadores con datos de ejemplo.', '');
  assert.ok(huecosDeIssue(sinCriterios).some((x) => /criterio/i.test(x)), JSON.stringify(huecosDeIssue(sinCriterios)));
});

test('huecosDeIssue: un cuerpo vacio no revienta', () => {
  assert.ok(huecosDeIssue('').length > 0);
  assert.ok(huecosDeIssue(null).length > 0);
});
