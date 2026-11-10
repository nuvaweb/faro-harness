// Cortafuegos tras un incidente real (11 sep 2026): un test escribio fixtures en el ~/.faro.json del
// desarrollador y borro sus tokens. Desde un contexto de test, el almacen de credenciales NUNCA puede
// resolverse a la ruta real: sin FARO_CONFIG_PATH va a un temporal por proceso; con ella, a esa ruta.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks', 'lib');
const real = path.join(os.homedir(), '.faro.json');
const cargar = async (f) => (await import(`file://${path.join(LIB, f).replace(/\\/g, '/')}?t=${Date.now()}`)).default;

test('en contexto de test SIN override, la ruta del almacen NO es la real (ni leyendo ni escribiendo)', async () => {
  delete process.env.FARO_CONFIG_PATH;
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test debe marcar el contexto de test');
  const c = (await cargar('credenciales.js'))();
  const ruta = c.rutaCfg();
  assert.notStrictEqual(path.resolve(ruta), path.resolve(real), `apunta a la ruta real: ${ruta}`);
  assert.ok(ruta.startsWith(os.tmpdir()), `debe ser un temporal: ${ruta}`);
  const antes = fs.existsSync(real) ? fs.readFileSync(real, 'utf8') : null;
  c.guardarToken('gitlab.com', { token: 'FIXTURE', forja: 'gitlab' });
  const despues = fs.existsSync(real) ? fs.readFileSync(real, 'utf8') : null;
  assert.strictEqual(despues, antes, 'la escritura de un test ha tocado el fichero REAL');
});

test('FARO_CONFIG_PATH manda, y los tres modulos que escriben usan la MISMA ruta', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-cfg-'));
  process.env.FARO_CONFIG_PATH = path.join(dir, 'almacen.json');
  try {
    const c = (await cargar('credenciales.js'))();
    assert.strictEqual(c.rutaCfg(), process.env.FARO_CONFIG_PATH);
    c.guardarToken('gitlab.com', { token: 'A', forja: 'gitlab' });
    const gl = (await cargar('forge-gitlab.js'))({ ROOT: dir, git: () => '', forge: () => ({ forge: 'gitlab', host: 'gitlab.com', owner: 'g', project: 'p', path: 'g/p' }), tokenPara: c.tokenPara, guardarToken: c.guardarToken, faroSchema: () => ({}), specBase: 'x' });
    gl.invalidarResumen();   // pasa por escribirCfg de forge-gitlab -> credenciales
    const gh = (await cargar('github.js'))({ ROOT: dir, git: () => '', IS_TEMPLATE: false, specBase: 'x', forge: () => ({ forge: 'github', host: 'github.com' }) });
    assert.strictEqual(typeof gh.cachedUser, 'function');
    const j = JSON.parse(fs.readFileSync(process.env.FARO_CONFIG_PATH, 'utf8'));
    assert.strictEqual(j.tokens['gitlab.com'].token, 'A', 'lo escrito por credenciales debe seguir ahi tras pasar por los otros modulos');
  } finally { delete process.env.FARO_CONFIG_PATH; }
});
