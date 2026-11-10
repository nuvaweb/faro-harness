// lib/procesos.js — HIGIENE DE PROCESOS (#177): que FARO y sus tests no dejen procesos huerfanos ni saturen
// la maquina, y una forma de verlos y limpiarlos.
//
// MARCA. Todo proceso que lanza el motor hereda la variable de entorno FARO_PROC=<id de sesion>. Ademas, los
// procesos DE LARGA VIDA que lanza el motor o el lanzador de la suite (test/run.js) se anotan en un registro
// (un fichero por PID en <tmp>/faro-procesos/) con quien los lanzo (`dueno`). Windows no deja leer el
// entorno de un proceso ajeno sin APIs nativas: alli la marca es el registro (PID + instante de arranque,
// para que un PID reutilizado por otro programa no cuente); en Linux tambien se lee /proc/<pid>/environ.
// HUERFANO = su dueño (o, sin registro, su padre) ya no existe.
//
// SEGURIDAD: sin `shell: true` (execFile con argumentos fijos); todo PID se valida como entero antes de
// tocarlo; `limpiar` SOLO actua sobre procesos con marca y jamas sobre uno sin ella; los mensajes no
// llevan contenido del repo.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const MARCA = 'FARO_PROC';
const MAX_EDAD_REGISTRO_MS = 48 * 3600e3;
const VENTANA_ARRANQUE_MS = 120e3;      // el registro se escribe justo tras lanzar: el proceso arranco poco antes
const UMBRALES = { cpuS: 600, edadS: 6 * 3600 };

// ───────────────────────── utilidades ─────────────────────────
function pidValido(x) {
  const s = String(x);
  if (typeof x !== 'number' && typeof x !== 'string') return false;
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 1 && n < 2 ** 31 && n !== process.pid && n !== process.ppid;
}
function vivo(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); } catch (e) { return !!(e && e.code === 'EPERM'); }
  // Linux: un zombi (muerto, aun sin recoger por su padre) responde a kill(0) pero ya no esta vivo.
  if (process.platform === 'linux') { try { if (/^\d+ \(.*\) Z/s.test(fs.readFileSync('/proc/' + n + '/stat', 'utf8'))) return false; } catch {} }
  return true;
}

// ───────────────────────── cierre de un arbol ─────────────────────────
function descendientesPosix(pid) {
  try {
    const t = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    const hijos = new Map();
    for (const l of t.split('\n')) { const m = l.trim().match(/^(\d+)\s+(\d+)$/); if (m) { (hijos.get(+m[2]) || hijos.set(+m[2], []).get(+m[2])).push(+m[1]); } }
    const out = []; const pila = [pid];
    while (pila.length) { const p = pila.pop(); for (const h of hijos.get(p) || []) { out.push(h); pila.push(h); } }
    return out;
  } catch { return []; }
}
/** Cierra el proceso y TODOS sus descendientes. Windows: taskkill /T /F; POSIX: grupo de procesos y arbol por ppid. */
function matarArbol(pid) {
  if (!pidValido(pid)) return false;
  const n = Number(pid);
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(n), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 60000 }); return true; } catch { return !vivo(n); }
  }
  const desc = descendientesPosix(n);
  try { process.kill(-n, 'SIGKILL'); } catch {}
  for (const d of desc.reverse()) { try { process.kill(d, 'SIGKILL'); } catch {} }
  try { process.kill(n, 'SIGKILL'); } catch {}
  return !vivo(n);
}

