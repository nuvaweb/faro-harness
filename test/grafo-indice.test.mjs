// Tarea T3 del grafo FARO (#298): indice incremental persistido.
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
const X = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'extraer.js'));

const escribir = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
function repoCon(ficheros, { git = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-idx-'));
  for (const [rel, txt] of Object.entries(ficheros)) escribir(d, rel, txt);
  if (git) spawnSync('git', ['init', '-q'], { cwd: d, windowsHide: true });
  return d;
}
const plano = (m) => Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort()]));
const espia = () => { const e = { n: 0, rels: [] }; e.f = (rel, txt) => { e.n++; e.rels.push(rel); return X.extraer(rel, txt); }; return e; };
const futuro = (d, rel) => { const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(d, rel), t, t); };

const BASE = { 'src/a.js': "import './b.js';\nexport const a = 1;\n", 'src/b.js': "import './c.js';\n", 'src/c.js': 'module.exports = {};\n', 'README.md': '# x\n' };

test('en frio: aristas esperadas, aristas() coincide y solo hay nodos de codigo', () => {
  const d = repoCon(BASE);
  const ind = I.construir(d, {});
  assert.strictEqual(ind.version, 1);
  assert.deepStrictEqual(Object.keys(ind.ficheros).sort(), ['src/a.js', 'src/b.js', 'src/c.js']);
  assert.strictEqual(ind.ficheros['src/a.js'].tipo, 'codigo');
  assert.match(ind.ficheros['src/a.js'].hash, /^[0-9a-f]{40}$/);
  assert.deepStrictEqual(ind.ficheros['src/a.js'].imports[0], { spec: './b.js', linea: 1, destino: 'src/b.js', clase: 'interno' });
  const g = I.aristas(ind);
  assert.deepStrictEqual(plano(g.aristas), { 'src/a.js': ['src/b.js'], 'src/b.js': ['src/c.js'] });
  assert.deepStrictEqual(plano(g.inversas), { 'src/b.js': ['src/a.js'], 'src/c.js': ['src/b.js'] });
});

test('tipo: test, migracion y codigo', () => {
  const d = repoCon({ 'test/x.test.js': '', 'src/y.spec.ts': '', 'tests/z.py': '', 'a/test_q.py': '', 'db/001.sql': 'create table t(id int);', 'src/k.js': '' });
  const f = I.construir(d, {}).ficheros;
  assert.strictEqual(f['test/x.test.js'].tipo, 'test');
  assert.strictEqual(f['src/y.spec.ts'].tipo, 'test');
  assert.strictEqual(f['tests/z.py'].tipo, 'test');
  assert.strictEqual(f['a/test_q.py'].tipo, 'test');
  assert.strictEqual(f['db/001.sql'].tipo, 'migracion');
  assert.strictEqual(f['src/k.js'].tipo, 'codigo');
});

test('incremental: cambiar un fichero reextrae solo ese', () => {
  const d = repoCon(BASE);
  const prev = I.construir(d, {});
  escribir(d, 'src/c.js', "import './a.js';\n"); futuro(d, 'src/c.js');
  const e = espia();
  const ind = I.construir(d, { previo: prev, _extraer: e.f });
  assert.deepStrictEqual(e.rels, ['src/c.js']);
  assert.deepStrictEqual(plano(I.aristas(ind).aristas)['src/c.js'], ['src/a.js']);
});

test('incremental: mismo contenido con otro mtime no se reextrae', () => {
  const d = repoCon(BASE);
  const prev = I.construir(d, {});
  futuro(d, 'src/c.js');
  const e = espia();
  const ind = I.construir(d, { previo: prev, _extraer: e.f });
  assert.strictEqual(e.n, 0);
  assert.notStrictEqual(ind.ficheros['src/c.js'].mtimeMs, prev.ficheros['src/c.js'].mtimeMs);
});

test('incremental: borrar un fichero quita sus aristas', () => {
  const d = repoCon(BASE);
  const prev = I.construir(d, {});
  fs.rmSync(path.join(d, 'src/b.js'));
  const ind = I.construir(d, { previo: prev });
  assert.ok(!('src/b.js' in ind.ficheros));
  assert.deepStrictEqual(plano(I.aristas(ind).aristas), {});
  assert.strictEqual(ind.ficheros['src/a.js'].imports[0].clase, 'no-resuelto');
});

