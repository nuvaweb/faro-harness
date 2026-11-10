// lib/config-repo.js — LECTOR Y ESCRITOR UNICO de la configuracion del repo (#293).
//
// La configuracion vive en faro/config.json (layout nuevo) o en .faro.json (layout antiguo, sin
// migrar). Quien la lea o la escriba pasa por aqui: la ruta la decide lib/paths.js, no cada lib.
// NO es ~/.faro.json (el almacen de credenciales del usuario, fuera del repo): eso es credenciales.js.
'use strict';
const fs = require('fs');
const path = require('path');
const paths = require('./paths.js');
const { escribirJsonAtomico } = require('./json-seguro.js');

/** Ruta relativa de la configuracion segun el layout ('faro/config.json' | '.faro.json'). */
const ruta = (root) => paths(root).CONFIG;
const rutaAbs = (root) => path.join(root, ruta(root));
const existe = (root) => fs.existsSync(rutaAbs(root));

/** La configuracion como objeto. Ausente, corrupta o no-objeto -> {} (quien llama no debe reventar). */
function leer(root) {
  try {
    const j = JSON.parse(fs.readFileSync(rutaAbs(root), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

/** Escribe la configuracion entera (atomico). Crea faro/ si hace falta. */
function escribir(root, datos) {
  const abs = rutaAbs(root);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!escribirJsonAtomico(abs, datos, 0o644)) throw new Error(`No se pudo escribir ${ruta(root)}.`);
}

/** Fusiona claves de primer nivel con lo que hay. Si el fichero existe y no es JSON, NO lo pisa: lanza. */
function fusionar(root, cambios) {
  const abs = rutaAbs(root);
  let actual = {};
  if (fs.existsSync(abs)) {
    try { actual = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { throw new Error(`${ruta(root)} no es JSON válido: no se toca.`); }
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) throw new Error(`${ruta(root)} no es un objeto JSON: no se toca.`);
  }
  const nuevo = { ...actual, ...cambios };
  escribir(root, nuevo);
  return nuevo;
}

module.exports = { ruta, rutaAbs, existe, leer, escribir, fusionar };
