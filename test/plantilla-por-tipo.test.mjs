// Cada tipo de issue tiene su formato ESTANDAR, leido del contrato (faro-schema.json >
// enums.plantillas_issue), no escrito a mano en el codigo (#74). Y las subtareas van SIEMPRE a su
// seccion: antes 'ampliar' las colaba tras los criterios y '--subtarea' creaba un segundo bloque.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { plantillaIssue, huecosDeIssue, subtareasEnCuerpo, ampliarCuerpo } = require(path.join(HOOKS, 'lib', 'ciclo.js'));
const SCHEMA = require(path.join(HOOKS, 'faro-schema.json'));
const P = SCHEMA.enums.plantillas_issue;
const secciones = (p) => [...p.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
const rellena = (p) => p.replace(/<[^>]*>+/g, 'algo');

test('cada tipo con plantilla propia la saca en el ORDEN del contrato', () => {
  for (const [tipo, def] of Object.entries(P)) {
    if (tipo.startsWith('_') || def.exento) continue;
    assert.deepStrictEqual(secciones(plantillaIssue(tipo)), def.secciones.map((s) => s.titulo), tipo);
  }
});

test('los alias usan la plantilla de su tipo (bugfix/hotfix -> bug, spike -> investigacion)', () => {
  assert.strictEqual(plantillaIssue('hotfix'), plantillaIssue('bug'));
  assert.strictEqual(plantillaIssue('spike'), plantillaIssue('investigacion'));
});

test('investigacion pide pregunta, hipotesis y limite de tiempo; requerimiento, a quien sirve', () => {
  for (const s of ['Pregunta', 'Hipotesis', 'Limite de tiempo', 'Resultado esperado']) assert.ok(secciones(plantillaIssue('investigacion')).includes(s), s);
  assert.ok(secciones(plantillaIssue('requerimiento')).includes('A quien sirve'));
});

test('huecos por tipo: una investigacion con la plantilla comun esta incompleta', () => {
  const h = huecosDeIssue(rellena(plantillaIssue('tarea')), 'investigacion');
  for (const s of ['Pregunta', 'Hipotesis', 'Limite de tiempo']) assert.ok(h.some((x) => x.includes(s)), `${s}: ${h.join(' | ')}`);
});

test('huecos por tipo: cada plantilla rellena esta completa para su tipo', () => {
  for (const [tipo, def] of Object.entries(P)) {
    if (tipo.startsWith('_') || def.exento) continue;
    assert.deepStrictEqual(huecosDeIssue(rellena(plantillaIssue(tipo)), tipo), [], tipo);
  }
});

test('tipos EXENTOS (reporte, duplicado, descartado): sin plantilla ni huecos', () => {
  for (const tipo of ['reporte', 'duplicado', 'descartado']) {
    assert.strictEqual(plantillaIssue(tipo), '', tipo);
    assert.deepStrictEqual(huecosDeIssue('lo que llego, tal cual', tipo), [], tipo);
  }
});

test('las subtareas de --subtarea van a la seccion de la plantilla, sin un segundo bloque', () => {
  const r = subtareasEnCuerpo(plantillaIssue('tarea'), ['Marca y colores', 'Favicon']);
  assert.strictEqual((r.match(/^## Subtareas$/gm) || []).length, 1, r);
  assert.doesNotMatch(r, /- \[ \] <paso>/, 'el marcador de ejemplo se sustituye');
  const sub = r.split('## Subtareas')[1].split('## ')[0];
  assert.match(sub, /- \[ \] Marca y colores\n- \[ \] Favicon/);
});

test('ampliar mete la subtarea en SU seccion, no despues de los criterios', () => {
  const base = subtareasEnCuerpo(rellena(plantillaIssue('tarea')).replace('- [ ] algo\n\n## Criterios', '- [ ] Primera\n\n## Criterios'), []);
  const r = ampliarCuerpo(base, ['Segunda']);
  const sub = r.split('## Subtareas')[1].split('## ')[0];
  assert.match(sub, /- \[ \] Primera\n- \[ \] Segunda/, r);
  assert.doesNotMatch(r.split('## Criterios de aceptacion')[1], /Segunda/);
});
