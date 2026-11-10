// consolidar y publicar delegan en el CI de la forja (#289). La decision es dominio puro
// (lib/estado-ci.js); el cableado en harness.js se comprueba por fuente.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const E = createRequire(import.meta.url)(path.join(HOOKS, 'lib', 'estado-ci.js'));
const LOCAL = ['validate', '--gates'];
const r = (rama, estado, fallidos = []) => ({ rama, estado, fallidos });

test('modoValidacion: ci, local o ambos; sin clave o con un valor raro, local', () => {
  assert.strictEqual(E.modoValidacion({ validacion: 'ci' }), 'ci');
  assert.strictEqual(E.modoValidacion({ validacion: 'ambos' }), 'ambos');
  assert.strictEqual(E.modoValidacion({}), 'local');
  assert.strictEqual(E.modoValidacion(null), 'local');
  assert.strictEqual(E.modoValidacion({ validacion: 'jenkins' }), 'local');
});

test('sin modo declarado: validación local como antes y no hace falta consultar el CI', () => {
  assert.strictEqual(E.consultaCi('local'), false);
  const d = E.decidirConsolidar({ modo: 'local', ramas: [r('feat/1-a', null)], argsLocal: LOCAL });
  assert.deepStrictEqual(d.integrar, ['feat/1-a']);
  assert.deepStrictEqual(d.args, LOCAL);
  assert.deepStrictEqual(d.excluidas, []);
});

test('CI verde en modo ci: no repite la suite en local (solo el ciclo)', () => {
  assert.strictEqual(E.consultaCi('ci'), true);
  const d = E.decidirConsolidar({ modo: 'ci', ramas: [r('feat/1-a', 'verde')], argsLocal: LOCAL });
  assert.deepStrictEqual(d.integrar, ['feat/1-a']);
  assert.deepStrictEqual(d.args, ['validate']);
  assert.match(d.avisos.join('\n'), /CI verde/);
});

test('CI rojo: esa rama no se integra y se dice qué check falló', () => {
  const d = E.decidirConsolidar({ modo: 'ci', ramas: [r('feat/1-a', 'rojo', ['lint']), r('feat/2-b', 'verde')], argsLocal: LOCAL });
  assert.deepStrictEqual(d.integrar, ['feat/2-b']);
  assert.strictEqual(d.excluidas[0].rama, 'feat/1-a');
  assert.match(d.avisos.join('\n'), /feat\/1-a.*rojo.*lint/);
});

test('CI pendiente: esa rama espera', () => {
  const d = E.decidirConsolidar({ modo: 'ambos', ramas: [r('feat/1-a', 'pendiente')], argsLocal: LOCAL });
  assert.deepStrictEqual(d.integrar, []);
  assert.strictEqual(d.args, null);
  assert.match(d.avisos.join('\n'), /en curso/);
});

test('sin cuota o sin CI: avisa y corre la suite completa en local', () => {
  for (const estado of ['sin-cuota', 'sin-ci']) {
    const d = E.decidirConsolidar({ modo: 'ci', ramas: [r('feat/1-a', estado)], argsLocal: LOCAL });
    assert.deepStrictEqual(d.integrar, ['feat/1-a'], estado);
    assert.deepStrictEqual(d.args, ['validate', '--todas'], estado);
  }
  assert.match(E.decidirConsolidar({ modo: 'ci', ramas: [r('feat/1-a', 'sin-cuota')], argsLocal: LOCAL }).avisos.join('\n'), /minutos/);
});

test('modo ambos con CI verde: además valida en local como siempre', () => {
  const d = E.decidirConsolidar({ modo: 'ambos', ramas: [r('feat/1-a', 'verde')], argsLocal: LOCAL });
  assert.deepStrictEqual(d.args, LOCAL);
});

test('publicar: CI de develop en rojo bloquea; sin cuota o sin CI solo avisa', () => {
  assert.strictEqual(E.decidirPublicar({ modo: 'ci', estado: 'rojo', fallidos: ['test'] }).bloquear, true);
  assert.strictEqual(E.decidirPublicar({ modo: 'ci', estado: 'sin-cuota' }).bloquear, false);
  assert.match(E.decidirPublicar({ modo: 'ci', estado: 'sin-cuota' }).aviso, /minutos/);
  assert.strictEqual(E.decidirPublicar({ modo: 'ci', estado: 'verde' }).bloquear, false);
  assert.strictEqual(E.decidirPublicar({ modo: 'local', estado: 'rojo' }).bloquear, false, 'en local no se consulta');
});

test('fuente: consolidar y publicar usan la decisión y el puerto estadoCi', () => {
  const src = fs.readFileSync(path.join(HOOKS, 'harness.js'), 'utf8');
  const consolidar = src.slice(src.indexOf('async function cmdConsolidar'), src.indexOf('async function cmdConsolidar') + 6000);
  assert.match(consolidar, /decidirConsolidar/);
  assert.match(consolidar, /estadoCi\(/);
  const publicar = src.slice(src.indexOf('async function cmdPublicar'));
  assert.match(publicar.slice(0, 12000), /decidirPublicar/);
  assert.match(publicar.slice(0, 12000), /estadoCiCommit\(/);
});

test('schema: .faro.json declara la clave validacion', () => {
  const s = JSON.parse(fs.readFileSync(path.join(HOOKS, 'faro-schema.json'), 'utf8'));
  const v = JSON.stringify(s).match(/"validacion":\{"modos":\[([^\]]*)\]/);
  assert.ok(v, 'validacion con sus modos');
  assert.match(v[1], /"ci".*"local".*"ambos"/);
});
