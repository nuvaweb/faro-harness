// #182 — EJECUTOR COMUN DE GATES PESADOS: turno del semaforo, memoria minima, timeout, marca FARO_PROC,
// NODE_OPTIONS, arbol de procesos sin huerfanos. Sin shell.
//
// Todos los fixtures SE AUTOEXPIRAN (leccion de #177): un nieto dormido vive como mucho 60 s por si mismo,
// y cada test limpia el suyo; el `after` falla si algo queda vivo.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { rastrear, guardaHuerfanos } from './lib-fixtures.mjs';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const X = require(path.join(HOOKS, 'lib', 'ejecutar-pesado.js'));
const G = require(path.join(HOOKS, 'lib', 'gobernador.js'));
const P = require(path.join(HOOKS, 'lib', 'procesos.js'));
guardaHuerfanos();

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-ep-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const entorno = (extra = {}) => ({ ...process.env, FARO_PROC_DIR: tmp(), FARO_PROC: '', FARO_PESADOS: '', FARO_PESADOS_ESPERA_S: '', FARO_MEM_MIN_MB: '0', ...extra });
const trabajo = (js, extra = {}) => ({ cmd: process.execPath, args: ['-e', js], cwd: tmp(), timeoutMs: 20000, etiqueta: 'prueba', ...extra });
const esperar = async (cond, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 100)); } return cond(); };

test('un trabajo correcto devuelve pass y su salida; uno que falla, fail con la salida', async () => {
  const env = entorno();
  const ok = await X.ejecutarAsync(trabajo('console.log("hola gate")'), { env });
  assert.strictEqual(ok.status, 'pass'); assert.match(ok.out, /hola gate/);
  const mal = await X.ejecutarAsync(trabajo('console.error("roto"); process.exit(3)'), { env });
  assert.strictEqual(mal.status, 'fail'); assert.strictEqual(mal.codigo, 3); assert.match(mal.out, /roto/);
  assert.deepStrictEqual(G.leerSlots(env), [], 'el turno se libera siempre');
  assert.deepStrictEqual(P.leerRegistro(env).filter((e) => e.rol === 'gate'), [], 'y el registro queda limpio');
});

test('comando inexistente → skip (no es un fallo del gate)', async () => {
  const r = await X.ejecutarAsync({ ...trabajo(''), cmd: 'comando-que-no-existe-faro-182', args: [] }, { env: entorno() });
  assert.strictEqual(r.status, 'skip'); assert.match(r.out, /no disponible/);
});

test('el hijo hereda FARO_PROC y NODE_OPTIONS con un tope de memoria; el que ya lo trae no se pisa', async () => {
  const js = 'console.log(JSON.stringify({ p: process.env.FARO_PROC, n: process.env.NODE_OPTIONS, ci: process.env.CI }))';
  const r = await X.ejecutarAsync(trabajo(js, { env: { CI: 'true' } }), { env: entorno({ FARO_PROC: 'sesion-x', NODE_OPTIONS: '' }) });
  const o = JSON.parse(r.out);
  assert.strictEqual(o.p, 'sesion-x'); assert.match(o.n, /--max-old-space-size=\d+/); assert.strictEqual(o.ci, 'true');
  const r2 = await X.ejecutarAsync(trabajo(js), { env: entorno({ NODE_OPTIONS: '--max-old-space-size=777' }) });
  assert.strictEqual(JSON.parse(r2.out).n, '--max-old-space-size=777');
  const r3 = await X.ejecutarAsync(trabajo(js), { env: entorno() });
  assert.match(JSON.parse(r3.out).p, /^gate-\d+$/, 'sin marca previa se pone una');
});

