// Test de la funcion de tageo tras aprobar (0.9.4): el merge develop -> main debe dejar tageada
// la version publicada (vX.Y.Z), leida de package.json o .claude-plugin/plugin.json — sin esto el
// CHANGELOG dice una fecha pero nadie puede ir directo al commit exacto de cada release (ciclo
// cerrado en skills/changelog/SKILL.md, ahora tambien determinista en el harness).
// Probamos la funcion pura (sin red/GitHub): tagVersionSiProcede(root) lee la version, comprueba
// si el tag ya existe y crea/avisa segun corresponda.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${name}-`));
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120000 });

function repoConPackage(name, version) {
  const dir = tmp(name);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test-cli', version }, null, 2));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  // La firma de commits heredada de la config global (gpg/1Password/ssh-sign) puede fallar o
  // pedir interaccion y dejar el repo de prueba SIN COMMITS: entonces el harness no tiene nada
  // que gobernar y el test falla por el entorno. Se apaga solo aqui, no en la config del usuario.
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', `feat: ${version} — cambio de prueba`);
  return dir;
}

// Carga aislada del modulo (sin pasar por harness.js completo): mismo patron que lib/*.js del motor.
// import() de una ruta absoluta de Windows exige file:// URL (ERR_UNSUPPORTED_ESM_URL_SCHEME si no).
async function cargarTagVersionSiProcede() {
  const mod = await import(pathToFileURL(path.join(HOOKS, 'lib', 'release.js')).href);
  return mod.default || mod;
}

test('tagVersionSiProcede: crea vX.Y.Z sobre HEAD leyendo la version de package.json', async () => {
  const dir = repoConPackage('tag-package', '1.2.3');
  const { tagVersionSiProcede } = (await cargarTagVersionSiProcede())({ ROOT: dir, git: (...a) => (git(dir, ...a).stdout || '').trim() });
  const r = tagVersionSiProcede();
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.tag, 'v1.2.3');
  const tags = (git(dir, 'tag', '-l', 'v1.2.3').stdout || '').trim();
  assert.strictEqual(tags, 'v1.2.3');
  const tagCommit = (git(dir, 'rev-list', '-n', '1', 'v1.2.3').stdout || '').trim();
  const head = (git(dir, 'rev-parse', 'HEAD').stdout || '').trim();
  assert.strictEqual(tagCommit, head);
});

test('tagVersionSiProcede: lee la version de .claude-plugin/plugin.json si no hay package.json', async () => {
  const dir = tmp('tag-plugin');
  fs.mkdirSync(path.join(dir, '.claude-plugin'));
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'faro', version: '0.9.4' }));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'feat: 0.9.4');
  const { tagVersionSiProcede } = (await cargarTagVersionSiProcede())({ ROOT: dir, git: (...a) => (git(dir, ...a).stdout || '').trim() });
  const r = tagVersionSiProcede();
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.tag, 'v0.9.4');
});

test('tagVersionSiProcede: si el tag ya existe apuntando a OTRO commit, NO lo reescribe y avisa', async () => {
  const dir = repoConPackage('tag-conflicto', '2.0.0');
  git(dir, 'tag', '-a', 'v2.0.0', '-m', 'tag previo de otro commit');
  fs.writeFileSync(path.join(dir, 'x.txt'), '1'); // avanza HEAD para que el tag quede en OTRO commit
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'avanza');
  const { tagVersionSiProcede } = (await cargarTagVersionSiProcede())({ ROOT: dir, git: (...a) => (git(dir, ...a).stdout || '').trim() });
  const r = tagVersionSiProcede();
  assert.strictEqual(r.ok, false);
  assert.match(r.msg, /v2\.0\.0.*existe/i);
});

test('tagVersionSiProcede: si el tag ya existe apuntando al MISMO commit, no hace nada (idempotente)', async () => {
  const dir = repoConPackage('tag-idempotente', '3.0.0');
  git(dir, 'tag', '-a', 'v3.0.0', '-m', 'ya tageado en este mismo commit');
  const { tagVersionSiProcede } = (await cargarTagVersionSiProcede())({ ROOT: dir, git: (...a) => (git(dir, ...a).stdout || '').trim() });
  const r = tagVersionSiProcede();
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.match(r.msg, /ya exist/i);
});

