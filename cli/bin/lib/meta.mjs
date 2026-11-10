// meta.mjs — metadato del REPO (.faro.json): nombre vigente, legado y lectura/escritura.
// Fuente única para repo.mjs, plugin.mjs y los flujos (evita un ciclo de imports entre ellos).
import fs from 'node:fs';
import path from 'node:path';

// Metadato del REPO: .faro.json (mismo nombre que ~/.faro.json del usuario: la ruta desambigua).
const REPO_META = '.faro.json';
function leerMetaRepo(destino) {
  try { return JSON.parse(fs.readFileSync(path.join(destino, REPO_META), 'utf8')); } catch { return null; }
}
function escribirMetaRepo(destino, meta) {
  fs.writeFileSync(path.join(destino, REPO_META), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

export { REPO_META, leerMetaRepo, escribirMetaRepo };
