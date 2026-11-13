// lib/grafo/uso.js — medicion del uso del grafo (#301, T9): contadores por intencion, sin rutas ni textos.
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const I = require('./indice.js');

const rutaUso = (root) => path.join(path.dirname(I.rutaIndice(root)), 'grafo-uso.json');

/** Medicion guardada, o null si falta, es ilegible, es un enlace o es de otra version. */
function leer(root) {
  try {
    const p = rutaUso(root);
    if (!fs.lstatSync(p).isFile()) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && j.version === 1 && j.intenciones && typeof j.intenciones === 'object' ? j : null;
  } catch { return null; }
}

/** Suma una consulta. Nunca lanza: un fallo de medicion no rompe la consulta. */
function registrar(root, { intencion, lineas, ficheros, idx } = {}) {
  try {
    if (typeof intencion !== 'string' || !/^[a-z]+$/.test(intencion)) return false;
    const dir = path.dirname(rutaUso(root));
    if (!I.dirSinEnlaces(root, dir)) return false;
    const nodos = (idx && idx.ficheros) || {};
    let tam = 0;
    for (const rel of ficheros || []) { const t = nodos[rel] && nodos[rel].tam; if (Number.isFinite(t)) tam += Math.round(t / 40); }
    const dev = Math.max(0, Number(lineas) || 0);
    const evitadas = Math.max(0, tam - dev);
    const act = leer(root) || { version: 1, intenciones: {}, desde: new Date().toISOString().slice(0, 10) };
    const e = act.intenciones[intencion] || { n: 0, lineas: 0, evitadas: 0 };
    e.n += 1; e.lineas += dev; e.evitadas += evitadas;
    act.intenciones[intencion] = e;
    fs.mkdirSync(dir, { recursive: true });
    const p = rutaUso(root);
    try { if (fs.lstatSync(p).isSymbolicLink()) return false; } catch { /* no existe */ }
    const tmp = `${p}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(act), { flag: 'wx' });
    fs.renameSync(tmp, p);
    return true;
  } catch { return false; }
}

module.exports = { registrar, leer, rutaUso };
