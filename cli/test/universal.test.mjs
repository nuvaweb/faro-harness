// Lo que hace falta para que el wizard funcione para cualquiera: sin marca ni servicios de ninguna
// organización y sin asumir github.com en la identidad, las credenciales o la detección de la forja.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseSshLogin, asegurarGitIdentidad } from '../bin/lib/repo.mjs';
import { detectarForja } from '../bin/lib/forja.mjs';
import { gh, fijarApi, run } from '../bin/lib/core.mjs';
import { PERFILES } from '../bin/lib/perfil.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ficheros = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'esqueleto' ? [] : ficheros(p);
  return [p];
});

// El escenario «instalación externa» se comprueba sobre el paquete: lo que no está no se puede ejecutar.
// Única excepción: los nombres de ficheros legados del plugin que check retira de los repos.
test('el paquete no lleva marca ni servicios de ninguna organización', () => {
  // Troceado para que el propio test no cuente como mención de la marca.
  const PROHIBIDO = new RegExp(['fract' + 'alia', 'cas-?' + 'ia', 'clickup', 'n8n', 'webhook', 'qratia'].join('|'), 'i');
  const hallazgos = [];
  for (const f of [...ficheros(path.join(ROOT, 'bin')), path.join(ROOT, 'package.json'), path.join(ROOT, 'README.md'), path.join(ROOT, 'LICENSE')]) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((linea, i) => {
      const limpia = linea.replace(/'clickup\.js'/, '').replace(/'gestor-clickup\.md'/, '');
      if (PROHIBIDO.test(limpia)) hallazgos.push(`${path.relative(ROOT, f)}:${i + 1}: ${linea.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(hallazgos, []);
});

test('parseSshLogin reconoce los saludos de GitHub y de GitLab', () => {
  assert.equal(parseSshLogin("Hi Ana! You've successfully authenticated"), 'ana');
  assert.equal(parseSshLogin('Welcome to GitLab, @Ana.Perez!'), 'ana.perez');
  assert.equal(parseSshLogin('Permission denied (publickey).'), null);
});

test('asegurarGitIdentidad en GitLab: noreply y credencial de esa forja, no de github.com', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-id-'));
  const global = path.join(dir, 'gitconfig'); const almacen = path.join(dir, 'credenciales');
  fs.writeFileSync(global, `[credential]\n\thelper = store --file=${almacen.replace(/\\/g, '/')}\n`);
  const previo = process.env.GIT_CONFIG_GLOBAL; const sistema = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = global;
  process.env.GIT_CONFIG_NOSYSTEM = '1';   // el credential.helper del sistema no debe ver el token de prueba
  try {
    await asegurarGitIdentidad({ login: 'ana', id: 7, token: 'tok', email: null }, { ...PERFILES.gitlab, host: 'code.empresa.com' });
    assert.equal(execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8' }).trim(), '7-ana@users.noreply.code.empresa.com');
    assert.equal(fs.readFileSync(almacen, 'utf8').trim(), 'https://oauth2:tok@code.empresa.com');
  } finally {
    if (previo === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previo;
    if (sistema === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = sistema;
  }
});

test('detectarForja reconoce un host propio declarado en un perfil', () => {
  const perfiles = [{ id: 'empresa', forja: 'gitlab', host: 'code.empresa.com' }];
  const r = detectarForja('git@code.empresa.com:equipo/sub/app.git', perfiles);
  assert.equal(r.forja, 'gitlab');
  assert.equal(r.selfHosted, true);
  assert.equal(r.path, 'equipo/sub/app');
  assert.equal(detectarForja('git@code.empresa.com:equipo/app.git').forja, 'desconocida', 'sin perfil no se adivina');
});

test('gh habla con la API que se le fije (GitHub Enterprise)', async () => {
  const previo = globalThis.fetch;
  let pedida = '';
  globalThis.fetch = async (u) => { pedida = String(u); return new Response('{}', { status: 200 }); };
  try {
    fijarApi('https://ghe.empresa.com/api/v3');
    await gh('t', '/user');
    assert.equal(pedida, 'https://ghe.empresa.com/api/v3/user');
  } finally {
    fijarApi('https://api.github.com');
    globalThis.fetch = previo;
  }
});

test('un comando fallido no enseña el token de su URL', () => {
  assert.throws(
    () => run(process.execPath, ['-e', 'process.exit(1)', 'https://u:tok-secreto@forja.test/a/b.git'], { stdio: 'ignore' }),
    (e) => !e.message.includes('tok-secreto') && e.message.includes('forja.test'),
  );
});

test('--team y --team-perm ya no existen en la ayuda', () => {
  const ayuda = fs.readFileSync(path.join(ROOT, 'bin', 'crear.mjs'), 'utf8');
  assert.equal(/--team\b|--team-perm/.test(ayuda), false);
});