// ───────────────────────── registro de procesos propios ─────────────────────────
// Directorio PRIVADO por usuario (nunca el /tmp compartido a secas): otro usuario no puede crearlo antes ni
// meter entradas que `limpiar` interprete. Se exige que sea un directorio real (ni symlink ni junction), propio
// y sin permisos de grupo/otros (POSIX).
const sufijoUsuario = () => String(process.platform === 'win32' ? os.userInfo().username : (process.getuid ? process.getuid() : os.userInfo().username)).replace(/[^\w.-]/g, '_');
const dirRegistro = (env = process.env) => env.FARO_PROC_DIR || path.join(os.tmpdir(), `faro-procesos-${sufijoUsuario()}`);
function dirSeguro(dir, { crear = false } = {}) {
  try {
    if (crear) {
      try { fs.mkdirSync(dir, { mode: 0o700 }); }
      catch (e) {
        if (!e || e.code !== 'EEXIST') { fs.mkdirSync(path.dirname(dir), { recursive: true }); try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e2) { if (!e2 || e2.code !== 'EEXIST') return false; } }
      }
    }
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (process.platform !== 'win32') { if (st.uid !== process.getuid() || (st.mode & 0o077) !== 0) return false; }
    return true;
  } catch { return false; }
}
const nombreEntrada = (pid) => `${Number(pid)}.json`;
function registrar(pid, { dueno = process.pid, rol = '', sesion } = {}, env = process.env) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  let fd = null;
  try {
    const dir = dirRegistro(env);
    if (!dirSeguro(dir, { crear: true })) return false;
    const e = { pid: n, dueno: Number(dueno) || process.pid, sesion: String(sesion || env[MARCA] || '').slice(0, 80), rol: String(rol).slice(0, 40), registrado: Date.now() };
    const fich = path.join(dir, nombreEntrada(n));
    try { fs.unlinkSync(fich); } catch {}                                  // una entrada previa (o un enlace puesto ahi) se quita, no se sigue
    fd = fs.openSync(fich, 'wx', 0o600);                                   // O_EXCL: falla si algo ocupa el nombre
    fs.writeSync(fd, JSON.stringify(e));
    return true;
  } catch { return false; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
}
function olvidar(pid, env = process.env) { try { const dir = dirRegistro(env); if (dirSeguro(dir)) fs.unlinkSync(path.join(dir, nombreEntrada(pid))); } catch {} }
const CLAVES = ['pid', 'dueno', 'sesion', 'rol', 'registrado'];
const entradaValida = (e, pidNombre) => !!e && typeof e === 'object' && !Array.isArray(e)
  && Object.keys(e).length === CLAVES.length && CLAVES.every((k) => k in e)
  && Number.isSafeInteger(e.pid) && e.pid > 0 && e.pid === pidNombre
  && Number.isSafeInteger(e.dueno) && e.dueno > 0 && typeof e.registrado === 'number' && Number.isFinite(e.registrado)
  && typeof e.sesion === 'string' && e.sesion.length <= 80 && typeof e.rol === 'string' && e.rol.length <= 40;
/** Entradas validas del registro. Las de procesos que ya no existen se purgan (no hay nada que limpiar). */
function leerRegistro(env = process.env) {
  const dir = dirRegistro(env); const out = [];
  if (!dirSeguro(dir)) return out;
  let fich = []; try { fich = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return out; }
  for (const f of fich) {
    const ruta = path.join(dir, f);
    let e;
    try {
      const st = fs.lstatSync(ruta);
      if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) continue;
      if (process.platform !== 'win32' && st.uid !== process.getuid()) continue;
      e = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    } catch { continue; }
    if (!entradaValida(e, Number(f.slice(0, -5)))) continue;
    if (!vivo(e.pid) || Date.now() - e.registrado > MAX_EDAD_REGISTRO_MS) { try { fs.unlinkSync(ruta); } catch {} continue; }
    out.push({ pid: e.pid, dueno: e.dueno, sesion: e.sesion, rol: e.rol, registrado: e.registrado });
  }
  return out;
}

