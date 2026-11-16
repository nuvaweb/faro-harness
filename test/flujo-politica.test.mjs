// lib/flujo.js — la politica del flujo directo a main (FARO 3.0), en tests atomicos (sin git ni red).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const f = require('../plugins/faro/hooks/lib/flujo.js');

test('config: por defecto main, auto-merge y squash', () => {
  assert.deepStrictEqual({ ...f.config({ env: {}, cfgRepo: {} }) }, { rama_principal: 'main', auto_merge: true, metodo_merge: 'squash' });
});

test('config: el repo manda sobre el defecto y el entorno sobre el repo', () => {
  const repo = { rama_principal: 'master', auto_merge: false, metodo_merge: 'merge' };
  assert.deepStrictEqual({ ...f.config({ env: {}, cfgRepo: repo }) }, { rama_principal: 'master', auto_merge: false, metodo_merge: 'merge' });
  const env = { FARO_RAMA_PRINCIPAL: 'trunk', FARO_AUTO_MERGE: '1', FARO_METODO_MERGE: 'rebase' };
  assert.deepStrictEqual({ ...f.config({ env, cfgRepo: repo }) }, { rama_principal: 'trunk', auto_merge: true, metodo_merge: 'rebase' });
});

test('config: un metodo de merge desconocido cae al defecto', () => {
  assert.strictEqual(f.config({ env: { FARO_METODO_MERGE: 'pulpo' }, cfgRepo: {} }).metodo_merge, 'squash');
});

test('config: lee "flujo" de .faro.json del repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-flujo-'));
  fs.writeFileSync(path.join(dir, '.faro.json'), JSON.stringify({ flujo: { auto_merge: false } }));
  assert.strictEqual(f.config({ root: dir, env: {} }).auto_merge, false);
});

test('tipoDeRama: Conventional, alias heredados y ramas que no son de trabajo', () => {
  assert.strictEqual(f.tipoDeRama('feat/12-algo'), 'feat');
  assert.strictEqual(f.tipoDeRama('hotfix/3-x'), 'fix');
  assert.strictEqual(f.tipoDeRama('feature/x'), 'feat');
  assert.strictEqual(f.tipoDeRama('spike/x'), 'chore');
  assert.strictEqual(f.tipoDeRama('main'), null);
  assert.strictEqual(f.tipoDeRama('develop'), null);
});

test('analizarTitulo: tipo, alcance y ruptura', () => {
  assert.deepStrictEqual(f.analizarTitulo('feat(flujo)!: directo a main'), { ok: true, tipo: 'feat', alcance: 'flujo', ruptura: true, descripcion: 'directo a main' });
  assert.strictEqual(f.analizarTitulo('fix: x').ok, true);
  assert.strictEqual(f.analizarTitulo('Arreglo cosas').ok, false);
  assert.strictEqual(f.analizarTitulo('magia: x').ok, false);
});

test('tituloConventional: respeta uno valido y construye desde la rama si no lo es', () => {
  assert.strictEqual(f.tituloConventional('fix/4-x', 'feat: ya vale'), 'feat: ya vale');
  assert.strictEqual(f.tituloConventional('hotfix/4-x', 'Login roto'), 'fix: login roto');
  assert.strictEqual(f.tituloConventional('feat/7-flujo-directo', ''), 'feat: flujo directo');
});

test('bumpDe: el mayor manda; docs/chore no publican', () => {
  assert.strictEqual(f.bumpDe(['docs: x', 'chore: y']), null);
  assert.strictEqual(f.bumpDe(['fix: x', 'docs: y']), 'patch');
  assert.strictEqual(f.bumpDe(['fix: x', 'feat: y']), 'minor');
  assert.strictEqual(f.bumpDe(['feat!: x', 'fix: y']), 'major');
  assert.strictEqual(f.bumpDe(['fix: x\n\nBREAKING CHANGE: se quita develop']), 'major');
  assert.strictEqual(f.bumpDe(['Merge branch x']), null);
});

test('siguienteVersion', () => {
  assert.strictEqual(f.siguienteVersion('2.4.0', 'major'), '3.0.0');
  assert.strictEqual(f.siguienteVersion('v2.4.1', 'minor'), '2.5.0');
  assert.strictEqual(f.siguienteVersion('2.4.1', 'patch'), '2.4.2');
  assert.strictEqual(f.siguienteVersion('2.4.1', null), '2.4.1');
  assert.strictEqual(f.siguienteVersion('nada', 'patch'), null);
});

test('avisoRetirado: dice que se retiro y por donde se va ahora', () => {
  const t = f.avisoRetirado('consolidar');
  assert.match(t, /3\.0/);
  assert.match(t, /PR a main/);
});
