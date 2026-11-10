// esqueleto.mjs — la capa FARO con la que nace todo repo: viaja dentro del paquete, sin depender de
// ningún repositorio plantilla. El .gitignore se guarda como `gitignore` porque npm no empaqueta un
// fichero con ese nombre.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ_ESQUELETO = fileURLToPath(new URL('../esqueleto', import.meta.url));

function copiarEsqueleto(destino) {
  fs.cpSync(RAIZ_ESQUELETO, destino, { recursive: true });
  fs.renameSync(path.join(destino, 'gitignore'), path.join(destino, '.gitignore'));
}

export { RAIZ_ESQUELETO, copiarEsqueleto };
