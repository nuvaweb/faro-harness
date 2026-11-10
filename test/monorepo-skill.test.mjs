// #161 — la skill /faro:monorepo y los comandos que cita. La conversion con el usuario la hace la
// skill; lo mecanico, el harness. Si uno cambia sin el otro, la skill manda a ejecutar algo que no
// existe (misma red que test/coherencia-docs-comandos.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(RAIZ, 'plugins', 'faro');
const require = createRequire(import.meta.url);
const SKILL = path.join(PLUGIN, 'skills', 'monorepo', 'SKILL.md');
const txt = () => fs.readFileSync(SKILL, 'utf8').replace(/\r\n/g, '\n');
const harness = () => fs.readFileSync(path.join(PLUGIN, 'hooks', 'harness.js'), 'utf8');

test('la skill existe, es inline, y su descripcion cabe en 200 caracteres y empieza por «Úsala»', () => {
  const t = txt();
  const m = t.match(/^---\ndescription: "(.*)"\n/);
  assert.ok(m, 'frontmatter con description entre comillas');
  assert.ok(m[1].length <= 200, `descripcion de ${m[1].length} car.`);
  assert.match(m[1], /^Úsala/);
  assert.doesNotMatch(t.split('\n---\n')[0], /disable-model-invocation/);
  assert.match(t, /inline/);
});

test('cita subcomandos reales del harness (monorepo init e importar) y los flags que existen', () => {
  const t = txt();
  assert.match(harness(), /cmd === 'monorepo'/);
  const cli = fs.readFileSync(path.join(PLUGIN, 'hooks', 'lib', 'monorepo.js'), 'utf8');
  for (const sub of ['init', 'importar']) { assert.match(t, new RegExp(`monorepo ${sub}`)); assert.match(cli, new RegExp(`'${sub}'`)); }
  for (const flag of ['--confirmo', '--dry-run', '--app', '--rol', '--consolidar']) assert.match(cli, new RegExp(`'${flag}'|${flag}`), flag);
  assert.match(t, /--confirmo/);
});

test('el plan que la skill documenta es valido para el esquema del motor', () => {
  const mp = require(path.join(PLUGIN, 'hooks', 'lib', 'monorepo-plan.js'));
  const bloque = txt().match(/```json\n([\s\S]*?)\n```/);
  assert.ok(bloque, 'ejemplo de plan');
  const plan = JSON.parse(bloque[1]);
  assert.deepStrictEqual(mp.validarPlan(plan, { org: 'org' }), []);
});

test('la skill no manda tocar nada a mano ni saltarse la firma', () => {
  const t = txt();
  assert.match(t, /nunca muevas, borres ni crees ficheros a mano/i);
  assert.match(t, /no la saltes/i);
  assert.match(t, /Nunca sobre `develop` ni `main`/);
});

test('el aviso de workspace sin declarar apunta a /faro:monorepo', () => {
  const ap = fs.readFileSync(path.join(PLUGIN, 'hooks', 'lib', 'apps.js'), 'utf8');
  assert.match(ap, /sin modo monorepo: \/faro:monorepo/);
});
