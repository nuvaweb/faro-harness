// lib/ejecutar-pesado.js — EJECUTOR COMUN DE GATES PESADOS (#182): el UNICO punto por el que pasan typecheck,
// lint, test, build y el simulacro de despliegue (`wrangler deploy --dry-run`) de lib/code.js.
//
//   · turno: semaforo global por usuario (lib/gobernador.js); cola con espera acotada y aviso de una linea.
//   · memoria libre minima antes de lanzar (espera acotada o aborta con aviso corto).
//   · `execFile`/`spawn` SIN shell; timeout por trabajo; marca FARO_PROC y registro (lib/procesos.js).
//   · al acabar, al expirar y ante SIGINT/SIGTERM/SIGHUP cierra el ARBOL de procesos (procesos.matarArbol).
//   · NODE_OPTIONS=--max-old-space-size=<razonable> salvo que ya lo traiga.
//
// Dos formas: `ejecutarAsync` (promesa) y `ejecutarSync` (la que usa code.js, que es sincrono): esta ultima lanza
// este mismo fichero como SUPERVISOR (`node ejecutar-pesado.js --supervisor <b64>`), que es quien tiene el bucle
// de eventos para atender el timeout y las senales y cerrar el arbol. Si el llamador muere, el supervisor sigue
// acotado por el mismo timeout.
//
// SEGURIDAD: el comando y los argumentos se validan con patrones cerrados (nada de `shell: true`). En Windows
// los shims `.cmd` de pnpm/npm/npx/yarn solo se pueden lanzar a traves de `cmd.exe /d /s /c`: alli SOLO se admiten
// argumentos sin metacaracteres (^[A-Za-z0-9_@./\\:=,+-]+$), de modo que no hay nada que interpretar.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const P = require('./procesos.js');
const G = require('./gobernador.js');

const MARCA_SALIDA = '@@FARO_PESADO@@ ';
const SHIMS_WIN = new Set(['pnpm', 'npm', 'npx', 'yarn', 'corepack']);
const RE_CMD = /^[A-Za-z0-9._-]{1,40}$/;
const RE_ARG_WIN = /^[A-Za-z0-9_@./\\:=,+-]+$/;
const RE_ENV = /^[A-Z][A-Z0-9_]{0,40}$/;
const MAX_SALIDA = 200 * 1024;
const unaLinea = G.unaLinea;

/** → { ok } | { ok:false, motivo }. El trabajo viene del motor, pero se revalida: tambien llega por la linea de comandos del supervisor. */
function validar(t) {
  if (!t || typeof t !== 'object') return { ok: false, motivo: 'trabajo vacío' };
  const absoluto = typeof t.cmd === 'string' && path.isAbsolute(t.cmd) && !/[\0\r\n]/.test(t.cmd);
  if (!absoluto && !RE_CMD.test(String(t.cmd))) return { ok: false, motivo: 'comando no válido' };
  if (!Array.isArray(t.args) || t.args.length > 60 || t.args.some((a) => typeof a !== 'string' || a.length > 600 || /\0/.test(a))) return { ok: false, motivo: 'argumentos no válidos' };
  if (typeof t.cwd !== 'string' || !path.isAbsolute(t.cwd)) return { ok: false, motivo: 'directorio no válido' };
  try { if (!fs.statSync(t.cwd).isDirectory()) return { ok: false, motivo: 'directorio no válido' }; } catch { return { ok: false, motivo: 'el directorio no existe' }; }
  if (!Number.isInteger(t.timeoutMs) || t.timeoutMs < 1000 || t.timeoutMs > 6 * 3600e3) return { ok: false, motivo: 'timeout no válido' };
  if (t.env !== undefined && (typeof t.env !== 'object' || t.env === null || Object.entries(t.env).some(([k, v]) => !RE_ENV.test(k) || typeof v !== 'string' || v.length > 200 || /\0/.test(v)))) return { ok: false, motivo: 'entorno no válido' };
  const ent = (v, min, max) => v === undefined || (Number.isInteger(v) && v >= min && v <= max);
  if (!ent(t.maxPesados, 1, 8) || !ent(t.esperaS, 0, 3600) || !ent(t.memMinMB, 0, 1048576) || !ent(t.memEsperaS, 0, 3600) || (t.exclusivo !== undefined && typeof t.exclusivo !== 'boolean')) return { ok: false, motivo: 'límites no válidos' };
  return { ok: true };
}

/** → { file, argv } o { error }. Sin shell; en Windows, shims .cmd por cmd.exe con argumentos sin metacaracteres. */
function lanzador(cmd, args, plataforma = process.platform, env = process.env) {
  if (plataforma === 'win32' && SHIMS_WIN.has(String(cmd).toLowerCase())) {
    const mal = args.find((a) => !RE_ARG_WIN.test(a));
    if (mal !== undefined) return { error: `argumento no admitido para lanzar ${cmd} en Windows: ${unaLinea(mal, 40)}` };
    return { file: env.ComSpec || 'cmd.exe', argv: ['/d', '/s', '/c', String(cmd), ...args] };
  }
  return { file: cmd, argv: args };
}

