// Núcleo agnóstico de despliegue: config con valores por defecto, registro y agregado de adaptadores.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const D = require(path.join(RAIZ, 'plugins/faro/hooks/lib/despliegue.js'));
const J = require(path.join(RAIZ, 'plugins/faro/hooks/lib/jsonc.js'));

test('jsonc.parse tolera comentarios y comas finales; null si no es válido', () => {
  assert.deepStrictEqual(J.parse('{\n // c\n "a": 1, /* x */ "b": [1,2,], }'), { a: 1, b: [1, 2] });
  assert.strictEqual(J.parse('{nope'), null);
  assert.strictEqual(J.parse(null), null);
});

test('config sin clave devuelve los valores por defecto', () => {
  const c = D.config({});
  assert.deepStrictEqual(c.entornos, ['staging', 'production']);
  assert.strictEqual(c.puerta_produccion, 'tag');
  assert.strictEqual(c.preview, true);
  assert.strictEqual(c.infra, null);
  assert.strictEqual(c.referencia, null);
  assert.strictEqual(c.salud_url, null);
  assert.deepStrictEqual(c.terraform, { dir: null, binario: null });
  assert.deepStrictEqual(c.avisos, []);
  assert.deepStrictEqual(D.config(null).entornos, ['staging', 'production']);
});

test('config con valores válidos los respeta', () => {
  const c = D.config({ despliegue: { entornos: ['dev', 'prod'], puerta_produccion: 'aprobacion', preview: false, infra: 'externa', referencia: 'docs/x.md', salud_url: 'https://x.test/health', terraform: { dir: 'infra', binario: 'tofu' } } });
  assert.deepStrictEqual(c.entornos, ['dev', 'prod']);
  assert.strictEqual(c.puerta_produccion, 'aprobacion');
  assert.strictEqual(c.preview, false);
  assert.strictEqual(c.infra, 'externa');
  assert.strictEqual(c.referencia, 'docs/x.md');
  assert.strictEqual(c.salud_url, 'https://x.test/health');
  assert.deepStrictEqual(c.terraform, { dir: 'infra', binario: 'tofu' });
  assert.deepStrictEqual(c.avisos, []);
});

test('entorno inválido cae al defecto con aviso', () => {
  const c = D.config({ despliegue: { entornos: ['Prod!'] } });
  assert.deepStrictEqual(c.entornos, ['staging', 'production']);
  assert.strictEqual(c.avisos.length, 1);
  assert.match(c.avisos[0], /entornos/);
});

test('puerta_produccion, infra y preview inválidos caen al defecto con aviso', () => {
  const c = D.config({ despliegue: { puerta_produccion: 'x', infra: 'otra', preview: 'si' } });
  assert.strictEqual(c.puerta_produccion, 'tag');
  assert.strictEqual(c.infra, null);
  assert.strictEqual(c.preview, true);
  assert.strictEqual(c.avisos.length, 3);
});

const ctxVacio = { root: '/x', leer: () => null, existe: () => false, listar: () => [], cfg: D.config({}), forja: null, monorepo: false, apps: [] };
const falso = (id, det, hall, sec) => ({ id, detectar: () => det, diagnostico: () => hall, gates: () => [], pasosCi: () => [], comandoLocal: () => null, secretosEsperados: () => sec });

test('diagnosticar agrega, ordena hallazgos (error, aviso, info) y une secretos por nombre', () => {
  const a = falso('a', { x: 1 }, [{ nivel: 'info', codigo: 'i', mensaje: 'i' }, { nivel: 'error', codigo: 'e', mensaje: 'e' }], [{ nombre: 'TOKEN', entornos: ['staging'], proposito: 'p' }]);
  const b = falso('b', { y: 2 }, [{ nivel: 'aviso', codigo: 'w', mensaje: 'w' }], [{ nombre: 'TOKEN', entornos: ['production', 'staging'], proposito: 'p' }, { nombre: 'OTRO', entornos: ['production'], proposito: 'q' }]);
  const n = falso('n', null, [{ nivel: 'error', codigo: 'no', mensaje: 'no' }], []);
  const r = D.diagnosticar(ctxVacio, [a, b, n]);
  assert.deepStrictEqual(r.detectados.map((d) => d.id), ['a', 'b']);
  assert.deepStrictEqual(r.hallazgos.map((h) => h.nivel), ['error', 'aviso', 'info']);
  const t = r.secretos.find((s) => s.nombre === 'TOKEN');
  assert.deepStrictEqual([...t.entornos].sort(), ['production', 'staging']);
  assert.strictEqual(r.secretos.length, 2);
});

test('diagnosticar sin detectados devuelve un info', () => {
  const r = D.diagnosticar(ctxVacio, [falso('a', null, [], [])]);
  assert.deepStrictEqual(r.detectados, []);
  assert.strictEqual(r.hallazgos.length, 1);
  assert.strictEqual(r.hallazgos[0].nivel, 'info');
  assert.match(r.hallazgos[0].mensaje, /sin despliegue detectado/i);
});

test('ADAPTADORES es una lista y ctxDesdeDisco construye un contexto sin tocar la red', () => {
  assert.ok(Array.isArray(D.ADAPTADORES));
  const ctx = D.ctxDesdeDisco(RAIZ, {});
  assert.strictEqual(ctx.root, RAIZ);
  assert.strictEqual(ctx.existe('package.json'), true);
  assert.strictEqual(ctx.existe('no-existe-xyz'), false);
  assert.strictEqual(ctx.leer('no-existe-xyz'), null);
  assert.ok(ctx.listar('test').length > 0);
  assert.deepStrictEqual(ctx.listar('no-existe-xyz'), []);
});
