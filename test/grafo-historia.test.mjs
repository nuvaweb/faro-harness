// Tarea T8 del grafo FARO (#301): impacto, tests y porque desde git.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const I = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'indice.js'));
const H = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'historia.js'));

const escribir = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
const git = (d, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: d, encoding: 'utf8', windowsHide: true });
function repo(ficheros, { init = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-his-'));
  if (init) git(d, 'init', '-q', '-b', 'main');
  for (const [rel, txt] of Object.entries(ficheros)) escribir(d, rel, txt);
  return d;
}
const commit = (d, msg) => { git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', msg); return git(d, 'rev-parse', 'HEAD').stdout.trim(); };

const CADENA = {
  'src/c.js': 'exports.c = 1;\n',
  'src/b.js': "const c = require('./c');\nexports.b = c;\n",
  'src/a.js': "const b = require('./b');\nexports.a = b;\n",
  'test/a.test.js': "require('../src/a');\n",
};

test('impacto: c cambiado -> b directo, a transitivo, test alcanzado', () => {
  const d = repo(CADENA);
  const base = commit(d, 'uno');
  escribir(d, 'src/c.js', 'exports.c = 2;\n');
  const idx = I.construir(d, {});
  const r = H.impacto(d, idx, {});
  const t = r.lineas.join('\n');
  assert.match(t, /cambiados:\n.*src\/c\.js/);
  assert.match(t, /directos:\n[^\n]*src\/b\.js/);
  assert.match(t, /transitivos:\n[^\n]*src\/a\.js/);
  assert.match(t, /tests:\n[^\n]*test\/a\.test\.js/);
  assert.ok(r.ficheros.includes('src/a.js'));
  // base explicita: el commit nuevo de b entra en el rango
  escribir(d, 'src/c.js', 'exports.c = 1;\n');
  escribir(d, 'src/b.js', "const c = require('./c');\nexports.b = c + 1;\n");
  commit(d, 'dos');
  const r2 = H.impacto(d, I.construir(d, {}), { base });
  assert.match(r2.lineas.join('\n'), /cambiados:\n.*src\/b\.js/);
  assert.match(r2.lineas[0], new RegExp(base.slice(0, 7)));
  assert.deepStrictEqual(H.cambiados(d).rels, []);
});

test('repo sin commits: solo arbol de trabajo, sin excepcion', () => {
  const d = repo(CADENA);
  const c = H.cambiados(d);
  assert.strictEqual(c.base, null);
  assert.ok(c.rels.includes('src/c.js'));
  const r = H.impacto(d, I.construir(d, {}), {});
  assert.match(r.lineas[0], /solo árbol de trabajo/);
  const fuera = H.cambiados(fs.mkdtempSync(path.join(os.tmpdir(), 'faro-his-')));
  assert.deepStrictEqual(fuera.rels, []);
});

test('tests: primero el que mas veces cambio junto a c', () => {
  const d = repo({ ...CADENA, 'test/c.test.js': "require('../src/c');\n" });
  commit(d, 'base');
  for (let i = 0; i < 3; i++) { escribir(d, 'src/c.js', `exports.c = ${i + 10};\n`); escribir(d, 'test/c.test.js', `require('../src/c'); // ${i}\n`); commit(d, `c${i}`); }
  escribir(d, 'src/c.js', 'exports.c = 99;\n'); escribir(d, 'test/a.test.js', "require('../src/a'); // x\n"); commit(d, 'ca');
  escribir(d, 'src/c.js', 'exports.c = 100;\n');
  const r = H.tests(d, I.construir(d, {}), {});
  const filas = r.lineas.filter((l) => l.includes('.test.js'));
  assert.match(filas[0], /^test\/c\.test\.js/);
  assert.match(filas[1], /^test\/a\.test\.js/);
});

test('porque: asunto con #7, citas y fichero inexistente', () => {
  const d = repo(CADENA);
  commit(d, 'fix(c): arregla el calculo (#7)');
  const r = H.porque(d, I.construir(d, {}), 'src/c.js');
  assert.ok(r.lineas.some((l) => l.includes('arregla el calculo') && l.includes('#7')));
  assert.deepStrictEqual(r.ficheros, ['src/c.js']);
  for (const mal of ['src/no.js', '../../etc/passwd', '', '-x']) {
    assert.match(H.porque(d, I.construir(d, {}), mal).lineas[0], /no existe/);
  }
});

test('porque: lista los documentos de gestion que citan el fichero', () => {
  const d = repo({ ...CADENA, 'gestion/decisions/x.md': 'Decidimos tocar `src/c.js` por rendimiento.\n', 'gestion/decisions/y.md': 'nada\n' });
  commit(d, 'base');
  const t = H.porque(d, I.construir(d, {}), 'src/c.js').lineas.join('\n');
  assert.match(t, /citado en:\n\s+gestion\/decisions\/x\.md/);
  assert.ok(!t.includes('y.md'));
});

test('rutas no ASCII salen en impacto y porque', () => {
  const d = repo({ 'src/año.js': 'exports.x = 1;\n', 'test/año.test.js': "require('../src/año');\n" });
  commit(d, 'uno');
  escribir(d, 'src/año.js', 'exports.x = 2;\n');
  const idx = I.construir(d, {});
  const t = H.impacto(d, idx, {}).lineas.join('\n');
  assert.match(t, /cambiados:\n.*src\/año\.js/);
  assert.match(t, /tests:\n[^\n]*test\/año\.test\.js/);
  const p = H.porque(d, idx, 'src/año.js').lineas.join('\n');
  assert.match(p, /uno/);
});

test('base que empieza por guion: no se usa y la cabecera lo dice', () => {
  const d = repo(CADENA);
  commit(d, 'uno');
  escribir(d, 'src/c.js', 'exports.c = 2;\n');
  const r = H.impacto(d, I.construir(d, {}), { base: '-x' });
  assert.match(r.lineas[0], /base no válida/);
  assert.ok(!/base main/.test(r.lineas[0]));
});

test('porque: pathspec magico no ensancha, da no existe', () => {
  const d = repo(CADENA);
  commit(d, 'uno');
  const idx = I.construir(d, {});
  for (const mal of ['.', 'src/*', ':(glob)src/**', 'src']) {
    assert.match(H.porque(d, idx, mal).lineas[0], /no existe/, mal);
  }
});

test('porque: no lee gestion a traves de un enlace simbolico', () => {
  const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-fuera-'));
  escribir(fuera, 'gestion/x.md', 'cita src/c.js\n');
  const d = repo(CADENA);
  commit(d, 'uno');
  try { fs.symlinkSync(fuera, path.join(d, 'faro'), 'junction'); } catch { return; }
  const t = H.porque(d, I.construir(d, {}), 'src/c.js').lineas.join('\n');
  assert.ok(!t.includes('x.md'));
});

// Ola final de menores (#301).
test('porque: fichero borrado con historia muestra commits; borrado sin historia, no existe', () => {
  const d = repo(CADENA);
  commit(d, 'añade c');
  fs.rmSync(path.join(d, 'src/c.js'));
  commit(d, 'borra c');
  const idx = I.construir(d, {});
  const t = H.porque(d, idx, 'src/c.js').lineas.join('\n');
  assert.match(t, /borra c/);
  assert.match(t, /añade c/);
  assert.match(H.porque(d, idx, 'src/nunca.js').lineas[0], /no existe/);
  assert.match(H.porque(d, idx, 'src').lineas[0], /no existe/);
});

test('impacto: base inexistente lo dice; bases con segmentos vacios se rechazan', () => {
  const d = repo(CADENA);
  commit(d, 'uno');
  const idx = I.construir(d, {});
  assert.match(H.impacto(d, idx, { base: 'no-existe' }).lineas[0], /base no-existe no encontrada: solo árbol de trabajo/);
  assert.match(H.impacto(d, idx, { base: 'a//b' }).lineas[0], /base no válida/);
  assert.match(H.impacto(d, idx, { base: 'a/' }).lineas[0], /base no válida/);
});

test('impacto: en main sin rango dice solo arbol de trabajo, no base main', () => {
  const d = repo(CADENA);
  commit(d, 'uno');
  const l = H.impacto(d, I.construir(d, {}), {}).lineas[0];
  assert.match(l, /solo árbol de trabajo/);
  assert.ok(!/base main/.test(l));
});

test('porque: la cita exige limite de ruta, sin falsos positivos por subcadena', () => {
  const d = repo({ ...CADENA, 'gestion/a.md': 'toca xsrc/c.js.bak y src/c.jsx\n', 'gestion/b.md': 'ver (src/c.js)\n' });
  commit(d, 'base');
  const t = H.porque(d, I.construir(d, {}), 'src/c.js').lineas.join('\n');
  assert.ok(!t.includes('a.md'));
  assert.ok(t.includes('b.md'));
});
