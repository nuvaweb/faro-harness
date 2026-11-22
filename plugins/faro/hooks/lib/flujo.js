// lib/flujo.js — LA POLITICA DEL FLUJO, en un solo sitio (FARO 3.0).
//
// Flujo directo a main: issue -> rama <tipo>/<N>-<slug> desde origin/main -> PR a main con auto-merge
// -> el CI corre la suite y, al integrarse, publica (tag + release). Sin develop, sin consolidar, sin
// publicar a mano.
//
// Lo que antes estaba repartido (rama base, tipos de rama, tipo de commit, version a subir, metodo de
// merge) se decide AQUI. harness.js, las libs y los scripts del CI leen de este modulo: cambiar una
// regla es cambiar una linea, no barrer veinte ficheros.
//
// CONFIGURABLE (de mas a menos prioridad):
//   1. entorno: FARO_RAMA_PRINCIPAL · FARO_AUTO_MERGE (0/1) · FARO_METODO_MERGE (squash|merge|rebase)
//   2. faro/config.json (o .faro.json) > "flujo": { "rama_principal", "auto_merge", "metodo_merge" }
//   3. DEFECTO.
// Modulo puro salvo leerConfig(): sin git ni red, testeable de forma atomica.
'use strict';
const fs = require('fs');
const path = require('path');

const DEFECTO = Object.freeze({ rama_principal: 'main', auto_merge: true, metodo_merge: 'squash' });
const METODOS = Object.freeze(['squash', 'merge', 'rebase']);

// Tipos Conventional: ramas, commits, titulos de PR y versiones comparten UNA nomenclatura.
// 'publica': que parte de la version mueve al integrarse en main (null = no publica).
const TIPOS = Object.freeze({
  feat: { publica: 'minor' },
  fix: { publica: 'patch' },
  perf: { publica: 'patch' },
  refactor: { publica: 'patch' },
  revert: { publica: 'patch' },
  docs: { publica: null },
  chore: { publica: null },
  test: { publica: null },
  ci: { publica: null },
  build: { publica: null },
  style: { publica: null },
});
// Prefijos de rama heredados que se traducen a un tipo Conventional.
const ALIAS_RAMA = Object.freeze({ feature: 'feat', bug: 'fix', bugfix: 'fix', hotfix: 'fix', spike: 'chore' });

const RE_TITULO = /^([a-z]+)(\(([^)\s]+)\))?(!)?: (\S.*)$/;
const RE_BREAKING = /(^|\n)BREAKING[ -]CHANGE: /;

function bool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function leerConfig(root) {
  if (!root) return {};
  for (const f of [path.join('faro', 'config.json'), '.faro.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
      return (j && typeof j.flujo === 'object' && j.flujo) || {};
    } catch { /* siguiente */ }
  }
  return {};
}

function ramaValida(r) {
  return typeof r === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(r) && !/\.\.|\/\/|\/$|\.lock$|\.$/.test(r);
}

// Config efectiva. 'cfgRepo' = el objeto "flujo" ya leido (tests); si se omite, se lee del repo.
function config({ root = null, env = process.env, cfgRepo } = {}) {
  const repo = cfgRepo !== undefined ? (cfgRepo || {}) : leerConfig(root);
  const rama = String(env.FARO_RAMA_PRINCIPAL || repo.rama_principal || DEFECTO.rama_principal).trim();
  const metodo = String(env.FARO_METODO_MERGE || repo.metodo_merge || DEFECTO.metodo_merge).trim().toLowerCase();
  return Object.freeze({
    // El nombre acaba como argumento de git (fetch, merge-base...): solo un nombre de rama valido y que no
    // empiece por '-' (no se puede leer como opcion). Si no lo es, se usa el defecto.
    rama_principal: ramaValida(rama) ? rama : DEFECTO.rama_principal,
    auto_merge: bool(env.FARO_AUTO_MERGE, bool(repo.auto_merge, DEFECTO.auto_merge)),
    metodo_merge: METODOS.includes(metodo) ? metodo : DEFECTO.metodo_merge,
  });
}

// Tipo Conventional de una rama '<prefijo>/...' (null si el prefijo no es de trabajo).
function tipoDeRama(rama) {
  const p = String(rama || '').split('/')[0].toLowerCase();
  if (TIPOS[p]) return p;
  return ALIAS_RAMA[p] || null;
}

