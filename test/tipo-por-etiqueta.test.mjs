// El TIPO de un issue sale de su etiqueta: la de FARO ('mejora', 'faro:mejora') o la NATIVA de GitHub
// que el catalogo le asigna ('enhancement'). Se buscaba la nativa en un campo 'nativo' que el contrato
// no tiene (se llama 'github'): una mejora se validaba como 'tarea' y se le exigia otra plantilla (#81).
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { tipoDeEtiquetas } = require(path.join(HOOKS, 'lib', 'ciclo.js'));
const CAT = require(path.join(HOOKS, 'faro-schema.json')).enums.labels;

test('tipo por etiqueta: slug, faro:slug y la NATIVA de GitHub', () => {
  assert.strictEqual(tipoDeEtiquetas(['enhancement'], CAT), 'mejora');
  assert.strictEqual(tipoDeEtiquetas([{ name: 'documentation' }], CAT), 'documentacion');
  assert.strictEqual(tipoDeEtiquetas(['question'], CAT), 'pregunta');
  assert.strictEqual(tipoDeEtiquetas(['faro:investigacion'], CAT), 'investigacion');
  assert.strictEqual(tipoDeEtiquetas(['bug', 'urgente'], CAT), 'bug');
  assert.strictEqual(tipoDeEtiquetas(['urgente'], CAT), null, 'un transversal no es un tipo');
  assert.strictEqual(tipoDeEtiquetas([], CAT), null);
});

test('ningun sitio busca ya el campo inexistente l.nativo', () => {
  const src = fs.readFileSync(path.join(HOOKS, 'lib', 'github-tareas.js'), 'utf8');
  assert.doesNotMatch(src, /l\.nativo/);
});

