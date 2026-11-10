// #177 — test/run.js: timeout por fichero y bateria, arbol de procesos muerto, candado de bateria completa
// y aviso/espera por memoria baja. Se prueba contra una carpeta de tests sinteticos (FARO_TEST_DIR).
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const TEST = path.dirname(fileURLToPath(import.meta.url));
const P = createRequire(import.meta.url)(path.join(TEST, '..', 'plugins', 'faro', 'hooks', 'lib', 'procesos.js'));
import { inactivo, rastrear, guardaHuerfanos } from './lib-fixtures.mjs';
guardaHuerfanos();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function suite(ficheros) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-bat-'));
  const carpeta = path.join(dir, 'tests'); fs.mkdirSync(carpeta);
  for (const [n, c] of Object.entries(ficheros)) fs.writeFileSync(path.join(carpeta, n), c);
  return { dir, carpeta };
}
// node --test anidado dentro de otro test se salta: el lanzador bajo prueba debe correr como uno de primer nivel.
const sinContexto = (() => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; })();
const envBase = (dir, extra = {}) => ({
  ...sinContexto, FARO_TEST_DIR: path.join(dir, 'tests'), FARO_BATERIA_CANDADO: path.join(dir, 'b.lock'), FARO_PROC_DIR: path.join(dir, 'reg'),
  FARO_TEST_MEM_MIN_MB: '0', ...extra,
});
const run = (dir, args = [], extra = {}) => spawnSync(process.execPath, [path.join(TEST, 'run.js'), ...args], { encoding: 'utf8', timeout: 120000, env: envBase(dir, extra) });
const OK = "import {test} from 'node:test'; test('ok',()=>{});\n";

test('bateria sana: pasa, resume y libera el candado', () => {
  const s = suite({ 'a.test.mjs': OK, 'b.test.mjs': OK });
  const r = run(s.dir);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /2 fichero/);
  assert.strictEqual(fs.existsSync(path.join(s.dir, 'b.lock')), false, 'el candado no se libero');
});

test('un fichero que falla da codigo != 0 y la bateria sigue con los demas', () => {
  const s = suite({ 'a.test.mjs': "import {test} from 'node:test'; import a from 'node:assert'; test('mal',()=>a.fail('x'));\n", 'b.test.mjs': OK });
  const r = run(s.dir);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /b\.test\.mjs/);
});

test('timeout por fichero: se corta, se marca y NO quedan procesos hijos ni nietos', async () => {
  const s = suite({});
  const pidFile = path.join(s.dir, 'nieto.pid');
  fs.writeFileSync(path.join(s.carpeta, 'cuelga.test.mjs'), `
import {test} from 'node:test'; import {spawn} from 'node:child_process'; import fs from 'node:fs';
test('cuelga', async () => {
  const n = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),300000)'], {stdio:'ignore'});
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(n.pid));
  await new Promise((r) => setTimeout(r, 300000));
});\n`);
  fs.writeFileSync(path.join(s.carpeta, 'otro.test.mjs'), OK);
  const t0 = Date.now();
  const r = run(s.dir, [], { FARO_TEST_TIMEOUT_FICHERO_S: '4' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /timeout/i);
  assert.match(r.stdout + r.stderr, /otro\.test\.mjs/, 'la bateria no continuo tras el timeout');
  assert.ok(Date.now() - t0 < 60000);
  const nieto = Number(fs.readFileSync(pidFile, 'utf8')); rastrear(nieto);
  for (let i = 0; i < 30 && P.vivo(nieto); i++) await dormir(100);
  assert.strictEqual(P.vivo(nieto), false, 'quedo un proceso nieto vivo');
});

test('timeout de bateria: aborta lo que queda', () => {
  const s = suite({ 'a.test.mjs': "import {test} from 'node:test'; test('lento', async()=>{ await new Promise(r=>setTimeout(r,3000)); });\n", 'b.test.mjs': "import {test} from 'node:test'; test('lento', async()=>{ await new Promise(r=>setTimeout(r,3000)); });\n" });
  const r = run(s.dir, [], { FARO_TEST_TIMEOUT_BATERIA_S: '2' });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /bater[ií]a/i);
  assert.match(r.stdout + r.stderr, /timeout/i);
});

