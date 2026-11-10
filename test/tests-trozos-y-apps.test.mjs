// #178 — cierre: (1) la suite completa se reparte en TROZOS deterministas para correr en paralelo en CI
// (`node test/run.js --trozo i/n`); (2) en un monorepo, cuando el cambio no deja claro QUE probar (varias apps,
// codigo sin dominio) el comando lo dice con las opciones para que el agente PREGUNTE al usuario, y `--app <ruta>`
// acota a una app. Nada se adivina: misma entrada, misma salida.
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
const dom = require(path.join(HOOKS, 'lib', 'dominios.js'));

const escribir = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const repo = (ficheros, faro) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-trozos-'));
  git(d, 'init', '-q'); git(d, 'config', 'user.email', 'a@b.c'); git(d, 'config', 'user.name', 'T'); git(d, 'config', 'commit.gpgsign', 'false');
  escribir(d, '.faro.json', JSON.stringify(faro, null, 2));
  for (const [rel, txt] of Object.entries(ficheros)) escribir(d, rel, txt);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base');
  return d;
};
const harness = (cwd, args) => {
  const r = spawnSync(process.execPath, [HARNESS, ...args], { cwd, encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, CLAUDE_PLUGIN_DATA: path.join(os.tmpdir(), 'faro-trozos-data', path.basename(cwd)) } });
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
};

// ---------- trozos ----------

test('trozo: reparte TODOS los ficheros, sin repetir, igual en cada ejecucion y equilibrado por peso', () => {
  const lista = Array.from({ length: 23 }, (_, i) => `test/t${String(i).padStart(2, '0')}.test.mjs`);
  const peso = (f) => 1 + (Number(f.slice(6, 8)) % 5) * 10;
  const trozos = [1, 2, 3, 4].map((i) => dom.trozo(lista, i, 4, peso));
  assert.deepStrictEqual(trozos.flat().sort(), [...lista].sort(), 'la union es la suite completa');
  assert.strictEqual(new Set(trozos.flat()).size, lista.length, 'sin repetidos');
  assert.deepStrictEqual(dom.trozo([...lista].reverse(), 2, 4, peso), trozos[1], 'determinista aunque cambie el orden de entrada');
  const pesos = trozos.map((t) => t.reduce((s, f) => s + peso(f), 0));
  assert.ok(Math.max(...pesos) - Math.min(...pesos) <= 41, `equilibrado: ${pesos}`);
});

test('trozo: un argumento invalido se rechaza (nunca ejecuta de mas ni de menos en silencio)', () => {
  for (const [i, n] of [[0, 4], [5, 4], [1, 0], [1.5, 2]]) assert.throws(() => dom.trozo(['a'], i, n), /trozo/);
  assert.deepStrictEqual(dom.trozoDe('2/4'), { i: 2, n: 4 });
  assert.strictEqual(dom.trozoDe('2-4'), null);
  assert.strictEqual(dom.trozoDe('9/4'), null);
});

test('run.js --trozo i/n ejecuta solo su parte de la suite y lo dice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-trozos-suite-'));
  const nombres = ['a', 'b', 'c', 'd', 'e'].map((x) => `${x}.test.mjs`);
  for (const n of nombres) escribir(dir, n, "import { test } from 'node:test'; test('ok', () => {});\n");
  const correr = (t) => spawnSync(process.execPath, [path.join(RAIZ, 'test', 'run.js'), `--trozo=${t}`], { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, FARO_TEST_DIR: dir, FARO_BATERIA_FORZAR: '1' } });
  const vistos = [];
  for (const t of ['1/2', '2/2']) {
    const r = correr(t);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, new RegExp(`trozo ${t.replace('/', '\\/')}`));
    vistos.push(...nombres.filter((n) => r.stdout.includes(`] ${n}`)));
  }
  assert.deepStrictEqual(vistos.sort(), nombres);
  const mal = correr('3/2');
  assert.strictEqual(mal.status, 2);
  assert.match(mal.stderr, /trozo/);
  const vacio = correr('6/6');
  assert.strictEqual(vacio.status, 2, 'un trozo vacio no es un verde');
  assert.match(vacio.stderr, /vacío/);
  const espacio = spawnSync(process.execPath, [path.join(RAIZ, 'test', 'run.js'), '--trozo', '1/2'], { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, FARO_TEST_DIR: dir, FARO_BATERIA_FORZAR: '1' } });
  assert.strictEqual(espacio.status, 2);
  assert.match(espacio.stderr, /--trozo=i\/n/);
});

