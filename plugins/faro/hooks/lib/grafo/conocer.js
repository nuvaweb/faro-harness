// lib/grafo/conocer.js — `harness.js conocer` (#303): arranca el conocimiento de un repo en un comando.
//
//   1. construye el indice (incremental, el mismo construirYGuardar de `grafo construir`);
//   2. si hay forja (puerto de forja-conocer.js), lee bajo demanda los comentarios de revision de las
//      ultimas 50 peticiones integradas y los ultimos 50 bugs cerrados;
//   3. mina las fuentes locales y lo leido de la forja con el MISMO filtro (minado.minar: mascaras,
//      descarte por secreto, id estable, _estado.json). Un candidato existente no se reescribe;
//   4. resume: ficheros, aristas, aprendizajes vigentes, candidatos por revisar y los 5 mejores.
// Sin forja (sin token o no soportada) lo dice en una linea; un error de red tambien se omite con una
// linea. Dos ejecuciones seguidas dejan el mismo estado (idempotente). Nunca escribe aprendizajes.
//
// Ademas, lo barato para la sesion y la statusline: lineasSesion() y segmentoStatus() solo hacen
// lstat/readdir y leen ficheros pequenos (el resumen del indice y _estado.json).
'use strict';

const fs = require('fs');
const path = require('path');
const I = require('./indice.js');
const M = require('./minado.js');

const N_FORJA = 50;
const UNA_HORA = 3600 * 1000;
const TOPE_RESUMEN = 4096;
// Lo de la forja puntua por debajo de cualquier senal local (la minima local es 2).
const PUNTOS_FORJA = 1.5;
const SIN_FORJA = 'forja: sin token o no soportada — se omite';

const limpia = (s) => String(s || '').replace(/[\r\n\t\0]+/g, ' ').trim();

/** Senales de la forja con la forma de minado: { fuente, tipo_sugerido, toca, texto, puntuacion }. */
async function senalesForja(root, forja, idx, out) {
  if (!forja) { out(SIN_FORJA); return []; }
  // Solo rels que existen en el indice y sin caracteres de control: la forja no decide que se `toca`.
  const valida = (r) => typeof r === 'string' && !/[\u0000-\u001f\u007f]/.test(r) && Object.prototype.hasOwnProperty.call(idx.ficheros, r);
  const enIndice = (texto) => M.rutasEn(root, texto).filter(valida);
  try {
    const revs = await forja.revisiones(N_FORJA);
    const bugs = await forja.bugsCerrados(N_FORJA);
    const xs = [];
    let ncom = 0;
    for (const r of Array.isArray(revs) ? revs : []) {
      const marca = r.tipo === 'MR' ? `MR!${r.numero}` : `PR#${r.numero}`;
      for (const c of Array.isArray(r.comentarios) ? r.comentarios : []) {
        ncom++;
        const delPr = [...(c.ruta ? [c.ruta] : []), ...(Array.isArray(r.ficheros) ? r.ficheros : [])].filter(valida);
        const toca = delPr.length ? [...new Set(delPr)] : enIndice(c.texto);
        xs.push({ fuente: { tipo: 'revision', ref: `${marca}/${c.id}`, externa: true }, tipo_sugerido: 'cuidado', toca, texto: `revisión en ${marca}: ${c.texto}`, puntuacion: PUNTOS_FORJA });
      }
    }
    for (const b of Array.isArray(bugs) ? bugs : []) {
      const texto = `${b.titulo}\n${b.texto}`;
      const toca = enIndice(texto);
      xs.push({ fuente: { tipo: 'bug', ref: `#${b.numero}`, externa: true }, tipo_sugerido: 'cuidado', toca, texto: `bug #${b.numero}: ${b.titulo} — ${b.texto}`, puntuacion: toca.length ? PUNTOS_FORJA : 1 });
    }
    out(`forja: ${ncom} comentarios de revisión · ${Array.isArray(bugs) ? bugs.length : 0} bugs cerrados leídos`);
    return xs;
  } catch (e) {
    if (e && e.sinToken) out(SIN_FORJA);
    else out(`forja: no se pudo leer (${limpia(e && e.message).slice(0, 80) || 'error'}) — se omite`);
    return [];
  }
}

