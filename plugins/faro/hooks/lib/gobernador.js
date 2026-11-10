// lib/gobernador.js — GOBERNADOR DE RECURSOS (#182): semaforo global por usuario para los trabajos pesados
// (typecheck, lint, test, build, simulacro de despliegue) que FARO lanza en cualquier repo y sesion.
//
// Generaliza lo de #177 (lib/procesos.js): MISMO directorio privado por usuario (0700, lstat, ni symlink ni
// junction, propio), MISMA marca FARO_PROC y MISMOS helpers de PID. Aqui solo se anade la COORDINACION:
//   · `slot-<k>.json` (k < N) creado en exclusiva ('wx'): quien lo crea tiene turno; sin condiciones de carrera.
//   · cola con espera acotada y un mensaje de una linea.
//   · entradas obsoletas recuperables (dueño muerto o zombi, o vencida: `hasta`), y entradas NO CONFIABLES
//     (esquema estricto: claves exactas, tipos, longitudes) que se descartan en vez de obedecerse.
//   · trabajo EXCLUSIVO (el simulacro de wrangler): nunca coincide con otro pesado.
//   · memoria libre minima antes de lanzar.
//
// SEGURIDAD: sin shell; todo PID pasa por procesos.pidValido/vivo; nada del repo llega a una ruta (los nombres
// de fichero salen de un entero); el texto del repo (etiquetas) se recorta a una linea.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./procesos.js');

const DEF = { maxPesados: 2, esperaS: 300, memMinMB: 1024, memEsperaS: 60 };
const TOPE_PESADOS = 8;
const MAX_ESPERA_S = 3600;
const MARGEN_S = 60;                       // vigencia de una entrada = timeout del trabajo + margen
const CLAVES = ['pid', 'desde', 'hasta', 'etiqueta', 'sesion', 'exclusivo'];

const unaLinea = (t, n = 60) => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, n);
function dormirSync(ms) {
  const n = Math.max(0, Math.min(Number(ms) || 0, 60000));
  if (n) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
}
const entero = (v, min, max) => {
  if (typeof v === 'number' && Number.isInteger(v)) return v >= min && v <= max ? v : undefined;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) { const n = Number(v); return n >= min && n <= max ? n : undefined; }
  return undefined;
};

// ───────────────────────── configuracion ─────────────────────────
/** .faro.json > recursos (esquema cerrado; lo invalido se ignora) → { max_pesados, max_memoria_mb, mem_min_mb, espera_s }. */
function leerRecursosRepo(root) {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(String(root), '.faro.json'), 'utf8'));
    const r = t && t.recursos;
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  } catch { return {}; }
}
/** N de pesados, esperas y memoria. Prioridad: variable de entorno > .faro.json > defecto. */
function config(root, env = process.env) {
  const r = root ? leerRecursosRepo(root) : {};
  // El .faro.json del repo NO es confiable: solo puede ENDURECER (menos pesados, menos espera, mas memoria minima, menos memoria
  // maxima). Subir un limite es decision del usuario, por variable de entorno.
  const memDef = Math.min(4096, Math.max(1024, Math.floor(os.totalmem() / 1048576 / 8)));
  const dur = (v, def, hardMin) => { const n = entero(v, hardMin, 1048576); return n === undefined ? def : Math.min(n, def); };
  const maxPesados = entero(env.FARO_PESADOS, 1, TOPE_PESADOS) ?? dur(r.max_pesados, DEF.maxPesados, 1);
  const esperaS = entero(env.FARO_PESADOS_ESPERA_S, 0, MAX_ESPERA_S) ?? dur(r.espera_s, DEF.esperaS, 0);
  const memRepo = entero(r.mem_min_mb, 0, 1048576);
  const memMinMB = entero(env.FARO_MEM_MIN_MB, 0, 1048576) ?? (memRepo === undefined ? DEF.memMinMB : Math.max(memRepo, DEF.memMinMB));
  const memEsperaS = entero(env.FARO_MEM_ESPERA_S, 0, MAX_ESPERA_S) ?? DEF.memEsperaS;
  const maxMemoriaMB = entero(env.FARO_MAX_MEMORIA_MB, 256, 65536) ?? dur(r.max_memoria_mb, memDef, 256);
  return { maxPesados, esperaS, memMinMB, memEsperaS, maxMemoriaMB };
}

