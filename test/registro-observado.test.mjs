// QUE PASO, no solo QUE DISCREPA.
//
// 'desajustesDelFaseo' dice que no cuadra (checkbox marcado con issue abierto, o al reves), pero no
// puede decir POR QUE, porque solo ve una foto. Y los dos casos son OPUESTOS:
//   - se cerro en la web y nadie marco el checkbox  -> trabajo hecho sin registrar
//   - se marco el checkbox y el trabajo nunca salio -> registro sin trabajo
// Con una sola foto se ven iguales. Con la ANTERIOR, se distinguen: lo que cambio desde la ultima
// vez que se miro dice quien se movio.
//
// El registro guarda solo CAMBIOS observados, no cada lectura: apuntar "seguia igual" en cada
// consulta llenaria el fichero de ruido y nadie lo miraria (el antipatron del TODO, mudado de sitio).
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { cambiosObservados, explicarDesajuste } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

// ---------- que cambio desde la ultima vez ----------

test('un issue que pasa de abierto a cerrado se registra como cambio', () => {
  const c = cambiosObservados({ 4: 'open' }, { 4: 'closed' });
  assert.strictEqual(c.length, 1, JSON.stringify(c));
  assert.strictEqual(c[0].issue, '4');
  assert.strictEqual(c[0].de, 'open');
  assert.strictEqual(c[0].a, 'closed');
});

test('lo que NO cambio no se registra (el fichero crece con el trabajo, no con las consultas)', () => {
  assert.deepStrictEqual(cambiosObservados({ 4: 'open', 5: 'closed' }, { 4: 'open', 5: 'closed' }), []);
});

test('un issue visto por primera vez NO es un cambio (no habia con que comparar)', () => {
  assert.deepStrictEqual(cambiosObservados({}, { 4: 'open' }), []);
});

test('un issue que ya no se consulta no genera un cambio fantasma', () => {
  // Dejo de mirarlo (salio del faseo, o no se pudo consultar): eso no es que haya cambiado.
  assert.deepStrictEqual(cambiosObservados({ 4: 'open' }, {}), []);
});

test('sin registro previo (primera ejecucion) no inventa historia', () => {
  assert.deepStrictEqual(cambiosObservados(null, { 4: 'open' }), []);
  assert.deepStrictEqual(cambiosObservados(undefined, { 4: 'closed' }), []);
});

// ---------- lo que de verdad aporta: explicar ----------

// El caso que motivo todo: alguien cierra el issue en la web de GitHub, sin pasar por el flujo.
test('issue cerrado fuera del flujo con el checkbox sin marcar: lo dice con esas palabras', () => {
  const e = explicarDesajuste({
    issue: '4', titulo: 'Pantallas', marcado: false, estadoForja: 'closed',
    cambio: { de: 'open', a: 'closed', cuando: '2026-09-22T10:00:00Z' },
  });
  assert.ok(e, 'tiene que explicarlo');
  assert.match(e, /#4/, e);
  assert.match(e, /cerr/i, e);
  assert.match(e, /marca el checkbox|marcalo/i, `debe decir que hacer: ${e}`);
});

// El opuesto, y se lee distinto: aqui el trabajo NO ha salido.
test('checkbox marcado con el issue aun abierto: dice que el trabajo no ha salido', () => {
  const e = explicarDesajuste({
    issue: '4', titulo: 'Pantallas', marcado: true, estadoForja: 'open', cambio: null,
  });
  assert.ok(e, 'tiene que explicarlo');
  assert.match(e, /#4/, e);
  assert.match(e, /no ha salido|sigue abierta|sin cerrar/i, e);
});

test('si hay cambio observado, la explicacion dice CUANDO se movio', () => {
  const e = explicarDesajuste({
    issue: '7', titulo: 'API', marcado: false, estadoForja: 'closed',
    cambio: { de: 'open', a: 'closed', cuando: '2026-09-20T08:30:00Z' },
  });
  assert.match(e, /2026-09-20/, `la fecha del cambio es la pista mas util: ${e}`);
});

// Sin historia previa se puede describir el desajuste, pero NO afirmar cuando ocurrio.
test('sin cambio observado no se inventa una fecha', () => {
  const e = explicarDesajuste({
    issue: '9', titulo: 'Algo', marcado: false, estadoForja: 'closed', cambio: null,
  });
  assert.ok(e, 'sigue habiendo desajuste que contar');
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(e), `no puede inventar una fecha que no observo: ${e}`);
});

test('lo que cuadra no se explica: no hay nada que contar', () => {
  assert.strictEqual(explicarDesajuste({ issue: '4', titulo: 'X', marcado: true, estadoForja: 'closed', cambio: null }), null);
  assert.strictEqual(explicarDesajuste({ issue: '4', titulo: 'X', marcado: false, estadoForja: 'open', cambio: null }), null);
});

test('sin estado de la forja (no se pudo consultar) no se explica nada', () => {
  assert.strictEqual(explicarDesajuste({ issue: '4', titulo: 'X', marcado: true, estadoForja: null, cambio: null }), null);
});