async function conocer(root, { home, ahora = Date.now, forja = null, out = console.log } = {}) {
  const { construirYGuardar, aristasN } = require('./cli.js');
  const r = construirYGuardar(root, ahora, { explicito: true });
  if (!r.guardado) out('grafo: no se pudo guardar el índice (supera 20 MB o la ruta no es segura)');
  const extra = await senalesForja(root, forja, r.idx, out);
  let nuevos = 0;
  try { nuevos = M.minar(root, { ahora, extra, ...(home ? { home } : {}) }).nuevos; } catch { out('conocer: el minado falló — se omite'); }
  const vig = require('./aprendizajes.js').vigentes(root).length;
  const pend = M.pendientes(root);
  if (nuevos) out(`minado: ${nuevos} candidatos nuevos`);
  out(`conocer: ${Object.keys(r.idx.ficheros).length} ficheros · ${aristasN(r.idx)} aristas · ${vig} aprendizajes vigentes · ${pend.length} candidatos por revisar`);
  const { lineaCandidato } = require('./aprender-cli.js');
  for (const c of pend.slice(0, 5)) out(lineaCandidato(c));
  return 0;
}

async function cli(argv, { root, out = console.log, ahora = Date.now, home, forja = null } = {}) {
  if (argv && argv.length && argv[0] !== '') { out('Uso: harness.js conocer'); return 2; }
  try { return await conocer(root, { out, ahora, home, forja }); } catch (e) { out(`conocer: error — ${limpia(e && e.message)}`); return 1; }
}

// ---------- sesion y statusline (baratos) ----------

/** ['hay N aprendizajes por revisar: /faro:aprender'] si hay candidatos pendientes; [] si no. */
function lineasSesion(root) {
  try {
    const n = M.contarPendientes(root);
    return n ? [`hay ${n} aprendizajes por revisar: /faro:aprender`] : [];
  } catch { return []; }
}

/** mtime del index de git (cambia con add/commit/checkout; en un worktree, el de su gitdir) o 0 si no se sabe. */
function mtimeGitIndex(root) {
  try { return fs.statSync(path.join(I.gitDir(root), 'index')).mtimeMs; } catch { return 0; }
}

/**
 * Segmento de statusline `◈ <F>f/<A>a ✓|~[ · N por revisar]`, o null. Lee solo el resumen del indice
 * (nunca el indice). Fresco (✓) = generado hace menos de 1 h y no anterior al ultimo cambio de .git/index.
 */
function segmentoStatus(root, ahora = Date.now) {
  try {
    const ri = I.rutaIndice(root);
    if (!fs.lstatSync(ri).isFile()) return null;
    const rp = `${ri}.resumen.json`;
    const st = fs.lstatSync(rp);
    if (!st.isFile() || st.size > TOPE_RESUMEN) return null;
    const res = JSON.parse(fs.readFileSync(rp, 'utf8'));
    if (!res || !Number.isInteger(res.ficheros) || !Number.isInteger(res.aristas)) return null;
    const gen = Date.parse(res.generado);
    const t = ahora();
    const fresco = Number.isFinite(gen) && t >= gen - 1000 && t - gen < UNA_HORA && mtimeGitIndex(root) <= gen + 1000;
    const n = M.contarPendientes(root);
    return `◈ ${res.ficheros}f/${res.aristas}a ${fresco ? '✓' : '~'}${n ? ` · ${n} por revisar` : ''}`;
  } catch { return null; }
}

module.exports = { conocer, cli, lineasSesion, segmentoStatus, SIN_FORJA };
