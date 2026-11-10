// La version SUGERIDA tiene que ser la que se va a publicar (#69). Si la version declarada
// (package.json / plugin.json) ya se subio en su rama y esta sin tag, ESA es la del release — el tag
// sale de ahi. Antes se sumaba siempre sobre ella: package.json 0.4.0 sin tags sugeria 0.5.0, y
// plugin.json 0.54.1 con ultimo tag v0.50.0 sugeria 0.55.0.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { analizarRelease } = require(path.join(HOOKS, 'lib', 'ciclo.js'));
const commits = ['feat(x): algo nuevo', 'fix(y): una correccion'];

test('sin tags previos: se sugiere la version declarada', () => {
  const r = analizarRelease({ ultimoTag: null, commits, unreleased: '', versionActual: '0.4.0' });
  assert.strictEqual(r.sugerida, '0.4.0');
  assert.match(r.razon, /declarada/i);
});

test('version declarada por delante del ultimo tag: se sugiere la declarada', () => {
  const r = analizarRelease({ ultimoTag: 'v0.50.0', commits, unreleased: '', versionActual: '0.54.1' });
  assert.strictEqual(r.sugerida, '0.54.1');
});

test('version declarada YA tageada: se sugiere el siguiente salto por contenido', () => {
  assert.strictEqual(analizarRelease({ ultimoTag: 'v0.54.1', commits, unreleased: '', versionActual: '0.54.1' }).sugerida, '0.55.0');
  assert.strictEqual(analizarRelease({ ultimoTag: 'v0.54.1', commits: ['fix: algo'], unreleased: '', versionActual: '0.54.1' }).sugerida, '0.54.2');
});

test('sin version declarada (0.0.0) y sin tags: sigue el salto por contenido', () => {
  assert.strictEqual(analizarRelease({ ultimoTag: null, commits, unreleased: '', versionActual: '0.0.0' }).sugerida, '0.1.0');
});