// ───────────────────────── verificacion previa al cierre ─────────────────────────
// El registro NO es una autoridad: antes de cerrar un PID se pregunta al sistema. Debe existir, ser del usuario
// actual, ser un proceso node y llevar la marca FARO_PROC. Linux: /proc/<pid>/environ. Windows/macOS no dejan leer
// el entorno ajeno: alli la marca es la entrada del registro PRIVADO (dir propio, sin enlaces) cuyo instante de
// registro encaja con el arranque del proceso. Si no se puede verificar, NO se cierra.
function consultaSistema(pid) {
  try {
    if (process.platform === 'linux') {
      const st = fs.statSync(`/proc/${pid}`);
      let nombre = ''; try { nombre = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch {}
      let envTexto = null; try { envTexto = fs.readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch {}
      return { existe: true, nombre, propio: st.uid === process.getuid(), inicio: null, envTexto };
    }
    if (process.platform === 'win32') {
      // tasklist (execFile, PID ya validado como entero): existe, nombre de imagen y usuario propietario.
      const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH', '/V'], { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.split(/\r?\n/).map((l) => l.match(/^"([^"]*)","(\d+)","[^"]*","[^"]*","[^"]*","[^"]*","([^"]*)"/)).find((x) => x && Number(x[2]) === Number(pid));
      if (!m) return { existe: false };
      const usuario = m[3].toLowerCase(); const yo = os.userInfo().username.toLowerCase();
      return { existe: true, nombre: m[1], propio: usuario === yo || usuario.endsWith('\\' + yo), inicio: null, envTexto: null };
    }
    const t = execFileSync('ps', ['-o', 'uid=,etime=,comm=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = t.match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) return { existe: false };
    return { existe: true, nombre: m[3], propio: Number(m[1]) === process.getuid(), inicio: Date.now() - parsearEtime(m[2]) * 1000, envTexto: null };
  } catch { return { existe: false }; }
}
/** → { ok, motivo }. opts: entrada (del registro privado), consulta (inyectable en tests). */
function verificarProceso(pid, { entrada = null, consulta = consultaSistema } = {}) {
  if (!pidValido(pid)) return { ok: false, motivo: 'PID no valido' };
  const n = Number(pid);
  let c; try { c = consulta(n); } catch { c = null; }
  if (!c || !c.existe) return { ok: false, motivo: 'el proceso no existe' };
  if (!esNode(c.nombre)) return { ok: false, motivo: 'no es un proceso node' };
  if (!c.propio) return { ok: false, motivo: 'no es del usuario actual' };
  if (c.envTexto !== null && c.envTexto !== undefined) {
    return /(?:^|\0)FARO_PROC=[^\0]+/.test(c.envTexto) ? { ok: true } : { ok: false, motivo: 'no lleva la marca FARO_PROC' };
  }
  if (!entrada) return { ok: false, motivo: 'no se puede verificar la marca FARO_PROC' };
  if (c.inicio && !(c.inicio <= entrada.registrado + 5000 && entrada.registrado - c.inicio < VENTANA_ARRANQUE_MS)) return { ok: false, motivo: 'el PID fue reutilizado por otro proceso' };
  return { ok: true };
}

// ───────────────────────── instantanea del sistema ─────────────────────────
function parsearEtime(s) {
  const m = String(s).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]);
}
function parsearPs(texto) {
  const out = [];
  for (const l of String(texto).split('\n')) {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (m) out.push({ pid: +m[1], ppid: +m[2], antigS: parsearEtime(m[3]), cpuS: parsearEtime(m[4]), nombre: m[5].trim() });
  }
  return out;
}
function parsearCim(texto) {
  let j; try { j = JSON.parse(texto); } catch { return []; }
  const lista = Array.isArray(j) ? j : (j && typeof j === 'object' ? [j] : []);
  return lista.filter((p) => p && Number.isInteger(p.ProcessId)).map((p) => ({
    pid: p.ProcessId, ppid: Number(p.ParentProcessId) || 0, nombre: String(p.Name || ''), inicio: Number(p.inicio) || 0, cpuS: Number(p.cpuS) || 0,
  }));
}
const PS_WIN = 'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $i = 0; if ($_.CreationDate) { $i = [int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; ' +
  '[pscustomobject]@{ ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; inicio = $i; cpuS = [math]::Round(([int64]$_.KernelModeTime + [int64]$_.UserModeTime) / 1e7, 1) } } | ConvertTo-Json -Compress';
/** Todos los procesos de la maquina ({pid, ppid, nombre, inicio|antigS, cpuS}) o null si no se pudo listar. */
function snapshotSistema() {
  try {
    if (process.platform === 'win32') {
      const t = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_WIN], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      return parsearCim(t);
    }
    const t = execFileSync('ps', ['-eo', 'pid=,ppid=,etime=,time=,comm='], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return parsearPs(t);
  } catch { return null; }
}
function envLinux(pid) {
  try { return fs.readFileSync(`/proc/${Number(pid)}/environ`, 'utf8'); } catch { return null; }
}
const sesionDeEntorno = (txt) => { const m = String(txt || '').match(/(?:^|\0)FARO_PROC=([^\0]*)/); return m ? m[1] : null; };
const esNode = (n) => /^node(js)?(\.exe)?$/i.test(String(n));

/**
 * Procesos node con marca. Fuentes inyectables para probar sin tocar el sistema:
 * opts.snapshot (lista de procesos), opts.registro, opts.ahora, opts.envDe(pid) → entorno crudo o null.
 * → { propios: [{pid, ppid, nombre, antigS, cpuS, sesion, rol, marca:true, huerfano}], ajenos: <n node sin marca>, error? }
 */
function listar(opts = {}) {
  const env = opts.env || process.env;
  const snap = opts.snapshot !== undefined ? opts.snapshot : snapshotSistema();
  if (!snap) return { propios: [], ajenos: 0, error: 'no se pudo listar los procesos de esta maquina' };
  const ahora = opts.ahora || Date.now();
  const registro = opts.registro !== undefined ? opts.registro : leerRegistro(env);
  const envDe = opts.envDe !== undefined ? opts.envDe : (process.platform === 'linux' ? envLinux : () => null);
  const pids = new Set(snap.map((p) => p.pid));
  const muerto = (pid) => !pid || pid <= 1 || !pids.has(pid);
  const propios = []; let ajenos = 0;
  for (const p of snap) {
    if (!esNode(p.nombre) || p.pid === process.pid) continue;
    const inicio = p.inicio != null ? p.inicio : ahora - (p.antigS || 0) * 1000;
    const antigS = p.antigS != null ? p.antigS : Math.max(0, Math.round((ahora - p.inicio) / 1000));
    const entrada = registro.find((e) => e.pid === p.pid && inicio <= e.registrado + 5000 && e.registrado - inicio < VENTANA_ARRANQUE_MS);
    const sesionEnv = entrada ? null : sesionDeEntorno(envDe(p.pid));
    if (!entrada && sesionEnv === null) { ajenos++; continue; }
    propios.push({
      pid: p.pid, ppid: p.ppid, nombre: p.nombre, antigS, cpuS: p.cpuS || 0, marca: true,
      sesion: entrada ? entrada.sesion : sesionEnv, rol: entrada ? entrada.rol : '',
      huerfano: entrada ? muerto(entrada.dueno) : muerto(p.ppid),
    });
  }
  return { propios, ajenos };
}

/** Los que se pueden cerrar: CON marca y (huerfanos o por encima del umbral de CPU/tiempo). Nunca uno sin marca. */
function candidatos(lista, { cpuS = UMBRALES.cpuS, edadS = UMBRALES.edadS } = {}) {
  return (lista || []).filter((p) => p && p.marca === true && (p.huerfano || p.cpuS > cpuS || p.antigS > edadS));
}
function limpiar(lista, { confirmo = false, matar = matarArbol, umbrales = UMBRALES, verificar, env = process.env } = {}) {
  const cand = candidatos(lista, umbrales);
  const cerrados = []; const noVerificados = [];
  if (!confirmo) return { candidatos: cand, cerrados, noVerificados };
  const registro = verificar ? null : leerRegistro(env);
  const ver = verificar || ((pid) => verificarProceso(pid, { entrada: registro.find((e) => e.pid === pid) || null }));
  for (const p of cand) {
    if (!pidValido(p.pid) || p.marca !== true) continue;
    const v = ver(p.pid);                                             // re-comprobacion contra el sistema, no contra el registro
    if (!v || !v.ok) { noVerificados.push({ pid: p.pid, motivo: (v && v.motivo) || 'no verificable' }); continue; }
    if (matar(p.pid)) cerrados.push(p.pid);
  }
  return { candidatos: cand, cerrados, noVerificados };
}

// ───────────────────────── candado de bateria completa ─────────────────────────
function rutaCandado(root, env = process.env) {
  if (env.FARO_BATERIA_CANDADO) return env.FARO_BATERIA_CANDADO;
  let clave = path.resolve(String(root || process.cwd()));
  try { const n = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name; if (n) clave = 'pkg:' + n; } catch {}   // mismo proyecto => mismo candado, aunque sea otro worktree
  return path.join(os.tmpdir(), `faro-bateria-${crypto.createHash('sha1').update(clave).digest('hex').slice(0, 12)}.lock`);
}
function leerCandado(ruta, { maxEdadMs = 4 * 3600e3 } = {}) {
  let c; try { c = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { return null; }
  if (!c || !Number.isInteger(c.pid) || typeof c.desde !== 'number') return null;
  if (!vivo(c.pid) || Date.now() - c.desde > maxEdadMs) return null;       // obsoleto: dueño muerto o PID reutilizado
  return c;
}
/** → {ok:true} si lo toma; {ok:false, pid, desde} si otra bateria viva lo tiene. Un candado obsoleto se recupera. */
function tomarCandado(ruta, { pid = process.pid, maxEdadMs = 4 * 3600e3 } = {}) {
  for (let intento = 0; intento < 3; intento++) {
    try { fs.writeFileSync(ruta, JSON.stringify({ pid, desde: Date.now() }), { flag: 'wx' }); return { ok: true }; }
    catch (e) { if (!e || e.code !== 'EEXIST') return { ok: true, sinCandado: true }; }       // no se puede escribir: no se bloquea la bateria por eso
    const c = leerCandado(ruta, { maxEdadMs });
    if (c) return { ok: false, pid: c.pid, desde: c.desde };
    try { fs.unlinkSync(ruta); } catch {}
  }
  return { ok: true, sinCandado: true };
}
function soltarCandado(ruta, pid = process.pid) {
  try { const c = JSON.parse(fs.readFileSync(ruta, 'utf8')); if (c && c.pid === pid) fs.unlinkSync(ruta); } catch {}
}

// ───────────────────────── memoria ─────────────────────────
/** Si la memoria libre esta por debajo de minMB espera (hasta esperaS) y luego sigue: avisa, no cuelga. */
async function esperarMemoria({ minMB, esperaS, libreMB = () => os.freemem() / 1048576, dormir = (ms) => new Promise((r) => setTimeout(r, ms)), aviso = () => {} } = {}) {
  let libre = libreMB();
  if (!(minMB > 0) || libre >= minMB) return { ok: true, libreMB: libre, esperadoS: 0 };
  aviso(`Memoria libre baja: ${Math.round(libre)} MB (minimo ${minMB} MB). Espero hasta ${esperaS} s a que se libere; cierra servidores y baterias ajenas.`);
  let esperado = 0;
  while (esperado < esperaS && libre < minMB) { const paso = Math.min(5, esperaS - esperado); await dormir(paso * 1000); esperado += paso; libre = libreMB(); }
  if (libre < minMB) aviso(`Sigo con ${Math.round(libre)} MB libres (por debajo de ${minMB} MB): la bateria puede ir lenta.`);
  return { ok: libre >= minMB, libreMB: libre, esperadoS: esperado };
}

// ───────────────────────── aviso corto (SessionStart / Stop) ─────────────────────────
/** '' si todo esta bien (silencio). Una frase si hay procesos propios huerfanos o una bateria completa corriendo. Barato: sin listar el sistema. */
function avisoCorto(env = process.env, root) {
  try {
    if (env.FARO_EN_BATERIA === '1') return '';                             // dentro de la propia bateria no se avisa de la bateria
    const partes = [];
    const huerfanos = leerRegistro(env).filter((e) => e.pid !== e.dueno && !vivo(e.dueno)).length;
    if (huerfanos) partes.push(`FARO: ${huerfanos} ${huerfanos === 1 ? 'proceso propio huérfano' : 'procesos propios huérfanos'}; ciérralos con: node harness.js procesos --limpiar --confirmo.`);
    const c = leerCandado(rutaCandado(root, env));
    if (c) partes.push(`Hay una batería de tests completa en curso (PID ${c.pid}): no lances otra.`);
    return partes.join(' ');
  } catch { return ''; }
}

// ───────────────────────── comando `harness.js procesos` ─────────────────────────
const dur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`);
function numArg(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return /^\d+(\.\d+)?$/.test(String(v)) ? Number(v) : NaN;
}
/** `procesos` | `procesos --limpiar [--confirmo] [--cpu-s N] [--edad-min N]`. Devuelve el codigo de salida. */
function cli(argv, { env = process.env, root, out = (t) => console.log(t), listarFn = listar, matar = matarArbol } = {}) {
  const cpuS = numArg(argv, '--cpu-s'); const edadMin = numArg(argv, '--edad-min');
  if (Number.isNaN(cpuS) || Number.isNaN(edadMin)) { out('Uso: procesos [--limpiar [--confirmo]] [--cpu-s <segundos>] [--edad-min <minutos>] (valores numericos).'); return 2; }
  const umbrales = { cpuS: cpuS !== undefined ? cpuS : UMBRALES.cpuS, edadS: edadMin !== undefined ? edadMin * 60 : UMBRALES.edadS };
  const r = listarFn({ env });
  if (r.error) { out(`procesos: ${r.error}.`); return 1; }
  const lineas = [`Procesos node de FARO (marca ${MARCA}): ${r.propios.length} · node ajenos sin marca (no se tocan): ${r.ajenos}`];
  const cand = new Set(candidatos(r.propios, umbrales).map((p) => p.pid));
  for (const p of r.propios) {
    lineas.push(`  PID ${p.pid} · edad ${dur(p.antigS)} · CPU ${dur(Math.round(p.cpuS))} · sesión ${p.sesion || '-'}${p.rol ? ' · ' + p.rol : ''}${p.huerfano ? ' · huérfano' : ''}${cand.has(p.pid) ? ' · candidato' : ''}`);
  }
  const c = leerCandado(rutaCandado(root, env));
  if (c) lineas.push(`Batería de tests completa en curso: PID ${c.pid}.`);
  if (!argv.includes('--limpiar')) { out(lineas.join('\n')); return 0; }
  const confirmo = argv.includes('--confirmo');
  const res = limpiar(r.propios, { confirmo, matar, umbrales, env });
  if (!res.candidatos.length) lineas.push('Nada que limpiar: ningún proceso propio huérfano ni por encima del umbral.');
  else if (!confirmo) lineas.push(`Cerraría ${res.candidatos.length} proceso(s) propio(s) (huérfanos o sobre ${umbrales.cpuS}s de CPU / ${Math.round(umbrales.edadS / 60)} min). Repite con --confirmo para cerrarlos.`);
  else lineas.push(`Cerrados ${res.cerrados.length} de ${res.candidatos.length} proceso(s) propio(s).`);
  for (const n of res.noVerificados || []) lineas.push(`  No cerrado PID ${n.pid}: ${n.motivo}.`);
  out(lineas.join('\n'));
  return 0;
}

module.exports = {
  MARCA, UMBRALES, pidValido, vivo, matarArbol, dirRegistro, registrar, olvidar, leerRegistro,
  dirSeguro, verificarProceso, parsearEtime, parsearPs, parsearCim, snapshotSistema, listar, candidatos, limpiar,
  rutaCandado, leerCandado, tomarCandado, soltarCandado, esperarMemoria, avisoCorto, cli,
};
