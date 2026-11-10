// Caja de permisos que cierra crear y traer: quién decide, quién añade gente y qué nivel sirve para qué.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NIVELES, enlaceMiembros, lineasPermisos } from '../bin/lib/permisos.mjs';

test('niveles de cada forja, en orden y con su uso en FARO', () => {
  assert.deepEqual(NIVELES.github.map((n) => n.nombre), ['Read', 'Triage', 'Write', 'Maintain', 'Admin']);
  assert.deepEqual(NIVELES.gitlab.map((n) => n.nombre), ['Guest', 'Reporter', 'Developer', 'Maintainer', 'Owner']);
  for (const n of [...NIVELES.github, ...NIVELES.gitlab]) assert.ok(n.uso.length > 10, n.nombre);
});

test('enlace a la gestión de miembros', () => {
  assert.equal(enlaceMiembros('github', 'github.com', 'ana/app'), 'https://github.com/ana/app/settings/access');
  assert.equal(enlaceMiembros('github', 'ghe.empresa.com', 'eq/app'), 'https://ghe.empresa.com/eq/app/settings/access');
  assert.equal(enlaceMiembros('gitlab', 'gitlab.com', 'g/sub/app'), 'https://gitlab.com/g/sub/app/-/project_members');
});

test('la caja dice quién aprueba, que añadir gente es del owner, los niveles y el enlace', () => {
  const t = lineasPermisos({ forja: 'gitlab', host: 'gitlab.com', ruta: 'g/app' }).join('\n');
  assert.match(t, /owner/i); assert.match(t, /maintainer/i);
  assert.match(t, /develop/); assert.match(t, /main/);
  for (const n of NIVELES.gitlab) assert.ok(t.includes(n.nombre), n.nombre);
  assert.ok(t.includes('https://gitlab.com/g/app/-/project_members'));
  assert.ok(!t.includes('Triage'));
});