test('CI: la suite completa corre en trozos paralelos (matriz) con node directo, no via npm --', () => {
  const ci = fs.readFileSync(path.join(RAIZ, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /trozo:\s*\[\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*\]/);
  assert.match(ci, /run: node test\/run\.js --test-concurrency=1 --trozo=\$\{\{ matrix\.trozo \}\}\/4/);
});

// ---------- monorepo: preguntar cuando no se puede deducir ----------

const MONO = {
  'apps/api/src/pagos/cobro.js': 'module.exports = { cobrar: (x) => x };\n',
  'apps/api/src/suelto.js': 'module.exports = {};\n',
  'apps/api/test/pagos.test.mjs': "import { cobrar } from '../src/pagos/cobro.js';\n",
  'apps/web/src/carrito/carrito.js': 'module.exports = { total: () => 0 };\n',
  'apps/web/test/carrito.test.mjs': "import { total } from '../src/carrito/carrito.js';\n",
};
const FARO_MONO = {
  tests: {
    comando: 'node --test',
    codigo: ['apps/*/src/**'],
    dominios: {
      pagos: { descripcion: 'Cobros de la api', codigo: ['apps/api/src/pagos/**'], tests: ['apps/api/test/pagos.test.mjs'] },
      carrito: { descripcion: 'Carrito de la web', codigo: ['apps/web/src/carrito/**'], tests: ['apps/web/test/carrito.test.mjs'] },
    },
  },
};
const tocar = (d, ...rels) => { for (const r of rels) fs.appendFileSync(path.join(d, r), '// cambio\n'); };

test('monorepo: cambio en UNA app -> sin pregunta, solo su dominio', () => {
  const d = repo(MONO, FARO_MONO);
  tocar(d, 'apps/api/src/pagos/cobro.js');
  const ctx = dom.contexto(d);
  const r = dom.resolver(d, dom.cambiadosContra(d, 'HEAD'), { ctx });
  assert.deepStrictEqual(r.afectados.map((a) => a.dominio), ['pagos']);
  assert.deepStrictEqual(r.apps, ['apps/api']);
  assert.deepStrictEqual(r.preguntas, []);
});

test('monorepo: cambios en VARIAS apps -> pregunta cual probar, con las apps como opciones', () => {
  const d = repo(MONO, FARO_MONO);
  tocar(d, 'apps/api/src/pagos/cobro.js', 'apps/web/src/carrito/carrito.js');
  const r = dom.resolver(d, dom.cambiadosContra(d, 'HEAD'), { ctx: dom.contexto(d) });
  assert.deepStrictEqual(r.apps, ['apps/api', 'apps/web']);
  const p = r.preguntas.find((x) => x.tipo === 'app');
  assert.ok(p, JSON.stringify(r.preguntas));
  assert.deepStrictEqual(p.opciones.map((o) => o.valor), ['apps/api', 'apps/web', 'todas']);
  const cli = harness(d, ['tests-dominios', '--afectados', '--base', 'HEAD']);
  assert.match(cli.out, /PREGUNTA AL USUARIO/);
  assert.match(cli.out, /--app apps\/api/);
});

test('monorepo: --app acota a esa app y ya no pregunta', () => {
  const d = repo(MONO, FARO_MONO);
  tocar(d, 'apps/api/src/pagos/cobro.js', 'apps/web/src/carrito/carrito.js');
  const r = dom.resolver(d, dom.cambiadosContra(d, 'HEAD'), { ctx: dom.contexto(d), app: 'apps/web' });
  assert.deepStrictEqual(r.afectados.map((a) => a.dominio), ['carrito']);
  assert.deepStrictEqual(r.tests, ['apps/web/test/carrito.test.mjs']);
  assert.deepStrictEqual(r.preguntas, []);
  const cli = harness(d, ['tests-dominios', '--afectados', '--base', 'HEAD', '--app', 'apps/web']);
  assert.doesNotMatch(cli.out, /PREGUNTA AL USUARIO/);
  assert.match(cli.out, /carrito/);
  assert.doesNotMatch(cli.out, /- pagos/);
  const mal = harness(d, ['tests-dominios', '--afectados', '--base', 'HEAD', '--app', 'apps/nada']);
  assert.strictEqual(mal.status, 2);
  assert.match(mal.err, /apps\/api, apps\/web/);
});

test('--app con un cambio TRANSVERSAL de la raiz: sigue alcanzando a los dominios de esa app (no se esconde)', () => {
  const faro = JSON.parse(JSON.stringify(FARO_MONO));
  faro.tests.transversal = ['shared/**'];
  const d = repo({ ...MONO, 'shared/util.js': 'module.exports = { x: 1 };\n', 'apps/api/src/pagos/cobro.js': "require('../../../../shared/util.js'); module.exports = { cobrar: (x) => x };\n" }, faro);
  tocar(d, 'shared/util.js');
  const ctx = dom.contexto(d);
  const cambiados = dom.cambiadosContra(d, 'HEAD');
  const todas = dom.resolver(d, cambiados, { ctx });
  assert.deepStrictEqual(todas.afectados.map((a) => a.dominio), ['pagos']);
  const api = dom.resolver(d, cambiados, { ctx, app: 'apps/api' });
  assert.deepStrictEqual(api.afectados.map((a) => a.dominio), ['pagos']);
  assert.deepStrictEqual(api.tests, ['apps/api/test/pagos.test.mjs']);
  const web = dom.resolver(d, cambiados, { ctx, app: 'apps/web' });
  assert.deepStrictEqual(web.afectados, [], 'a la web no le alcanza');
});

test('--app todas: todos los dominios afectados, sin pregunta', () => {
  const d = repo(MONO, FARO_MONO);
  tocar(d, 'apps/api/src/pagos/cobro.js', 'apps/web/src/carrito/carrito.js');
  const r = dom.resolver(d, dom.cambiadosContra(d, 'HEAD'), { ctx: dom.contexto(d), app: 'todas' });
  assert.deepStrictEqual(r.afectados.map((a) => a.dominio).sort(), ['carrito', 'pagos']);
  assert.deepStrictEqual(r.preguntas, []);
  assert.strictEqual(harness(d, ['tests-dominios', '--afectados', '--base', 'HEAD', '--app', 'todas']).status, 0);
});

test('test:afectados del motor: una --app inexistente sale con 2 (nunca verde en silencio)', () => {
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'test-afectados.js'), '--lista', '--app', 'apps/nada'], { cwd: RAIZ, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 2, r.stdout);
  assert.match(r.stderr, /no existe/);
});

