// #286 — cambiar la fuente de faro-marketplace no puede dejar faro desinstalado ni la maquina a medias.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { limpiarCacheAntigua, alinearSettingsUsuario, resumenInstalar } from '../bin/lib/plugin.mjs';
import { PERFILES } from '../bin/lib/perfil.mjs';

const home = (pref) => fs.mkdtempSync(path.join(os.tmpdir(), pref));

test('limpiarCacheAntigua: si faro NO figura instalado en ningun scope, su cache no se toca (#286)', () => {
  const d = home('faro-286-cache-');
  const base = path.join(d, '.claude', 'plugins');
  fs.mkdirSync(path.join(base, 'cache', 'faro-marketplace', 'faro', '1.1.27'), { recursive: true });
  fs.writeFileSync(path.join(base, 'installed_plugins.json'), JSON.stringify({ plugins: {} }));
  const r = limpiarCacheAntigua({ homeDir: d });
  assert.deepEqual(r.borrados, []);
  assert.ok(fs.existsSync(path.join(base, 'cache', 'faro-marketplace', 'faro', '1.1.27')));
});

test('alinearSettingsUsuario: cambia la fuente vieja de faro-marketplace en ~/.claude/settings.json y conserva el resto (#286)', () => {
  const d = home('faro-286-set-');
  fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
  const f = path.join(d, '.claude', 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ model: 'x', extraKnownMarketplaces: { 'faro-marketplace': { source: { source: 'github', repo: 'CAS-IA/faro-plugin' }, autoUpdate: true }, otro: { source: { source: 'github', repo: 'a/b' } } } }, null, 2));
  const r = alinearSettingsUsuario({ homeDir: d, perfil: PERFILES.github });
  assert.equal(r.cambiado, true);
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(s.extraKnownMarketplaces['faro-marketplace'].source, PERFILES.github.plugin.source);
  assert.equal(s.extraKnownMarketplaces['faro-marketplace'].autoUpdate, true);
  assert.deepEqual(s.extraKnownMarketplaces.otro, { source: { source: 'github', repo: 'a/b' } });
  assert.equal(s.model, 'x');
});

test('alinearSettingsUsuario: sin la entrada, o ya alineada, no escribe nada', () => {
  const d = home('faro-286-set2-');
  fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
  const f = path.join(d, '.claude', 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ model: 'x' }));
  assert.equal(alinearSettingsUsuario({ homeDir: d, perfil: PERFILES.github }).cambiado, false);
  assert.equal(fs.readFileSync(f, 'utf8'), JSON.stringify({ model: 'x' }));
  const ok = JSON.stringify({ extraKnownMarketplaces: { 'faro-marketplace': { source: PERFILES.github.plugin.source } } });
  fs.writeFileSync(f, ok);
  assert.equal(alinearSettingsUsuario({ homeDir: d, perfil: PERFILES.github }).cambiado, false);
  assert.equal(fs.readFileSync(f, 'utf8'), ok);
  assert.equal(alinearSettingsUsuario({ homeDir: home('faro-286-nada-'), perfil: PERFILES.github }).cambiado, false);
});

test('resumenInstalar: "listo" solo si faro y superpowers quedan instalados; si falta uno lo dice (#286)', () => {
  const todo = resumenInstalar(new Map([['faro@faro-marketplace', { version: '1.5.1', enabled: true }], ['superpowers@claude-plugins-official', { version: '7.1.0', enabled: true }]]));
  assert.equal(todo.listo, true);
  assert.match(todo.lineas.join('\n'), /faro 1\.5\.1/);
  assert.match(todo.lineas.join('\n'), /superpowers 7\.1\.0/);
  const falta = resumenInstalar(new Map([['superpowers@claude-plugins-official', { version: '7.1.0', enabled: true }]]));
  assert.equal(falta.listo, false);
  assert.deepEqual(falta.faltan, ['faro@faro-marketplace']);
  assert.equal(resumenInstalar(null).listo, false);
});