test('timeout: mata el arbol completo (hijo + nieto) y no queda ningun huerfano', async () => {
  const marca = path.join(tmp(), 'nieto.pid');
  const js = `
    const { spawn } = require('child_process'); const fs = require('fs');
    const n = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 60000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(marca)}, String(n.pid));
    setTimeout(() => process.exit(0), 60000);`;
  const env = entorno();
  const r = await X.ejecutarAsync(trabajo(js, { timeoutMs: 2500 }), { env });
  try {
    assert.strictEqual(r.status, 'fail'); assert.strictEqual(r.timeout, true); assert.match(r.out, /tiempo agotado/);
    const nieto = Number(fs.readFileSync(marca, 'utf8')); rastrear(nieto);
    assert.ok(await esperar(() => !P.vivo(nieto)), 'el nieto murio con el arbol');
    assert.deepStrictEqual(G.leerSlots(env), []);
  } finally {
    try { const n = Number(fs.readFileSync(marca, 'utf8')); if (n && P.vivo(n)) P.matarArbol(n); } catch {}
  }
});

test('POSIX: al acabar con exito tampoco queda un nieto suelto del mismo grupo', { skip: process.platform === 'win32' ? 'en Windows un arbol no se puede cerrar una vez muerto su padre' : false }, async () => {
  const marca = path.join(tmp(), 'nieto.pid');
  const js = `
    const { spawn } = require('child_process'); const fs = require('fs');
    const n = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 60000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(marca)}, String(n.pid)); n.unref();`;
  try {
    const r = await X.ejecutarAsync(trabajo(js), { env: entorno() });
    assert.strictEqual(r.status, 'pass');
    const nieto = Number(fs.readFileSync(marca, 'utf8')); rastrear(nieto);
    assert.ok(await esperar(() => !P.vivo(nieto)), 'el nieto cerrado al acabar el trabajo');
  } finally {
    try { const n = Number(fs.readFileSync(marca, 'utf8')); if (n && P.vivo(n)) P.matarArbol(n); } catch {}
  }
});

test('cola: sin turno en la espera acordada → busy (no se cuelga) y el aviso es de una linea', async () => {
  const env = entorno(); const avisos = [];
  const otro = G.adquirir({ env, max: 1, esperaS: 0, etiqueta: 'otro' });
  assert.ok(otro.ok);
  const t0 = Date.now();
  const r = await X.ejecutarAsync(trabajo('console.log(1)', { maxPesados: 1, esperaS: 1 }), { env, aviso: (m) => avisos.push(m) });
  assert.strictEqual(r.status, 'busy'); assert.strictEqual(r.motivo, 'cola'); assert.ok(Date.now() - t0 < 6000);
  assert.strictEqual(avisos.length, 1); assert.ok(!/\n/.test(avisos[0]));
  otro.liberar();
  assert.strictEqual((await X.ejecutarAsync(trabajo('console.log(1)', { maxPesados: 1, esperaS: 1 }), { env })).status, 'pass', 'liberado, ya pasa');
});

test('memoria insuficiente → busy con aviso corto, y el turno no se queda retenido', async () => {
  const env = entorno(); const avisos = [];
  const r = await X.ejecutarAsync(trabajo('console.log(1)', { memMinMB: 4096, memEsperaS: 0 }), { env, libreMB: () => 100, aviso: (m) => avisos.push(m) });
  assert.strictEqual(r.status, 'busy'); assert.strictEqual(r.motivo, 'memoria');
  assert.ok(avisos.every((m) => !/\n/.test(m)));
  assert.deepStrictEqual(G.leerSlots(env), []);
});

test('trabajos no validos se rechazan sin ejecutar nada', async () => {
  const env = entorno();
  const malos = [
    { ...trabajo(''), cmd: 'node; ls' }, { ...trabajo(''), cmd: 'a b' }, { ...trabajo(''), cmd: '' }, { ...trabajo(''), cmd: '../node' },
    { ...trabajo(''), args: 'no es lista' }, { ...trabajo(''), args: [1] }, { ...trabajo(''), args: ['a\0b'] },
    { ...trabajo(''), cwd: 'relativa' }, { ...trabajo(''), cwd: path.join(tmp(), 'no-existe') },
    { ...trabajo(''), timeoutMs: 5 }, { ...trabajo(''), timeoutMs: 'mucho' }, { ...trabajo(''), env: { minuscula: 'x' } },
    null,
  ];
  for (const m of malos) { const r = await X.ejecutarAsync(m, { env }); assert.strictEqual(r.status, 'fail'); assert.match(r.out, /rechazado/); }
});

