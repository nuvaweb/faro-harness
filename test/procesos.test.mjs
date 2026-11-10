// #177 — higiene de procesos: marca FARO_PROC, listado, limpieza (solo propios), candado de bateria, aviso corto.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const P = createRequire(import.meta.url)(path.join(HOOKS, 'lib', 'procesos.js'));
import { inactivo, rastrear, guardaHuerfanos } from './lib-fixtures.mjs';
guardaHuerfanos();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'faro-proc-'));
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const DUENO_MUERTO = 2 ** 22 + 999;

test('parsearEtime entiende [[dd-]hh:]mm:ss', () => {
  assert.strictEqual(P.parsearEtime('03:04'), 184);
  assert.strictEqual(P.parsearEtime('01:03:04'), 3784);
  assert.strictEqual(P.parsearEtime('2-01:00:00'), 2 * 86400 + 3600);
  assert.strictEqual(P.parsearEtime('basura'), 0);
});

test('parsearPs lee la salida de ps sin depender de shell', () => {
  const t = '  100     1 05:00 00:10 node\n  200   100 01:00:00 02:00:00 node\n  300     1 00:01 00:00 bash\n';
  const l = P.parsearPs(t);
  assert.deepStrictEqual(l.map((p) => p.pid), [100, 200, 300]);
  assert.strictEqual(l[1].ppid, 100); assert.strictEqual(l[1].antigS, 3600); assert.strictEqual(l[1].cpuS, 7200);
});

test('parsearCim lee el JSON de PowerShell (objeto unico o lista)', () => {
  const j = JSON.stringify([{ ProcessId: 10, ParentProcessId: 4, Name: 'node.exe', inicio: 1000, cpuS: 12.5 }]);
  const l = P.parsearCim(j);
  assert.deepStrictEqual(l[0], { pid: 10, ppid: 4, nombre: 'node.exe', inicio: 1000, cpuS: 12.5 });
  assert.strictEqual(P.parsearCim('{"ProcessId":1,"ParentProcessId":0,"Name":"x","inicio":1,"cpuS":0}').length, 1);
  assert.deepStrictEqual(P.parsearCim('no es json'), []);
});

const AHORA = 1_000_000_000_000;
const snap = [
  { pid: 10, ppid: 1, nombre: 'node.exe', inicio: AHORA - 3600e3, cpuS: 5 },    // marcado, dueño muerto => huerfano
  { pid: 20, ppid: 30, nombre: 'node', inicio: AHORA - 60e3, cpuS: 1 },          // marcado, dueño vivo, sano
  { pid: 30, ppid: 1, nombre: 'bash', inicio: AHORA - 90e3, cpuS: 0 },
  { pid: 40, ppid: 30, nombre: 'node', inicio: AHORA - 60e3, cpuS: 9999 },       // marcado, CPU alta
  { pid: 50, ppid: 1, nombre: 'node', inicio: AHORA - 99999e3, cpuS: 99999 },    // AJENO (sin marca): jamas
  { pid: 60, ppid: 30, nombre: 'node', inicio: AHORA - 30 * 3600e3, cpuS: 1 },   // marcado, muy antiguo
];
const registro = [10, 20, 40, 60].map((pid) => ({ pid, dueno: 30, sesion: 's1', rol: 'x', registrado: snap.find((p) => p.pid === pid).inicio + 1000 }));
registro[0].dueno = 999;   // dueño muerto (no esta en el snapshot)

test('listar: solo node con marca; huerfano si su dueño murio; los ajenos solo se cuentan', () => {
  const r = P.listar({ snapshot: snap, registro, ahora: AHORA });
  assert.deepStrictEqual(r.propios.map((p) => p.pid).sort((a, b) => a - b), [10, 20, 40, 60]);
  assert.strictEqual(r.propios.find((p) => p.pid === 10).huerfano, true);
  assert.strictEqual(r.propios.find((p) => p.pid === 20).huerfano, false);
  assert.strictEqual(r.ajenos, 1);
  assert.ok(r.propios.find((p) => p.pid === 20).antigS >= 59);
});

