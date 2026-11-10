// #256 — El motor se publica abierto y universal: las plantillas de documentos son NEUTRAS «FARO».
// Ni la marca de una empresa concreta, ni su logo incrustado, ni un pie «confidencial — uso interno»
// en ninguna plantilla ni en las imprentas que las usan (Word, one-pager, reporte de negocio).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLANTILLAS = path.join(RAIZ, 'plugins', 'faro', 'plantillas');
const LIB = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib');

function recorrer(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? recorrer(p) : [p];
  });
}

const FICHEROS = [
  ...recorrer(PLANTILLAS),
  ...['docx.js', 'reporte-negocio.js', 'onepager.js'].map((f) => path.join(LIB, f)),
];
const MARCA = new RegExp(['fract', 'alia'].join(''), 'i');   // troceado: el test no cita la marca
const rel = (p) => path.relative(RAIZ, p).replace(/\\/g, '/');

test('las plantillas neutras existen con nombre faro-* y no queda ninguna de marca', () => {
  const html = fs.readdirSync(path.join(PLANTILLAS, 'html'));
  for (const n of ['documento', 'informe', 'presentacion', 'onepager', 'roadmap']) assert.ok(html.includes(`faro-${n}.html`), `falta faro-${n}.html`);
  assert.deepStrictEqual(html.filter((f) => MARCA.test(f)), []);
});

test('ninguna plantilla ni imprenta (docx, reporte-negocio, onepager) cita la marca', () => {
  for (const f of FICHEROS) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), MARCA, rel(f));
});

test('sin logos incrustados en base64 (el de marca ni ningun otro) ni pie confidencial de uso interno', () => {
  for (const f of FICHEROS) {
    const s = fs.readFileSync(f, 'utf8');
    // Una imagen incrustada de verdad: data URI seguido de datos base64 (no el patron de una regex).
    assert.doesNotMatch(s, /data:image\/[a-z+]+;base64,[A-Za-z0-9+/]{40}/, `${rel(f)} incrusta una imagen`);
    // Cabecera PNG del logo de marca que llevaban las plantillas (por si se cuela fuera de un data URI).
    assert.ok(!s.includes('iVBORw0KGgoAAAANSUhEUgAAAMYAAAA3'), `${rel(f)} lleva el logo de marca`);
    assert.doesNotMatch(s, /CONFIDENCIAL|uso interno/i, `${rel(f)} lleva un pie de uso interno`);
  }
});
