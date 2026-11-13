// Tarea T4 del grafo FARO (#298): comando `grafo` y construccion en segundo plano.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');
const I = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'indice.js'));
const C = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'grafo', 'cli.js'));

const escribir = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
function repo({ faro = true } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-grafo-'));
  escribir(d, 'src/a.js', "const b = require('./b.js');\nmodule.exports = b;\n");
  escribir(d, 'src/b.js', 'module.exports = 1;\n');
  if (faro) escribir(d, 'faro/ESTADO.md', '# estado\n'); else escribir(d, 'ESTADO.md', '# estado\n');
  spawnSync('git', ['init', '-q'], { cwd: d, windowsHide: true });
  return d;
}
const correr = (root, argv) => { const l = []; const code = C.cli(argv, { root, out: (t) => l.push(t) }); return { code, out: l.join('\n') }; };

test('estado sin indice da el mensaje exacto', () => {
  const d = repo();
  const r = correr(d, ['estado']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'grafo: sin índice — harness.js grafo construir');
});

test('construir crea el indice en layout faro y estado lo describe', () => {
  const d = repo();
  const r = correr(d, ['construir']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^grafo: 2 ficheros, 1 aristas, 2 reextraídos, \d+ ms$/);
  assert.ok(fs.existsSync(path.join(d, 'faro', '.cache', 'grafo.json')));
  assert.match(correr(d, ['estado']).out, /^grafo: 2 ficheros · 1 aristas · generado hace .+ · fresco$/);
  const r2 = correr(d, ['construir']);
  assert.match(r2.out, /, 0 reextraídos,/);
});

test('estado marca desactualizado con el numero de cambiados', () => {
  const d = repo();
  correr(d, ['construir']);
  escribir(d, 'src/b.js', 'module.exports = 22222;\n');
  assert.match(correr(d, ['estado']).out, /desactualizado \(1 cambiados\)$/);
});

test('construir en layout legado guarda en el gitdir', () => {
  const d = repo({ faro: false });
  assert.equal(correr(d, ['construir']).code, 0);
  assert.ok(fs.existsSync(path.join(d, '.git', 'faro-grafo.json')));
  assert.ok(!fs.existsSync(path.join(d, 'faro')));
  assert.ok(I.cargar(d));
});

test('.gitignore: faro/.cache/ una sola vez tras construir en layout faro', () => {
  const d = repo();
  fs.writeFileSync(path.join(d, '.gitignore'), 'node_modules');
  correr(d, ['construir']); correr(d, ['construir']);
  const lineas = fs.readFileSync(path.join(d, '.gitignore'), 'utf8').split(/\r?\n/).filter((l) => l === 'faro/.cache/');
  assert.equal(lineas.length, 1);
  assert.match(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), /^node_modules\nfaro\/\.cache\/\n$/);
});

test('lock obsoleto (200 s) no impide construir en fondo', () => {
  const d = repo();
  const lock = I.rutaIndice(d) + '.lock';
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '{"pid":1}');
  const t = new Date(Date.now() - 200000); fs.utimesSync(lock, t, t);
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-proc-'));
  const prev = process.env.FARO_PROC_DIR; process.env.FARO_PROC_DIR = proc;
  try { assert.equal(correr(d, ['construir', '--fondo']).code, 0); } finally { if (prev === undefined) delete process.env.FARO_PROC_DIR; else process.env.FARO_PROC_DIR = prev; }
  assert.ok(I.cargar(d));
  assert.ok(!fs.existsSync(lock));
});

test('lock vigente: --fondo no construye', () => {
  const d = repo();
  const lock = I.rutaIndice(d) + '.lock';
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '{"pid":1}');
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-proc-'));
  const prev = process.env.FARO_PROC_DIR; process.env.FARO_PROC_DIR = proc;
  try { assert.equal(correr(d, ['construir', '--fondo']).code, 0); } finally { if (prev === undefined) delete process.env.FARO_PROC_DIR; else process.env.FARO_PROC_DIR = prev; }
  assert.equal(I.cargar(d), null);
});

test('dos construir --fondo simultaneos: indice valido y como mucho uno construye', async () => {
  const d = repo();
  for (let i = 0; i < 40; i++) escribir(d, `src/m${i}.js`, `module.exports = ${i};\n`);
  const traza = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'faro-traza-')), 'traza.txt');
  const env = { ...process.env, FARO_PROC_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'faro-proc-')), FARO_GRAFO_TRAZA: traza, CLAUDE_PROJECT_DIR: d };
  const lanzar = () => new Promise((res) => {
    let out = '';
    const p = spawn(process.execPath, [HARNESS, 'grafo', 'construir', '--fondo'], { cwd: d, env, windowsHide: true });
    p.stdout.on('data', (b) => { out += b; }); p.stderr.on('data', (b) => { out += b; });
    p.on('close', (code) => res({ code, out }));
  });
  const rs = await Promise.all([lanzar(), lanzar()]);
  for (const r of rs) { assert.equal(r.code, 0); assert.equal(r.out, ''); }
  assert.ok(I.cargar(d), 'el indice final carga');
  const n = fs.existsSync(traza) ? fs.readFileSync(traza, 'utf8').split('\n').filter(Boolean).length : 0;
  assert.equal(n, 1);
});

const conProc = (f) => { const prev = process.env.FARO_PROC_DIR; process.env.FARO_PROC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-proc-')); try { return f(); } finally { if (prev === undefined) delete process.env.FARO_PROC_DIR; else process.env.FARO_PROC_DIR = prev; } };

test('marca .fallo reciente frena --fondo; construir explicito la ignora y la borra', () => {
  const d = repo();
  const marca = I.rutaIndice(d) + '.fallo';
  fs.mkdirSync(path.dirname(marca), { recursive: true });
  fs.writeFileSync(marca, 'x');
  conProc(() => correr(d, ['construir', '--fondo']));
  assert.equal(I.cargar(d), null);
  correr(d, ['construir']);
  assert.ok(I.cargar(d));
  assert.ok(!fs.existsSync(marca));
});

test('marca .fallo de mas de 24 h no frena --fondo', () => {
  const d = repo();
  const marca = I.rutaIndice(d) + '.fallo';
  fs.mkdirSync(path.dirname(marca), { recursive: true });
  fs.writeFileSync(marca, 'x');
  const t = new Date(Date.now() - 25 * 3600 * 1000); fs.utimesSync(marca, t, t);
  conProc(() => correr(d, ['construir', '--fondo']));
  assert.ok(I.cargar(d));
});

test('.gitignore como enlace simbolico: no se escribe a traves de el', (t) => {
  const d = repo();
  const fuera = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'faro-fuera-')), 'destino.txt');
  fs.writeFileSync(fuera, 'intacto\n');
  try { fs.symlinkSync(fuera, path.join(d, '.gitignore'), 'file'); } catch { return t.skip('el SO no permite enlaces'); }
  correr(d, ['construir']);
  assert.equal(fs.readFileSync(fuera, 'utf8'), 'intacto\n');
});

test('faro/.cache como enlace: --fondo no construye ni crea nada a traves de el', (t) => {
  const d = repo();
  const fuera = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-fuera-'));
  try { fs.symlinkSync(fuera, path.join(d, 'faro', '.cache'), 'junction'); } catch { return t.skip('el SO no permite enlaces'); }
  conProc(() => correr(d, ['construir', '--fondo']));
  assert.deepEqual(fs.readdirSync(fuera), []);
});