test('listar: una entrada de registro con PID reutilizado (proceso muy anterior al registro) no cuenta como marca', () => {
  const reg = [{ pid: 50, dueno: 30, sesion: 's', rol: 'x', registrado: AHORA - 5000e3 }];
  const r = P.listar({ snapshot: snap, registro: reg, ahora: AHORA });
  assert.strictEqual(r.propios.length, 0);
});

test('listar: marca por entorno (POSIX) sin registro', () => {
  const r = P.listar({ snapshot: snap, registro: [], ahora: AHORA, envDe: (pid) => (pid === 40 ? 'PATH=x\0FARO_PROC=sesion9\0' : null) });
  assert.deepStrictEqual(r.propios.map((p) => p.pid), [40]);
  assert.strictEqual(r.propios[0].sesion, 'sesion9');
});

test('candidatos: huerfanos o sobre umbral de CPU/tiempo, y NUNCA un proceso sin marca', () => {
  const r = P.listar({ snapshot: snap, registro, ahora: AHORA });
  const c = P.candidatos(r.propios, { cpuS: 600, edadS: 6 * 3600 }).map((p) => p.pid).sort((a, b) => a - b);
  assert.deepStrictEqual(c, [10, 40, 60]);
  assert.ok(!c.includes(50));
  assert.deepStrictEqual(P.candidatos([{ pid: 50, huerfano: true, cpuS: 1e9, antigS: 1e9, marca: false }], { cpuS: 1, edadS: 1 }), []);
});

test('limpiar: sin confirmo no cierra nada; con confirmo, solo candidatos validos', () => {
  const r = P.listar({ snapshot: snap, registro, ahora: AHORA });
  const cerrados = [];
  const matar = (pid) => { cerrados.push(pid); return true; };
  const umbrales = { cpuS: 600, edadS: 21600 };
  const seco = P.limpiar(r.propios, { confirmo: false, matar, umbrales, verificar: () => ({ ok: true }) });
  assert.deepStrictEqual(cerrados, []); assert.strictEqual(seco.candidatos.length, 3);
  const real = P.limpiar(r.propios, { confirmo: true, matar, umbrales, verificar: () => ({ ok: true }) });
  assert.deepStrictEqual(cerrados.sort((a, b) => a - b), [10, 40, 60]); assert.strictEqual(real.cerrados.length, 3);
});

test('pidValido rechaza lo no numerico, el propio y los de sistema', () => {
  for (const x of ['1; calc', '-1', '0', 1, process.pid, '12abc', null, undefined, 1.5]) assert.strictEqual(P.pidValido(x), false, String(x));
  assert.strictEqual(P.pidValido(4321), true);
  assert.strictEqual(P.pidValido('4321'), true);
});

test('matarArbol cierra el proceso Y sus nietos', async () => {
  const dir = tmp(); const pidFile = path.join(dir, 'nieto.pid');
  const hijo = `const {spawn}=require('child_process');const n=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),300000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(n.pid));setTimeout(()=>process.exit(0),300000)`;
  const h = rastrear(spawn(process.execPath, ['-e', hijo], { stdio: 'ignore', detached: process.platform !== 'win32' }));
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await dormir(100);
  const nieto = Number(fs.readFileSync(pidFile, 'utf8')); rastrear(nieto);
  assert.ok(P.vivo(h.pid) && P.vivo(nieto));
  P.matarArbol(h.pid);
  for (let i = 0; i < 50 && (P.vivo(h.pid) || P.vivo(nieto)); i++) await dormir(100);
  assert.strictEqual(P.vivo(h.pid), false, 'el hijo sigue vivo');
  assert.strictEqual(P.vivo(nieto), false, 'el nieto sigue vivo (huerfano)');
});

test('registro: registrar y leer; entradas corruptas se ignoran', () => {
  const dir = tmp(); const env = { FARO_PROC_DIR: dir };
  P.registrar(process.pid, { dueno: process.pid, rol: 'test', sesion: 's' }, env);
  fs.writeFileSync(path.join(dir, '77.json'), '{rota');
  fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({ pid: 'no' }));
  assert.deepStrictEqual(P.leerRegistro(env).map((e) => e.pid), [process.pid]);
});

