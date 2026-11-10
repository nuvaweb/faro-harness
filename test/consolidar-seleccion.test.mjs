// consolidar integra SOLO lo pedido y valida SOLO lo que tocan las ramas (#226).
// Antes integraba todas las ramas locales sin integrar y lanzaba siempre `validate --todas`.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const C = createRequire(import.meta.url)(path.join(HOOKS, 'lib', 'consolidar.js'));
const issueDeRama = (r) => (String(r).match(/^[^/]+\/(\d+)(?:-|$)/) || [])[1] || null;

const RAMAS = ['feat/65-login', 'fix/70-avisos', 'feat/notas-sueltas'];
const pr = (number, estado = 'open', base = 'develop') => ({ number, state: estado, base: { ref: base } });

test('sin argumentos solo entran las ramas con PR abierto a develop', () => {
  const prs = new Map([['feat/65-login', [pr(80)]], ['fix/70-avisos', []], ['feat/notas-sueltas', [pr(81, 'closed')]]]);
  const s = C.seleccionarRamas({ ramas: RAMAS, pedidas: [], prs, issueDeRama });
  assert.deepStrictEqual(s.ramas, ['feat/65-login']);
  assert.deepStrictEqual(s.sinPr, ['fix/70-avisos', 'feat/notas-sueltas']);
});

test('sin argumentos y sin poder consultar los PRs no integra nada', () => {
  const s = C.seleccionarRamas({ ramas: RAMAS, pedidas: [], prs: null, issueDeRama });
  assert.deepStrictEqual(s.ramas, []);
  assert.strictEqual(s.sinConsultar, true);
});

test('con argumentos entra solo lo pedido: numero de PR, numero de issue o nombre de rama', () => {
  const prs = new Map([['feat/65-login', [pr(80)]], ['fix/70-avisos', []], ['feat/notas-sueltas', []]]);
  assert.deepStrictEqual(C.seleccionarRamas({ ramas: RAMAS, pedidas: ['#80'], prs, issueDeRama }).ramas, ['feat/65-login']);
  assert.deepStrictEqual(C.seleccionarRamas({ ramas: RAMAS, pedidas: ['70'], prs, issueDeRama }).ramas, ['fix/70-avisos']);
  assert.deepStrictEqual(C.seleccionarRamas({ ramas: RAMAS, pedidas: ['feat/notas-sueltas'], prs: null, issueDeRama }).ramas, ['feat/notas-sueltas']);
  const s = C.seleccionarRamas({ ramas: RAMAS, pedidas: ['#999'], prs, issueDeRama });
  assert.deepStrictEqual(s.ramas, []);
  assert.deepStrictEqual(s.noEncontradas, ['#999']);
});

test('--todas-las-ramas recupera el comportamiento anterior', () => {
  assert.deepStrictEqual(C.seleccionarRamas({ ramas: RAMAS, pedidas: [], prs: null, issueDeRama, todasLasRamas: true }).ramas, RAMAS);
});

test('la validacion se acota a lo que tocan las ramas', () => {
  assert.deepStrictEqual(C.argsValidate({ monorepo: true, apps: ['web', 'api'] }), ['validate', '--app', 'web,api']);
  assert.deepStrictEqual(C.argsValidate({ monorepo: true, apps: [] }), ['validate']);
  assert.deepStrictEqual(C.argsValidate({ monorepo: false, apps: [] }), ['validate', '--gates']);
  assert.deepStrictEqual(C.argsValidate({ monorepo: true, apps: ['web'], todas: true }), ['validate', '--todas']);
});
