// #182 — GOBERNADOR DE RECURSOS: semaforo global por usuario para los trabajos pesados (typecheck, lint,
// test, build, simulacro de despliegue) de TODAS las sesiones y repos.
//
// Todo el estado vive en un directorio PRIVADO por usuario (el de lib/procesos.js, aqui redirigido a un
// temporal con FARO_PROC_DIR). Los fixtures que lanzan procesos SE AUTOEXPIRAN siempre (leccion de #177):
// ningun test deja un nodo colgado aunque falle.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { rastrear, guardaHuerfanos } from './lib-fixtures.mjs';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const G = require(path.join(HOOKS, 'lib', 'gobernador.js'));
guardaHuerfanos();

const DUENO_MUERTO = 2 ** 22 + 999;
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-gob-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const entorno = () => ({ ...process.env, FARO_PROC_DIR: tmp(), FARO_CACHE_DIR: '', FARO_PESADOS: '', FARO_PESADOS_ESPERA_S: '', FARO_EN_BATERIA: '', FARO_MEM_MIN_MB: '', FARO_MAX_MEMORIA_MB: '' });
const sinDormir = { dormir: () => {} };

test('config: N=2 por defecto; FARO_PESADOS gana a .faro.json; valores absurdos se ignoran', () => {
  const raiz = tmp();
  assert.strictEqual(G.config(raiz, entorno()).maxPesados, 2);
  fs.writeFileSync(path.join(raiz, '.faro.json'), JSON.stringify({ recursos: { max_pesados: 1 } }));
  assert.strictEqual(G.config(raiz, entorno()).maxPesados, 1);
  assert.strictEqual(G.config(raiz, { ...entorno(), FARO_PESADOS: '3' }).maxPesados, 3);
  for (const malo of ['0', '99', 'x', '-1', '1.5']) assert.strictEqual(G.config(raiz, { ...entorno(), FARO_PESADOS: malo }).maxPesados, 1, `FARO_PESADOS=${malo} cae al valor del repo`);
  fs.writeFileSync(path.join(raiz, '.faro.json'), JSON.stringify({ recursos: { max_pesados: 'mucho' } }));
  assert.strictEqual(G.config(raiz, entorno()).maxPesados, 2);
  fs.writeFileSync(path.join(raiz, '.faro.json'), '{ no es json');
  assert.strictEqual(G.config(raiz, entorno()).maxPesados, 2);
});

test('el semaforo respeta el maximo, avisa en una linea y se libera', () => {
  const env = entorno(); const avisos = [];
  const a = G.adquirir({ env, max: 2, esperaS: 0, etiqueta: 'a', ...sinDormir });
  const b = G.adquirir({ env, max: 2, esperaS: 0, etiqueta: 'b', ...sinDormir });
  assert.ok(a.ok && b.ok);
  assert.notStrictEqual(a.slot, b.slot);
  const c = G.adquirir({ env, max: 2, esperaS: 0, etiqueta: 'c', aviso: (m) => avisos.push(m), ...sinDormir });
  assert.strictEqual(c.ok, false); assert.strictEqual(c.motivo, 'cola'); assert.strictEqual(c.enCurso, 2);
  assert.strictEqual(avisos.length, 1); assert.ok(!/\n/.test(avisos[0])); assert.match(avisos[0], /2 trabajos pesados en curso/);
  a.liberar();
  const d = G.adquirir({ env, max: 2, esperaS: 0, etiqueta: 'd', ...sinDormir });
  assert.ok(d.ok, 'al liberar uno, el siguiente entra');
  b.liberar(); d.liberar();
  assert.deepStrictEqual(G.leerSlots(env), []);
});