// 'tipo(alcance)!: descripcion' -> partes. ok:false si no es Conventional o el tipo no existe.
function analizarTitulo(titulo) {
  const m = String(titulo || '').trim().match(RE_TITULO);
  if (!m || !TIPOS[m[1]]) return { ok: false };
  return { ok: true, tipo: m[1], alcance: m[3] || null, ruptura: !!m[4], descripcion: m[5] };
}

// Titulo Conventional desde la rama y una descripcion libre. Si ya lo es, se respeta tal cual.
function tituloConventional(rama, descripcion) {
  const d = String(descripcion || '').trim();
  if (analizarTitulo(d).ok) return d;
  const tipo = tipoDeRama(rama) || 'chore';
  const desdeRama = String(rama || '').split('/').slice(1).join('/').replace(/^\d+-/, '').replace(/-/g, ' ');
  const texto = (d || desdeRama || 'cambio').replace(/^[A-ZÁÉÍÓÚÑ]/, (c) => c.toLowerCase());
  return `${tipo}: ${texto}`;
}

const ORDEN = { patch: 1, minor: 2, major: 3 };
// Parte de la version que publica un conjunto de mensajes (commits o titulos de PR). null = nada.
function bumpDe(mensajes) {
  let max = null;
  for (const msg of [].concat(mensajes || [])) {
    const texto = String(msg || '');
    const a = analizarTitulo(texto.split('\n')[0]);
    let b = null;
    if ((a.ok && a.ruptura) || RE_BREAKING.test(texto)) b = 'major';
    else if (a.ok) b = TIPOS[a.tipo].publica;
    if (b && (!max || ORDEN[b] > ORDEN[max])) max = b;
  }
  return max;
}

function siguienteVersion(version, bump) {
  const m = String(version || '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  let [ma, mi, pa] = m.slice(1).map(Number);
  if (bump === 'major') { ma += 1; mi = 0; pa = 0; } else if (bump === 'minor') { mi += 1; pa = 0; } else if (bump === 'patch') pa += 1;
  return `${ma}.${mi}.${pa}`;
}

// Ramas candidatas a BASE, por orden: la principal configurada, main/master y, solo como ultimo recurso
// en repos heredados del flujo anterior, develop. Las libs que buscan "contra que comparo" usan esto.
function basesCandidatas(root, env = process.env) {
  const p = config({ root, env }).rama_principal;
  return [...new Set([p, 'main', 'master', 'develop'])];
}

// Mensaje unico para quien aun invoque lo retirado (consolidar, publicar, develop).
function avisoRetirado(cmd, rama = DEFECTO.rama_principal) {
  return `'${cmd}' se retiro en FARO 3.0: ya no hay develop ni publicacion manual. Cada rama entra por PR a ${rama} con auto-merge (harness.js pr crear) y el CI publica tag y release al integrarse.`;
}

// UNA RAMA -> UN PR -> UNA ISSUE (regla firme). Decide si 'pr crear' puede abrir la peticion:
//  - la rama ya tiene peticion abierta -> no se abre otra: los commits nuevos se SUBEN (git push) y la
//    peticion existente se actualiza y relanza el CI;
//  - la peticion cerraria mas de una issue -> se parte en una rama por issue.
// Puro (sin red): 'prAbierto' es la url que devuelve la forja (prAbiertoDe) o null; 'cierra' son los
// numeros de issue que la peticion cerraria (tarea.js issuesDePr).
function validarPeticion({ rama, prAbierto = null, cierra = [] } = {}) {
  if (prAbierto) {
    return { ok: false, motivo: `La rama '${rama}' ya tiene su peticion abierta: ${prAbierto}. Una rama = un PR: sigue haciendo commits en la rama y 'git push'; la peticion se actualiza sola, el CI se relanza y el auto-merge la integra cuando pase.` };
  }
  const nums = [...new Set([...(cierra || [])].map(String))].sort((a, b) => Number(a) - Number(b));
  if (nums.length > 1) {
    return { ok: false, motivo: `Esta peticion cerraria ${nums.length} issues (${nums.map((n) => `#${n}`).join(', ')}). Un PR por issue: abre una rama por cada una (harness.js rama <tipo> "<desc>" --issue <N>) y deja en esta solo la suya.` };
  }
  return { ok: true };
}

module.exports = {
  DEFECTO, METODOS, TIPOS, ALIAS_RAMA,
  config, leerConfig, ramaValida, tipoDeRama, analizarTitulo, tituloConventional, bumpDe, siguienteVersion, avisoRetirado, basesCandidatas, validarPeticion,
};
