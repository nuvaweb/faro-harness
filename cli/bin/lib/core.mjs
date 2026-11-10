// core.mjs — estado compartido (flags CLI, colores, config) + helpers de UI (clack) y utilidades base
// (gh, run). El parseo de process.argv vive SOLO aquí; el resto de módulos importa YES/DRY/argVal/…

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as p from '@clack/prompts';

// Config del usuario: ~/.faro.json (perfiles, sesiones y preferencias), compartida con el plugin.
const CONFIG_PATH = path.join(os.homedir(), '.faro.json');
// GUARDA: bajo `node --test` (NODE_TEST_CONTEXT) NUNCA se escribe ni se migra el fichero real del
// usuario. Un test que ejercitaba la cascada de login con datos de prueba sobrescribio ~/.faro.json
// (token real perdido, 2026-09-11). Los tests que necesiten persistencia inyectan su propio `guardar`.
const EN_TESTS = !!process.env.NODE_TEST_CONTEXT;
let API = 'https://api.github.com';

// ---------- CLI args ----------
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const argVal = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
};
const argFlag = (name) => args.includes(`--${name}`);
const NO_OPEN = argFlag('no-open');
const YES = argFlag('yes') || argFlag('si');

// Cancelación limpia (Ctrl-C).
// Item 7: si ya se creó el repo, el mensaje de cancelación es honesto.
const runState = { repoCreado: false };
const cancelar = () => {
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
  try { process.stdin.pause(); } catch {}
  if (runState.repoCreado) console.log('\n\n  Cancelado. El repo YA existe en la forja; reejecuta el asistente para reanudar (te ofrecerá clonarlo).\n');
  else console.log('\n\n  Cancelado. No se ha creado nada nuevo.\n');
  process.exit(130);
};

