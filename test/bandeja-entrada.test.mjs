// BANDEJA DE ENTRADA (#84): lo que llega de fuera (bugs, features, sugerencias) entra SUELTO, sin hito,
// y el harness lo recupera igualmente para triar. Bandeja = issues abiertos SIN HITO, mas cualquiera
// con la etiqueta 'reporte' (lo que manda el canal y lo que alguien crea a mano por la web). No depende
// del canal. Solo lo triado recibe tipo, plantilla y hito.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { bandejaDeEntrada } = require(path.join(HOOKS, 'lib', 'tarea.js'));
const CAT = require(path.join(HOOKS, 'faro-schema.json')).enums.labels;
const AHORA = Date.parse('2026-09-24T12:00:00Z');
const hace = (n) => new Date(AHORA - n * 86400000).toISOString();

const ISSUES = [
  { number: 1, title: 'Falla el login', state: 'open', milestone: null, labels: [{ name: 'reporte' }, { name: 'bug' }, { name: 'origen:atlas-web' }], created_at: hace(3), reactions: { '+1': 2 }, comments: 1, author_association: 'NONE', html_url: 'u1' },
  { number: 2, title: 'Idea: exportar a PDF', state: 'open', milestone: null, labels: [{ name: 'enhancement' }], created_at: hace(10), author_association: 'CONTRIBUTOR' },
  { number: 3, title: 'Sin etiqueta', state: 'open', milestone: null, labels: [], created_at: hace(1), author_association: 'MEMBER' },
  { number: 4, title: 'Ya en una fase', state: 'open', milestone: { title: 'Fase 1 — Base' }, labels: [], created_at: hace(20) },
  { number: 5, title: 'Reporte que alguien metio en el Backlog', state: 'open', milestone: { title: 'Backlog' }, labels: [{ name: 'faro:reporte' }], created_at: hace(30) },
  { number: 6, title: 'Cerrado sin hito', state: 'closed', milestone: null, labels: [], created_at: hace(40) },
  { number: 7, title: 'Un PR', state: 'open', milestone: null, pull_request: {}, created_at: hace(2) },
];

test('bandeja = abiertos sin hito + cualquiera con reporte; ni PRs ni cerrados; el mas antiguo primero', () => {
  assert.deepStrictEqual(bandejaDeEntrada(ISSUES, CAT, AHORA).map((e) => e.numero), [5, 2, 1, 3]);
});

test('cada entrada trae lo que el triaje necesita: tipo sugerido (tambien nativo), origen, votos, dias y si viene de fuera', () => {
  const porN = Object.fromEntries(bandejaDeEntrada(ISSUES, CAT, AHORA).map((e) => [e.numero, e]));
  assert.deepStrictEqual(porN[1], { numero: 1, titulo: 'Falla el login', tipo: 'bug', origen: 'atlas-web', votos: 2, comentarios: 1, dias: 3, deFuera: true, url: 'u1' });
  assert.strictEqual(porN[2].tipo, 'mejora', "'enhancement' es una mejora");
  assert.strictEqual(porN[3].tipo, null, 'sin etiqueta: el triaje decide');
  assert.strictEqual(porN[3].deFuera, false, 'MEMBER es del equipo');
});
