// #298 T5 — consumidores en modo sombra: comparar, dominios.grafo con indice fresco, y la linea [grafo] de validate.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const require = createRequire(import.meta.url);
const S = require(path.join(HOOKS, 'lib', 'grafo', 'sombra.js'));
const I = require(path.join(HOOKS, 'lib', 'grafo', 'indice.js'));
const dom = require(path.join(HOOKS, 'lib', 'dominios.js'));

const escribir = (d, rel, txt) => { const p = path.join(d, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); };
const repo = (ficheros) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-sombra-'));
  git(d, 'init', '-q'); git(d, 'config', 'user.email', 'a@b.c'); git(d, 'config', 'user.name', 'T'); git(d, 'config', 'commit.gpgsign', 'false');
  for (const [rel, txt] of Object.entries(ficheros)) escribir(d, rel, txt);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base');
  return d;
};
const g = (obj) => ({ aristas: new Map(Object.entries(obj).map(([k, v]) => [k, new Set(v)])) });
const FICHEROS = {
  'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
  'src/a.ts': "import { b } from './b';\nimport { x } from '@/x';\nexport const a = b + x;\n",
  'src/b.ts': 'export const b = 1;\n',
  'src/x.ts': 'export const x = 2;\n',
};
const conIndice = (ficheros = FICHEROS) => { const d = repo(ficheros); assert.ok(I.guardar(d, I.construir(d, {}))); return d; };

test('comparar: aristas identicas dan listas vacias', () => {
  const r = S.comparar(g({ 'a.js': ['b.js'] }), g({ 'a.js': ['b.js'] }));
  assert.deepStrictEqual(r, { soloViejo: [], soloNuevo: [] });
});

test('comparar: un import por alias @/x aparece en soloNuevo', () => {
  const d = repo(FICHEROS);
  const nuevo = I.aristas(I.construir(d, {}));
  const r = S.comparar(g({ 'src/a.ts': ['src/b.ts'] }), nuevo);
  assert.deepStrictEqual(r.soloNuevo, [['src/a.ts', 'src/x.ts']]);
  assert.deepStrictEqual(r.soloViejo, []);
});

test('dominios.grafo con indice fresco deja .sombra.json y devuelve el resultado viejo', () => {
  const d = conIndice();
  const r = dom.grafo(d);
  assert.deepStrictEqual([...r.aristas.get('src/a.ts')], ['src/b.ts'], 'el valor devuelto es el viejo (sin alias)');
  const s = JSON.parse(fs.readFileSync(I.rutaIndice(d) + '.sombra.json', 'utf8'));
  assert.deepStrictEqual(Object.keys(s).sort(), ['generado', 'indiceMtime', 'soloNuevo', 'soloViejo']);
  assert.deepStrictEqual(s.soloNuevo, [['src/a.ts', 'src/x.ts']]);
});

test('sin indice: no se crea nada y el resultado es el mismo', () => {
  const d = repo(FICHEROS);
  const r = dom.grafo(d, ['src/a.ts', 'src/b.ts', 'src/x.ts']);
  assert.ok(r.aristas.has('src/a.ts'));
  assert.ok(!fs.existsSync(path.join(d, 'faro')));
  assert.ok(!fs.existsSync(I.rutaIndice(d) + '.sombra.json'));
});

test('lista parcial: no se toca la sombra', () => {
  const d = conIndice();
  dom.grafo(d, ['src/a.ts', 'src/b.ts']);
  assert.ok(!fs.existsSync(I.rutaIndice(d) + '.sombra.json'));
});

test('indice caducado: la segunda llamada no ejecuta cargar', () => {
  const d = conIndice();
  escribir(d, 'src/b.ts', 'export const b = 99; // cambio\n');
  const orig = I.cargar; let n = 0;
  I.cargar = (...a) => { n++; return orig(...a); };
  try { dom.grafo(d); dom.grafo(d); } finally { I.cargar = orig; }
  assert.strictEqual(n, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(I.rutaIndice(d) + '.sombra.json', 'utf8')).noFresco, true);
});

test('grafo.js deja .sombra-cableado.json con indice fresco', () => {
  const d = conIndice({ 'a.js': "require('./b.js');\n", 'b.js': '\n' });
  const H = path.join(HOOKS, 'lib', 'grafo.js');
  const ctx = { fs, path, ROOT: d, faroSchema: () => null };
  require(H)(ctx).analizar();
  assert.ok(fs.existsSync(I.rutaIndice(d) + '.sombra-cableado.json'));
});

