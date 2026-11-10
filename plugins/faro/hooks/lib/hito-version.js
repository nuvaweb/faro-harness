// lib/hito-version.js — en el MOTOR, el hito de un issue es la VERSION en curso, no una fase (#134).
//
// El repo del plugin no tiene ESTADO.md ni faseo: lo que se planifica son versiones ('0.56', '1.0').
// Sin esto, 'asignar-tarea' en el motor creaba el issue SIN hito (no hay fases que exigir) y habia
// que acordarse de colgarlo a mano. Ahora se ancla solo, con este criterio:
//
//   1. Candidatos = hitos ABIERTOS cuyo titulo es una version ('X.Y' o 'X.Y.Z').
//   2. Se descartan los que quedan POR DEBAJO de la version en curso (plugin.json): un hito '0.56'
//      abierto con el plugin en 0.59.1 es un hito olvidado, no donde va el trabajo nuevo.
//      Un hito 'X.Y' cubre todas las X.Y.* (con 0.59.1, '0.59' sigue siendo el de la version en curso).
//   3. De los que quedan, el MAS PROXIMO (la version menor). Con '0.59' abierto, '0.59'; si no hay
//      '0.59' pero si '1.0', va a '1.0': el trabajo ya se esta planificando para esa version y crear
//      un '0.59' suelto lo dispersaria.
//   4. Si no hay ninguno, se crea 'X.Y' de la version en curso.
//
// Funcion pura (sin red): el llamador le pasa la lista de hitos de la forja.
'use strict';
const fs = require('fs');
const path = require('path');

const RE_VERSION = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/;

/** '0.59.1' -> [0, 59, 1]; '1.0' -> [1, 0] ; no-version -> null. */
function partes(v) {
  const m = String(v || '').trim().match(RE_VERSION);
  if (!m) return null;
  return m[3] === undefined ? [Number(m[1]), Number(m[2])] : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compara dos listas de partes de la misma longitud: <0, 0, >0. */
function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** ¿El repo es el MOTOR (fuente del plugin y su marketplace)? */
function esMotor(root) {
  if (!root) return false;
  try {
    return fs.existsSync(path.join(root, '.claude-plugin', 'marketplace.json')) &&
      fs.existsSync(path.join(root, 'plugins', 'faro', '.claude-plugin', 'plugin.json'));
  } catch { return false; }
}

/** Version en curso del motor (plugins/faro/.claude-plugin/plugin.json) o null. */
function versionMotor(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'plugins', 'faro', '.claude-plugin', 'plugin.json'), 'utf8')).version || null; } catch { return null; }
}

/** 'X.Y' de una version (titulo del hito que se crearia). */
function tituloDeVersion(version) {
  const p = partes(version);
  return p ? `${p[0]}.${p[1]}` : null;
}

/**
 * Elige el hito de la version en curso.
 * @param {string} version  version del plugin ('0.59.1')
 * @param {Array<{number,title,state}>} lista  hitos de la forja (cualquier estado)
 * @returns {{titulo, numero, crear, motivo, olvidados: string[]} | null}  null si la version no se entiende
 */
function elegirHitoVersion(version, lista) {
  const actual = partes(version);
  if (!actual) return null;
  const abiertos = (lista || []).filter((m) => m && String(m.state || 'open') === 'open' && partes(m.title));
  const olvidados = [];
  const validos = [];
  for (const m of abiertos) {
    const pm = partes(m.title);
    // Se compara con la PRECISION del hito: '0.59' frente a 0.59 (no a 0.59.1).
    if (cmp(pm, actual.slice(0, pm.length)) < 0) olvidados.push(m.title);
    else validos.push({ m, pm });
  }
  validos.sort((a, b) => cmp(a.pm, b.pm) || a.pm.length - b.pm.length);
  const xy = tituloDeVersion(version);
  if (validos.length) {
    const { m } = validos[0];
    const motivo = String(m.title) === xy
      ? `hito de la version en curso (${version})`
      : `hito abierto mas proximo a la version en curso (${version}); no hay '${xy}' abierto`;
    return { titulo: m.title, numero: m.number, crear: false, motivo, olvidados };
  }
  return { titulo: xy, numero: null, crear: true, motivo: `no hay hito abierto de la version en curso (${version}) ni posterior: se crea '${xy}'`, olvidados };
}

module.exports = { esMotor, versionMotor, tituloDeVersion, elegirHitoVersion, RE_VERSION };
