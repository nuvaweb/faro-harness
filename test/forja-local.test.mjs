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

test('consolidar con remoto LOCAL hace su trabajo en vez de abortar por SIN_TOKEN', () => {
  // El caso que rompia CI: develop local por delante del remoto, sin ramas que integrar.
  const bare = tmp('local-bare');
  git(bare, 'init', '--bare', '-b', 'main');
  const dir = tmp('local-trabajo');
  const cfg = (d) => {
    git(d, 'config', 'user.email', 't@t');
    git(d, 'config', 'user.name', 'T');
    git(d, 'config', 'commit.gpgsign', 'false');
  };
  fs.writeFileSync(path.join(dir, 'ESTADO.md'),
    '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · P — in_progress\n- [ ] t\n');
  git(dir, 'init', '-b', 'main');
  cfg(dir);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'switch', '-c', 'develop');
  git(dir, 'push', '-u', 'origin', 'develop');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'trabajo ya integrado\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'merge previo');

  const r = spawnSync(process.execPath, [HARNESS, 'consolidar'], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/SIN_TOKEN/.test(r.stdout),
    `un remoto local no debe pedir token de GitHub:\n${r.stdout}`);
  assert.match(r.stdout, /por delante|SIN SUBIR|push origin develop/i,
    `deberia avisar de que develop local va por delante:\n${r.stdout}`);
});
