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
  assert.strictEqual('infra' in c, false);
  assert.strictEqual('referencia' in c, false);
  assert.deepStrictEqual(c.terraform, { dir: null, binario: null });
  assert.deepStrictEqual(c.avisos, []);
  assert.deepStrictEqual(D.config(null).terraform, { dir: null, binario: null });
});

test('config con valores válidos los respeta', () => {
  const c = D.config({ despliegue: { terraform: { dir: 'infra', binario: 'tofu' } } });
  assert.deepStrictEqual(c.terraform, { dir: 'infra', binario: 'tofu' });
  assert.deepStrictEqual(c.avisos, []);
});

test('config ignora una clave entornos (FARO no piensa en entornos)', () => {
  const c = D.config({ despliegue: { entornos: ['dev', 'Prod!'] } });
  assert.strictEqual('entornos' in c, false);
  assert.deepStrictEqual(c.avisos, []);
});

test('las claves retiradas (infra, referencia, puerta_produccion...) ya no existen', () => {
  const c = D.config({ despliegue: { infra: 'otra', referencia: 'x', puerta_produccion: 'x', preview: false, salud_url: 'u' } });
  assert.strictEqual(c.avisos.length, 0);
  for (const k of ['infra', 'referencia', 'puerta_produccion', 'preview', 'salud_url', 'entornos']) assert.strictEqual(k in c, false);
});

const ctxVacio = { root: '/x', leer: () => null, existe: () => false, listar: () => [], cfg: D.config({}), forja: null, monorepo: false, apps: [] };
const falso = (id, det, hall) => ({ id, detectar: () => det, diagnostico: () => hall, gates: () => [], comandoLocal: () => null });

test('diagnosticar agrega y ordena hallazgos (error, aviso, info) sin secretos', () => {
  const a = falso('a', { x: 1 }, [{ nivel: 'info', codigo: 'i', mensaje: 'i' }, { nivel: 'error', codigo: 'e', mensaje: 'e' }]);
  const b = falso('b', { y: 2 }, [{ nivel: 'aviso', codigo: 'w', mensaje: 'w' }]);
  const n = falso('n', null, [{ nivel: 'error', codigo: 'no', mensaje: 'no' }]);
  const r = D.diagnosticar(ctxVacio, [a, b, n]);
  assert.deepStrictEqual(r.detectados.map((d) => d.id), ['a', 'b']);
  assert.deepStrictEqual(r.hallazgos.map((h) => h.nivel), ['error', 'aviso', 'info']);
  assert.strictEqual('secretos' in r, false);
});

test('diagnosticar sin detectados devuelve un info', () => {
  const r = D.diagnosticar(ctxVacio, [falso('a', null, [], [])]);
  assert.deepStrictEqual(r.detectados, []);
  assert.strictEqual(r.hallazgos.length, 1);
  assert.strictEqual(r.hallazgos[0].nivel, 'info');
  assert.match(r.hallazgos[0].mensaje, /sin despliegue detectado/i);
});

test('adaptadores() devuelve un array real aunque falten los módulos de Cloudflare y Terraform', () => {
  const l = D.adaptadores();
  assert.ok(Array.isArray(l));
  assert.doesNotThrow(() => Object.keys(l));
  assert.strictEqual('ADAPTADORES' in D, false);
});

test('ctxDesdeDisco construye un contexto sin tocar la red', () => {
  const ctx = D.ctxDesdeDisco(RAIZ, {});
  assert.strictEqual(ctx.root, RAIZ);
  assert.strictEqual(ctx.existe('package.json'), true);
  assert.strictEqual(ctx.existe('no-existe-xyz'), false);
  assert.strictEqual(ctx.leer('no-existe-xyz'), null);
  assert.ok(ctx.listar('test').length > 0);
  assert.deepStrictEqual(ctx.listar('no-existe-xyz'), []);
});
