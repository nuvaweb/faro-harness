// lib/referencias.js — ESTANDAR DE REFERENCIAS (#157): la forma unica de citar un registro.
//
// Los patrones viven UNA vez, en faro-schema.json > referencias. Este modulo solo los compila y
// ofrece tres funciones puras:
//   tipoDe(texto)    -> 'fase'|'tarea'|'cambio'|'req'|'riesgo'|'app'|'doc'|null
//   normalizar(texto)-> la forma canonica ('req-136' -> 'REQ-136') o null si no es referencia
//   analizar(texto)  -> {tipo, ref, id} | null     (id: lo que identifica; para tarea '7' o 'L-3')
//
// SEGURIDAD: una referencia llega por argumento y acaba formando rutas (gestion/tareas/<id>.json,
// changes/<slug>/). Por eso SOLO se acepta lo que casa con un patron estricto (sin '.', '/', '\\',
// espacios ni ';'), recortado a 'max' caracteres. Nada de lo que no casa llega a tocar disco.
'use strict';
const fs = require('fs');
const path = require('path');

let _def = null;
function definicion() {
  if (_def) return _def;
  const bloque = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'faro-schema.json'), 'utf8')).referencias;
  const tipos = {};
  for (const nombre of bloque.orden) {
    const t = bloque.tipos[nombre];
    tipos[nombre] = { ...t, re: new RegExp(t.patron) };
  }
  _def = { max: bloque.max, orden: bloque.orden, tipos };
  return _def;
}

// Forma canonica previa a casar: segun 'canon' del tipo.
function aCanon(tipo, t) {
  if (tipo.canon === 'minusculas') return t.toLowerCase();
  if (tipo.canon === 'mayusculas') return t.toUpperCase();
  return t.replace(/^app:/i, 'app:');   // tal-cual: solo el prefijo es insensible a mayusculas
}

/** {tipo, ref, id} o null. */
function analizar(texto) {
  if (typeof texto !== 'string') return null;
  const t = texto.trim();
  const def = definicion();
  if (!t || t.length > def.max) return null;
  for (const nombre of def.orden) {
    const tipo = def.tipos[nombre];
    const c = aCanon(tipo, t);
    const m = tipo.re.exec(c);
    if (!m) continue;
    let id = m.slice(1).find((g) => g !== undefined);
    if (nombre === 'tarea' && m[2] !== undefined) id = `L-${m[2]}`;
    if (nombre === 'doc') id = c;
    return { tipo: nombre, ref: c, id };
  }
  return null;
}

const tipoDe = (texto) => { const a = analizar(texto); return a ? a.tipo : null; };
const normalizar = (texto) => { const a = analizar(texto); return a ? a.ref : null; };

/** Ejemplos por tipo, para mensajes de ayuda: "fase:2 · #149 · cambio:..." */
function ejemplos() { const d = definicion(); return d.orden.map((n) => d.tipos[n].ejemplo); }

module.exports = { analizar, tipoDe, normalizar, ejemplos, definicion };