test('entradas obsoletas (PID muerto, vencidas, corruptas) se recuperan', () => {
  const env = entorno();
  const dir = G.dirPesados(env); assert.ok(G.preparar(env));
  const escribir = (n, obj) => fs.writeFileSync(path.join(dir, `slot-${n}.json`), typeof obj === 'string' ? obj : JSON.stringify(obj));
  const base = { desde: Date.now(), hasta: Date.now() + 600e3, etiqueta: 'x', sesion: 's', exclusivo: false };
  escribir(0, { ...base, pid: DUENO_MUERTO });                                   // dueño muerto
  escribir(1, { ...base, pid: process.pid, hasta: Date.now() - 1000 });          // vivo pero vencido (PID reutilizado / colgado)
  assert.ok(G.adquirir({ env, max: 2, esperaS: 0, ...sinDormir }).ok);
  assert.ok(G.adquirir({ env, max: 2, esperaS: 0, ...sinDormir }).ok);
  assert.strictEqual(G.adquirir({ env, max: 2, esperaS: 0, ...sinDormir }).ok, false);
  // corruptas / con esquema invalido: se descartan, no bloquean
  const caso = (contenido) => {
    const e = entorno(); G.preparar(e);
    fs.writeFileSync(path.join(G.dirPesados(e), 'slot-0.json'), contenido);
    return G.adquirir({ env: e, max: 1, esperaS: 0, ...sinDormir }).ok;
  };
  assert.ok(caso('{ basura'), 'JSON corrupto');
  assert.ok(caso(JSON.stringify({ ...base, pid: process.pid, extra: 1 })), 'clave desconocida = entrada no confiable');
  assert.ok(caso(JSON.stringify({ ...base, pid: '1; boom' })), 'PID no entero');
  assert.ok(caso(JSON.stringify({ ...base, pid: process.pid, etiqueta: 'x'.repeat(500) })), 'campo desmesurado');
});

test('una entrada VIVA y valida de otra sesion no se toca', () => {
  const env = entorno(); G.preparar(env);
  const dir = G.dirPesados(env);
  fs.writeFileSync(path.join(dir, 'slot-0.json'), JSON.stringify({ pid: process.pid, desde: Date.now(), hasta: Date.now() + 600e3, etiqueta: 'otra', sesion: 's', exclusivo: false }));
  assert.strictEqual(G.adquirir({ env, max: 1, esperaS: 0, ...sinDormir }).ok, false);
  assert.ok(fs.existsSync(path.join(dir, 'slot-0.json')));
});

test('el trabajo exclusivo (dry-run) nunca coincide con otro pesado, en ninguno de los dos ordenes', () => {
  const env = entorno();
  const n = G.adquirir({ env, max: 2, esperaS: 0, ...sinDormir });
  assert.strictEqual(G.adquirir({ env, max: 2, esperaS: 0, exclusivo: true, ...sinDormir }).ok, false, 'hay uno en curso: el exclusivo espera');
  n.liberar();
  const e = G.adquirir({ env, max: 2, esperaS: 0, exclusivo: true, ...sinDormir });
  assert.ok(e.ok);
  assert.strictEqual(G.adquirir({ env, max: 2, esperaS: 0, ...sinDormir }).ok, false, 'hay un exclusivo en curso: los demas esperan');
  e.liberar();
  assert.ok(G.adquirir({ env, max: 2, esperaS: 0, ...sinDormir }).ok);
});

test('sin directorio privado utilizable no se bloquea la maquina: sigue sin semaforo', () => {
  const f = path.join(tmp(), 'fichero'); fs.writeFileSync(f, 'x');
  const r = G.adquirir({ env: { ...process.env, FARO_PROC_DIR: path.join(f, 'dentro') }, max: 1, esperaS: 0, ...sinDormir });
  assert.ok(r.ok && r.sinSemaforo);
});