test('candado de bateria: el segundo no arranca; el obsoleto se recupera; se suelta', () => {
  const ruta = path.join(tmp(), 'bateria.lock');
  assert.strictEqual(P.tomarCandado(ruta, { pid: process.pid }).ok, true);
  const b = P.tomarCandado(ruta, { pid: 123456 });
  assert.strictEqual(b.ok, false); assert.strictEqual(b.pid, process.pid);
  P.soltarCandado(ruta, process.pid);
  assert.strictEqual(fs.existsSync(ruta), false);
  fs.writeFileSync(ruta, JSON.stringify({ pid: DUENO_MUERTO, desde: Date.now() }));          // dueño muerto
  assert.strictEqual(P.tomarCandado(ruta, { pid: process.pid }).ok, true);
  P.soltarCandado(ruta, process.pid);
  fs.writeFileSync(ruta, JSON.stringify({ pid: process.pid, desde: Date.now() - 10_000 }));   // vivo pero demasiado viejo
  assert.strictEqual(P.tomarCandado(ruta, { pid: 7, maxEdadMs: 1000 }).ok, true);
  P.soltarCandado(ruta, 999);                                                                 // de otro dueño: no borra
  assert.strictEqual(fs.existsSync(ruta), true);
  fs.writeFileSync(ruta, 'basura');                                                           // corrupto
  assert.strictEqual(P.tomarCandado(ruta, { pid: process.pid }).ok, true);
});

test('avisoCorto: silencio si todo OK; breve si hay huerfanos o una bateria corriendo', async () => {
  const dir = tmp(); const env = { FARO_PROC_DIR: dir, FARO_BATERIA_CANDADO: path.join(dir, 'b.lock') };
  assert.strictEqual(P.avisoCorto(env), '');
  const h = inactivo();
  try {
    P.registrar(h.pid, { dueno: DUENO_MUERTO, rol: 'test', sesion: 's' }, env);
    const a = P.avisoCorto(env);
    assert.match(a, /1 proceso/); assert.match(a, /procesos --limpiar/);
    assert.ok(a.length < 250, a);
  } finally { P.matarArbol(h.pid); }
  P.tomarCandado(env.FARO_BATERIA_CANDADO, { pid: process.pid });
  fs.readdirSync(dir).filter((f) => f.endsWith('.json')).forEach((f) => fs.unlinkSync(path.join(dir, f)));
  const b = P.avisoCorto(env);
  assert.match(b, /bater/i); assert.ok(b.length < 250, b);
});

const harness = (args, env = {}) => spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), ...args], { encoding: 'utf8', timeout: 90000, env: { ...process.env, ...env } });

test('harness.js procesos: lista sin tocar ajenos; --limpiar sin --confirmo solo informa; con el, cierra el propio huerfano', async () => {
  const dir = tmp(); const env = { FARO_PROC_DIR: dir };
  const sinMarca = { ...process.env }; delete sinMarca.FARO_PROC; // en Linux la marca se lee de /proc/<pid>/environ: el ajeno NO debe heredarla
  const ajeno = inactivo({ env: sinMarca });
  const propio = inactivo();
  try {
    await dormir(300);
    P.registrar(propio.pid, { dueno: DUENO_MUERTO, rol: 'test', sesion: 's1' }, env);
    const l = harness(['procesos'], env);
    assert.strictEqual(l.status, 0, l.stderr);
    assert.match(l.stdout, new RegExp(`\\b${propio.pid}\\b`));
    assert.match(l.stdout, /hu[eé]rfano/i);
    assert.ok(!new RegExp(`\\b${ajeno.pid}\\b`).test(l.stdout), 'lista un proceso sin marca');
    const seco = harness(['procesos', '--limpiar'], env);
    assert.match(seco.stdout, /--confirmo/);
    assert.ok(P.vivo(propio.pid), 'cerro sin --confirmo');
    const real = harness(['procesos', '--limpiar', '--confirmo'], env);
    assert.strictEqual(real.status, 0, real.stderr);
    for (let i = 0; i < 50 && P.vivo(propio.pid); i++) await dormir(100);
    assert.strictEqual(P.vivo(propio.pid), false, 'no cerro el propio huerfano');
    assert.ok(P.vivo(ajeno.pid), 'cerro un proceso SIN marca');
  } finally { P.matarArbol(ajeno.pid); P.matarArbol(propio.pid); }
});