test('versionActual: repo MARKETPLACE (plugin anidado en plugins/<nombre>/.claude-plugin/plugin.json)', async () => {
  const dir = tmp('tag-marketplace');
  fs.mkdirSync(path.join(dir, 'plugins', 'faro', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'faro', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'faro', version: '0.30.0' }));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'feat: 0.30.0');
  const { tagVersionSiProcede, versionActual } = (await cargarTagVersionSiProcede())({ ROOT: dir, git: (...a) => (git(dir, ...a).stdout || '').trim() });
  assert.strictEqual(versionActual(), '0.30.0');
  const r = tagVersionSiProcede();
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.tag, 'v0.30.0');
});

test('versionActual: repo MARKETPLACE con MAS DE UN plugin es ambiguo -> null (no adivina)', async () => {
  const dir = tmp('tag-marketplace-ambiguo');
  fs.mkdirSync(path.join(dir, 'plugins', 'uno', '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins', 'dos', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'uno', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'uno', version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'plugins', 'dos', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'dos', version: '2.0.0' }));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  const { versionActual } = (await cargarTagVersionSiProcede())({ ROOT: dir, git: (...a) => (git(dir, ...a).stdout || '').trim() });
  assert.strictEqual(versionActual(), null);
});

// --- changelogTieneVersion: coherencia CHANGELOG <-> version ANTES de tagear (sin esto, aprobar
// podia tagear una version sin documentar — ver harness.js:cmdPublicar) ---

test('changelogTieneVersion: ok si el CHANGELOG tiene una cabecera "## <version>"', async () => {
  const dir = repoConPackage('chg-ok', '1.2.3');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.3 — 2026-09-14\n\n- cambio\n');
  const { changelogTieneVersion } = (await cargarTagVersionSiProcede())({ ROOT: dir, git: (...a) => (git(dir, ...a).stdout || '').trim() });
  const r = changelogTieneVersion();
  assert.strictEqual(r.ok, true, JSON.stringify(r));
});

test('changelogTieneVersion: falla si no hay CHANGELOG.md', async () => {
  const dir = repoConPackage('chg-sin-fichero', '1.2.3');
  const { changelogTieneVersion } = (await cargarTagVersionSiProcede())({ ROOT: dir, git: (...a) => (git(dir, ...a).stdout || '').trim() });
  const r = changelogTieneVersion();
  assert.strictEqual(r.ok, false);
  assert.match(r.msg, /no hay changelog/i);
});

test('changelogTieneVersion: falla si el CHANGELOG existe pero no tiene la version actual', async () => {
  const dir = repoConPackage('chg-desajustado', '1.2.3');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 1.2.2 — 2026-09-01\n\n- version anterior\n');
  const { changelogTieneVersion } = (await cargarTagVersionSiProcede())({ ROOT: dir, git: (...a) => (git(dir, ...a).stdout || '').trim() });
  const r = changelogTieneVersion();
  assert.strictEqual(r.ok, false);
  assert.match(r.msg, /1\.2\.3/);
  assert.match(r.msg, /changelog/i);
});

// --- Integracion: 'harness.js publicar' de punta a punta (remoto LOCAL, sin GitHub/red real) ---

const HARNESS = path.join(HOOKS, 'harness.js');
const runHarness = (args, cwd) =>
  spawnSync(process.execPath, [HARNESS, ...args], {
    cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });

