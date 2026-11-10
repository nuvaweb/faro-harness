// Los skills (triaje, pr, consolidar) documentan rutas como repos/{org}/{repo}/issues/95, pero el
// transporte `harness.js gh` las bloqueaba: '{org}' no es la organizacion de la sesion (#245).
// La expansion va ANTES del control de alcance, asi que el control juzga la ruta ya expandida:
// expandir no puede dar acceso a nada que la ruta escrita a mano no tuviera.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const A = createRequire(import.meta.url)(path.join(HOOKS, 'lib', 'alcance.js'));
const S = { org: 'acme', repo: 'propio' };
const API = { apiBase: 'https://api.github.com/' };

test('{org} y {repo} se sustituyen por los del remoto de la sesion', () => {
  assert.strictEqual(A.expandirPlaceholders('repos/{org}/{repo}/issues/95', S), 'repos/acme/propio/issues/95');
  assert.strictEqual(A.expandirPlaceholders('repos/{org}/{repo}/pulls?state=open', S), 'repos/acme/propio/pulls?state=open');
  assert.strictEqual(A.expandirPlaceholders('orgs/{org}/repos', S), 'orgs/acme/repos');
});

test('una ruta sin placeholders, o sin sesion, no se toca', () => {
  assert.strictEqual(A.expandirPlaceholders('repos/acme/otro/issues', S), 'repos/acme/otro/issues');
  assert.strictEqual(A.expandirPlaceholders('repos/{org}/{repo}/issues', null), 'repos/{org}/{repo}/issues');
});

test('la ruta expandida pasa el control de alcance; la sin expandir sigue bloqueada', () => {
  const ruta = 'repos/{org}/{repo}/issues/95';
  assert.ok(A.evaluarGh(ruta, 'GET', S, API), 'sin expandir sigue bloqueada (falla cerrado)');
  assert.strictEqual(A.evaluarGh(A.expandirPlaceholders(ruta, S), 'GET', S, API), null);
});

test('expandir no abre escritura en otro repo ni en otra org', () => {
  // el placeholder solo resuelve a la sesion: una org escrita a mano sigue rechazada
  assert.ok(A.evaluarGh(A.expandirPlaceholders('repos/otra/{repo}/issues/1', S), 'GET', S, API));
  assert.ok(A.evaluarGh(A.expandirPlaceholders('repos/{org}/ajeno/contents/x', S), 'PUT', S, { ...API, cuerpo: '{}' }));
});

test('un valor de remoto con caracteres raros no se cuela en la ruta', () => {
  const raro = { org: 'acme', repo: '../../orgs/otra' };
  assert.ok(A.evaluarGh(A.expandirPlaceholders('repos/{org}/{repo}/issues', raro), 'GET', raro, API), 'segmentos de escape: rechazada');
});
