#!/usr/bin/env node
// faro-harness — el wizard de FARO (Forge-Agnostic Repo Operations): crea, trae o conecta repos con
// el harness, en GitHub o GitLab. El harness vive en el plugin de Claude Code; esto prepara el repo.
//
// Cuatro modos (lib/modos.mjs): instalar (sin sesión) · crear · traer (carpeta o URL, con migración
// opcional) · conectar. La clasificación va en topics (faro · dom-<área> · nat-<tipo>) y en .faro.json; la
// sesión (~/.faro.json) la comparte el plugin. Dependencia: @clack/prompts. Node >= 20.12.
'use strict';

import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import * as p from '@clack/prompts';
import { args, DRY, YES, argVal, argFlag, C, ui, cancelar, elige, fail, warn, say, caja, paso, loadConfig } from './lib/core.mjs';
import { NATURALEZAS, DOMINIOS, slugify, coincideRepo } from './lib/model.mjs';
import { checkPrerrequisitos } from './lib/repo.mjs';
import { MENU, leerModo, AYUDA } from './lib/modos.mjs';
import { flujoCrear } from './flows/crear.mjs';
import { flujoTraer } from './flows/traer.mjs';
import { flujoLogin, forjaDeCarpeta } from './flows/login.mjs';
import { prepararSesion } from './flows/preparar.mjs';
import { detectarForja } from './lib/forja.mjs';
import { actualizar } from './lib/actualizar.mjs';

if (args.includes('--help') || args.includes('-h')) { console.log(AYUDA); process.exit(0); }

process.on('SIGINT', cancelar);

const catalogo = { naturalezas: NATURALEZAS, dominios: DOMINIOS };   // viaja con el paquete

// INSTALAR: el plugin y superpowers en Claude Code, sin sesión (el plugin es público). La cuenta de la
// forja se pide solo al crear o traer un repo, o cuando el plugin opere la forja.
async function instalar() {
  await actualizar();
  say(`  ${C.d}Abre Claude Code en cualquier repo y escribe /faro: para ver las skills. Para crear o traer un repo: npx faro-harness (solo entonces pide conectar con tu forja).${C.x}`);
  p.outro(`${C.g}✅ Plugin listo${C.x}`);
}

// CONECTAR: solo la sesión (compartida con el plugin). El remoto de --dir solo se lee si se dio.
async function conectar(cfg) {
  ui.pasoT = 1; paso('Conectar con la forja');
  const dir = argVal('dir');
  await flujoLogin(cfg, { perfilFlag: argVal('perfil'), soloForja: argVal('forja'), forjaDetectada: dir ? await forjaDeCarpeta(dir, cfg) : detectarForja(null), reautorizar: argFlag('reautorizar') || argFlag('reauth'), tokenPegado: argVal('token') });
  p.outro(`${C.g}✅ Conectado${C.x}`);
}

// CREAR: sin repo que leer todavía, la forja no se adivina por el cwd (se pregunta o sale del perfil).
async function crear(cfg) {
  ui.pasoT = 6; ui.pasoN = 0;
  paso('Sesión');
  const s = await prepararSesion(cfg, { usarRemoto: false, preguntarDestino: true });
  if (!s) return;
  await flujoCrear(s.auth, s.org, cfg, catalogo, s.esOwner, s.ctx);
}

async function main() {
  p.intro(`${C.c}${C.b}🧭  FARO${C.x}  ${C.d}· asistente de repositorios (Forge-Agnostic Repo Operations)${C.x}`);
  const pedido = leerModo(args);
  // instalar no necesita sesión ni repo: el plugin es público. Se atiende antes de pedir nada (#274).
  if (pedido.modo === 'instalar') return instalar();
  caja(['Crea o trae repos con el harness FARO —gobierno git, docs, agentes y clasificación—', 'listos para Claude Code o Cursor.']);
  if (DRY) { say(''); warn(`${C.y}MODO SIMULACIÓN (--dry-run): no se crea nada.${C.x}`); }
  if (!DRY) checkPrerrequisitos();
  const cfg = loadConfig();
  const modo = pedido.modo || (YES ? 'crear' : await elige('¿Qué quieres hacer?', MENU));
  if (modo === 'instalar') return instalar();
  if (modo === 'conectar') return conectar(cfg);
  if (modo === 'traer') {
    ui.pasoT = 4;
    const r = await flujoTraer(cfg, pedido.modo ? pedido : { origen: null, repo: null, revisar: false, migrar: null }, catalogo);
    if (r !== 'CREAR') return;   // quien abría no tenía repos y eligió crear uno
  }
  await crear(cfg);
}

// Guard: solo ejecuta el wizard si el archivo se invoca directamente (los tests lo importan sin arrancarlo).
// npx/npm instala el binario `faro` como SYMLINK: process.argv[1] apunta al enlace y import.meta.url
// al fichero real. Comparando las rutas en crudo NUNCA coinciden -> main() no arranca y el proceso
// sale en silencio con código 0. Solución: resolver ambos lados con realpathSync y comparar como
// file:// URL (evita problemas de separadores/encoding entre SO). Es el patrón robusto multiplataforma.
function _esInvocadoDirectamente() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const invocado = pathToFileURL(realpathSync(argv1)).href;
    const esteFichero = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    return invocado === esteFichero;
  } catch {
    // Fallback si alguna ruta no se puede resolver (p. ej. archivo movido): compara por nombre de bin.
    return argv1.endsWith('crear.mjs') || argv1.endsWith('faro');
  }
}
if (_esInvocadoDirectamente()) main().catch((e) => { fail(e.message || String(e)); process.exit(1); });

export { slugify, coincideRepo };
