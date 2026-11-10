// publicar cancelaba con un CHANGELOG en formato Keep a Changelog ('## [0.7.0] — fecha'): el gate y
// las notas del Release buscaban '## 0.7.0' literal (#68). El harness ya aceptaba '## [Unreleased]'
// con corchetes, pero no los encabezados de version. La salida que proponia el agente —quitar los
// corchetes del CHANGELOG del repo— arreglaba el sintoma en el sitio equivocado.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

async function repoCon(changelog, version = '0.7.0') {
  const dir = tmp('kac');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  const mod = await import(`file://${path.join(HOOKS, 'lib', 'release.js').replace(/\\/g, '/')}`);
  return (mod.default || mod)({ ROOT: dir, git: () => '' });
}
const doc = (cab) => `# Changelog\r\n\r\n## [Unreleased]\r\n\r\n${cab}\r\n\r\n- el cambio de esta version\r\n\r\n## [0.6.0] — 2026-09-01\r\n\r\n- lo anterior\r\n`;

for (const cab of ['## [0.7.0] — 2026-09-18', '## 0.7.0 — 2026-09-18', '## v0.7.0 - 2026-09-18', '## [v0.7.0] - 2026-09-18', '## [0.7.0]']) {
  test(`gate y notas reconocen '${cab}'`, async () => {
    const r = await repoCon(doc(cab));
    const chg = r.changelogTieneVersion();
    assert.strictEqual(chg.ok, true, chg.msg);
    assert.strictEqual(r.notasDeVersion('0.7.0'), '- el cambio de esta version', 'las notas son el bloque, sin cabecera ni la version siguiente');
  });
}

for (const cab of ['## [0.7.01] — 2026-09-18', '## [0.7.0-beta] — 2026-09-18', '## [10.7.0]']) {
  test(`'${cab}' NO cuenta como la version 0.7.0`, async () => {
    const r = await repoCon(doc(cab));
    assert.strictEqual(r.changelogTieneVersion().ok, false);
    assert.strictEqual(r.notasDeVersion('0.7.0'), null);
  });
}