test('harness.js: los hijos heredan FARO_PROC', () => {
  const src = fs.readFileSync(path.join(HOOKS, 'harness.js'), 'utf8');
  assert.match(src, /process\.env\.FARO_PROC\s*=/);
});

test('Stop avisa con una frase cuando hay huerfanos, y calla si todo esta bien', async () => {
  const dir = tmp(); const env = { FARO_PROC_DIR: dir, FARO_BATERIA_CANDADO: path.join(dir, 'b.lock'), FARO_EN_BATERIA: '' }; // dentro de la bateria el aviso se calla; aqui se prueba fuera
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-av-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'ESTADO.md'), '---\niniciativa: X\n---\n');
  spawnSync('git', ['add', '-A'], { cwd: repo }); spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'x'], { cwd: repo });
  const stop = () => spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), 'stop-check'], { cwd: repo, encoding: 'utf8', input: '{}', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: repo, ...env } });
  assert.strictEqual(stop().stdout.trim(), '');
  const h = inactivo();
  try {
    P.registrar(h.pid, { dueno: DUENO_MUERTO, rol: 'test', sesion: 's' }, env);
    const r = stop();
    assert.match(r.stdout, /procesos --limpiar/);
    assert.ok(r.stdout.length < 500, r.stdout);
  } finally { P.matarArbol(h.pid); }
});

// ───────── Revision de seguridad (#177): registro privado y verificacion previa al cierre ─────────
const usuario = os.userInfo().username;

test('el registro por defecto es un directorio POR USUARIO, no el compartido', () => {
  const d = P.dirRegistro({});
  assert.ok(path.basename(d).startsWith('faro-procesos-'), d);
  assert.ok(path.basename(d).includes(String(process.platform === 'win32' ? usuario : process.getuid()).replace(/[^\w.-]/g, '_')), d);
});

test('registro: un directorio que es un enlace (symlink/junction) se rechaza', () => {
  const real = tmp(); const enlace = path.join(tmp(), 'enlace');
  try { fs.symlinkSync(real, enlace, process.platform === 'win32' ? 'junction' : 'dir'); } catch { return; }   // sin permiso para enlaces: no aplicable
  const env = { FARO_PROC_DIR: enlace };
  assert.strictEqual(P.registrar(process.pid, { dueno: process.pid }, env), false);
  fs.writeFileSync(path.join(real, `${process.pid}.json`), JSON.stringify({ pid: process.pid, dueno: process.pid, sesion: '', rol: '', registrado: Date.now() }));
  assert.deepStrictEqual(P.leerRegistro(env), []);
});

test('registro: el directorio se crea privado (0700) y de uso propio (POSIX)', { skip: process.platform === 'win32' }, () => {
  const d = path.join(tmp(), 'priv');
  assert.strictEqual(P.registrar(process.pid, { dueno: process.pid }, { FARO_PROC_DIR: d }), true);
  assert.strictEqual(fs.statSync(d).mode & 0o077, 0);
  fs.chmodSync(d, 0o777);                                   // permisos abiertos => no se fia
  assert.deepStrictEqual(P.leerRegistro({ FARO_PROC_DIR: d }), []);
});

test('registrar no sigue un enlace puesto en el nombre de la entrada', () => {
  const d = tmp(); const victima = path.join(tmp(), 'victima.txt'); fs.writeFileSync(victima, 'intacto');
  try { fs.symlinkSync(victima, path.join(d, `${process.pid}.json`), 'file'); } catch { return; }
  P.registrar(process.pid, { dueno: process.pid }, { FARO_PROC_DIR: d });
  assert.strictEqual(fs.readFileSync(victima, 'utf8'), 'intacto');
});

