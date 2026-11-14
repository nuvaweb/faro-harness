#!/usr/bin/env node
// bench/grafo/comprobar.js — comprobación de las tareas «responde en RESPUESTA.md» del banco (#308).
//   node {base}/comprobar.js <regex> [<regex>…]   → sale 0 si RESPUESTA.md (en el cwd) casa con TODAS.
// Las expresiones no distinguen mayúsculas. Imprime las que faltan para que el informe diga por qué falló.
'use strict';
const fs = require('fs');

let t = '';
try { t = fs.readFileSync('RESPUESTA.md', 'utf8'); } catch { console.log('falta RESPUESTA.md'); process.exit(1); }
const faltan = process.argv.slice(2).filter((p) => !new RegExp(p, 'i').test(t));
if (faltan.length) { console.log(`no aparece: ${faltan.join(' · ')}`); process.exit(1); }
console.log('ok');
