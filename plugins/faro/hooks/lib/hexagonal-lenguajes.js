// lib/hexagonal-lenguajes.js — ADAPTADORES por lenguaje de la verificacion hexagonal (#280).
//
// Cada lenguaje sabe sacar de un texto dos cosas: sus IMPORTS (spec tal cual se escribe y linea) y
// sus usos de E/S que no pasan por un import (fetch, process.env, open(), os.environ). Lo que significa
// cada import —interno, del sistema, externo— lo decide el dominio (lib/hexagonal.js), no esto.
//
// Para anadir un lenguaje: una entrada en LENGUAJES. Sin entrada, el fichero no se juzga.
'use strict';

// Borra comentarios conservando los saltos de linea, para que los numeros de linea sigan valiendo.
// El '//' de linea solo cuenta tras inicio o espacio: 'https://x' no es un comentario.
const sinComentariosJs = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/.*$/gm, '$1');
const sinComentariosPy = (t) => t.replace(/(^|\s)#.*$/gm, '$1');
const lineaDe = (texto, idx) => texto.slice(0, idx).split('\n').length;

function buscar(texto, re, aEntrada) {
  const out = [];
  for (const m of texto.matchAll(re)) out.push(...[].concat(aEntrada(m, lineaDe(texto, m.index + (m[0].length - m[0].trimStart().length)))));
  return out;
}

const JS = {
  extensiones: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts'],
  extraer(texto) {
    const t = sinComentariosJs(texto);
    const imports = buscar(t, /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^[ \t]*import\s+)(['"])([^'"\n]+)\1/gm,
      (m, linea) => ({ spec: m[2], linea }));
    const es = [
      ...buscar(t, /\bfetch\s*\(/g, (m, linea) => ({ uso: 'fetch()', linea })),
      ...buscar(t, /\bprocess\.env\b/g, (m, linea) => ({ uso: 'process.env', linea })),
      ...buscar(t, /\bnew\s+(XMLHttpRequest|WebSocket)\b/g, (m, linea) => ({ uso: m[1], linea })),
    ];
    return { imports, es };
  },
};

const PY = {
  extensiones: ['.py'],
  extraer(texto) {
    const t = sinComentariosPy(texto);
    const imports = [
      ...buscar(t, /^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm,
        (m, linea) => m[1].split(',').map((s) => ({ spec: s.trim(), linea }))),
      // 'from .. import db' no nombra el modulo: el destino es cada nombre importado ('..db').
      ...buscar(t, /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+\(?([\w ,*]+)/gm, (m, linea) => (m[2]
        ? [{ spec: m[1] + m[2], linea }]
        : m[3].split(',').map((s) => s.trim().split(/\s+/)[0]).filter((s) => s && s !== '*').map((n) => ({ spec: m[1] + n, linea })))),
    ];
    const es = [
      ...buscar(t, /(?<![\w.])open\s*\(/g, (m, linea) => ({ uso: 'open()', linea })),
      ...buscar(t, /\bos\.(environ|getenv)\b/g, (m, linea) => ({ uso: `os.${m[1]}`, linea })),
    ];
    return { imports, es };
  },
};

const LENGUAJES = { js: JS, py: PY };
const extensiones = Object.values(LENGUAJES).flatMap((l) => l.extensiones);

function lenguajeDe(rel) {
  const r = rel.toLowerCase();
  for (const [id, l] of Object.entries(LENGUAJES)) if (l.extensiones.some((e) => r.endsWith(e)) && !/\.d\.[cm]?ts$/.test(r)) return id;
  return null;
}

// { lenguaje, imports, es } de un fichero; lenguaje null si no hay extractor para el.
function extraer(rel, texto) {
  const lenguaje = lenguajeDe(rel);
  if (!lenguaje) return { lenguaje: null, imports: [], es: [] };
  return { lenguaje, ...LENGUAJES[lenguaje].extraer(String(texto || '')) };
}

module.exports = { extraer, lenguajeDe, extensiones };