// ---------- UI (clack: bonita y compatible con Windows Terminal/PowerShell) ----------
// C = ANSI solo para CONTENIDO embebido en notas; el resto lo estiliza clack.
const C = process.stdout.isTTY
  ? { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', c: '\x1b[36m', b: '\x1b[1m', d: '\x1b[2m', inv: '\x1b[7m', x: '\x1b[0m' }
  : { g: '', y: '', r: '', c: '', b: '', d: '', inv: '', x: '' };
const say = (s = '') => p.log.message(String(s));
const ok = (s) => p.log.success(String(s));
const warn = (s) => p.log.warn(String(s));
const fail = (s) => { p.log.error(String(s)); process.exitCode = 1; };
// caja -> note de clack (misma firma: lineas[], {titulo}).
function caja(lineas, { titulo = '' } = {}) {
  p.note(Array.isArray(lineas) ? lineas.join('\n') : String(lineas), titulo || undefined);
}
// Progreso: mantiene el contador (no cambian las llamadas) con log.step.
const ui = { pasoN: 0, pasoT: 6 };
function paso(titulo) { ui.pasoN++; p.log.step(`${C.b}Paso ${ui.pasoN}/${ui.pasoT}${C.x}  ${titulo}`); }
// spinner de clack; devuelve la función de parada (compat: const s = spinner('..'); s('hecho')).
function spinner(text) { const s = p.spinner(); s.start(text); return (okMsg) => s.stop(okMsg || text); }
// Cancelación limpia (Ctrl-C) en cualquier prompt de clack.
const _noCancel = (v) => { if (p.isCancel(v)) { p.cancel(runState.repoCreado ? 'Cancelado. El repo YA existe en la forja; reejecuta para reanudar.' : 'Cancelado. No se ha creado nada nuevo.'); process.exit(130); } return v; };
async function preguntaLinea(prompt) { return String(_noCancel(await p.text({ message: prompt })) || ''); }
async function pregunta(q, defecto, validate) {
  const v = _noCancel(await p.text({ message: q, placeholder: defecto || undefined, defaultValue: defecto || undefined, validate: validate || undefined }));
  return String(v || defecto || '').trim();
}
// Entrada SECRETA: enmascara lo tecleado (tokens/API keys nunca en claro en consola/scrollback).
async function secreto(q, validate) {
  const v = _noCancel(await p.password({ message: q, mask: '•', validate: validate || undefined }));
  return String(v || '').trim();
}
async function confirma(q, def = 's') { if (YES) return true; return !!_noCancel(await p.confirm({ message: q, initialValue: /^s/i.test(def) })); }

async function elige(titulo, opciones, preseleccion) {
  const keys = Object.keys(opciones);
  if (preseleccion) {
    if (keys.includes(preseleccion)) return preseleccion;
    fail(`Valor '${preseleccion}' no válido. Opciones: ${keys.join(', ')}.`); process.exit(1);
  }
  if (keys.length === 1) return keys[0];                    // auto-salta si solo hay una opción
  const options = keys.map((k) => ({ value: k, label: opciones[k].etiqueta || k, hint: opciones[k].explica || undefined }));
  return _noCancel(await p.select({ message: titulo, options }));
}

// ---------- navegación ATRÁS (wizard multi-paso) ----------
// Centinela que un paso devuelve para pedir "volver al paso anterior".
const BACK = Symbol('faro:atras');

// Menú tipo `elige` con soporte de "← Atrás". Con { atras:true } añade la entrada y, si se elige (o
// se pulsa Esc), devuelve BACK. En el PRIMER paso (atras:false) Esc cancela como siempre (Ctrl-C también).
async function eligePaso(titulo, opciones, { atras = false } = {}) {
  const keys = Object.keys(opciones);
  const options = keys.map((k) => ({ value: k, label: opciones[k].etiqueta || k, hint: opciones[k].explica || undefined }));
  if (atras) options.push({ value: '__atras', label: '← Atrás', hint: 'volver al paso anterior' });
  const v = await p.select({ message: titulo, options });
  if (p.isCancel(v)) return atras ? BACK : _noCancel(v);     // Esc: atrás si se puede; si no, cancela.
  return v === '__atras' ? BACK : v;
}

// Paso de menú para `correrPasos`: respeta flag (preseleccion, sin prompt), auto-salta si hay 1 opción,
// y ofrece "← Atrás" cuando procede. Devuelve la clave elegida o BACK.
async function pasoElige(titulo, opciones, preseleccion, { atras = false } = {}) {
  const keys = Object.keys(opciones);
  if (preseleccion) {
    if (keys.includes(preseleccion)) return preseleccion;
    fail(`Valor '${preseleccion}' no válido. Opciones: ${keys.join(', ')}.`); process.exit(1);
  }
  if (keys.length === 1) return keys[0];
  return eligePaso(titulo, opciones, { atras });
}

// Motor de pasos re-visitables. Cada paso: { key, run: async (respuestas, { atras }) => valor | BACK }.
// Al recibir BACK retrocede un paso (el primero no ofrece atrás). Devuelve el objeto de respuestas.
async function correrPasos(pasos) {
  const respuestas = {};
  let i = 0;
  while (i < pasos.length) {
    const r = await pasos[i].run(respuestas, { atras: i > 0 });
    if (r === BACK) { i = Math.max(0, i - 1); continue; }
    respuestas[pasos[i].key] = r;
    i++;
  }
  return respuestas;
}

// ---------- config local ----------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  if (EN_TESTS) return;
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch {}
}

// ---------- GitHub API ----------
// Un GitHub Enterprise tiene otra base: la fija el arranque con la del perfil activo.
const fijarApi = (base) => { API = base; };
async function gh(token, ruta, init = {}) {
  const res = await fetch(`${API}${ruta}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  // headers: GitHub declara en X-OAuth-Scopes los permisos REALES del token y en X-GitHub-SSO el
  // SSO pendiente de autorizar. Sin exponerlos no se puede distinguir "token valido" de "token que
  // ademas SIRVE" (uno sin 'repo' responde 200 en /user y luego no clona nada privado).
  return { status: res.status, ok: res.ok, body, headers: Object.fromEntries(res.headers) };
}

// git lleva el token en la URL de clonado y de push: un fallo no debe enseñarlo.
const run = (cmd, argv, opts = {}) => {
  try { return execFileSync(cmd, argv, { stdio: 'inherit', ...opts }); }
  catch (e) { if (e && e.message) e.message = e.message.replace(/\/\/[^/@\s]+@/g, '//***@'); throw e; }
};

export {
  args, DRY, argVal, argFlag, NO_OPEN, YES,
  runState, cancelar,
  C, say, ok, warn, fail, caja, ui, paso, spinner, _noCancel, preguntaLinea, pregunta, secreto, confirma, elige,
  BACK, eligePaso, pasoElige, correrPasos,
  loadConfig, saveConfig, gh, fijarApi, run, CONFIG_PATH,
};
