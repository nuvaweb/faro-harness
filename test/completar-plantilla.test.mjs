// COMPLETAR sin reescribir (#84): lo que llega de Userback ya trae secciones de FARO (Comportamiento
// obtenido, Evidencia, Entorno, Contexto). Al triarlo, la plantilla de su tipo solo AÑADE lo que falta
// — antes 'reparar-tarea' metia todo el cuerpo dentro de 'Contexto' y duplicaba secciones.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { completarPlantilla, huecosDeIssue } = require(path.join(HOOKS, 'lib', 'ciclo.js'));

const USERBACK = '## Comportamiento obtenido\n\n> sale en blanco\n\n## Evidencia\n\n![Captura 1](https://static.userback.io/a.png)\n\n## Entorno\n\n| Campo | Valor |\n|---|---|\n| Navegador | Chrome |\n\n## Contexto\n\n| Repo origen | `atlas-web` |\n\n---\n_Llegó por Userback_\n<!-- faro:entrada {"canal":"userback","id":"1"} -->\nUserback ID 1';
const secciones = (t) => [...t.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

test('bug: conserva lo que trajo Userback tal cual y añade SOLO lo que falta', () => {
  const r = completarPlantilla(USERBACK, 'bug');
  for (const s of ['Comportamiento obtenido', 'Evidencia', 'Entorno', 'Contexto']) assert.strictEqual(secciones(r).filter((x) => x === s).length, 1, `${s} sin duplicar`);
  for (const s of ['Objetivo', 'Pasos para reproducir', 'Comportamiento esperado', 'Alcance', 'Fuera de alcance', 'Criterios de aceptacion']) assert.ok(secciones(r).includes(s), s);
  assert.ok(r.includes('> sale en blanco') && r.includes('Userback ID 1'), 'nada de lo que habia se pierde');
  assert.ok(r.indexOf('## Objetivo') < r.indexOf('\n---\n'), 'lo nuevo va antes del pie');
  assert.deepStrictEqual(huecosDeIssue(r, 'bug'), [], 'queda con todas las secciones de un bug');
});

test('sin ninguna seccion de FARO: null (el llamador usa la plantilla entera)', () => {
  assert.strictEqual(completarPlantilla('dos lineas de texto', 'bug'), null);
});

test('tipo exento (reporte): no se toca', () => {
  assert.strictEqual(completarPlantilla(USERBACK, 'reporte'), USERBACK);
});
