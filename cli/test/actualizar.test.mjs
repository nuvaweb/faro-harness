// `faro update`: refresca el plugin y dice si hay wizard nuevo. Lo primero nunca depende de lo segundo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { versionPublicada, avisoVersion, actualizar } from '../bin/lib/actualizar.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const respuesta = (status, cuerpo) => new Response(JSON.stringify(cuerpo), { status });

test('versionPublicada: lee la última versión del paquete faro-harness', async () => {
  let pedida = '';
  const v = await versionPublicada({ fetchImpl: async (u) => { pedida = String(u); return respuesta(200, { version: '1.2.3' }); } });
  assert.equal(v, '1.2.3');
  assert.equal(pedida, 'https://registry.npmjs.org/faro-harness/latest');
});

test('versionPublicada: null si npm no contesta, responde error o tarda demasiado', { timeout: 5000 }, async () => {
  assert.equal(await versionPublicada({ fetchImpl: async () => { throw new Error('ENOTFOUND'); } }), null);
  assert.equal(await versionPublicada({ fetchImpl: async () => respuesta(503, { version: '9.9.9' }) }), null);
  const colgado = (_u, { signal }) => new Promise((_, rechaza) => signal.addEventListener('abort', () => rechaza(new Error('abortado'))));
  assert.equal(await versionPublicada({ fetchImpl: colgado, limiteMs: 10 }), null);
});

test('avisoVersion: solo si la publicada es mayor, comparando números y no texto', () => {
  assert.match(avisoVersion('0.9.2', '0.10.0'), /npx faro-harness@latest update/);
  assert.equal(avisoVersion('0.10.0', '0.9.2'), null);
  assert.equal(avisoVersion('1.0.0', '1.0.0'), null);
  assert.equal(avisoVersion('1.0.0', null), null);
});

test('actualizar: fuerza el refresco del plugin aunque ya se hiciera hoy', async () => {
  const opciones = [];
  await actualizar({ refrescar: async (o) => { opciones.push(o); return { estado: 'ok' }; }, consultar: async () => null, instalada: '1.0.0', decir: () => {} });
  assert.equal(opciones.length, 1);
  assert.equal(opciones[0].forzar, true);
});

test('actualizar: un fallo del refresco no impide decir que hay wizard nuevo', async () => {
  const dicho = [];
  const r = await actualizar({ refrescar: async () => { throw new Error('claude falló'); }, consultar: async () => '9.0.0', instalada: '1.0.0', decir: (t) => dicho.push(t) });
  assert.equal(r.plugin, 'error');
  assert.match(dicho.join('\n'), /npx faro-harness@latest update/);
});

test('el paquete se llama faro-harness, con un único bin faro y sin hablar de plantillas oficiales', () => {
  assert.equal(pkg.name, 'faro-harness');
  assert.deepEqual(pkg.bin, { faro: 'bin/crear.mjs' }, 'npx usa el único bin');
  assert.equal(/template oficial/i.test(pkg.description), false);
});

function lanzar(args, npm) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-upd-'));
  return spawnSync(process.execPath, ['--import', pathToFileURL(path.join(ROOT, 'test', 'apoyo', 'api-simulada.mjs')).href, path.join(ROOT, 'bin', 'crear.mjs'), ...args], {
    cwd: raiz, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
    env: { PATH: path.dirname(process.execPath), HOME: raiz, USERPROFILE: raiz, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, API_LOG: path.join(raiz, 'api.log'), NPM_SIMULADO: npm },
  });
}

test('faro update con versión nueva en npm: muestra el comando y termina bien, sin pedir sesión', () => {
  const r = lanzar(['update'], '99.0.0');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /npx faro-harness@latest update/);
});

test('faro update sin acceso a npm: no falla', () => {
  const r = lanzar(['update'], 'caido');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.includes('npx faro-harness@latest'), false);
});

test('la ayuda documenta update y el paquete nuevo', () => {
  const r = lanzar(['--help'], 'caido');
  assert.match(r.stdout, /npx faro-harness\b/);
  assert.match(r.stdout, /\bupdate\b/);
  assert.equal(new RegExp('fract' + 'alia', 'i').test(r.stdout), false);
});
