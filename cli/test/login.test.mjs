import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumenLogin } from '../bin/flows/login.mjs';

const gitlab = { id: 'gitlab', forja: 'gitlab', host: 'gitlab.com', org: null, plugin: { url: 'u' } };
const github = { id: 'github', forja: 'github', host: 'github.com', org: null, plugin: { url: 'https://example.test/plugin.git' } };

test('resumenLogin: forja, usuario, permisos y marketplace en llano', () => {
  const t = resumenLogin({ login: 'ana', email: 'ana@x.com' }, gitlab, { scopesOk: true, marketplace: true }).join('\n');
  assert.match(t, /GitLab.*gitlab\.com/i);
  assert.match(t, /@ana/);
  assert.match(t, /Plugin faro.*listo/i);
  assert.ok(!/actualizar solo/.test(t), 'ya no se escribe insteadOf: no se promete autoUpdate por esa via');
});

test('resumenLogin: dice qué falta si los permisos o el plugin no están', () => {
  const m = resumenLogin({ login: 'ana' }, github, { scopesOk: false, faltan: ['workflow'], marketplace: false }).join('\n');
  assert.match(m, /workflow/);
  assert.match(m, /no puede leer el marketplace/);
});

test('resumenLogin: un perfil sin organización no habla de membresía', () => {
  const t = resumenLogin({ login: 'ana' }, github, { scopesOk: true, marketplace: true }).join('\n');
  assert.ok(!/miembro|membresía|null/i.test(t), t);
});

test('resumenLogin: avisa de la caducidad de una sesión que no se puede renovar', () => {
  const cad = resumenLogin({ login: 'ana' }, gitlab, { scopesOk: true, marketplace: true, expira: true, renovable: false });
  assert.match(cad.join('\n'), /caducan a las 2 h/);
});
