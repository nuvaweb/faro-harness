// Tarea T1 del grafo FARO (#298): extractor unificado con exportaciones, SQL y el idioma
// path.join(__dirname, ...). Puro: recibe (rel, texto) y devuelve la estructura.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const X = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'extraer.js'));
const nombres = (l) => l.map((e) => e.nombre);

const JS_TXT = [
  'export function a() {}',
  'export const b = 1;',
  'export default function () {}',
  'export { c, d as e };',
  'module.exports = { f, g };',
  'exports.h = 1;',
].join('\n');

test('JS: exporta funciones, const, default, listas, module.exports y exports.x', () => {
  const r = X.extraer('src/m.js', JS_TXT);
  assert.strictEqual(r.lenguaje, 'js');
  assert.deepStrictEqual(nombres(r.exporta), ['a', 'b', 'default', 'c', 'e', 'f', 'g', 'h']);
  assert.strictEqual(r.exporta[0].linea, 1);
  assert.deepStrictEqual(r.tablas, { define: [], usa: [] });
});

test('JS: path.join(__dirname, ...) produce el import relativo', () => {
  const r = X.extraer('lib/y.js', "const z = path.join(__dirname, 'lib', 'x.js');\nconst w = path.resolve(__dirname, 'k.js');");
  assert.deepStrictEqual(r.imports.map((i) => i.spec), ['./lib/x.js', './k.js']);
  assert.strictEqual(r.imports[0].linea, 1);
  assert.strictEqual(r.imports[1].linea, 2);
});

test('PY: def, class y __all__ en el nivel superior; lo anidado no', () => {
  const txt = ['def a():', '    def interna():', '        pass', '', 'class B:', '    def metodo(self): pass', "__all__ = ['c']"].join('\n');
  const r = X.extraer('pkg/m.py', txt);
  assert.strictEqual(r.lenguaje, 'py');
  assert.deepStrictEqual(nombres(r.exporta), ['a', 'B', 'c']);
});

test('SQL: tablas definidas y usadas, solo bajo migrations/migraciones/db', () => {
  const txt = ['CREATE TABLE IF NOT EXISTS "x" (id int, y_id int REFERENCES y(id));', 'ALTER TABLE z ADD COLUMN q int;'].join('\n');
  for (const dir of ['migrations', 'migraciones', 'db']) {
    const r = X.extraer(`${dir}/001.sql`, txt);
    assert.strictEqual(r.lenguaje, 'sql');
    assert.deepStrictEqual(nombres(r.tablas.define), ['x']);
    assert.deepStrictEqual(nombres(r.tablas.usa), ['y', 'z']);
    assert.strictEqual(r.tablas.usa[1].linea, 2);
  }
  const fuera = X.extraer('docs/001.sql', txt);
  assert.strictEqual(fuera.lenguaje, null);
  assert.deepStrictEqual(fuera.tablas, { define: [], usa: [] });
  assert.deepStrictEqual(fuera.exporta, []);
});

test('CRLF da las mismas lineas y resultados que LF', () => {
  for (const [rel, txt] of [['m.js', JS_TXT], ['m.py', 'def a():\n  pass\nclass B: pass\n'], ['db/1.sql', 'CREATE TABLE t (a int);\nALTER TABLE u ADD x int;']]) {
    assert.deepStrictEqual(X.extraer(rel, txt.replace(/\n/g, '\r\n')), X.extraer(rel, txt));
  }
});

test('lenguajeDe y extensiones conservan su firma', () => {
  assert.strictEqual(X.lenguajeDe('a.ts'), 'js');
  assert.strictEqual(X.lenguajeDe('a.d.ts'), null);
  assert.strictEqual(X.lenguajeDe('a.txt'), null);
  assert.ok(X.extensiones.includes('.py'));
  assert.deepStrictEqual(X.extraer('a.txt', 'x'), { lenguaje: null, imports: [], es: [], exporta: [], tablas: { define: [], usa: [] } });
});
