// meta.mjs — metadato del REPO: nombre vigente, legado y lectura/escritura.
// Fuente única para repo.mjs, plugin.mjs y los flujos (evita un ciclo de imports entre ellos).
// #293: vive en faro/config.json; un repo sin migrar lo conserva en .faro.json (lectura dual).
import fs from 'node:fs';
import path from 'node:path';
import { rutaConfig } from './layout.mjs';

// Nombre LEGADO, para mensajes y compatibilidad (mismo nombre que ~/.faro.json del usuario: la ruta desambigua).
const REPO_META = '.faro.json';
function leerMetaRepo(destino) {
  try { return JSON.parse(fs.readFileSync(path.join(destino, rutaConfig(destino)), 'utf8')); } catch { return null; }
}
function escribirMetaRepo(destino, meta) {
  const f = path.join(destino, rutaConfig(destino));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

export { REPO_META, leerMetaRepo, escribirMetaRepo, rutaConfig };
