// plantilla.mjs — instanciar una plantilla de stack: sustituye sus marcadores por los valores del repo.
// Lo usan el alta de app única (repo.mjs) y cada app de un monorepo (monorepo.mjs).
import fs from 'node:fs';
import path from 'node:path';

// INSTANCIAR UNA PLANTILLA DE STACK — sustituye los MARCADORES que el template trae a proposito
// (wrangler.jsonc nace con "name": "name-dev" / "name-prod") por los valores de ESTE repo.
// ALCANCE deliberadamente MECANICO: solo lo que se deduce del nombre del repo sin criterio alguno.
// Lo que exige decidir —paleta, navegacion, textos, y sobre todo el APP_ID, que lo EMITE el centro
// de identidad y NO se inventa— se queda como esta y lo resuelve despues el agente dentro del repo.
// Heredar el APP_ID de la plantilla seria PEOR que dejarlo: la app nueva se identificaria como la
// vieja ante el centro, y el gate es fail-closed (falla, pero tarde y sin explicar por que).
// Idempotente y no destructivo: si un marcador ya no esta, esa sustitucion simplemente no ocurre.
function personalizarPlantilla(destino, { repoName, marcadores = [] }) {
  const hechos = [];
  const sustituir = (rel, pares) => {
    const f = path.join(destino, rel);
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { return false; }
    const antes = txt;
    for (const [de, a] of pares) txt = txt.split(de).join(a);
    if (txt === antes) return false;
    fs.writeFileSync(f, txt, 'utf8');
    return true;
  };
  // Nombre del worker por entorno. El template usa los literales 'name-dev'/'name-prod'.
  if (marcadores.includes('wrangler-name')) {
    for (const wr of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
      if (sustituir(wr, [['name-dev', `${repoName}-dev`], ['name-prod', `${repoName}-prod`]])) {
        hechos.push(`${wr}: worker ${repoName}-dev / ${repoName}-prod`);
        break;   // solo hay un fichero de wrangler por repo
      }
    }
  }
  return hechos;
}

export { personalizarPlantilla };