test('esperarMemoria: espera acotada y aborta con aviso corto si no se libera', () => {
  const avisos = []; let t = 0;
  const libres = [200, 300, 5000];
  const ok = G.esperarMemoria({ minMB: 1000, esperaS: 30, libreMB: () => libres[Math.min(t++, 2)], dormir: () => {}, aviso: (m) => avisos.push(m) });
  assert.strictEqual(ok.ok, true); assert.ok(ok.esperadoS > 0);
  const mal = G.esperarMemoria({ minMB: 1000, esperaS: 10, libreMB: () => 100, dormir: () => {}, aviso: (m) => avisos.push(m) });
  assert.strictEqual(mal.ok, false); assert.ok(avisos.every((m) => !/\n/.test(m)));
  assert.strictEqual(G.esperarMemoria({ minMB: 0, esperaS: 10, libreMB: () => 1 }).ok, true);
});

test('avisoSaturacion: silencio si todo esta bien; una linea si hay saturacion', () => {
  const env = entorno();
  assert.strictEqual(G.avisoSaturacion(env, tmp(), { libreMB: 100000 }), '');
  const bajo = G.avisoSaturacion(env, tmp(), { libreMB: 50 });
  assert.match(bajo, /memoria libre/i); assert.ok(!/\n/.test(bajo));
  const a = G.adquirir({ env, max: 1, esperaS: 0, ...sinDormir });
  const raiz = tmp(); fs.writeFileSync(path.join(raiz, '.faro.json'), JSON.stringify({ recursos: { max_pesados: 1 } }));
  const lleno = G.avisoSaturacion(env, raiz, { libreMB: 100000 });
  assert.match(lleno, /1 trabajo pesado en curso/); assert.ok(!/\n/.test(lleno));
  assert.ok(lleno.length < 220, 'cabe en una linea corta: no sube el contexto');
  a.liberar();
});

// ───────── concurrencia REAL entre procesos node ─────────
const SCRIPT = `
const G = require(${JSON.stringify(path.join(HOOKS, 'lib', 'gobernador.js'))});
const fs = require('fs');
const [log, nombre, esperaS, retenerMs, arranque] = process.argv.slice(1);
G.dormirSync(Math.max(0, Number(arranque) - Date.now()));   // todos arrancan a la vez, aunque node tarde en iniciar
const t0 = Date.now();
const r = G.adquirir({ max: 1, esperaS: Number(esperaS), etiqueta: nombre });
if (!r.ok) { fs.appendFileSync(log, JSON.stringify({ nombre, ok: false, espera: Date.now() - t0 }) + '\\n'); process.exit(0); }
const ini = Date.now();
G.dormirSync(Number(retenerMs));
const fin = Date.now();
r.liberar();
fs.appendFileSync(log, JSON.stringify({ nombre, ok: true, ini, fin, espera: ini - t0 }) + '\\n');
`;
// Cada proceso es finito por construccion: espera acotada (esperaS) + retencion acotada (retenerMs).
const lanzar = (env, log, nombre, esperaS, retenerMs, arranque = Date.now() + 4000) => {
  const hijo = spawn(process.execPath, ['-e', SCRIPT, log, nombre, String(esperaS), String(retenerMs), String(arranque)], { env, stdio: 'ignore', windowsHide: true });
  rastrear(hijo); hijo.ref();   // rastrear() lo desreferencia: en Linux el bucle de eventos acabaria mientras se espera su cierre
  return new Promise((res) => { hijo.on('exit', res); });
};
const leerLog = (log) => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('dos procesos node a la vez con max=1: el segundo ESPERA al primero y nunca se solapan', async () => {
  const env = entorno(); const log = path.join(tmp(), 'log.jsonl');
  const T = Date.now() + 5000;
  await Promise.all([lanzar(env, log, 'A', 20, 1200, T), lanzar(env, log, 'B', 20, 1200, T)]);
  const r = leerLog(log); assert.strictEqual(r.length, 2);
  assert.ok(r.every((x) => x.ok), 'ambos acaban pudiendo correr');
  const [p, s] = r.sort((x, y) => x.ini - y.ini);
  assert.ok(s.ini >= p.fin - 5, `no se solapan: el segundo entra a ${s.ini} y el primero acaba a ${p.fin}`);
  assert.ok(s.espera >= 900, `el segundo esperó (${s.espera} ms)`);
  assert.deepStrictEqual(G.leerSlots(env), []);
});

