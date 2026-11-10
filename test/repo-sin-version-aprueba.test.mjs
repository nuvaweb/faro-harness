// Un repo SIN version (gestion/documentacion) tiene que poder aprobarse.
//
// Caso real reportado: un repo de gestion —sin package.json ni .claude-plugin/plugin.json en la
// RAIZ, porque no es un paquete node ni un plugin, sino la raiz autonoma de un trabajo— no podia
// aprobar. 'versionActual()' devolvia null y el gate de coherencia CHANGELOG<->version cancelaba
// TODA la aprobacion con "no se encontro version... nada que comprobar".
//
// El mensaje se contradecia a si mismo: si no hay nada que comprobar, no hay incoherencia que
// bloquear. Sin version el chequeo NO APLICA: se sigue con el merge y simplemente no se tagea
// (tagVersionSiProcede ya contemplaba ese caso; el gate no).
//
// Lo que SI debe seguir bloqueando: hay version y el CHANGELOG no la documenta — ahi si hay
// incoherencia real entre lo que se publica y lo que se dice que se publica.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

async function cargar(root) {
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'release.js').replace(/\\/g, '/')}`);
  return (mod.default || mod)({ ROOT: root, git: () => '' });
}

test('repo SIN version (gestion/documentacion): el gate NO bloquea — no aplica', async () => {
  const dir = tmp('sin-version');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## Cambios recientes\n\n- algo\n');
  const r = await cargar(dir);
  const chg = r.changelogTieneVersion();
  assert.strictEqual(chg.ok, true, `no hay version que comprobar, no puede haber incoherencia:\n${chg.msg}`);
  assert.strictEqual(chg.version, null, 'y se dice explicitamente que no hay version');
});

test('repo SIN version y SIN CHANGELOG: tampoco bloquea (no hay nada que cuadrar)', async () => {
  const dir = tmp('sin-nada');
  const r = await cargar(dir);
  assert.strictEqual(r.changelogTieneVersion().ok, true);
});

test('repo CON version y CHANGELOG que la documenta: pasa, como siempre', async () => {
  const dir = tmp('con-version-ok');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.0' }));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.0 — 2026-09-19\n\n- algo\n');
  const r = await cargar(dir);
  const chg = r.changelogTieneVersion();
  assert.strictEqual(chg.ok, true, chg.msg);
  assert.strictEqual(chg.version, '1.2.0');
});

test('repo CON version pero el CHANGELOG NO la documenta: SIGUE bloqueando (incoherencia real)', async () => {
  const dir = tmp('con-version-sin-entrada');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.3.0' }));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.0 — 2026-09-18\n\n- lo viejo\n');
  const r = await cargar(dir);
  const chg = r.changelogTieneVersion();
  assert.strictEqual(chg.ok, false, 'publicar 1.3.0 sin documentarla es justo lo que el gate existe para evitar');
  assert.match(chg.msg, /1\.3\.0/, chg.msg);
});

test('repo CON version y SIN CHANGELOG: SIGUE bloqueando (hay algo que publicar y nada que lo cuente)', async () => {
  const dir = tmp('con-version-sin-changelog');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.4.0' }));
  const r = await cargar(dir);
  assert.strictEqual(r.changelogTieneVersion().ok, false);
});

test('sin version, tagVersionSiProcede tampoco tagea: coherente con el gate (no hay que inventar nada)', async () => {
  const dir = tmp('sin-version-tag');
  const r = await cargar(dir);
  const t = r.tagVersionSiProcede();
  assert.strictEqual(t.tag, undefined, `no hay version -> no hay tag: ${JSON.stringify(t)}`);
});
