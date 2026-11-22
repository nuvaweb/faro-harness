// #8 — seleccion de tests afectados para el CI de los PR (scripts/tests-afectados.js). Conservadora: ante la
// duda, suite completa ('*').
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../scripts/tests-afectados.js');

const inv = (pares) => { const m = new Map(); for (const [de, quien] of pares) { if (!m.has(de)) m.set(de, new Set()); m.get(de).add(quien); } return m; };
const TESTS = ['smoke.test.mjs', 'a.test.mjs', 'b.test.mjs', 'c.test.mjs'];
const TXT = {
  'smoke.test.mjs': '',
  'a.test.mjs': "import x from '../lib/x.js'",
  'b.test.mjs': "spawnSync(node, ['plugins/faro/hooks/harness.js', 'validate'])",
  'c.test.mjs': 'nada que ver',
};
const leer = (t) => TXT[t];

test('afectados: un test que lanza harness.js (spawn, sin import) entra si cambia una lib que harness importa', () => {
  const r = A.seleccionar({
    cambiados: ['plugins/faro/hooks/lib/gobernador.js'],
    inversas: inv([['plugins/faro/hooks/lib/gobernador.js', 'plugins/faro/hooks/harness.js']]),
    tests: TESTS, leer,
  });
  assert.deepStrictEqual(r, ['b.test.mjs', 'smoke.test.mjs']);
});

test('afectados: el import transitivo (sin limite de saltos) alcanza al test que importa', () => {
  const r = A.seleccionar({
    cambiados: ['lib/z.js'],
    inversas: inv([['lib/z.js', 'lib/y.js'], ['lib/y.js', 'lib/x.js'], ['lib/x.js', 'test/a.test.mjs']]),
    tests: TESTS, leer,
  });
  assert.deepStrictEqual(r, ['a.test.mjs', 'smoke.test.mjs']);
});

test('afectados: un test cambiado se corre; un cambio sin relacion corre solo el smoke (nunca cero tests)', () => {
  assert.deepStrictEqual(A.seleccionar({ cambiados: ['test/c.test.mjs'], inversas: new Map(), tests: TESTS, leer }), ['c.test.mjs', 'smoke.test.mjs']);
  assert.deepStrictEqual(A.seleccionar({ cambiados: ['docs/notas.md'], inversas: new Map(), tests: TESTS, leer }), ['smoke.test.mjs']);
});

test('afectados: infraestructura de tests, dependencias o el CI -> suite completa', () => {
  for (const f of ['test/run.js', 'test/helpers/repo.mjs', 'package.json', 'package-lock.json', '.github/workflows/ci.yml']) {
    assert.strictEqual(A.seleccionar({ cambiados: [f], inversas: new Map(), tests: TESTS, leer }), '*', f);
  }
  // Una lib que importa el lanzador (test/run.js) tambien: cambia como corre la suite entera.
  assert.strictEqual(A.seleccionar({ cambiados: ['plugins/faro/hooks/lib/procesos.js'], inversas: inv([['plugins/faro/hooks/lib/procesos.js', 'test/run.js']]), tests: TESTS, leer }), '*');
});

test('afectados: sin lista de cambios fiable o con base no valida -> suite completa', () => {
  assert.strictEqual(A.seleccionar({ cambiados: null, inversas: new Map(), tests: TESTS, leer }), '*');
  assert.strictEqual(A.calcular(process.cwd(), '--output=x'), '*');
  assert.strictEqual(A.calcular(process.cwd(), ''), '*');
});
