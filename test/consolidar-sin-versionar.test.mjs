// #117 — consolidar commiteaba ficheros SIN VERSIONAR (git add -A) y los subia a develop sin preguntar.
// Caso real (2026-10-05): tres exports locales de n8n entraron en develop -y de ahi en main- en un commit
// "chore: cambios pendientes" que nadie pidio. publicar tenia la misma salvaguarda.
//
// Regla: un fichero que nadie ha decidido versionar NO entra solo. Se para y se dice cuales son.
// Lo ya versionado (modificado) si se sigue recogiendo, con 'add -u'.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { ficherosSinVersionar, avisoSinVersionar } = require(path.join(HOOKS, 'lib', 'git.js'));
const fuente = fs.readFileSync(path.join(HOOKS, 'harness.js'), 'utf8');
const cuerpo = (nombre) => {
  const i = fuente.indexOf(`function ${nombre}(`);
  const j = fuente.indexOf('\nfunction ', i + 1);
  const k = fuente.indexOf('\nasync function ', i + 1);
  return fuente.slice(i, Math.min(...[j, k].filter((x) => x > 0)));
};

test('detecta SOLO los ficheros sin versionar (??), no los modificados', () => {
  const porcelain = [' M CHANGELOG.md', '?? n8n/userback-a-issue-v3.json', 'A  nuevo-ya-anadido.md', '?? "con espacios/flujo v2.json"', ''].join('\n');
  assert.deepStrictEqual(ficherosSinVersionar(porcelain), ['n8n/userback-a-issue-v3.json', 'con espacios/flujo v2.json']);
  assert.deepStrictEqual(ficherosSinVersionar(''), []);
  assert.deepStrictEqual(ficherosSinVersionar(null), []);
});

test('el aviso dice cuales son y que hacer (versionarlos con su commit o .gitignore)', () => {
  const t = avisoSinVersionar(['n8n/a.json', 'n8n/b.json'], 'CONSOLIDACION');
  assert.match(t, /CONSOLIDACION PARADA/);
  assert.match(t, /2 fichero\(s\) SIN VERSIONAR/);
  assert.match(t, /n8n\/a\.json/);
  assert.match(t, /\.gitignore/);
  assert.match(t, /rama de trabajo/);
});

test('consolidar: para ANTES de integrar si hay ficheros sin versionar, y ya no usa add -A', () => {
  const c = cuerpo('cmdConsolidar');
  assert.ok(c.length > 100, 'no encuentro cmdConsolidar');
  assert.ok(!/git\('add', '-A'\)/.test(c), 'consolidar no puede volver a commitear a ciegas con add -A');
  const iSin = c.indexOf('ficherosSinVersionar');
  const iMerge = c.indexOf("'merge', '--no-ff'");
  assert.ok(iSin > 0 && iSin < iMerge, 'la comprobacion tiene que ir ANTES del primer merge');
  assert.match(c, /git\('add', '-u'\)/, 'lo ya versionado se sigue recogiendo, con add -u');
});

test('publicar: comprueba los sin versionar ANTES de archivar (el archivado crea ficheros nuevos a proposito)', () => {
  const c = cuerpo('cmdPublicar');
  assert.ok(c.length > 100, 'no encuentro cmdPublicar');
  const iSin = c.indexOf('ficherosSinVersionar');
  const iArch = c.indexOf('archiveChange');
  assert.ok(iSin > 0 && (iArch < 0 || iSin < iArch), 'la comprobacion tiene que ir ANTES de archivar');
});