test('leerRegistro ignora entradas fuera de esquema o con nombre que no corresponde', () => {
  const d = tmp(); const env = { FARO_PROC_DIR: d };
  const ok = { pid: process.pid, dueno: process.pid, sesion: 's', rol: 'r', registrado: Date.now() };
  fs.writeFileSync(path.join(d, `${process.pid}.json`), JSON.stringify({ ...ok, extra: 'comando' }));        // campo extra
  assert.deepStrictEqual(P.leerRegistro(env), []);
  fs.writeFileSync(path.join(d, `${process.pid}.json`), JSON.stringify({ ...ok, sesion: 5 }));               // tipo erroneo
  assert.deepStrictEqual(P.leerRegistro(env), []);
  fs.writeFileSync(path.join(d, `${process.pid}.json`), JSON.stringify({ ...ok, pid: process.ppid }));       // el nombre no casa con el pid
  assert.deepStrictEqual(P.leerRegistro(env), []);
  fs.writeFileSync(path.join(d, `${process.pid}.json`), JSON.stringify(ok));
  assert.strictEqual(P.leerRegistro(env).length, 1);
});

test('pidValido rechaza tambien al proceso padre', () => {
  assert.strictEqual(P.pidValido(process.ppid), false);
});

test('verificarProceso: solo node, del usuario actual y con la marca; sin poder verificarla NO se cierra', () => {
  const entrada = { pid: 4321, dueno: 1, sesion: 's', rol: 'r', registrado: AHORA };
  const base = { existe: true, nombre: 'node', propio: true, inicio: AHORA - 1000, envTexto: 'A=1\0FARO_PROC=s\0' };
  const v = (c, e = entrada) => P.verificarProceso(4321, { entrada: e, ahora: AHORA, consulta: () => c });
  assert.strictEqual(v(base).ok, true);
  assert.strictEqual(v({ ...base, existe: false }).ok, false);
  assert.strictEqual(v({ ...base, nombre: 'bash' }).ok, false);
  assert.strictEqual(v({ ...base, propio: false }).ok, false);
  assert.strictEqual(v({ ...base, envTexto: 'A=1\0' }).ok, false, 'entorno legible sin marca');
  assert.strictEqual(v({ ...base, envTexto: null }).ok, true, 'sin entorno legible: vale la entrada del registro privado + ventana de arranque');
  assert.strictEqual(v({ ...base, envTexto: null }, null).ok, false, 'sin entorno y sin entrada: no verificable');
  assert.strictEqual(v({ ...base, envTexto: null, inicio: AHORA - 9e6 }).ok, false, 'PID reutilizado');
  assert.strictEqual(P.verificarProceso(process.pid, { consulta: () => base }).ok, false);
  assert.strictEqual(P.verificarProceso('12; calc', { consulta: () => base }).ok, false);
});

test('limpiar no cierra lo que no se puede verificar y lo informa', () => {
  const lista = [{ pid: 9001, marca: true, huerfano: true, cpuS: 0, antigS: 0 }, { pid: 9002, marca: true, huerfano: true, cpuS: 0, antigS: 0 }];
  const cerrados = [];
  const r = P.limpiar(lista, { confirmo: true, matar: (p) => { cerrados.push(p); return true; }, verificar: (p) => ({ ok: p === 9001, motivo: 'x' }) });
  assert.deepStrictEqual(cerrados, [9001]);
  assert.deepStrictEqual(r.noVerificados.map((n) => n.pid), [9002]);
});

test('verificarProceso real: un node propio registrado pasa; uno sin entrada ni entorno legible, no (Windows/macOS)', async () => {
  const dir = tmp(); const env = { FARO_PROC_DIR: dir };
  const h = inactivo({ env: { ...process.env, FARO_PROC: 'sx' } });
  try {
    await dormir(300);
    P.registrar(h.pid, { dueno: DUENO_MUERTO, rol: 'test', sesion: 'sx' }, env);
    const entrada = P.leerRegistro(env).find((e) => e.pid === h.pid);
    assert.strictEqual(P.verificarProceso(h.pid, { entrada }).ok, true);
    if (process.platform !== 'linux') assert.strictEqual(P.verificarProceso(h.pid, { entrada: null }).ok, false);
  } finally { P.matarArbol(h.pid); }
});
