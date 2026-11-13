// lib/grafo/sombra.js — consumidores en modo sombra del grafo FARO (#298, T5).
//
// Los consumidores viejos (dominios.grafo, grafo.js) siguen devolviendo su resultado de siempre. Aqui se
// COMPARA ese resultado con el del indice nuevo y se deja la diferencia en `<indice>.sombra.json`, para
// que `validate` avise y se pueda decidir la migracion con datos. Todo es opcional: nada de esto cambia
// un valor devuelto ni lanza.
//
// En caliente (hooks): si la sombra existe y no es mas vieja que el indice, no se hace NADA mas (ni
// cargar, ni fresco, ni comparar). Sin indice no se crea nada. No se escribe a traves de enlaces.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const I = require('./indice.js');

const SUFIJO = '.sombra.json';

const pares = (g) => {
  const out = new Set();
  for (const [d, hs] of ((g && g.aristas) || new Map())) for (const h of hs) out.add(`${d}\0${h}`);
  return out;
};
const aPar = (k) => k.split('\0');

/** Diferencia entre dos grafos {aristas: Map<desde, Set<hasta>>}: listas ordenadas de [desde, hasta]. */
function comparar(viejo, nuevo) {
  const v = pares(viejo);
  const n = pares(nuevo);
  return {
    soloViejo: [...v].filter((k) => !n.has(k)).sort().map(aPar),
    soloNuevo: [...n].filter((k) => !v.has(k)).sort().map(aPar),
  };
}

/** Escribe `texto` en `ruta` de forma atomica y sin seguir enlaces. false si no se pudo. */
function escribirAtomico(root, ruta, texto) {
  const dir = path.dirname(ruta);
  if (!I.dirSinEnlaces(root, dir)) return false;
  fs.mkdirSync(dir, { recursive: true });
  if (fs.lstatSync(dir).isSymbolicLink()) return false;
  try { if (fs.lstatSync(ruta).isSymbolicLink()) return false; } catch { /* no existe: bien */ }
  const tmp = `${ruta}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, texto, { flag: 'wx' });
    fs.renameSync(tmp, ruta);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nada */ }
    throw e;
  }
  return true;
}

/**
 * Compara `viejo` (el grafo que el consumidor ya calculo) con el del indice y guarda la sombra.
 * Nunca lanza ni devuelve nada util: es un efecto lateral opcional. opts.sufijo cambia el nombre del fichero.
 */
function registrar(root, viejo, opts = {}) {
  try {
    const ip = I.rutaIndice(root);
    const sp = ip + (opts.sufijo || SUFIJO);
    let ist;
    try { ist = fs.lstatSync(ip); } catch { return; } // sin indice: no se crea nada
    if (!ist.isFile()) return;
    try { const sst = fs.lstatSync(sp); if (sst.isFile() && sst.mtimeMs >= ist.mtimeMs) return; } catch { /* sin sombra */ }
    const idx = I.cargar(root);
    if (!idx) return;
    if (!I.fresco(root, idx)) {
      // Marca de caducado: la guarda por mtime corta las llamadas siguientes hasta que cambie el indice.
      escribirAtomico(root, sp, JSON.stringify({ generado: new Date().toISOString(), indiceMtime: ist.mtimeMs, noFresco: true }));
      return;
    }
    const { soloViejo, soloNuevo } = comparar(viejo, I.aristas(idx));
    escribirAtomico(root, sp, JSON.stringify({ generado: new Date().toISOString(), indiceMtime: ist.mtimeMs, soloViejo, soloNuevo }));
  } catch { /* la sombra nunca molesta */ }
}

/** Sombra ya guardada y vigente: {soloViejo, soloNuevo} o null (sin indice, obsoleta, noFresco, sin sombra o ilegible). */
function leer(root, sufijo = SUFIJO) {
  try {
    const ip = I.rutaIndice(root);
    const p = ip + sufijo;
    const ist = fs.lstatSync(ip); // sin indice: nada que avisar
    if (!ist.isFile() || !fs.lstatSync(p).isFile()) return null;
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!s || s.noFresco || s.indiceMtime !== ist.mtimeMs) return null; // caducada u obsoleta
    if (!Array.isArray(s.soloViejo) || !Array.isArray(s.soloNuevo)) return null;
    return s;
  } catch { return null; }
}

module.exports = { comparar, registrar, leer, SUFIJO };
