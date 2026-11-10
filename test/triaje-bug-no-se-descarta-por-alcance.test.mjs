// Un BUG no necesita estar planificado para ser un fallo (lo dice el propio triaje.js al clasificar
// por tipo), pero el cruce con el fuera de alcance era lexico y no miraba el tipo: «turnos» y
// «ausencias» coincidian con el punto «Ingesta gobernada» (ingesta de Excel legado) y un error al
// guardar el cuadrante salia como no-aplica (#244).
//
// Lo que se protege: un fuera de alcance solo descarta ideas y sugerencias; un bug no recibe
// no-aplica por coincidencia de palabras (queda en sin-criterio, que es la salida honesta).
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const { juzgar } = createRequire(import.meta.url)(path.join(HOOKS, 'lib', 'triaje.js'));

const FUERA = ['Ingesta gobernada: importar turnos y ausencias desde el Excel legado'];

test('un bug que solo comparte palabras con el fuera de alcance NO es no-aplica', () => {
  const j = juzgar({
    titulo: 'No puedo guardar el cuadrante',
    cuerpo: 'Al guardar turnos y ausencias sale error',
    fueraAlcance: FUERA,
  });
  assert.strictEqual(j.tipo, 'bug');
  assert.notStrictEqual(j.veredicto, 'no-aplica', `un bug no se descarta por coincidencia de palabras:\n${j.motivo}`);
  assert.deepStrictEqual(j.excluye, [], 'y no cita como exclusion una frase que no lo excluye');
});

test('una idea que SI cae en el fuera de alcance se sigue descartando citandolo', () => {
  const j = juzgar({
    titulo: 'Propuesta: importar turnos y ausencias desde Excel',
    cuerpo: 'Me gustaria que se pudiera importar turnos y ausencias del Excel legado',
    fueraAlcance: FUERA,
  });
  assert.strictEqual(j.veredicto, 'no-aplica');
  assert.deepStrictEqual(j.excluye, FUERA);
});
