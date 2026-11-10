// Autochequeo de ESTE repo (el motor): la version de plugin.json debe tener su entrada en
// CHANGELOG.md. Es el mismo requisito que aprobar-changelog-coherente exige a los repos de trabajo
// via cmdPublicar() — pero este repo no tiene 'develop' y nunca pasa por ahi (se aprueba por PR directo
// a main). Sin este test, npm test (la red de seguridad que .gitlab-ci.yml corre en cada MR/main) no
// detectaria una version subida sin su entrada de CHANGELOG. Reutiliza changelogTieneVersion(), ya
// probada por sus propios tests unitarios en aprobar-tag.test.mjs — este test es un fitness function
// de ESTE repo concreto, no un test de la funcion en si.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(ROOT, 'plugins', 'faro', 'hooks');

test('motor: CHANGELOG.md documenta la version actual de plugin.json', async () => {
  const mod = await import(pathToFileURL(path.join(HOOKS, 'lib', 'release.js')).href);
  const releaseMod = mod.default || mod;
  const { changelogTieneVersion, versionActual } = releaseMod({ ROOT, git: () => '' });
  const version = versionActual();
  const r = changelogTieneVersion();
  assert.strictEqual(r.ok, true, `plugin.json esta en ${version} pero CHANGELOG.md no tiene '## ${version}': ${r.msg}`);
});