// ───────────────────────── directorio privado ─────────────────────────
const dirPesados = (env = process.env) => path.join(P.dirRegistro(env), 'pesados');
const dirCache = (env = process.env) => path.join(P.dirRegistro(env), 'cache');
/** Crea (si hace falta) y comprueba el directorio privado y el subdirectorio. → ruta | null (no utilizable). */
function preparar(env = process.env, sub = 'pesados') {
  const raiz = P.dirRegistro(env);
  if (!P.dirSeguro(raiz, { crear: true })) return null;
  const d = path.join(raiz, sub);
  return P.dirSeguro(d, { crear: true }) ? d : null;
}

// ───────────────────────── entradas ─────────────────────────
const nombreSlot = (k) => `slot-${Number(k)}.json`;
const reSlot = /^slot-(\d{1,2})\.json$/;
function entradaValida(e) {
  return !!e && typeof e === 'object' && !Array.isArray(e)
    && Object.keys(e).length === CLAVES.length && CLAVES.every((k) => k in e)
    && Number.isSafeInteger(e.pid) && e.pid > 0 && e.pid < 2 ** 31
    && Number.isFinite(e.desde) && Number.isFinite(e.hasta) && e.hasta >= e.desde
    && typeof e.etiqueta === 'string' && e.etiqueta.length <= 60 && typeof e.sesion === 'string' && e.sesion.length <= 80
    && typeof e.exclusivo === 'boolean';
}
function esZombi(pid) {
  if (process.platform !== 'linux') return false;
  try { const s = fs.readFileSync(`/proc/${Number(pid)}/stat`, 'utf8'); return /\)\s+Z\b/.test(s); } catch { return false; }
}
const vigente = (e, ahora = Date.now()) => P.vivo(e.pid) && !esZombi(e.pid) && ahora <= e.hasta;
function leerEntrada(ruta) {
  try {
    const st = fs.lstatSync(ruta);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 2048) return null;
    if (process.platform !== 'win32' && st.uid !== process.getuid()) return null;
    const e = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    return entradaValida(e) ? e : null;
  } catch { return null; }
}
function retirar(ruta, esperado) {                         // re-lectura antes de borrar: no pisa la que otro acaba de crear
  try {
    const hoy = fs.readFileSync(ruta, 'utf8');
    if (esperado !== undefined && hoy !== esperado) return;
    fs.unlinkSync(ruta);
  } catch {}
}
/** Slots vigentes (las obsoletas, corruptas o no confiables se purgan). → [{slot, pid, desde, hasta, etiqueta, sesion, exclusivo}] */
function leerSlots(env = process.env, { purgar = true } = {}) {
  const dir = dirPesados(env);
  if (!P.dirSeguro(dir)) return [];
  let nombres = []; try { nombres = fs.readdirSync(dir).filter((f) => reSlot.test(f)); } catch { return []; }
  const out = [];
  for (const f of nombres) {
    const ruta = path.join(dir, f);
    let crudo = null; try { crudo = fs.readFileSync(ruta, 'utf8'); } catch { continue; }
    const e = leerEntrada(ruta);
    if (!e && crudo === '') {                                  // recien creado: entre openSync('wx') y writeSync. Cuenta como ocupado (y exclusivo, por prudencia)
      let joven = false; try { joven = Date.now() - fs.statSync(ruta).mtimeMs < 2000; } catch {}
      if (joven) { out.push({ slot: Number(f.match(reSlot)[1]), pid: 0, desde: Date.now(), hasta: Date.now() + 2000, etiqueta: '', sesion: '', exclusivo: true }); continue; }
    }
    if (!e || !vigente(e)) { if (purgar) retirar(ruta, crudo); continue; }
    out.push({ slot: Number(f.match(reSlot)[1]), ...e });
  }
  return out.sort((a, b) => a.slot - b.slot);
}
function crearSlot(dir, k, entrada) {
  let fd = null;
  try {
    fd = fs.openSync(path.join(dir, nombreSlot(k)), 'wx', 0o600);       // O_EXCL: solo uno gana
    fs.writeSync(fd, JSON.stringify(entrada));
    return true;
  } catch { return false; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
}
function soltarSlot(env, k, pid) {
  try {
    const ruta = path.join(dirPesados(env), nombreSlot(k));
    const e = leerEntrada(ruta);
    if (e && e.pid === pid) fs.unlinkSync(ruta);
  } catch {}
}

// ───────────────────────── semaforo ─────────────────────────
// Un exclusivo que espera lo anuncia (excl-espera-<pid>.json): los normales ceden turno mientras tanto, o no entraria nunca.
const reEspera = /^excl-espera-(\d{1,10})\.json$/;
function marcarEspera(env, esperaS) {
  const dir = preparar(env);
  if (!dir) return () => {};
  const ahora = Date.now();
  const ruta = path.join(dir, `excl-espera-${process.pid}.json`);
  try { fs.writeFileSync(ruta, JSON.stringify({ pid: process.pid, desde: ahora, hasta: ahora + (Math.max(0, Number(esperaS) || 0) + 5) * 1000, etiqueta: '', sesion: '', exclusivo: true }), { mode: 0o600 }); } catch { return () => {}; }
  return () => { try { fs.unlinkSync(ruta); } catch {} };
}
function exclusivosEsperando(env) {
  const dir = dirPesados(env);
  if (!P.dirSeguro(dir)) return [];
  const out = [];
  let nombres = []; try { nombres = fs.readdirSync(dir).filter((f) => reEspera.test(f)); } catch { return []; }
  for (const f of nombres) {
    const ruta = path.join(dir, f); const e = leerEntrada(ruta);
    if (!e || !vigente(e) || `excl-espera-${e.pid}.json` !== f) { retirar(ruta); continue; }
    out.push(e);
  }
  return out;
}

/**
 * UN intento de tomar turno. → { estado: 'ok', slot, liberar } | { estado: 'espera', enCurso, exclusivoEnCurso } | { estado: 'sin-semaforo' }
 * Tras crear su slot en exclusiva se RE-COMPRUEBA el conjunto: dos candidatos que se pisan (uno exclusivo y otro no) se
 * ceden el paso con un retardo aleatorio, nunca entran los dos.
 */
function intentar({ env = process.env, max = DEF.maxPesados, etiqueta = '', exclusivo = false, duracionS = 900 } = {}) {
  const dir = preparar(env);
  if (!dir) return { estado: 'sin-semaforo' };
  const activos = leerSlots(env);
  const hayExcl = activos.some((a) => a.exclusivo);
  const bloqueado = exclusivo ? activos.length > 0 : (activos.length >= max || hayExcl || exclusivosEsperando(env).length > 0);
  if (bloqueado) return { estado: 'espera', enCurso: activos.length, exclusivoEnCurso: hayExcl };
  const ocupados = new Set(activos.map((a) => a.slot));
  const ahora = Date.now();
  const entrada = {
    pid: process.pid, desde: ahora, hasta: ahora + (Math.max(1, Number(duracionS) || 900) + MARGEN_S) * 1000,
    etiqueta: unaLinea(etiqueta), sesion: unaLinea(env[P.MARCA], 80), exclusivo: Boolean(exclusivo),
  };
  const limite = exclusivo ? TOPE_PESADOS : max;
  for (let k = 0; k < limite; k++) {
    if (ocupados.has(k)) continue;
    if (!crearSlot(dir, k, entrada)) continue;
    const tras = leerSlots(env, { purgar: false }).filter((a) => !(a.slot === k && a.pid === process.pid));
    const choque = exclusivo ? tras.length > 0 : (tras.some((a) => a.exclusivo) || tras.length + 1 > max);
    if (choque) { soltarSlot(env, k, process.pid); return { estado: 'espera', enCurso: tras.length, exclusivoEnCurso: tras.some((a) => a.exclusivo), cedido: true }; }
    let liberado = false;
    return { estado: 'ok', slot: k, liberar() { if (liberado) return; liberado = true; soltarSlot(env, k, process.pid); } };
  }
  return { estado: 'espera', enCurso: activos.length, exclusivoEnCurso: hayExcl };
}
const textoCola = (n, esperaS) => `FARO: hay ${n} ${n === 1 ? 'trabajo pesado' : 'trabajos pesados'} en curso; espero turno (máx. ${esperaS} s).`;
const jitter = (base) => base + Math.floor(Math.random() * base);

/** Espera sincrona (Atomics.wait) hasta tener turno o agotar `esperaS`. → { ok:true, slot, liberar, esperadoS, sinSemaforo? } | { ok:false, motivo:'cola', enCurso, esperadoS } */
function adquirir(op = {}) {
  const esperaS = Math.max(0, Number(op.esperaS) || 0);
  const dormir = op.dormir || dormirSync;
  const t0 = Date.now(); let avisado = false; let ultimo = { enCurso: 0 }; let quitar = null;
  try {
  for (;;) {
    const r = intentar(op);
    if (r.estado === 'sin-semaforo') return { ok: true, sinSemaforo: true, liberar() {}, esperadoS: 0 };
    if (r.estado === 'ok') return { ok: true, slot: r.slot, liberar: r.liberar, esperadoS: Math.round((Date.now() - t0) / 1000) };
    ultimo = r;
    if (op.exclusivo && !quitar) quitar = marcarEspera(op.env || process.env, esperaS);
    if (!avisado && typeof op.aviso === 'function') { avisado = true; try { op.aviso(textoCola(r.enCurso, esperaS)); } catch {} }
    if (Date.now() - t0 >= esperaS * 1000) return { ok: false, motivo: 'cola', enCurso: ultimo.enCurso, esperadoS: Math.round((Date.now() - t0) / 1000) };
    dormir(jitter(r.cedido ? 80 : 150));
  }
  } finally { if (quitar) quitar(); }
}
/** Igual que `adquirir`, sin bloquear el bucle de eventos (lo usa el supervisor para poder atender senales). */
async function adquirirAsync(op = {}) {
  const esperaS = Math.max(0, Number(op.esperaS) || 0);
  const t0 = Date.now(); let avisado = false; let ultimo = { enCurso: 0 }; let quitar = null;
  try {
  for (;;) {
    const r = intentar(op);
    if (r.estado === 'sin-semaforo') return { ok: true, sinSemaforo: true, liberar() {}, esperadoS: 0 };
    if (r.estado === 'ok') return { ok: true, slot: r.slot, liberar: r.liberar, esperadoS: Math.round((Date.now() - t0) / 1000) };
    ultimo = r;
    if (op.exclusivo && !quitar) quitar = marcarEspera(op.env || process.env, esperaS);
    if (!avisado && typeof op.aviso === 'function') { avisado = true; try { op.aviso(textoCola(r.enCurso, esperaS)); } catch {} }
    if (op.cancelado && op.cancelado()) return { ok: false, motivo: 'cancelado', enCurso: ultimo.enCurso, esperadoS: Math.round((Date.now() - t0) / 1000) };
    if (Date.now() - t0 >= esperaS * 1000) return { ok: false, motivo: 'cola', enCurso: ultimo.enCurso, esperadoS: Math.round((Date.now() - t0) / 1000) };
    await new Promise((res) => setTimeout(res, jitter(r.cedido ? 80 : 150)));
  }
  } finally { if (quitar) quitar(); }
}

// ───────────────────────── memoria ─────────────────────────
const memoriaLibreMB = () => os.freemem() / 1048576;
/** Espera (acotada, sincrona) a que haya `minMB` libres; si no, ok:false y un aviso de UNA linea. */
function esperarMemoria({ minMB, esperaS, libreMB = memoriaLibreMB, dormir = dormirSync, aviso = () => {} } = {}) {
  let libre = libreMB();
  if (!(minMB > 0) || libre >= minMB) return { ok: true, libreMB: libre, esperadoS: 0 };
  aviso(`FARO: memoria libre baja (${Math.round(libre)} MB, mínimo ${minMB} MB); espero hasta ${esperaS} s.`);
  let esperado = 0;
  while (esperado < esperaS && libre < minMB) { const paso = Math.min(5, esperaS - esperado); dormir(paso * 1000); esperado += paso; libre = libreMB(); }
  if (libre < minMB) aviso(`FARO: no lanzo el trabajo pesado: solo ${Math.round(libre)} MB libres (mínimo ${minMB} MB).`);
  return { ok: libre >= minMB, libreMB: libre, esperadoS: esperado };
}
async function esperarMemoriaAsync({ minMB, esperaS, libreMB = memoriaLibreMB, aviso = () => {}, cancelado = () => false } = {}) {
  let libre = libreMB();
  if (!(minMB > 0) || libre >= minMB) return { ok: true, libreMB: libre, esperadoS: 0 };
  aviso(`FARO: memoria libre baja (${Math.round(libre)} MB, mínimo ${minMB} MB); espero hasta ${esperaS} s.`);
  let esperado = 0;
  while (esperado < esperaS && libre < minMB && !cancelado()) { const paso = Math.min(5, esperaS - esperado); await new Promise((r) => setTimeout(r, paso * 1000)); esperado += paso; libre = libreMB(); }
  if (libre < minMB) aviso(`FARO: no lanzo el trabajo pesado: solo ${Math.round(libre)} MB libres (mínimo ${minMB} MB).`);
  return { ok: libre >= minMB, libreMB: libre, esperadoS: esperado };
}

// ───────────────────────── aviso de saturacion (hooks / validate) ─────────────────────────
/** '' si todo esta bien (silencio). UNA linea corta si hay ≥N pesados en curso o la memoria libre es baja. Barato: sin listar el sistema. */
function avisoSaturacion(env = process.env, root, { libreMB } = {}) {
  try {
    if (env.FARO_EN_BATERIA === '1') return '';
    const c = config(root, env);
    const n = leerSlots(env, { purgar: false }).length;
    const libre = libreMB !== undefined ? libreMB : memoriaLibreMB();
    const partes = [];
    if (n >= c.maxPesados) partes.push(`${n} ${n === 1 ? 'trabajo pesado' : 'trabajos pesados'} en curso (máx. ${c.maxPesados})`);
    if (c.memMinMB > 0 && libre < c.memMinMB) partes.push(`memoria libre baja (${Math.round(libre)} MB)`);
    return partes.length ? `FARO: sistema saturado — ${partes.join(' y ')}; espera a que acaben en vez de lanzar otro (harness.js recursos).` : '';
  } catch { return ''; }
}

// ───────────────────────── comando `harness.js recursos` ─────────────────────────
const edad = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`; };
/** `recursos` | `recursos --limpiar [--confirmo] [--cache]`. Devuelve el codigo de salida. */
function cli(argv, { env = process.env, root, out = (t) => console.log(t), listarFn = P.listar, matar = P.matarArbol } = {}) {
  const C = require('./cache-gates.js');
  const c = config(root, env);
  const slots = leerSlots(env, { purgar: false });
  const libre = memoriaLibreMB();
  const cache = C.resumen(env);
  const lineas = [
    `Pesados en curso: ${slots.length} de ${c.maxPesados} permitidos (FARO_PESADOS o .faro.json > recursos.max_pesados)`,
    ...slots.map((s) => `  PID ${s.pid} · ${s.etiqueta || '-'}${s.exclusivo ? ' · exclusivo' : ''} · hace ${edad(Date.now() - s.desde)}`),
    `Memoria libre: ${Math.round(libre)} MB (mínimo para lanzar: ${c.memMinMB} MB) · NODE_OPTIONS --max-old-space-size=${c.maxMemoriaMB}`,
    `Caché de gates: ${cache.n} resultado(s), ${Math.round(cache.bytes / 1024)} KB`,
  ];
  if (!argv.includes('--limpiar')) { out(lineas.join('\n')); return 0; }
  const confirmo = argv.includes('--confirmo');
  const obsoletas = (() => {
    const dir = dirPesados(env); const r = [];
    if (!P.dirSeguro(dir)) return r;
    try {
      for (const f of fs.readdirSync(dir).filter((x) => reSlot.test(x))) { const e = leerEntrada(path.join(dir, f)); if (!e || !vigente(e)) r.push(f); }
    } catch {}
    return r;
  })();
  const lis = listarFn({ env });
  const res = P.limpiar(lis.propios || [], { confirmo, matar, env });
  const cacheViejo = C.limpiar(env, { confirmo, todo: argv.includes('--cache') });
  if (!confirmo) {
    lineas.push(`Limpiaría: ${obsoletas.length} entrada(s) obsoleta(s) del semáforo, ${res.candidatos.length} proceso(s) propio(s) huérfano(s) o colgado(s), ${cacheViejo.n} resultado(s) de caché${argv.includes('--cache') ? '' : ' caducado(s) o inválido(s)'}. Repite con --confirmo para hacerlo.`);
  } else {
    const dir = dirPesados(env);
    for (const f of obsoletas) retirar(path.join(dir, f));
    lineas.push(`Limpiado: ${obsoletas.length} entrada(s) del semáforo, ${res.cerrados.length} de ${res.candidatos.length} proceso(s) propio(s), ${cacheViejo.n} resultado(s) de caché.`);
  }
  out(lineas.join('\n'));
  return 0;
}

module.exports = {
  DEF, config, marcarEspera, leerRecursosRepo, dirPesados, dirCache, preparar, leerSlots, intentar, adquirir, adquirirAsync, dormirSync,
  memoriaLibreMB, esperarMemoria, esperarMemoriaAsync, avisoSaturacion, cli, unaLinea,
};