test('candado: una segunda bateria completa avisa y NO arranca; con ficheros concretos si corre', async () => {
  const s = suite({ 'lenta.test.mjs': "import {test} from 'node:test'; test('lenta', async()=>{ await new Promise(r=>setTimeout(r,6000)); });\n" });
  const primera = rastrear(spawn(process.execPath, [path.join(TEST, 'run.js')], { env: envBase(s.dir), stdio: 'ignore' }));
  try {
    for (let i = 0; i < 100 && !fs.existsSync(path.join(s.dir, 'b.lock')); i++) await dormir(100);
    assert.ok(fs.existsSync(path.join(s.dir, 'b.lock')), 'la primera no tomo el candado');
    const segunda = run(s.dir);
    assert.notStrictEqual(segunda.status, 0);
    assert.match(segunda.stdout + segunda.stderr, /ya hay una bater[ií]a/i);
    assert.ok(!/lenta\.test\.mjs/.test(segunda.stdout), 'la segunda arranco tests');
    const parcial = run(s.dir, [path.join(s.carpeta, 'lenta.test.mjs')], { FARO_TEST_TIMEOUT_FICHERO_S: '60' });
    assert.strictEqual(parcial.status, 0, parcial.stdout + parcial.stderr);
  } finally { P.matarArbol(primera.pid); }
});

test('candado obsoleto (dueño muerto): se recupera y la bateria corre', () => {
  const s = suite({ 'a.test.mjs': OK });
  fs.writeFileSync(path.join(s.dir, 'b.lock'), JSON.stringify({ pid: 2 ** 22 + 4242, desde: Date.now() }));
  const r = run(s.dir);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('memoria baja: avisa, espera lo acordado y sigue (no se queda colgada)', () => {
  const s = suite({ 'a.test.mjs': OK });
  const t0 = Date.now();
  const r = run(s.dir, [], { FARO_TEST_MEM_MIN_MB: '99999999', FARO_TEST_MEM_ESPERA_S: '1' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /memoria libre/i);
  assert.ok(Date.now() - t0 < 60000);
});

test('matar la bateria con SIGTERM no deja hijos (POSIX) / el registro marca los que queden (Windows)', async () => {
  const s = suite({}); fs.writeFileSync(path.join(s.carpeta, 'x.test.mjs'), `import {test} from 'node:test'; import fs from 'node:fs'; test('x', async()=>{ fs.writeFileSync(${JSON.stringify(path.join(s.dir, 'hijo.pid'))}, String(process.pid)); await new Promise(r=>setTimeout(r,30000)); });\n`);
  const b = rastrear(spawn(process.execPath, [path.join(TEST, 'run.js')], { env: envBase(s.dir), stdio: 'ignore' }));
  for (let i = 0; i < 100 && !fs.existsSync(path.join(s.dir, 'hijo.pid')); i++) await dormir(100);
  const hijo = Number(fs.readFileSync(path.join(s.dir, 'hijo.pid'), 'utf8')); rastrear(hijo);
  assert.ok(P.vivo(hijo));
  if (process.platform === 'win32') {
    // Windows no entrega SIGTERM a un proceso ajeno: el registro del lanzador debe permitir limpiar los restos.
    const reg = P.leerRegistro({ FARO_PROC_DIR: path.join(s.dir, 'reg') });
    assert.ok(reg.length >= 1, 'el lanzador no registro a sus hijos');
    P.matarArbol(b.pid);
    P.matarArbol(hijo);
  } else {
    process.kill(b.pid, 'SIGTERM');
    for (let i = 0; i < 50 && P.vivo(hijo); i++) await dormir(100);
    assert.strictEqual(P.vivo(hijo), false, 'el hijo sobrevivio al padre');
  }
});

test('una bateria que murio de golpe deja hijos registrados; la siguiente ejecucion los cierra', async () => {
  const s = suite({ 'a.test.mjs': OK });
  const resto = inactivo();
  try {
    P.registrar(resto.pid, { dueno: 2 ** 22 + 31337, rol: 'test', sesion: 'bateria-muerta' }, { FARO_PROC_DIR: path.join(s.dir, 'reg') });
    const r = run(s.dir);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    for (let i = 0; i < 50 && P.vivo(resto.pid); i++) await dormir(100);
    assert.strictEqual(P.vivo(resto.pid), false, 'el hijo huerfano de la bateria muerta sigue vivo');
  } finally { P.matarArbol(resto.pid); }
});