test('si la sombra no es mas vieja que el indice, no se recalcula', () => {
  const d = conIndice();
  dom.grafo(d, null);
  const sp = I.rutaIndice(d) + '.sombra.json';
  fs.writeFileSync(sp, '{"marca":1,"soloViejo":[],"soloNuevo":[]}');
  const futuro = new Date(Date.now() + 60000); fs.utimesSync(sp, futuro, futuro);
  dom.grafo(d, null);
  assert.match(fs.readFileSync(sp, 'utf8'), /marca/);
});

test('indice caducado: solo se deja la marca noFresco, sin diferencias', () => {
  const d = conIndice();
  escribir(d, 'src/b.ts', 'export const b = 99; // cambio\n');
  dom.grafo(d, null);
  const s = JSON.parse(fs.readFileSync(I.rutaIndice(d) + '.sombra.json', 'utf8'));
  assert.strictEqual(s.noFresco, true);
  assert.ok(!('soloViejo' in s));
});

test('no se escribe a traves de un enlace simbolico', (t) => {
  const d = conIndice();
  const sp = I.rutaIndice(d) + '.sombra.json';
  const objetivo = path.join(d, 'fuera.txt'); fs.writeFileSync(objetivo, 'intacto');
  try { fs.symlinkSync(objetivo, sp); } catch { t.skip('sin permiso para symlinks'); return; }
  dom.grafo(d, null);
  assert.strictEqual(fs.readFileSync(objetivo, 'utf8'), 'intacto');
});

const instancia = () => {
  const d = repo({ 'src/a.js': "require('./b.js');\n", 'src/b.js': '\n', 'ESTADO.md': '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\n---\n### Fase 1 · Una — in_progress\n' });
  return d;
};
const validate = (d) => { const r = spawnSync(process.execPath, [HARNESS, 'validate'], { cwd: d, encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: d, CLAUDE_PLUGIN_DATA: path.join(os.tmpdir(), 'faro-sombra-data', path.basename(d)) } }); return (r.stdout || '') + (r.stderr || ''); };

test('validate: emite [grafo] solo si hay diferencias', () => {
  const d = instancia();
  assert.doesNotMatch(validate(d), /\[grafo\]/, 'sin indice, nada');
  assert.ok(I.guardar(d, I.construir(d, {})));
  const sp = I.rutaIndice(d) + '.sombra.json';
  const im = fs.lstatSync(I.rutaIndice(d)).mtimeMs;
  fs.writeFileSync(sp, JSON.stringify({ indiceMtime: im + 1, soloViejo: [['a', 'b']], soloNuevo: [['c', 'd']] }));
  assert.doesNotMatch(validate(d), /\[grafo\]/, 'sombra de otro mtime: obsoleta');
  fs.writeFileSync(sp, JSON.stringify({ indiceMtime: im, noFresco: true }));
  assert.doesNotMatch(validate(d), /\[grafo\]/, 'noFresco');
  fs.writeFileSync(sp, JSON.stringify({ indiceMtime: im, soloViejo: [['a', 'b']], soloNuevo: [['c', 'd'], ['e', 'f']] }));
  assert.match(validate(d), /\[grafo\] el grafo nuevo difiere en 3 aristas \(1 solo en el viejo\) — harness\.js grafo estado/);
  fs.writeFileSync(sp, JSON.stringify({ indiceMtime: im, soloViejo: [], soloNuevo: [] }));
  assert.doesNotMatch(validate(d), /\[grafo\]/);
  fs.rmSync(I.rutaIndice(d));
  fs.writeFileSync(sp, JSON.stringify({ indiceMtime: im, soloViejo: [['a', 'b']], soloNuevo: [] }));
  assert.doesNotMatch(validate(d), /\[grafo\]/, 'sin indice');
});

test('contexto sin opts.lista (universo completo) deja .sombra.json; con lista parcial no', () => {
  const d = conIndice();
  dom.contexto(d, { cfg: dom.config(d) }).g;
  assert.ok(fs.existsSync(I.rutaIndice(d) + '.sombra.json'));
  const e = conIndice();
  dom.contexto(e, { cfg: dom.config(e), lista: ['src/a.ts', 'src/b.ts'] }).g;
  assert.ok(!fs.existsSync(I.rutaIndice(e) + '.sombra.json'));
});
