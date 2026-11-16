// scripts/release-ci.js — la publicacion automatica desde el CI (FARO 3.0), en tests atomicos.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const r = require('../scripts/release-ci.js');

const CL = '# Changelog\n\n## [Unreleased]\n\n## 3.0.0 — 2026-11-16\n\n### Cambiado\n- Directo a main.\n\n## 2.4.0 — 2026-11-13\n\n- Antes.\n';

test('seccionChangelog: saca solo la seccion de esa version', () => {
  assert.strictEqual(r.seccionChangelog(CL, '3.0.0'), '### Cambiado\n- Directo a main.');
  assert.strictEqual(r.seccionChangelog(CL, '2.4.0'), '- Antes.');
  assert.strictEqual(r.seccionChangelog(CL, '9.9.9'), null);
});

test('planPublicar: version nueva -> tag y notas del CHANGELOG', () => {
  assert.deepStrictEqual(r.planPublicar({ version: '3.0.0', tags: ['v2.4.0'], changelog: CL }), { publicar: true, tag: 'v3.0.0', notas: '### Cambiado\n- Directo a main.' });
});

test('planPublicar: tag ya existente -> no publica (merge de docs/chore)', () => {
  const p = r.planPublicar({ version: '3.0.0', tags: ['v3.0.0'], changelog: CL });
  assert.strictEqual(p.publicar, false);
  assert.match(p.motivo, /ya existe/);
});

test('planPublicar: version invalida no publica', () => {
  assert.strictEqual(r.planPublicar({ version: 'x', tags: [], changelog: CL }).publicar, false);
});

test('comprobar: feat sin bump avisa; con bump y CHANGELOG, sin avisos', () => {
  const sin = r.comprobar({ mensajes: ['feat: algo'], versionBase: '2.4.0', versionPr: '2.4.0', changelog: CL });
  assert.strictEqual(sin.bump, 'minor');
  assert.strictEqual(sin.esperada, '2.5.0');
  assert.strictEqual(sin.avisos.length, 1);
  const con = r.comprobar({ mensajes: ['feat!: directo a main'], versionBase: '2.4.0', versionPr: '3.0.0', changelog: CL });
  assert.deepStrictEqual(con.avisos, []);
});

test('comprobar: docs no pide version; subirla sin CHANGELOG avisa', () => {
  assert.deepStrictEqual(r.comprobar({ mensajes: ['docs: x'], versionBase: '2.4.0', versionPr: '2.4.0', changelog: CL }).avisos, []);
  const a = r.comprobar({ mensajes: ['fix: x'], versionBase: '2.4.0', versionPr: '2.4.1', changelog: CL }).avisos;
  assert.ok(a.some((x) => /CHANGELOG/.test(x)));
});
