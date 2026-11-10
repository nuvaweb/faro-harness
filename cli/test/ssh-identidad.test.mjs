import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSshLogin } from '../bin/lib/repo.mjs';

test('parseSshLogin: extrae el login del saludo real de GitHub (exit≠0, por stderr)', () => {
  const salida = "Hi octocat! You've successfully authenticated, but GitHub does not provide shell access.";
  assert.equal(parseSshLogin(salida), 'octocat');
});

test('parseSshLogin: normaliza a minúsculas y acepta guiones', () => {
  assert.equal(parseSshLogin('Hi Acme-Bot! You have successfully authenticated'), 'acme-bot');
});

test('parseSshLogin: sin saludo válido → null (permission denied, host key, vacío)', () => {
  assert.equal(parseSshLogin('git@github.com: Permission denied (publickey).'), null);
  assert.equal(parseSshLogin(''), null);
  assert.equal(parseSshLogin(null), null);
  assert.equal(parseSshLogin('Warning: Permanently added the RSA host key'), null);
});

test('parseSshLogin: no confunde otras líneas con "Hi" que no sean el saludo', () => {
  // Debe requerir el patrón "Hi <login>!" exacto.
  assert.equal(parseSshLogin('History of connections'), null);
});