test('codigo sin dominio -> pregunta a que dominio pertenece, ofreciendo los de SU app', () => {
  const d = repo(MONO, FARO_MONO);
  tocar(d, 'apps/api/src/suelto.js');
  const r = dom.resolver(d, dom.cambiadosContra(d, 'HEAD'), { ctx: dom.contexto(d) });
  const p = r.preguntas.find((x) => x.tipo === 'dominio');
  assert.ok(p, JSON.stringify(r.preguntas));
  assert.deepStrictEqual(p.ficheros, ['apps/api/src/suelto.js']);
  assert.deepStrictEqual(p.opciones.map((o) => o.valor), ['pagos', 'nuevo']);
});

test('repo normal (sin apps): ni apps ni pregunta de app', () => {
  const d = repo({ 'src/a/x.js': '1\n', 'test/a.test.mjs': "import '../src/a/x.js';\n" }, { tests: { comando: 'node --test', dominios: { a: { descripcion: 'A', codigo: ['src/a/**'], tests: ['test/a.test.mjs'] } } } });
  tocar(d, 'src/a/x.js');
  const r = dom.resolver(d, dom.cambiadosContra(d, 'HEAD'), { ctx: dom.contexto(d) });
  assert.deepStrictEqual(r.apps, []);
  assert.deepStrictEqual(r.preguntas, []);
});