test('espera acotada: si el otro no suelta a tiempo, el segundo falla con timeout (no se cuelga)', async () => {
  const env = entorno(); const log = path.join(tmp(), 'log.jsonl');
  const T = Date.now() + 5000;
  const a = lanzar(env, log, 'A', 20, 4000, T);
  const b0 = lanzar(env, log, 'B', 1, 100, T + 600);
  await Promise.all([a, b0]);
  const b = leerLog(log).find((x) => x.nombre === 'B');
  assert.strictEqual(b.ok, false);
  assert.ok(b.espera < 3000, `B salió por su propio timeout (${b.espera} ms), sin esperar a A`);
});

test('varias sesiones compitiendo: nunca mas de N dentro a la vez', async () => {
  const env = entorno(); const log = path.join(tmp(), 'log.jsonl');
  const T = Date.now() + 5000;
  await Promise.all(['A', 'B', 'C', 'D'].map((n) => lanzar(env, log, n, 40, 400, T)));
  const r = leerLog(log); assert.strictEqual(r.filter((x) => x.ok).length, 4);
  const ev = r.flatMap((x) => [[x.ini, 1], [x.fin, -1]]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  let dentro = 0; let max = 0; for (const [, d] of ev) { dentro += d; max = Math.max(max, dentro); }
  assert.strictEqual(max, 1);
});

test('harness.js recursos: estado y limpieza de entradas obsoletas (solo con --confirmo)', () => {
  const env = entorno(); G.preparar(env);
  const dir = G.dirPesados(env);
  fs.writeFileSync(path.join(dir, 'slot-0.json'), JSON.stringify({ pid: DUENO_MUERTO, desde: 1, hasta: Date.now() + 1e6, etiqueta: 'viejo', sesion: '', exclusivo: false }));
  const salidas = []; const opts = { env, root: tmp(), out: (t) => salidas.push(t), listarFn: () => ({ propios: [], ajenos: 0 }) };
  assert.strictEqual(G.cli([], opts), 0);
  const txt = salidas.join('\n');
  assert.match(txt, /Pesados en curso: 0/); assert.match(txt, /Memoria libre/); assert.match(txt, /Caché/);
  salidas.length = 0;
  G.cli(['--limpiar'], opts);
  assert.match(salidas.join('\n'), /--confirmo/);
  assert.ok(fs.existsSync(path.join(dir, 'slot-0.json')), 'sin --confirmo no se toca nada');
  G.cli(['--limpiar', '--confirmo'], opts);
  assert.ok(!fs.existsSync(path.join(dir, 'slot-0.json')), 'la entrada obsoleta se retira con --confirmo');
});

test('el comando real: node harness.js recursos funciona desde un repo', () => {
  const raiz = tmp(); spawnSync('git', ['init', '-q'], { cwd: raiz });
  const r = spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), 'recursos'], { cwd: raiz, encoding: 'utf8', env: { ...entorno(), CLAUDE_PROJECT_DIR: raiz }, timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Pesados en curso: 0/);
});

test('hook pre-bash: ante un gate pesado avisa en UNA linea si el sistema esta saturado; en silencio si no', () => {
  const raiz = tmp(); spawnSync('git', ['init', '-q'], { cwd: raiz });
  const env = { ...entorno(), FARO_PESADOS: '1', FARO_MEM_MIN_MB: '1', CLAUDE_PROJECT_DIR: raiz };
  const hook = (orden) => spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), 'pre-bash'], { cwd: raiz, encoding: 'utf8', input: JSON.stringify({ tool_input: { command: orden } }), env, timeout: 90000 });
  assert.strictEqual(hook('pnpm test').stdout.trim(), '', 'sin saturacion: silencio');
  const a = G.adquirir({ env, max: 1, esperaS: 0, etiqueta: 'otra sesion' });
  try {
    const r = hook('pnpm test -- --run');
    const j = JSON.parse(r.stdout);
    const ctx = j.hookSpecificOutput.additionalContext;
    assert.match(ctx, /1 trabajo pesado en curso/); assert.ok(!/\n/.test(ctx)); assert.ok(ctx.length < 220);
    assert.strictEqual(hook('npx vitest').stdout.trim() === '', false);
    assert.strictEqual(hook('echo hola').stdout.trim(), '', 'una orden que no es un gate no recibe aviso');
  } finally { a.liberar(); }
});