function entornoHijo(t, env, cfg) {
  const e = { ...env };
  for (const [k, v] of Object.entries(t.env || {})) e[k] = v;
  e[P.MARCA] = env[P.MARCA] || `gate-${process.pid}`;
  const no = String(e.NODE_OPTIONS || '');
  if (!/--max-old-space-size/.test(no)) e.NODE_OPTIONS = `${no} --max-old-space-size=${cfg.maxMemoriaMB}`.trim();
  return e;
}

/** Ejecuta UN trabajo pesado bajo el gobernador. → { status:'pass'|'fail'|'skip'|'busy', out, codigo?, ms, esperadoS, timeout?, motivo? } */
async function ejecutarAsync(t, o = {}) {
  const env = o.env || process.env;
  const v = validar(t);
  if (!v.ok) return { status: 'fail', out: `Trabajo pesado rechazado: ${v.motivo}.`, ms: 0, esperadoS: 0 };
  const base = G.config(t.root || t.cwd, env);
  const cfg = {
    ...base,
    maxPesados: t.maxPesados || base.maxPesados, esperaS: t.esperaS !== undefined ? t.esperaS : base.esperaS,
    memMinMB: t.memMinMB !== undefined ? t.memMinMB : base.memMinMB, memEsperaS: t.memEsperaS !== undefined ? t.memEsperaS : base.memEsperaS,
  };
  const aviso = o.aviso || (() => {});
  const l = lanzador(t.cmd, t.args, o.plataforma || process.platform, env);
  if (l.error) return { status: 'fail', out: l.error, ms: 0, esperadoS: 0 };

  let cancelado = false; let hijo = null; let turno = null; let hijoVivo = false;
  const limpiarSync = () => {
    if (hijo && hijo.pid) { if (hijoVivo) P.matarArbol(hijo.pid); P.olvidar(hijo.pid, env); }   // un PID ya terminado puede haberse reutilizado: no se toca
    if (turno && turno.liberar) turno.liberar();
  };
  const manejadores = [];
  if (o.manejarSenales) {
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) { const h = () => { cancelado = true; limpiarSync(); process.exit(130); }; process.on(s, h); manejadores.push([s, h]); }
    process.on('exit', limpiarSync);
  }
  const soltar = () => { for (const [s, h] of manejadores) process.removeListener(s, h); if (o.manejarSenales) process.removeListener('exit', limpiarSync); };
  try {
    const t0 = Date.now();
    turno = await G.adquirirAsync({ env, max: cfg.maxPesados, esperaS: cfg.esperaS, etiqueta: unaLinea(t.etiqueta), exclusivo: Boolean(t.exclusivo), duracionS: Math.ceil(t.timeoutMs / 1000) + cfg.memEsperaS, aviso, cancelado: () => cancelado });
    if (!turno.ok) return { status: 'busy', motivo: 'cola', enCurso: turno.enCurso, out: `Hay ${turno.enCurso} ${turno.enCurso === 1 ? 'trabajo pesado' : 'trabajos pesados'} en curso y no ha habido turno en ${cfg.esperaS} s: reintenta cuando acaben (harness.js recursos).`, ms: 0, esperadoS: turno.esperadoS };
    const mem = await G.esperarMemoriaAsync({ minMB: cfg.memMinMB, esperaS: cfg.memEsperaS, libreMB: o.libreMB || G.memoriaLibreMB, aviso, cancelado: () => cancelado });
    if (!mem.ok) return { status: 'busy', motivo: 'memoria', out: `Memoria libre insuficiente (${Math.round(mem.libreMB)} MB, mínimo ${cfg.memMinMB} MB): no lanzo el trabajo. Cierra servidores o baterías ajenas y reintenta.`, ms: 0, esperadoS: Math.round((Date.now() - t0) / 1000) };

    const inicio = Date.now();
    return await new Promise((resolve) => {
      const trozos = []; let tam = 0; let expirado = false;
      const acumular = (b) => { trozos.push(b); tam += b.length; while (tam > MAX_SALIDA && trozos.length > 1) tam -= trozos.shift().length; };
      let h;
      try {
        h = spawn(l.file, l.argv, { cwd: t.cwd, env: entornoHijo(t, env, cfg), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32' });
      } catch (e) { resolve({ status: e && e.code === 'ENOENT' ? 'skip' : 'fail', out: e && e.code === 'ENOENT' ? `comando no disponible: ${t.cmd}` : unaLinea(e && e.message, 200), ms: 0, esperadoS: turno.esperadoS }); return; }
      hijo = h; hijoVivo = true;
      if (h.pid) P.registrar(h.pid, { dueno: process.pid, rol: 'gate', sesion: env[P.MARCA] }, env);
      h.stdout.on('data', acumular); h.stderr.on('data', acumular);
      const reloj = setTimeout(() => { expirado = true; if (h.pid) P.matarArbol(h.pid); }, t.timeoutMs);
      let cerrado = false;
      const fin = (codigo, error) => {
        if (cerrado) return; cerrado = true; clearTimeout(reloj);
        // Restos que dejara el trabajo al acabar: POSIX tiene el grupo de procesos (aunque el lider ya no este); en Windows el arbol
        // se cierra mientras el padre vive (timeout/senal), porque un PID ya terminado puede ser de otro programa.
        if (h.pid) { if (process.platform !== 'win32') P.matarArbol(h.pid); P.olvidar(h.pid, env); }
        hijoVivo = false;
        const out = Buffer.concat(trozos).toString('utf8').trim();
        const ms = Date.now() - inicio;
        if (error && error.code === 'ENOENT') return resolve({ status: 'skip', out: `comando no disponible: ${t.cmd}`, ms, esperadoS: turno.esperadoS });
        if (expirado) return resolve({ status: 'fail', timeout: true, out: `tiempo agotado (${Math.round(t.timeoutMs / 1000)} s): proceso y descendientes cerrados.${out ? `\n${out.split('\n').slice(-12).join('\n')}` : ''}`, codigo, ms, esperadoS: turno.esperadoS });
        resolve({ status: codigo === 0 ? 'pass' : 'fail', out, codigo, ms, esperadoS: turno.esperadoS });
      };
      h.on('error', (e) => fin(1, e));
      h.on('close', (c) => fin(c == null ? 1 : c));
    });
  } finally {
    limpiarSync(); soltar();
  }
}

/**
 * Version SINCRONA (la que usa code.js): lanza el supervisor y espera su resultado. Mismo resultado que ejecutarAsync.
 * o.env: entorno del llamador; o.supervisor: ruta alternativa (tests).
 */
function ejecutarSync(t, o = {}) {
  const env = o.env || process.env;
  const v = validar(t);
  if (!v.ok) return { status: 'fail', out: `Trabajo pesado rechazado: ${v.motivo}.`, ms: 0, esperadoS: 0 };
  const cfg = G.config(t.root || t.cwd, env);
  const total = ((t.esperaS !== undefined ? t.esperaS : cfg.esperaS) + (t.memEsperaS !== undefined ? t.memEsperaS : cfg.memEsperaS)) * 1000 + t.timeoutMs + 45000;
  const b64 = Buffer.from(JSON.stringify(t), 'utf8').toString('base64');
  const r = spawnSync(process.execPath, [o.supervisor || __filename, '--supervisor', b64], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024, timeout: total, killSignal: 'SIGKILL', windowsHide: true,
  });
  if (r.error) {
    if (r.pid) for (const e of P.leerRegistro(env)) if (e.dueno === r.pid) P.matarArbol(e.pid);   // el supervisor se colgó: no deja hijos
    return { status: 'fail', out: `El supervisor del gate no respondió a tiempo (${Math.round(total / 1000)} s): ${unaLinea(r.error.message, 120)}`, ms: 0, esperadoS: 0 };
  }
  const linea = String(r.stdout || '').split('\n').reverse().find((x) => x.startsWith(MARCA_SALIDA));
  if (!linea) return { status: 'fail', out: 'El supervisor del gate terminó sin resultado.', ms: 0, esperadoS: 0 };
  try { return JSON.parse(linea.slice(MARCA_SALIDA.length)); } catch { return { status: 'fail', out: 'Resultado del supervisor ilegible.', ms: 0, esperadoS: 0 }; }
}

if (require.main === module && process.argv[2] === '--supervisor') {
  let t = null;
  try { t = JSON.parse(Buffer.from(String(process.argv[3] || ''), 'base64').toString('utf8')); } catch { t = null; }
  const salir = (r) => { process.stdout.write(`${MARCA_SALIDA}${JSON.stringify(r)}\n`); P.olvidar(process.pid); process.exit(0); };
  if (!t) salir({ status: 'fail', out: 'Trabajo pesado ilegible.', ms: 0, esperadoS: 0 });
  else {
    P.registrar(process.pid, { dueno: process.ppid, rol: 'supervisor-gate' });
    ejecutarAsync(t, { manejarSenales: true, aviso: (m) => process.stderr.write(`${m}\n`) })
      .then(salir, (e) => salir({ status: 'fail', out: `Error del supervisor: ${unaLinea(e && e.message, 200)}`, ms: 0, esperadoS: 0 }));
  }
}

module.exports = { MARCA_SALIDA, validar, lanzador, ejecutarAsync, ejecutarSync, ejecutarPesado: ejecutarSync };
