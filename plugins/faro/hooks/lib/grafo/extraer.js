// lib/grafo/extraer.js — EXTRACTOR unificado por lenguaje del grafo FARO (#298; nacio como los
// adaptadores de la verificacion hexagonal, #280).
//
// Cada lenguaje sabe sacar de un texto: sus IMPORTS (spec tal cual se escribe y linea), sus usos de E/S
// que no pasan por un import (fetch, process.env, open(), os.environ), lo que EXPORTA y, en SQL, las
// tablas que define y usa. Lo que significa cada import —interno, del sistema, externo— lo decide el
// dominio (lib/hexagonal.js), no esto.
//
// Para anadir un lenguaje: una entrada en LENGUAJES. Sin entrada, el fichero no se juzga.
'use strict';

// Borra comentarios conservando los saltos de linea, para que los numeros de linea sigan valiendo.
// El '//' de linea solo cuenta tras inicio o espacio: 'https://x' no es un comentario.
const sinComentariosJs = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/.*$/gm, '$1');
const sinComentariosPy = (t) => t.replace(/(^|\s)#.*$/gm, '$1');
const sinComentariosSql = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/--.*$/gm, '');
const lineaDe = (texto, idx) => texto.slice(0, idx).split('\n').length;
const porLinea = (a, b) => a.linea - b.linea;

function buscar(texto, re, aEntrada) {
  const out = [];
  for (const m of texto.matchAll(re)) out.push(...[].concat(aEntrada(m, lineaDe(texto, m.index + (m[0].length - m[0].trimStart().length)))));
  return out;
}

// Idioma del motor: path.join|resolve(__dirname, 'a', 'b.js') es un import './a/b.js'.
const RE_JOIN = /path\.(?:join|resolve)\s*\(\s*__dirname\s*,\s*((?:['"][^'"]+['"]\s*,\s*)*['"][^'"]+['"])\s*\)/g;
const segmentosDe = (grupo) => [...grupo.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);

// 'f, g: x, ...r' -> ['f','g'] (el nombre exportado es la clave).
const claves = (lista) => lista.split(',').map((s) => (s.trim().match(/^([\w$]+)/) || [])[1]).filter(Boolean);

const JS = {
  extensiones: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts'],
  extraer(texto) {
    const t = sinComentariosJs(texto);
    const imports = [
      ...buscar(t, /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^[ \t]*import\s+)(['"])([^'"\n]+)\1/gm,
        (m, linea) => ({ spec: m[2], linea })),
      ...buscar(t, RE_JOIN, (m, linea) => ({ spec: './' + segmentosDe(m[1]).join('/'), linea })),
    ].sort(porLinea);
    const es = [
      ...buscar(t, /\bfetch\s*\(/g, (m, linea) => ({ uso: 'fetch()', linea })),
      ...buscar(t, /\bprocess\.env\b/g, (m, linea) => ({ uso: 'process.env', linea })),
      ...buscar(t, /\bnew\s+(XMLHttpRequest|WebSocket)\b/g, (m, linea) => ({ uso: m[1], linea })),
    ];
    const exporta = [
      ...buscar(t, /^[ \t]*export\s+(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([\w$]+)/gm,
        (m, linea) => ({ nombre: m[1], linea })),
      ...buscar(t, /^[ \t]*export\s+default\b/gm, (m, linea) => ({ nombre: 'default', linea })),
      ...buscar(t, /^[ \t]*export\s*\{([^}]*)\}/gm,
        (m, linea) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).map((nombre) => ({ nombre, linea }))),
      ...buscar(t, /\bmodule\.exports\s*=\s*\{([^}]*)\}/g, (m, linea) => claves(m[1]).map((nombre) => ({ nombre, linea }))),
      ...buscar(t, /\b(?:module\.)?exports\.([\w$]+)\s*=/g, (m, linea) => ({ nombre: m[1], linea })),
    ].sort(porLinea);
    return { imports, es, exporta };
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
    // Solo el nivel superior (columna 0): lo anidado no se exporta.
    const exporta = [
      ...buscar(t, /^(?:async[ \t]+)?def[ \t]+(\w+)/gm, (m, linea) => ({ nombre: m[1], linea })),
      ...buscar(t, /^class[ \t]+(\w+)/gm, (m, linea) => ({ nombre: m[1], linea })),
      ...buscar(t, /^__all__[ \t]*=[ \t]*[[(]([^\])]*)[\])]/gm,
        (m, linea) => [...m[1].matchAll(/['"](\w+)['"]/g)].map((x) => ({ nombre: x[1], linea }))),
    ].sort(porLinea);
    return { imports, es, exporta };
  },
};

// SQL: solo cuenta bajo una carpeta de migraciones (migrations/migraciones/db); da tablas, no imports.
const NOMBRE_TABLA = '([`"\\[]?[\\w.]+[`"\\]]?)';
const limpiaNombre = (s) => s.replace(/[`"[\]]/g, '');
const SQL = {
  extensiones: ['.sql'],
  aplica: (rel) => /(^|\/)(migrations|migraciones|db)\//.test(rel.replace(/\\/g, '/').toLowerCase()),
  extraer(texto) {
    const t = sinComentariosSql(texto);
    const tabla = (m, linea) => ({ nombre: limpiaNombre(m[1]), linea });
    const define = buscar(t, new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?(?:(?:temp|temporary|unlogged)\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${NOMBRE_TABLA}`, 'gi'), tabla);
    const usa = [
      ...buscar(t, new RegExp(`\\breferences\\s+${NOMBRE_TABLA}\\s*\\(`, 'gi'), tabla),
      ...buscar(t, new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${NOMBRE_TABLA}`, 'gi'), tabla),
    ].sort(porLinea);
    return { imports: [], es: [], exporta: [], tablas: { define, usa } };
  },
};

const LENGUAJES = { js: JS, py: PY, sql: SQL };
const extensiones = Object.values(LENGUAJES).flatMap((l) => l.extensiones);

function lenguajeDe(rel) {
  const r = rel.toLowerCase();
  for (const [id, l] of Object.entries(LENGUAJES)) {
    if (l.extensiones.some((e) => r.endsWith(e)) && !/\.d\.[cm]?ts$/.test(r) && (!l.aplica || l.aplica(rel))) return id;
  }
  return null;
}

// { lenguaje, imports, es, exporta, tablas } de un fichero; lenguaje null si no hay extractor para el.
// El texto se normaliza a LF para que CRLF de las mismas lineas y aristas.
function extraer(rel, texto) {
  const lenguaje = lenguajeDe(rel);
  const vacio = { imports: [], es: [], exporta: [], tablas: { define: [], usa: [] } };
  if (!lenguaje) return { lenguaje: null, ...vacio };
  const r = LENGUAJES[lenguaje].extraer(String(texto || '').replace(/\r\n?/g, '\n'));
  return { lenguaje, ...vacio, ...r };
}

module.exports = { extraer, lenguajeDe, extensiones, RE_JOIN, segmentosDe };
