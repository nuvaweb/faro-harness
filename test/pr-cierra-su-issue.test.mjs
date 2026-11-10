// El PR debe CERRAR el issue de su rama, no recordarte que lo escribas tu.
//
// Caso real que lo motiva: 'rama feat "x" --issue 1' crea 'feat/1-x' y el harness imprime "pon
// Closes #1 en la descripcion". Nadie lo puso, el PR se fusiono, el trabajo entro en develop y el
// issue #1 se quedo ABIERTO. Hubo que cerrarlo a mano despues. El dato estaba ahi todo el rato: el
// numero viaja en el nombre de la rama.
//
// Regla: si la rama es '<tipo>/<N>-<slug>' y el cuerpo no menciona ya ese cierre, 'pr crear' anade
// 'Closes #N'. Idempotente (no duplica si ya estaba) y silencioso si la rama no lleva numero.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { issueDeRama, conCierreDeIssue } = require(path.join(HOOKS, 'lib', 'git.js'));

// ---------- extraer el issue del nombre de la rama ----------

test('issueDeRama: saca el numero de <tipo>/<N>-<slug>', () => {
  assert.strictEqual(issueDeRama('feat/4-mockup-ui-informe-partner'), '4');
  assert.strictEqual(issueDeRama('fix/127-login-roto'), '127');
  assert.strictEqual(issueDeRama('docs/1-estado'), '1');
});

test('issueDeRama: una rama SIN numero no inventa ninguno', () => {
  assert.strictEqual(issueDeRama('chore/traer-template-tanstack-worker-ui'), null);
  assert.strictEqual(issueDeRama('feat/onboarding-arranque-ordenado'), null);
  assert.strictEqual(issueDeRama('develop'), null);
  assert.strictEqual(issueDeRama(''), null);
});

test('issueDeRama: un slug que EMPIEZA por digitos no es un issue (2fa, 360, v2)', () => {
  // 'feat/2fa-login' no esta anclada al issue 2: el numero va seguido de '-' o es todo el segmento.
  assert.strictEqual(issueDeRama('feat/2fa-login'), null);
  assert.strictEqual(issueDeRama('feat/360-grados'), '360'); // este SI: digitos + '-'
});

// ---------- inyectar el cierre en el cuerpo ----------

test('conCierreDeIssue: anade "Closes #N" al final del cuerpo', () => {
  const r = conCierreDeIssue('Resumen del cambio.', 'feat/4-mockup');
  assert.match(r, /Closes #4/, r);
  assert.match(r, /^Resumen del cambio\./, 'no debe perder el cuerpo original');
});

test('conCierreDeIssue: cuerpo VACIO igual lleva el cierre', () => {
  assert.match(conCierreDeIssue('', 'feat/4-mockup'), /Closes #4/);
});

test('conCierreDeIssue: NO duplica si el cuerpo ya cierra ese issue', () => {
  const ya = 'Resumen.\n\nCloses #4';
  assert.strictEqual(conCierreDeIssue(ya, 'feat/4-mockup'), ya, 'ya estaba: se deja igual');
  // las otras palabras clave de GitHub cuentan como cierre ya declarado
  const fixes = 'Resumen.\n\nFixes #4';
  assert.strictEqual(conCierreDeIssue(fixes, 'feat/4-mockup'), fixes);
});

test('conCierreDeIssue: si ya cierra OTRO issue, anade el suyo igualmente', () => {
  const r = conCierreDeIssue('Resumen.\n\nCloses #9', 'feat/4-mockup');
  assert.match(r, /Closes #9/, 'no pisa el que ya habia');
  assert.match(r, /Closes #4/, 'y anade el de su rama');
});

test('conCierreDeIssue: rama sin numero deja el cuerpo intacto', () => {
  const cuerpo = 'Resumen del cambio.';
  assert.strictEqual(conCierreDeIssue(cuerpo, 'chore/traer-template'), cuerpo);
});
