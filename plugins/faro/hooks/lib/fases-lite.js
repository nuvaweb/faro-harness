// lib/fases-lite.js — las FASES declaradas en ESTADO.md, leidas sin cargar el motor.
//
// Lo usan los registros de tareas (tareas-json.js: rango de fechas de la fase) y el resumen
// publico (resumen-json.js). El analisis completo de ESTADO.md vive en el harness (parseEstado,
// cableado a su contexto); aqui solo lo imprescindible, con las mismas reglas de cabecera, para
// que `harness.js tarea` y `resumen` no paguen el motor entero.
//
// leerFases(root) -> [{num, nombre, estado, objetivo, inicio}] (objetivo/inicio: 'AAAA-MM-DD'|null)
// cabecera(root)  -> {nombre|null}
'use strict';
const fs = require('fs');
const path = require('path');

const ALIAS = { pendiente: 'pending', por_hacer: 'pending', en_curso: 'in_progress', en_progreso: 'in_progress', activa: 'in_progress', pruebas: 'testing', hecha: 'done', hecho: 'done', completada: 'done', cerrada: 'done' };

function textoEstado(root) {
  for (const f of ['ESTADO.md', 'INICIATIVA.md']) {
    try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { /* siguiente */ }
  }
  return null;
}

function leerFases(root) {
  const text = textoEstado(root);
  if (!text) return [];
  // [ \t] y no \s: con \s un `^` en cada linea en blanco consumia todas las siguientes (coste cuadratico).
  const re = /^###[ \t]+Fase[ \t]+(\d+)[ \t]*[·:][ \t]*(.+?)[ \t]*(?:—|--|-)[ \t]*(\w+)[^\n]*$/gm;
  const cab = [];
  let m;
  while ((m = re.exec(text))) cab.push({ num: Number(m[1]), nombre: m[2].trim(), estado: ALIAS[m[3].toLowerCase()] || m[3].toLowerCase(), start: m.index });
  return cab.map((f, i) => {
    const seg = text.slice(f.start, i + 1 < cab.length ? cab[i + 1].start : text.length);
    const fecha = (clave) => { const x = seg.match(new RegExp(`^\\*{0,4}[ \\t]*${clave}\\*{0,4}[ \\t]*:\\*{0,4}[ \\t]*(\\d{4}-\\d{2}-\\d{2})`, 'mi')); return x ? x[1] : null; };
    return { num: f.num, nombre: f.nombre, estado: f.estado, objetivo: fecha('Objetivo'), inicio: fecha('Inicio') };
  });
}

function cabecera(root) {
  const text = textoEstado(root);
  const fm = text && text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const campo = (k) => { const x = fm && fm[1].match(new RegExp(`^${k}:[ \\t]*(.+?)[ \\t]*$`, 'm')); return x ? x[1].replace(/^["']|["']$/g, '') : null; };
  return { nombre: campo('iniciativa') || campo('nombre') };
}

module.exports = { leerFases, cabecera, textoEstado };
