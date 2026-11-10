// Los cuatro modos del wizard (instalar · crear · traer · conectar) y los flags que llevan a cada uno.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leerModo, MENU, AYUDA } from '../bin/lib/modos.mjs';

test('menú: exactamente cuatro modos', () => {
  assert.deepEqual(Object.keys(MENU), ['instalar', 'crear', 'traer', 'conectar']);
  assert.match(MENU.instalar.explica, /sin cuenta ni token/i);
  for (const m of Object.values(MENU)) { assert.ok(m.etiqueta); assert.ok(m.explica); }
});

test('sin flags: el menú decide (null)', () => {
  assert.equal(leerModo([]).modo, null);
  assert.equal(leerModo(['--dry-run']).modo, null);
});

test('instalar (alias update) y --login', () => {
  assert.equal(leerModo(['instalar']).modo, 'instalar');
  assert.equal(leerModo(['update']).modo, 'instalar');
  assert.equal(leerModo(['--login']).modo, 'conectar');
});

test('--traer, --adoptar y --check traen la carpeta; --check solo revisa', () => {
  assert.deepEqual(leerModo(['--traer']), { modo: 'traer', origen: 'carpeta', repo: null, revisar: false, migrar: null });
  assert.equal(leerModo(['--adoptar']).origen, 'carpeta');
  assert.equal(leerModo(['--check']).revisar, true);
});

test('--abrir=<repo> y --traer=<url> traen un repo de la forja', () => {
  assert.deepEqual(leerModo(['--abrir=ana/app']), { modo: 'traer', origen: 'repo', repo: 'ana/app', revisar: false, migrar: null });
  assert.equal(leerModo(['--traer=https://gitlab.com/g/app.git']).repo, 'https://gitlab.com/g/app.git');
});

test('--migrar con URL de destino o con perfil', () => {
  assert.equal(leerModo(['--migrar=https://gitlab.com/g/app.git']).migrar, 'https://gitlab.com/g/app.git');
  const m = leerModo(['--migrar', '--perfil=gitlab']);
  assert.equal(m.modo, 'traer'); assert.equal(m.origen, 'carpeta'); assert.equal(m.migrar, true);
});

test('la ayuda enseña los cuatro modos y ya no habla de miembros ni de renombrar', () => {
  for (const f of ['instalar', '--traer', '--migrar', '--login', 'update', '--abrir', '--adoptar', '--check']) assert.ok(AYUDA.includes(f), f);
  for (const f of ['--miembros', '--invitar', '--renombrar']) assert.ok(!AYUDA.includes(f), f);
});

test('crear como modo explícito', () => {
  assert.equal(leerModo(['crear']).modo, 'crear');
  assert.equal(leerModo(['crear', '--yes']).modo, 'crear');
});
