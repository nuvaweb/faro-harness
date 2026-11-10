// FARO es universal (#256): nada de lo que se publica lleva la marca ni los nombres de una organizacion
// concreta, ni su app OAuth. Las plataformas de producto las declara cada organizacion en .faro.json.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// troceado: el test no se cita a si mismo
const MARCA = new RegExp(['fract' + 'alia', 'cas-?' + 'ia\b', 'ca' + 'sia', 'qra' + 'tia', 'three' + 'play'].join('|'), 'i');
const APP_OAUTH_ANTIGUA = 'Ov23li' + 'Kk3T9bWKak2wmH';

function ficheros(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules') return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? ficheros(p) : [p];
  });
}
const PUBLICADO = [
  ...ficheros(path.join(RAIZ, 'plugins')),
  ...ficheros(path.join(RAIZ, '.claude-plugin')),
  ...ficheros(path.join(RAIZ, 'cli', 'bin')),
  path.join(RAIZ, 'README.md'),
  path.join(RAIZ, 'cli', 'package.json'),
];

test('ningun fichero publicado (plugin, wizard, README) lleva la marca de una organizacion', () => {
  const con = PUBLICADO.filter((f) => MARCA.test(fs.readFileSync(f, 'latin1'))).map((f) => path.relative(RAIZ, f));
  assert.deepStrictEqual(con, []);
});

test('la app OAuth de la organizacion anterior ya no esta en el codigo', () => {
  const con = PUBLICADO.filter((f) => fs.readFileSync(f, 'latin1').includes(APP_OAUTH_ANTIGUA)).map((f) => path.relative(RAIZ, f));
  assert.deepStrictEqual(con, []);
});

test('licencia MIT en la raiz y manifiestos con autor y repo publico', () => {
  assert.match(fs.readFileSync(path.join(RAIZ, 'LICENSE'), 'utf8'), /^MIT License[\s\S]*Copyright \(c\) 2026 Fernando Acevedo/);
  const pj = JSON.parse(fs.readFileSync(path.join(RAIZ, 'plugins', 'faro', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.strictEqual(pj.license, 'MIT');
  assert.ok(!pj.mcpServers, 'el plugin no declara MCP de una organizacion');
  assert.match(pj.repository, /nuvaweb\/faro-harness/);
});

test('la variable del token es FARO_GITHUB_TOKEN y el client_id se configura con FARO_CLIENT_ID', () => {
  const cred = fs.readFileSync(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'credenciales.js'), 'utf8');
  const ident = fs.readFileSync(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'github-identidad.js'), 'utf8');
  assert.match(cred, /FARO_GITHUB_TOKEN/);
  assert.match(ident, /process\.env\.FARO_CLIENT_ID/);
});
