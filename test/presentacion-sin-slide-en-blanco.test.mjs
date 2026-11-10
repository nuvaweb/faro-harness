// #105 — La presentacion (docgen --presentacion) metia una slide EN BLANCO tras la portada.
//
// Causa: render-doc pone el indice (<nav class="toc">) al principio del cuerpo. En la plantilla de
// presentacion ese indice esta oculto, pero el script que reparte el cuerpo en slides abre una slide
// para cualquier elemento previo al primer h1/h2 -> una slide que solo contiene algo invisible.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(RAIZ, 'plugins', 'faro', 'plantillas', 'html');
const RENDER = path.join(HTML, 'render-doc.mjs');

const MD = `---
doc_id: X-INF-001
title: Informe de prueba
version: 1.0
date: 2026-10-05
status: draft
author: equipo
classification: interno
---

# Primera seccion

Contenido de la primera slide.

## Segunda seccion

Mas contenido.
`;

function generar(pres) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-pres-'));
  const md = path.join(dir, 'informe.md');
  fs.writeFileSync(md, MD);
  const out = path.join(dir, 'salida.html');
  const r = spawnSync(process.execPath, [RENDER, md, out, ...(pres ? ['--presentacion'] : [])], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return fs.readFileSync(out, 'utf8');
}

test('la presentacion NO lleva el indice: abriria una slide vacia tras la portada', () => {
  const html = generar(true);
  assert.doesNotMatch(html, /<nav class="toc">/);
  // El cuerpo empieza directamente por el primer encabezado.
  assert.match(html, /id="content">\s*<h1 id="s0">Primera seccion<\/h1>/);
});

test('la vista documento SI conserva el indice (alli se ve y sirve)', () => {
  assert.match(generar(false), /<nav class="toc">/);
});

test('la plantilla descarta las slides sin contenido visible (defensa ante otros casos)', () => {
  const tpl = fs.readFileSync(path.join(HTML, 'faro-presentacion.html'), 'utf8');
  assert.match(tpl, /function vacia\(/, 'debe existir el filtro de slides vacias');
});

test('en PDF la ultima slide no fuerza otra pagina (en blanco) detras', () => {
  const tpl = fs.readFileSync(path.join(HTML, 'faro-presentacion.html'), 'utf8');
  assert.match(tpl, /\.slide:last-child\{[^}]*break-after:auto/);
});
