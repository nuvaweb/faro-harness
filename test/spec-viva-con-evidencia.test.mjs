// El hueco que quedaba: 'validate' comprobaba coherencia DOCUMENTAL (que el proposal cite una fase
// que existe, que el cambio traiga deltas...) pero NADIE comprobaba que el codigo cumpla lo que la
// spec dice. Se podian tener specs impecables y una implementacion que no las respeta.
//
// Juzgar la semantica ("¿este codigo hace lo que el requisito pide?") no es determinista — eso lo
// hace 'revisor-code' con criterio. Lo determinista es la TRAZABILIDAD, y la unica forma de exigirla
// sin adivinar es que el requisito DECLARE su evidencia: una linea 'Evidencia: <ruta>' bajo el.
//
// (Se probo inferirla buscando el nombre del requisito dentro de los tests: daba 46/47 sin evidencia
// en el propio motor, porque nadie titula un test 'Las operaciones de plataforma se eligen por
// forja'. Un criterio que obliga a renombrar tests para contentarlo no mide nada.)
//
// Mismo principio que 'hito auditar' con las tareas: un requisito se DEMUESTRA, no se declara.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { evidenciaDeclarada, requisitosSinEvidencia } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

// ---------- leer la evidencia declarada en el cuerpo del requisito ----------

test('evidenciaDeclarada: saca la ruta de la linea "Evidencia:"', () => {
  assert.deepStrictEqual(
    evidenciaDeclarada('El sistema DEBE filtrar.\n\nEvidencia: test/planta.test.mjs'),
    ['test/planta.test.mjs'],
  );
});

test('evidenciaDeclarada: admite varias rutas separadas por coma', () => {
  const r = evidenciaDeclarada('DEBE x.\n\nEvidencia: test/a.test.mjs, test/b.test.mjs');
  assert.deepStrictEqual(r, ['test/a.test.mjs', 'test/b.test.mjs']);
});

test('evidenciaDeclarada: acepta negrita y el termino en ingles', () => {
  assert.deepStrictEqual(evidenciaDeclarada('DEBE x.\n\n**Evidencia:** test/a.test.mjs'), ['test/a.test.mjs']);
  assert.deepStrictEqual(evidenciaDeclarada('MUST x.\n\nEvidence: test/a.test.mjs'), ['test/a.test.mjs']);
});

test('evidenciaDeclarada: sin la linea, no inventa nada', () => {
  assert.deepStrictEqual(evidenciaDeclarada('El sistema DEBE filtrar.'), []);
  assert.deepStrictEqual(evidenciaDeclarada(''), []);
  assert.deepStrictEqual(evidenciaDeclarada(null), []);
});

// ---------- que requisitos se quedan sin demostrar ----------

const existe = (f) => ['test/planta.test.mjs', 'test/a.test.mjs'].includes(f);

test('un requisito con evidencia declarada y existente esta demostrado', () => {
  const r = requisitosSinEvidencia(
    [{ capacidad: 'planta', name: 'Filtrar por partner_id', evidencia: ['test/planta.test.mjs'] }],
    existe,
  );
  assert.deepStrictEqual(r, []);
});

test('un requisito SIN evidencia declarada se senala', () => {
  const r = requisitosSinEvidencia([{ capacidad: 'planta', name: 'Filtrar por partner_id', evidencia: [] }], existe);
  assert.strictEqual(r.length, 1);
  assert.match(r[0], /Filtrar por partner_id/, r[0]);
  assert.match(r[0], /Evidencia:/, 'debe decir como declararla');
});

test('evidencia declarada que apunta a un fichero que NO existe: enlace roto', () => {
  const r = requisitosSinEvidencia(
    [{ capacidad: 'planta', name: 'Filtrar', evidencia: ['test/borrado.test.mjs'] }],
    existe,
  );
  assert.strictEqual(r.length, 1);
  assert.match(r[0], /no existe/i, r[0]);
  assert.match(r[0], /borrado/, 'debe nombrar el fichero que falta');
});

test('sin requisitos no hay nada que exigir', () => {
  assert.deepStrictEqual(requisitosSinEvidencia([], existe), []);
  assert.deepStrictEqual(requisitosSinEvidencia(null, existe), []);
});
