// lib/hexagonal-fuentes.js — ADAPTADOR de disco de la verificacion hexagonal (#280).
//
// Lee el contrato (ARCHITECTURE.md de la base) y el codigo de la base, ya extraido por lenguaje, y se
// lo entrega al dominio (lib/hexagonal.js) con rutas relativas a esa base: la raiz del repo, o la
// carpeta de la app en un monorepo. Excluye lo que no es codigo del equipo con la misma lista que el
// resto de senales de salud (lib/generados.js).
'use strict';

const generados = require('./generados.js');
const LENG = require('./hexagonal-lenguajes.js');

const SALTAR = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', '.git', 'faro', 'gestion', 'documentos', 'fuentes', 'flujos', 'borrador']);

module.exports = function ({ fs, path, ROOT }) {
  // base: '' (raiz) o 'apps/<x>'. Devuelve { arquitectura: texto|null, ficheros: [{ rel, lenguaje, imports, es }] }.
  function leerBase(base) {
    let arquitectura = null;
    try { arquitectura = fs.readFileSync(path.join(ROOT, base, 'ARCHITECTURE.md'), 'utf8'); } catch { /* sin contrato */ }
    const rels = [];
    (function rec(dir, depth) {
      if (depth > 12) return;
      let entradas;
      try { entradas = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
      for (const e of entradas) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.name.startsWith('.') || generados.excluidoPorRuta(rel)) continue;
        if (e.isDirectory()) {
          // En un monorepo, la raiz no se mete en las apps: cada una se mide con su propio contrato.
          if (!SALTAR.has(e.name) && !(dir === base && !base && (e.name === 'apps' || e.name === 'packages'))) rec(rel, depth + 1);
        } else if (LENG.lenguajeDe(e.name)) rels.push(rel);
      }
    })(base, 0);
    const ficheros = [];
    for (const rel of generados.depurar(ROOT, rels, fs, path)) {
      let texto = '';
      try { texto = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
      const relBase = base ? rel.slice(base.length + 1) : rel;
      ficheros.push({ rel: relBase, ...LENG.extraer(relBase, texto) });
    }
    return { arquitectura, ficheros };
  }
  return { leerBase };
};
