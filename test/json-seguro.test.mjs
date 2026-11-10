// lib/json-seguro.js es una utilidad GLOBAL: cualquier parte del harness que comparta un JSON entre
// procesos deberia usarla. Por eso se prueba por su cuenta, no solo a traves de quien la consume.
//
// Resuelve dos fallos que se dan juntos en la practica pero son distintos: el fichero que queda a
// medias (writeFileSync interrumpido) y la perdida por copia obsoleta (escribir lo que leiste hace
// segundos, pisando lo de otro proceso).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { leerJson, escribirJsonAtomico, fusionarConDisco, fusionarSubobjeto } = require(path.join(HOOKS, 'lib', 'json-seguro.js'));

// Cada test con su PROPIO directorio, no solo su propio nombre de fichero: os.tmpdir() lo comparte
// toda la suite y se llena de ficheros de otros tests. Con directorio propio, el test de "no deja
// temporales" mira un sitio donde solo escribe el, y nada de fuera puede confundirlo.
const ruta = (n) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), `faro-js-${n}-`)), 'almacen.json');

// ---------- leerJson ----------

test('leerJson devuelve el defecto si el fichero no existe (no revienta)', () => {
  assert.deepStrictEqual(leerJson(ruta('inexistente'), { a: 1 }), { a: 1 });
});

test('leerJson devuelve el defecto si el JSON esta corrupto', () => {
  const p = ruta('corrupto');
  fs.writeFileSync(p, '{esto no es json');
  assert.deepStrictEqual(leerJson(p, {}), {}, 'un fichero roto no puede tumbar la sesion');
});

// ---------- escribirJsonAtomico ----------

test('escribe y se puede releer', () => {
  const p = ruta('basico');
  assert.strictEqual(escribirJsonAtomico(p, { a: 1, b: 'x' }), true);
  assert.deepStrictEqual(leerJson(p), { a: 1, b: 'x' });
});

test('no deja temporales tirados', () => {
  const p = ruta('limpio');
  escribirJsonAtomico(p, { a: 1 });
  escribirJsonAtomico(p, { a: 2 });
  const sobras = fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith(path.basename(p)) && f !== path.basename(p));
  assert.deepStrictEqual(sobras, [], `temporales sin limpiar: ${sobras.join(', ')}`);
});

// Lo que justifica el rename: si el fichero se sustituye de golpe, un lector concurrente ve la
// version vieja ENTERA o la nueva ENTERA, nunca un JSON truncado.
test('el fichero resultante siempre es JSON valido, tambien con contenido grande', () => {
  const p = ruta('grande');
  escribirJsonAtomico(p, { relleno: 'x'.repeat(200000), tokens: { a: 1 } });
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(p, 'utf8')));
});

test('si no se puede escribir devuelve false en vez de lanzar', () => {
  // Ruta imposible: el llamante es un hook, no puede permitirse una excepcion.
  assert.strictEqual(escribirJsonAtomico(path.join(os.tmpdir(), 'no-existe-este-dir', 'x.json'), { a: 1 }), false);
});

// ---------- fusionarConDisco ----------

test('conserva lo que otro proceso escribio y yo no conocia', () => {
  const p = ruta('fusion');
  escribirJsonAtomico(p, { deOtro: 'no me lo pises' });
  const salida = fusionarConDisco(p, { mio: 'lo que escribo' }, null);
  assert.strictEqual(salida.deOtro, 'no me lo pises');
  assert.strictEqual(salida.mio, 'lo que escribo');
});

test('lo que yo mando GANA sobre lo que hay en disco', () => {
  const p = ruta('gana');
  escribirJsonAtomico(p, { k: 'viejo' });
  assert.strictEqual(fusionarConDisco(p, { k: 'nuevo' }, null).k, 'nuevo');
});

// Sin esto la fusion haria IMPOSIBLE borrar: todo lo que quitaras reaparecia desde disco.
test('si conocia la clave y no la mando, es un BORRADO y se respeta', () => {
  const p = ruta('borrado');
  escribirJsonAtomico(p, { sobra: 1, queda: 2 });
  const salida = fusionarConDisco(p, { queda: 2 }, { sobra: true, queda: true });
  assert.ok(!('sobra' in salida), 'un borrado explicito debe respetarse');
  assert.strictEqual(salida.queda, 2);
});

test('sin fichero en disco no inventa nada', () => {
  assert.deepStrictEqual(fusionarConDisco(ruta('vacio'), { a: 1 }, null), { a: 1 });
});

// ---------- fusionarSubobjeto ----------

test('conserva las entradas de un subobjeto que yo no conocia (el caso de los tokens)', () => {
  const p = ruta('sub');
  escribirJsonAtomico(p, { tokens: { 'github.com': { token: 'G' }, 'gitlab.com': { token: 'L' } } });
  // Escribo solo el de github, sin saber que existia el de gitlab.
  const salida = fusionarSubobjeto(p, { tokens: { 'github.com': { token: 'G2' } } }, 'tokens', null);
  assert.strictEqual(salida.tokens['github.com'].token, 'G2', 'lo mio gana');
  assert.strictEqual(salida.tokens['gitlab.com'].token, 'L', 'lo que no conocia se conserva');
});

test('en un subobjeto, borrar lo que conocia tambien se respeta', () => {
  const p = ruta('sub-borrado');
  escribirJsonAtomico(p, { tokens: { a: 1, b: 2 } });
  const salida = fusionarSubobjeto(p, { tokens: { b: 2 } }, 'tokens', { a: true, b: true });
  assert.ok(!('a' in salida.tokens), 'borrado explicito de una credencial');
});

test('si la clave no existe en disco, devuelve lo que se manda tal cual', () => {
  const p = ruta('sin-sub');
  escribirJsonAtomico(p, { otra: 1 });
  assert.deepStrictEqual(fusionarSubobjeto(p, { tokens: { a: 1 } }, 'tokens', null).tokens, { a: 1 });
});
