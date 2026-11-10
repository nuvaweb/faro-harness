// Ayuda para conectar con token: scopes y dirección de cada forja, y por qué el SSH no basta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ayudaToken, urlTokens } from '../bin/lib/ayuda-token.mjs';

test('dirección donde se crea el token', () => {
  assert.equal(urlTokens('github', 'github.com'), 'https://github.com/settings/tokens');
  assert.equal(urlTokens('github', 'ghe.empresa.com'), 'https://ghe.empresa.com/settings/tokens');
  assert.equal(urlTokens('gitlab', 'git.empresa.com'), 'https://git.empresa.com/-/user_settings/personal_access_tokens');
});

test('GitHub: repo y read:org, workflow opcional', () => {
  const t = ayudaToken('github', 'github.com').join('\n');
  assert.match(t, /\brepo\b/); assert.match(t, /read:org/); assert.match(t, /workflow.*opcional|opcional.*workflow/i);
  assert.ok(t.includes('https://github.com/settings/tokens'));
});

test('GitLab: scope api', () => {
  const t = ayudaToken('gitlab', 'gitlab.com').join('\n');
  assert.match(t, /\bapi\b/);
  assert.ok(t.includes('https://gitlab.com/-/user_settings/personal_access_tokens'));
});

test('las dos dicen que el SSH solo mueve el código y la API necesita el token', () => {
  for (const f of ['github', 'gitlab']) assert.match(ayudaToken(f, 'x.com').join(' '), /SSH solo mueve el código.*token/);
});
