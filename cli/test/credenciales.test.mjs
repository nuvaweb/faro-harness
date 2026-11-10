import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esGithub, esGitlab, hostConfiable, cfgMigrada, tokenDeEntorno, tokenPara, guardarToken, borrarToken, entrada, caduca } from '../bin/lib/credenciales.mjs';

test('esGithub/esGitlab: reconocen host por sufijo, no por nombre suelto', () => {
  assert.equal(esGithub('github.com'), true);
  assert.equal(esGithub('api.github.com'), true);
  assert.equal(esGithub('mygithub.example'), false);
  assert.equal(esGitlab('gitlab.com'), true);
  assert.equal(esGitlab('gitlab.cliente.com'), false, 'un nombre con «gitlab» no hace de un servidor una forja conocida');
  assert.equal(esGitlab('evil-gitlab.example'), false);
  assert.equal(esGitlab('git.cliente.com'), false);
});

test('cfgMigrada: token plano -> tokens["github.com"] una sola vez', () => {
  const cfg = { token: 'ghp_viejo', token_scopes: { scopes: ['repo'] }, user: { login: 'ana' } };
  cfgMigrada(cfg);
  assert.equal(cfg.tokens['github.com'].token, 'ghp_viejo');
  assert.equal(cfg.tokens['github.com'].migrado, true);
  assert.equal(cfg.tokens['github.com'].forja, 'github');
  cfg.token = 'ghp_nuevo_plano';          // el plano cambia DESPUES de migrar
  cfgMigrada(cfg);
  assert.equal(cfg.tokens['github.com'].token, 'ghp_viejo', 'no re-migra: tokens[host] manda (mismo criterio que el plugin)');
});

test('tokenDeEntorno: variables por forja, solo para los hosts públicos', () => {
  assert.equal(tokenDeEntorno('github.com', { GITHUB_TOKEN: 'a' }), 'a');
  assert.equal(tokenDeEntorno('github.com', { FARO_GITHUB_TOKEN: 'b', GITHUB_TOKEN: 'a' }), 'b');
  assert.equal(tokenDeEntorno('gitlab.com', { GITLAB_TOKEN: ' c ' }), 'c');
  assert.equal(tokenDeEntorno('gitlab.cliente.com', { GITLAB_TOKEN: 'c' }), null, 'un host deducido por el nombre no recibe el token');
  assert.equal(tokenDeEntorno('git.x.com', { GITHUB_TOKEN: 'a', GITLAB_TOKEN: 'c' }), null);
});

test('tokenDeEntorno: un servidor propio solo lo recibe si es de confianza y con su forja', () => {
  assert.equal(tokenDeEntorno('git.empresa.com', { GITLAB_TOKEN: 'c' }, { forja: 'gitlab', confiable: true }), 'c');
  assert.equal(tokenDeEntorno('git.empresa.com', { GITLAB_TOKEN: 'c' }, { forja: 'gitlab', confiable: false }), null);
  assert.equal(tokenDeEntorno('git.empresa.com', { GITLAB_TOKEN: 'c' }, { confiable: true }), null, 'sin forja no se sabe qué variable');
});

test('hostConfiable: público, con sesión guardada o declarado en un perfil; nunca por el nombre', () => {
  assert.equal(hostConfiable('github.com', {}), true);
  assert.equal(hostConfiable('GitLab.com', {}), true);
  assert.equal(hostConfiable('gitlab.evil.com', {}), false);
  assert.equal(hostConfiable('git.empresa.com', { tokens: { 'git.empresa.com': { token: 'x' } } }), true);
  assert.equal(hostConfiable('git.empresa.com', {}, [{ id: 'gitlab@git.empresa.com', host: 'git.empresa.com' }]), true);
});

test('tokenPara: entorno > tokens[host] > plano (solo github) > gh (solo github)', () => {
  const cfg = { token: 'plano', tokens: { 'gitlab.com': { token: 'glpat' } } };
  assert.equal(tokenPara('gitlab.com', cfg, { env: {} }), 'glpat');
  assert.equal(tokenPara('gitlab.com', cfg, { env: { FARO_GITLAB_TOKEN: 'env-gl' } }), 'env-gl');
  assert.equal(tokenPara('github.com', cfg, { env: {} }), 'plano', 'sin entrada de host cae al plano');
  assert.equal(tokenPara('github.com', {}, { env: {}, gh: () => 'gh-tok' }), 'gh-tok');
  assert.equal(tokenPara('gitlab.com', {}, { env: {}, gh: () => 'gh-tok' }), null, 'gh solo vale para github');
  assert.equal(tokenPara('gitlab.evil.com', {}, { env: { GITLAB_TOKEN: 'e' } }), null, 'el entorno no viaja a un host desconocido');
  assert.equal(tokenPara('git.empresa.com', { tokens: { 'git.empresa.com': { forja: 'gitlab' } } }, { env: { GITLAB_TOKEN: 'e' } }), 'e', 'un host guardado es de confianza');
});

test('guardarToken: escribe tokens[host] y espeja el plano SOLO en github.com', () => {
  const cfg = {};
  const e = guardarToken('github.com', { token: 'ghp_1', scopes: ['repo', 'read:org'], user: { login: 'ana' }, forja: 'github' }, cfg);
  assert.equal(e.token, 'ghp_1');
  assert.ok(e.actualizado);
  assert.equal(cfg.token, 'ghp_1', 'espejo plano para el plugin');
  guardarToken('gitlab.com', { token: 'gl_1', client_id: 'abc', forja: 'gitlab' }, cfg);
  assert.equal(cfg.token, 'ghp_1', 'gitlab NO toca el plano');
  assert.equal(cfg.tokens['gitlab.com'].client_id, 'abc');
  guardarToken('github.com', { token: 'ghp_2' }, cfg);
  assert.equal(cfg.tokens['github.com'].user.login, 'ana', 'merge conserva lo previo');
  assert.equal(cfg.token, 'ghp_2', 'un login nuevo actualiza el espejo');
});

test('borrarToken: quita entrada y espejo; entrada() devuelve null', () => {
  const cfg = { token: 'x', token_scopes: {}, tokens: { 'github.com': { token: 'x' }, 'gitlab.com': { token: 'y' } } };
  borrarToken('github.com', cfg);
  assert.equal(cfg.token, undefined);
  assert.equal(cfg.token_scopes, undefined);
  assert.equal(entrada('github.com', cfg), null);
  assert.equal(entrada('gitlab.com', cfg).token, 'y');
});

test('caduca: solo si hay expira y queda menos que el margen', () => {
  const ahora = 1_000_000;
  assert.equal(caduca({ token: 't' }, 600000, ahora), false);
  assert.equal(caduca({ token: 't', expira: ahora + 60000 }, 600000, ahora), true);
  assert.equal(caduca({ token: 't', expira: ahora + 3600000 }, 600000, ahora), false);
});