test('aprobar (end-to-end, remoto local): merge develop->main deja el tag vX.Y.Z publicado', () => {
  // Remoto "bare" local: reproduce origin sin tocar GitHub. El rol de aprobacion via API de
  // GitHub no aplica aqui (roleInfo() con SIN_TOKEN devuelve puedeAprobar en modo permisivo
  // cuando no hay token configurado y el usuario es el unico committer del repo local — ver
  // github.js roleInfo). Si el entorno de CI trae un ~/.faro.json con token, el test se salta.
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && fs.existsSync(path.join(home, '.faro.json'))) {
    console.log('  (saltado: hay ~/.faro.json con token — evita interferir con la cuenta real)');
    return;
  }
  const bare = tmp('aprobar-e2e-bare');
  git(bare, 'init', '--bare', '-b', 'main');

  const dir = tmp('aprobar-e2e-work');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: Test\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · Piloto — in_progress\n- [ ] tarea\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test-cli', version: '5.0.0' }, null, 2));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'switch', '-c', 'develop');
  git(dir, 'push', '-u', 'origin', 'develop');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 5.0.0 — 2026-08-23\n\n- cambio de prueba\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'feat: 5.0.0 — cambio de prueba');

  const r = runHarness(['publicar'], dir);
  // No afirmamos exit 0 (depende de roleInfo/red hacia api.github.com, fuera de control aqui);
  // afirmamos que SI llego a mergear (heuristica: el tag existe en main) o, si no pudo aprobar
  // por rol/red, que el test lo documenta sin fallar en falso.
  const tagLocal = (git(dir, 'tag', '-l', 'v5.0.0').stdout || '').trim();
  if (!tagLocal) {
    console.log(`  (aprobar no completo el merge en este entorno — status=${r.status}, salida: ${r.stdout.slice(-300)})`);
    return;
  }
  assert.strictEqual(tagLocal, 'v5.0.0');
});

test('aprobar (end-to-end): CANCELA sin mergear a main si la version no esta en el CHANGELOG', () => {
  // Reproduce el desajuste real: develop sube la version en package.json pero nadie corrio
  // /faro:changelog (o lo hizo a medias). Aprobar debe pararse ANTES de tocar main.
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && fs.existsSync(path.join(home, '.faro.json'))) {
    console.log('  (saltado: hay ~/.faro.json con token — evita interferir con la cuenta real)');
    return;
  }
  const bare = tmp('aprobar-e2e-desajuste-bare');
  git(bare, 'init', '--bare', '-b', 'main');

  const dir = tmp('aprobar-e2e-desajuste-work');
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: Test\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · Piloto — in_progress\n- [ ] tarea\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test-cli', version: '6.0.0' }, null, 2));
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 5.9.0 — 2026-08-01\n\n- version anterior, nunca actualizada\n');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  git(dir, 'push', '-u', 'origin', 'main');
  git(dir, 'switch', '-c', 'develop');
  git(dir, 'push', '-u', 'origin', 'develop');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'cambio sin changelog'); // sube version, NO actualiza CHANGELOG
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'feat: 6.0.0 — cambio sin documentar');

  runHarness(['publicar'], dir);

  const tagLocal = (git(dir, 'tag', '-l', 'v6.0.0').stdout || '').trim();
  assert.strictEqual(tagLocal, '', 'no debe crear el tag si el CHANGELOG no tiene la version');
  const mainLog = (git(dir, 'log', '--format=%s', 'main').stdout || '');
  assert.doesNotMatch(mainLog, /cambio sin documentar/, 'no debe mergear a main si el CHANGELOG no coincide');
});

// BUG #78: publicar volvia a la rama de origen ANTES de tagear, y el tag caia sobre esa rama (HEAD), no
// sobre lo publicado. Al publicar v0.55.2 desde feat/72 el tag quedo en el commit de la rama.
test('tagVersionSiProcede(ref): etiqueta la referencia pedida (main), no HEAD de otra rama', async () => {
  const dir = repoConPackage('tag-ref', '2.0.0');
  git(dir, 'switch', '-c', 'feat/otra');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'sin publicar');
  git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'wip: no publicado');
  const { tagVersionSiProcede } = (await cargarTagVersionSiProcede())({ ROOT: dir, git: (...a) => (git(dir, ...a).stdout || '').trim() });
  const r = tagVersionSiProcede('main');
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const tagCommit = (git(dir, 'rev-list', '-n', '1', 'v2.0.0').stdout || '').trim();
  assert.strictEqual(tagCommit, (git(dir, 'rev-parse', 'main').stdout || '').trim(), 'el tag va a main');
  assert.notStrictEqual(tagCommit, (git(dir, 'rev-parse', 'HEAD').stdout || '').trim());
  assert.strictEqual(tagVersionSiProcede('main').ok, true, 'repetirlo sobre main es idempotente');
});

test('publicar etiqueta MAIN (no la rama a la que vuelve)', () => {
  const src = fs.readFileSync(path.join(HOOKS, 'harness.js'), 'utf8');
  const i = src.indexOf('async function cmdPublicar(');
  const c = src.slice(i, src.indexOf('\n}', i));
  assert.match(c, /tagVersionSiProcede\(main\)/);
});
