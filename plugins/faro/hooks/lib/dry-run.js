// lib/dry-run.js — POLITICA del simulacro de despliegue (#182). `wrangler deploy --dry-run` es de los trabajos mas caros
// de los gates y casi nunca aporta nada cuando el cambio es logica interior: SOLO corre
//   · al publicar (`gates --todas`, que es lo que piden consolidar y publicar) o si se fuerza (`--simulacro`), o
//   · si el cambio toca algo que afecta al despliegue de ESA app: su wrangler.* (donde viven los bindings), su
//     punto de entrada (`main` del wrangler), el package.json de la app o de una dependencia de workspace suya,
//     o los ficheros de dependencias/lockfile de la raiz.
// Funcion pura (sin disco ni git): recibe los ficheros cambiados.
'use strict';

const RAIZ_DEPENDENCIAS = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package-lock.json', 'yarn.lock']);
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

/** Entrada `main` de un wrangler.jsonc/json (objeto ya parseado) o wrangler.toml (texto). → ruta relativa a la app | null. */
function entrypoint(cfg, tomlTexto) {
  if (cfg && typeof cfg.main === 'string' && cfg.main.trim()) return norm(cfg.main.trim());
  const m = typeof tomlTexto === 'string' && tomlTexto.match(/^\s*main\s*=\s*["']([^"'\n]+)["']/m);
  return m ? norm(m[1]) : null;
}

/**
 * ¿Hay que simular el despliegue de esta app?
 * op: { publicar, forzar, ficheros: [rutas desde la raiz del repo] | null (sin base), rutaApp ('' = raiz), entrypoint, depsRutas: [rutas de apps/paquetes de las que depende] }
 * → { si: boolean, motivo: string (una linea) }
 */
function debeSimular(op) {
  if (op.publicar) return { si: true, motivo: 'al publicar' };
  if (op.forzar) return { si: true, motivo: 'forzado con --simulacro' };
  if (!Array.isArray(op.ficheros)) return { si: true, motivo: 'no hay rama base con la que comparar' };
  const app = norm(op.rutaApp || '').replace(/\/$/, '');
  const dentro = (f) => (app ? (f.startsWith(`${app}/`) ? f.slice(app.length + 1) : null) : f);
  const entrada = op.entrypoint ? norm(op.entrypoint) : null;
  const deps = (op.depsRutas || []).map((d) => norm(d).replace(/\/$/, ''));
  for (const f0 of op.ficheros) {
    const f = norm(f0);
    if (RAIZ_DEPENDENCIAS.has(f)) return { si: true, motivo: `cambia ${f} de la raíz (dependencias)` };
    const rel = dentro(f);
    if (rel !== null) {
      if (/^wrangler(\.[\w-]+)?\.(jsonc?|toml)$/.test(rel)) return { si: true, motivo: `cambia ${f} (bindings y configuración del despliegue)` };
      if (rel === 'package.json') return { si: true, motivo: `cambia ${f} (dependencias)` };
      if (entrada && rel === entrada) return { si: true, motivo: `cambia el punto de entrada ${f}` };
    }
    for (const d of deps) if (f === `${d}/package.json`) return { si: true, motivo: `cambia ${f} (dependencia de workspace)` };
  }
  return { si: false, motivo: 'ningún cambio afecta al despliegue (wrangler.*, bindings, entrypoint, dependencias); corre al publicar o con --simulacro' };
}

module.exports = { debeSimular, entrypoint };
