// layout.mjs — dónde vive lo de FARO en un repo (#293). ESPEJO de plugins/faro/hooks/lib/paths.js
// (el wizard es otro paquete npm y no puede importar el motor): si cambia la detección allí, cambia aquí.
//
// Layout 'faro' (el vigente): todo cuelga de faro/ — faro/{gestion,fuentes,documentos,flujos,borrador,
// notebooks}/, faro/ESTADO.md y faro/config.json (el antiguo .faro.json). En la raíz quedan CLAUDE.md,
// .claude/, README.md y scripts/. Layout 'legado': lo anterior a 2.0, todo en la raíz; se sigue leyendo
// hasta que el repo se migra (`harness.js migrar-layout`). Un repo sin nada de FARO nace 'faro'.
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'faro';
const AREAS = ['gestion', 'fuentes', 'documentos', 'flujos', 'borrador', 'notebooks'];

const existe = (destino, rel) => { try { return fs.existsSync(path.join(destino, rel)); } catch { return false; } };

function detectarLayout(destino) {
  if (['ESTADO.md', 'config.json', 'gestion'].some((f) => existe(destino, `${BASE}/${f}`))) return 'faro';
  if (['ESTADO.md', 'INICIATIVA.md', '.faro.json', 'gestion'].some((f) => existe(destino, f))) return 'legado';
  return 'faro';
}

/** Ruta lógica (la del layout antiguo: 'gestion/x', 'ESTADO.md', '.faro.json') -> ruta física en ese repo. */
function rutaFaro(destino, rel) {
  const r = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (detectarLayout(destino) === 'legado') return r;
  if (r === 'ESTADO.md' || r === 'INICIATIVA.md') return `${BASE}/ESTADO.md`;
  // migración a medias: si la config sigue en .faro.json, se lee ahí (misma regla que el motor, lib/paths.js)
  if (r === '.faro.json') return !existe(destino, `${BASE}/config.json`) && existe(destino, '.faro.json') ? '.faro.json' : `${BASE}/config.json`;
  return AREAS.includes(r.split('/')[0]) ? `${BASE}/${r}` : r;
}

/** Fichero de configuración del repo (NO ~/.faro.json, que es el almacén de credenciales del usuario). */
const rutaConfig = (destino) => rutaFaro(destino, '.faro.json');

export { BASE, AREAS, detectarLayout, rutaFaro, rutaConfig };