test('lanzador: sin shell; en Windows los shims .cmd solo aceptan argumentos sin metacaracteres', () => {
  assert.deepStrictEqual(X.lanzador('pnpm', ['run', 'test'], 'linux'), { file: 'pnpm', argv: ['run', 'test'] });
  const w = X.lanzador('pnpm', ['run', 'test'], 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
  assert.strictEqual(w.file, 'C:\\Windows\\System32\\cmd.exe'); assert.deepStrictEqual(w.argv, ['/d', '/s', '/c', 'pnpm', 'run', 'test']);
  for (const mal of ['a&b', 'a|b', 'a b', '"x"', 'a;b', '%PATH%', 'a>b', '^x', '$(x)']) assert.ok(X.lanzador('npx', [mal], 'win32').error, mal);
  assert.ok(X.lanzador('npx', ['wrangler', 'deploy', '--dry-run'], 'win32').file, 'el simulacro de wrangler pasa');
  assert.ok(X.lanzador('node', ['a&b'], 'win32').file, 'node no es un shim: no pasa por cmd.exe');
});

test('ejecutarSync (supervisor): pass, fail, timeout con arbol cerrado y busy', () => {
  const env = entorno();
  assert.strictEqual(X.ejecutarSync(trabajo('console.log("sync")'), { env }).status, 'pass');
  const mal = X.ejecutarSync(trabajo('process.exit(2)'), { env });
  assert.strictEqual(mal.status, 'fail'); assert.strictEqual(mal.codigo, 2);
  const t0 = Date.now();
  const to = X.ejecutarSync(trabajo('setTimeout(() => process.exit(0), 60000)', { timeoutMs: 1500 }), { env });
  assert.strictEqual(to.timeout, true); assert.ok(Date.now() - t0 < 15000);
  const otro = G.adquirir({ env, max: 1, esperaS: 0 });
  const busy = X.ejecutarSync(trabajo('console.log(1)', { maxPesados: 1, esperaS: 1 }), { env });
  assert.strictEqual(busy.status, 'busy');
  otro.liberar();
  assert.deepStrictEqual(P.leerRegistro(env).filter((e) => e.rol === 'gate' || e.rol === 'supervisor-gate'), []);
});

test('dos ejecutarSync en procesos distintos con N=1 se turnan: nunca hay dos gates a la vez', async () => {
  const env = entorno({ FARO_PESADOS: '1', FARO_PESADOS_ESPERA_S: '30' });
  const log = path.join(tmp(), 'log.jsonl');
  const gate = `const fs=require('fs');const a=Date.now();const t=Date.now()+1000;while(Date.now()<t){}fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({a,b:Date.now()})+'\\n')`;
  const runner = `const X=require(${JSON.stringify(path.join(HOOKS, 'lib', 'ejecutar-pesado.js'))});
    const r=X.ejecutarSync({cmd:process.execPath,args:['-e',${JSON.stringify(gate)}],cwd:${JSON.stringify(tmp())},timeoutMs:20000,etiqueta:'r'});
    process.exit(r.status==='pass'?0:1);`;
  const lanzar = () => { const h = spawn(process.execPath, ['-e', runner], { env, stdio: 'ignore', windowsHide: true }); rastrear(h); h.ref();
    // la promesa que espera su salida necesita el bucle vivo
    return new Promise((res) => h.on('exit', res)); };
  const codigos = await Promise.all([lanzar(), lanzar()]);
  assert.deepStrictEqual(codigos, [0, 0]);
  const r = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).sort((x, y) => x.a - y.a);
  assert.strictEqual(r.length, 2);
  assert.ok(r[1].a >= r[0].b - 5, `el segundo gate arrancó (${r[1].a}) cuando el primero ya había acabado (${r[0].b})`);
});