test('incremental: anadir un fichero resuelve un import antes no-resuelto', () => {
  const d = repoCon({ 'src/a.js': "import './n.js';\n" });
  const prev = I.construir(d, {});
  assert.strictEqual(prev.ficheros['src/a.js'].imports[0].clase, 'no-resuelto');
  escribir(d, 'src/n.js', '');
  const e = espia();
  const ind = I.construir(d, { previo: prev, _extraer: e.f });
  assert.deepStrictEqual(e.rels, ['src/n.js']);
  assert.deepStrictEqual(plano(I.aristas(ind).aristas), { 'src/a.js': ['src/n.js'] });
});

test('incremental: cambiar un tsconfig rehace la resolucion de todos', () => {
  const d = repoCon({ 'src/a.ts': "import '@x/b';\n", 'src/lib/b.ts': '', 'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@x/*":["nada/*"]}}}' });
  const prev = I.construir(d, {});
  assert.strictEqual(prev.ficheros['src/a.ts'].imports[0].destino, null);
  escribir(d, 'tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@x/*":["src/lib/*"]}}}'); futuro(d, 'tsconfig.json');
  const ind = I.construir(d, { previo: prev });
  assert.strictEqual(ind.ficheros['src/a.ts'].imports[0].destino, 'src/lib/b.ts');
});

test('persistencia: guardar y cargar es idempotente; corrupto o version vieja da null', () => {
  const d = repoCon(BASE);
  const ind = I.construir(d, {});
  assert.strictEqual(I.cargar(d), null);
  assert.strictEqual(I.guardar(d, ind), true);
  assert.ok(I.rutaIndice(d).replace(/\\/g, '/').endsWith('faro/.cache/grafo.json'));
  assert.deepStrictEqual(I.cargar(d), JSON.parse(JSON.stringify(ind)));
  assert.ok(!fs.existsSync(I.rutaIndice(d) + '.tmp'));
  const txt = fs.readFileSync(I.rutaIndice(d), 'utf8');
  fs.writeFileSync(I.rutaIndice(d), txt.slice(0, txt.length >> 1));
  assert.strictEqual(I.cargar(d), null);
  fs.writeFileSync(I.rutaIndice(d), JSON.stringify({ ...ind, version: 0 }));
  assert.strictEqual(I.cargar(d), null);
  // un previo corrupto equivale a frio
  assert.deepStrictEqual(plano(I.aristas(I.construir(d, { previo: I.cargar(d) })).aristas), plano(I.aristas(ind).aristas));
});

test('rutaIndice: layout legado usa .git/faro-grafo.json y no crea faro/', () => {
  const d = repoCon({ 'ESTADO.md': '# e\n', 'src/a.js': '' });
  assert.ok(I.rutaIndice(d).replace(/\\/g, '/').endsWith('.git/faro-grafo.json'));
  assert.strictEqual(I.guardar(d, I.construir(d, {})), true);
  assert.ok(!fs.existsSync(path.join(d, 'faro')));
  assert.ok(I.cargar(d));
});

test('guardar: un indice de mas de 20 MB no se guarda', () => {
  const d = repoCon(BASE);
  const ind = I.construir(d, {});
  ind.relleno = 'x'.repeat(21 * 1024 * 1024);
  assert.strictEqual(I.guardar(d, ind), false);
  assert.ok(!fs.existsSync(I.rutaIndice(d)));
});

test('fresco: true sin cambios, false tras cambiar o anadir', () => {
  const d = repoCon(BASE);
  const ind = I.construir(d, {});
  assert.strictEqual(I.fresco(d, ind), true);
  escribir(d, 'src/c.js', 'module.exports = { z: 1 };\n'); futuro(d, 'src/c.js');
  assert.strictEqual(I.fresco(d, ind), false);
  const ind2 = I.construir(d, { previo: ind });
  assert.strictEqual(I.fresco(d, ind2), true);
  escribir(d, 'src/nuevo.js', '');
  assert.strictEqual(I.fresco(d, ind2), false);
});

