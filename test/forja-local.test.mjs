// Un remoto que NO es de GitHub (una ruta local, otra forja) no debe tratarse como repo de GitHub.
// Regresion real: en Linux/macOS la ruta local lleva barras normales y la regex de ghRepo() casaba,
// asi que el harness llamaba a la API por un repo inexistente, respondia SIN_TOKEN y abortaba la
// operacion. En Windows no se veia (contrabarras), asi que CI llevaba en rojo en 2 de 3 plataformas.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');
const git = (dir, ...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

test('forja: una RUTA LOCAL como origin no se confunde con un repo de GitHub', async () => {
  const { detect } = await import(`file://${path.join(RAIZ, 'plugins/faro/hooks/lib/forge.js').replace(/\\/g, '/')}`);
  // Las tres formas reales que toma un directorio temporal en cada sistema.
  for (const ruta of [
    '/tmp/proyecto-bare',
    '/home/runner/work/_temp/proyecto-bare',      // ubuntu en CI
    '/var/folders/ab/xyz/T/proyecto-bare',        // macOS
    'C:\\Users\\x\\AppData\\Local\\Temp\\proyecto-bare',
  ]) {
    assert.strictEqual(detect(ruta).forge, 'desconocida', `'${ruta}' no es una forja`);
  }
});

test('FARO 3.0: consolidar y publicar ya no operan; explican el flujo a main sin pedir token', () => {
  const dir = tmp('local-retirado');
  git(dir, 'init', '-b', 'main');
  for (const cmd of ['consolidar', 'publicar']) {
    const r = spawnSync(process.execPath, [HARNESS, cmd], {
      cwd: dir, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!/SIN_TOKEN/.test(r.stdout), r.stdout);
    assert.match(r.stdout, /se retiro en FARO 3.0/, r.stdout);
    assert.match(r.stdout, /auto-merge/, r.stdout);
  }
});