// ───────── revision independiente (#184) ─────────
test('el .faro.json del repo (no confiable) solo puede ENDURECER los limites; subirlos es cosa del entorno', () => {
  const raiz = tmp(); const def = G.config(tmp(), entorno());
  fs.writeFileSync(path.join(raiz, '.faro.json'), JSON.stringify({ recursos: { max_pesados: 8, espera_s: 3600, mem_min_mb: 0, max_memoria_mb: 65536 } }));
  const c = G.config(raiz, entorno());
  assert.strictEqual(c.maxPesados, def.maxPesados); assert.strictEqual(c.esperaS, def.esperaS);
  assert.strictEqual(c.memMinMB, def.memMinMB); assert.strictEqual(c.maxMemoriaMB, def.maxMemoriaMB);
  fs.writeFileSync(path.join(raiz, '.faro.json'), JSON.stringify({ recursos: { max_pesados: 1, espera_s: 10, mem_min_mb: 4096, max_memoria_mb: 512 } }));
  const d = G.config(raiz, entorno());
  assert.deepStrictEqual([d.maxPesados, d.esperaS, d.memMinMB, d.maxMemoriaMB], [1, 10, 4096, 512]);
  const e = G.config(raiz, { ...entorno(), FARO_PESADOS: '4', FARO_MEM_MIN_MB: '0' });
  assert.deepStrictEqual([e.maxPesados, e.memMinMB], [4, 0]);
});

test('un slot recien creado y aun vacio no se purga (carrera entre openSync y writeSync); pasados unos segundos, si', () => {
  const env = entorno(); G.preparar(env);
  const ruta = path.join(G.dirPesados(env), 'slot-0.json'); fs.writeFileSync(ruta, '');
  assert.strictEqual(G.adquirir({ env, max: 1, esperaS: 0, ...sinDormir }).ok, false);
  assert.ok(fs.existsSync(ruta));
  const viejo = new Date(Date.now() - 10000); fs.utimesSync(ruta, viejo, viejo);
  assert.ok(G.adquirir({ env, max: 1, esperaS: 0, ...sinDormir }).ok);
});

test('un exclusivo en espera no se muere de hambre: los normales ceden turno mientras espera', () => {
  const env = entorno();
  const normal = G.adquirir({ env, max: 2, esperaS: 0, ...sinDormir });
  let vista = null;
  const r = G.adquirir({ env, max: 2, esperaS: 1, exclusivo: true, dormir: () => { if (!vista) vista = G.intentar({ env, max: 2 }).estado; } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(vista, 'espera', 'un normal no se cuela delante del exclusivo que espera');
  assert.ok(G.intentar({ env, max: 2 }).estado === 'ok', 'al terminar la espera el marcador desaparece');
  normal.liberar();
});

test('pre-bash: una orden enorme no provoca backtracking cuadratico en el detector de gates', () => {
  const raiz = tmp(); spawnSync('git', ['init', '-q'], { cwd: raiz });
  const orden = 'npm '.repeat(30000);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(HOOKS, 'harness.js'), 'pre-bash'], { cwd: raiz, encoding: 'utf8', input: JSON.stringify({ tool_input: { command: orden } }), env: { ...entorno(), CLAUDE_PROJECT_DIR: raiz }, timeout: 120000 });
  assert.ok(r.status !== null);
  assert.ok(Date.now() - t0 < 12000, `tardó ${Date.now() - t0} ms`);
});