test('enlace simbolico a un directorio con codigo: no es nodo ni se recorre', (t) => {
  const d = repoCon({ 'src/a.js': '', 'otro/z.js': '' }, { git: false });
  try { fs.symlinkSync(path.join(d, 'otro'), path.join(d, 'enlace'), 'junction'); } catch { return t.skip('el SO no permite enlaces'); }
  try { fs.symlinkSync(path.join(d, 'src/a.js'), path.join(d, 'src/ln.js'), 'file'); } catch { /* sin enlaces a fichero */ }
  const ind = I.construir(d, {});
  assert.deepStrictEqual(Object.keys(ind.ficheros).sort(), ['otro/z.js', 'src/a.js']);
});

test('fichero grande: omitido por tamano y sin imports', () => {
  const d = repoCon({ 'src/grande.js': "import './a.js';\n//" + 'x'.repeat(2 * 1024 * 1024) + '\n', 'src/a.js': '' });
  const e = espia();
  const ind = I.construir(d, { _extraer: e.f });
  assert.strictEqual(ind.ficheros['src/grande.js'].omitido, 'tamaño');
  assert.deepStrictEqual(ind.ficheros['src/grande.js'].imports, []);
  assert.ok(!e.rels.includes('src/grande.js'));
});

test('rendimiento: 2000 ficheros en frio < 4 s; 1 cambiado < 200 ms', () => {
  const f = {};
  for (let i = 0; i < 2000; i++) f[`src/m${i % 50}/f${i}.js`] = `import './f${(i + 1) % 2000}.js';\nexport const v${i} = ${i};\n`;
  const d = repoCon(f, { git: false });
  const lista = Object.keys(f);
  let t0 = performance.now();
  const ind = I.construir(d, { lista });
  const frio = performance.now() - t0;
  assert.strictEqual(Object.keys(ind.ficheros).length, 2000);
  assert.ok(frio < 4000, `frio ${frio} ms`);
  escribir(d, 'src/m0/f0.js', 'export const v0 = 99;\n'); futuro(d, 'src/m0/f0.js');
  t0 = performance.now();
  const ind2 = I.construir(d, { previo: ind, lista });
  const inc = performance.now() - t0;
  assert.ok(inc < 200, `incremental ${inc} ms`);
  if (process.env.FARO_PERF) console.log(`perf frio=${frio.toFixed(0)}ms inc=${inc.toFixed(0)}ms`);
  assert.strictEqual(ind2.ficheros['src/m0/f0.js'].imports.length, 0);
});

test('worktree legado: .git es un fichero gitdir (relativo o absoluto) y el indice se guarda alli', () => {
  for (const relativo of [true, false]) {
    const d = repoCon({ 'ESTADO.md': '# e\n', 'src/a.js': '' }, { git: false });
    fs.mkdirSync(path.join(d, 'real-gitdir'));
    fs.writeFileSync(path.join(d, '.git'), 'gitdir: ' + (relativo ? 'real-gitdir' : path.join(d, 'real-gitdir')) + '\n');
    assert.strictEqual(path.resolve(I.rutaIndice(d)), path.join(d, 'real-gitdir', 'faro-grafo.json'));
    assert.strictEqual(I.guardar(d, I.construir(d, { lista: ['ESTADO.md', 'src/a.js'] })), true);
    assert.ok(I.cargar(d));
  }
});

test('guardar: tmp unico, sin restos y sin tocar un .tmp ajeno', () => {
  const d = repoCon(BASE);
  const ind = I.construir(d, {});
  const p = I.rutaIndice(d);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', 'ajeno');
  assert.strictEqual(I.guardar(d, ind), true);
  assert.strictEqual(fs.readFileSync(p + '.tmp', 'utf8'), 'ajeno');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(p)).filter((n) => n.includes('.tmp-')), []);
  // si rename falla (destino es un directorio) no queda tmp
  fs.rmSync(p); fs.mkdirSync(p);
  assert.strictEqual(I.guardar(d, ind), false);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(p)).filter((n) => n.includes('.tmp-')), []);
});
