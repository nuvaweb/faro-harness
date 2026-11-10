// #131 — RELEASE POR APP en un monorepo.
//
// Un monorepo FARO (#129) tiene varias apps, cada una con su package.json, su CHANGELOG.md y su
// ritmo. Antes, release.js solo leia la RAIZ: en un monorepo pnpm la raiz no tiene version, asi que
// versionActual() devolvia null y 'publicar' no tageaba nada (caso real: acme-aiops).
//
// Ahora la coherencia version <-> CHANGELOG <-> tag se exige POR APP: se publica solo la app que
// cambio desde SU ultimo tag ('{app}@{version}' por defecto), con su propio CHANGELOG y su propio
// Release. Una app sin cambios no se toca. Un tag heredado 'v0.2.0' (anterior al monorepo) se
// informa como ambiguo, sin romper. Y el repo simple / el motor siguen igual.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const require = createRequire(import.meta.url);
const releaseFactory = require(path.join(HOOKS, 'lib', 'release.js'));
const gitLibFactory = require(path.join(HOOKS, 'lib', 'git.js'));

const sh = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 60000 });
const gitCtx = (dir) => (...a) => { const r = sh(dir, ...a); return r.status === 0 ? (r.stdout || '').trim() : null; };
const release = (dir) => releaseFactory({ ROOT: dir, git: gitCtx(dir) });
const escribir = (dir, rel, txt) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, txt);
};
const commit = (dir, msg) => { sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', msg); };
const harness = (dir, ...args) => {
  const r = spawnSync(process.execPath, [HARNESS, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
};

const FARO = {
  teams: ['desarrollo'],
  monorepo: {
    apps: {
      api: { rol: 'API de metricas que sirve el panel', equipo: 'desarrollo' },
      web: { rol: 'Panel de operaciones', equipo: 'desarrollo' },
    },
    tag: '{app}@{version}',
  },
};
const pkg = (name, version) => JSON.stringify({ name, version }, null, 2);

// Fixture: el monorepo pnpm de monorepo-apps.test.mjs (2 apps + 1 paquete, gestion en la raiz) en un
// repo git con main/develop. Ya publicado una vez: api@1.2.0 y web@0.3.0 sobre main, y un tag
// HEREDADO v0.2.0 de cuando el repo aun no era monorepo.
function monorepoPublicado() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-relapp-'));
  sh(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) sh(dir, 'config', k, v);
  escribir(dir, 'README.md', '# mono\n');
  commit(dir, 'chore: repo antes del monorepo');
  sh(dir, 'tag', '-a', 'v0.2.0', '-m', '0.2.0');
  escribir(dir, '.faro.json', JSON.stringify(FARO, null, 2));
  escribir(dir, 'package.json', JSON.stringify({ name: 'mono', private: true }));
  escribir(dir, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  escribir(dir, 'apps/api/package.json', pkg('mono-api', '1.2.0'));
  escribir(dir, 'apps/api/CHANGELOG.md', '# Changelog — api\n\n## [Unreleased]\n\n## 1.2.0 — 2026-10-01\n\n- API inicial.\n');
  escribir(dir, 'apps/api/CLAUDE.md', '# api\n');
  escribir(dir, 'apps/api/src/index.ts', 'export default {};\n');
  escribir(dir, 'apps/web/package.json', pkg('mono-web', '0.3.0'));
  escribir(dir, 'apps/web/CHANGELOG.md', '# Changelog — web\n\n## [Unreleased]\n\n## 0.3.0 — 2026-10-01\n\n- Panel inicial.\n');
  escribir(dir, 'apps/web/CLAUDE.md', '# web\n');
  escribir(dir, 'apps/web/src/main.ts', 'export {};\n');
  escribir(dir, 'packages/shared/package.json', pkg('@mono/shared', '0.0.1'));
  commit(dir, 'feat: monorepo con api y web');
  sh(dir, 'tag', '-a', 'api@1.2.0', '-m', '1.2.0');
  sh(dir, 'tag', '-a', 'web@0.3.0', '-m', '0.3.0');
  sh(dir, 'tag', '-a', 'shared@0.0.1', '-m', '0.0.1');
  sh(dir, 'switch', '-q', '-c', 'develop');
  return dir;
}

// Trabajo nuevo SOLO en api, con su version y su CHANGELOG al dia (lo que deja /faro:changelog).
function conCambioEnApi(dir, { bump = true, entrada = true } = {}) {
  escribir(dir, 'apps/api/src/index.ts', 'export default { fetch() { return new Response("ok"); } };\n');
  if (bump) escribir(dir, 'apps/api/package.json', pkg('mono-api', '1.3.0'));
  if (entrada) escribir(dir, 'apps/api/CHANGELOG.md', '# Changelog — api\n\n## [Unreleased]\n\n## 1.3.0 — 2026-10-10\n\n- **Endpoint fetch** (#7): responde ok.\n\n## 1.2.0 — 2026-10-01\n\n- API inicial.\n');
  commit(dir, 'feat(api): endpoint fetch (#7)');
  return dir;
}

// publicar: merge --no-ff develop -> main y vuelta a develop (lo que hace cmdPublicar).
function mergeAMain(dir) {
  sh(dir, 'switch', '-q', 'main');
  sh(dir, 'merge', '-q', '--no-ff', 'develop', '-m', 'merge develop -> main');
  sh(dir, 'switch', '-q', 'develop');
}

const porApp = (plan, id) => plan.find((p) => p.app.id === id);

// ---------- release.js por app ----------

test('versionActual / changelogTieneVersion / notasDeVersion leen la app, no la raiz', () => {
  const dir = conCambioEnApi(monorepoPublicado());
  const r = release(dir);
  assert.strictEqual(r.versionActual('api'), '1.3.0');
  assert.strictEqual(r.versionActual('web'), '0.3.0');
  assert.strictEqual(r.versionActual(), null, 'la raiz del monorepo no declara version');
  assert.strictEqual(r.changelogTieneVersion('api').ok, true);
  assert.strictEqual(r.changelogTieneVersion('api').version, '1.3.0');
  const notas = r.notasDeVersion('1.3.0', 'api');
  assert.match(notas, /Endpoint fetch/);
  assert.doesNotMatch(notas, /API inicial/, 'no arrastra la version anterior');
  assert.strictEqual(r.notasDeVersion('1.3.0'), null, 'sin app, lee el CHANGELOG de la raiz (que no existe)');
});

test('el ultimo tag de cada app sale de SU plantilla ({app}@{version}), por SemVer', () => {
  const dir = monorepoPublicado();
  sh(dir, 'tag', '-a', 'api@1.10.0', '-m', 'x', 'main');
  const r = release(dir);
  assert.deepStrictEqual(r.ultimoTagDeApp('api'), { tag: 'api@1.10.0', version: '1.10.0' });
  assert.deepStrictEqual(r.ultimoTagDeApp('web'), { tag: 'web@0.3.0', version: '0.3.0' });
});

test('planApps: solo la app CAMBIADA desde su ultimo tag queda lista; la otra no se toca', () => {
  const dir = conCambioEnApi(monorepoPublicado());
  const plan = release(dir).planApps('HEAD');
  const api = porApp(plan, 'api');
  const web = porApp(plan, 'web');
  assert.strictEqual(api.estado, 'lista', JSON.stringify(api));
  assert.strictEqual(api.tag, 'api@1.3.0');
  assert.strictEqual(api.desde, 'api@1.2.0');
  assert.strictEqual(api.commits.length, 1);
  assert.strictEqual(api.sugerida, '1.3.0', 'la version declarada y sin tag es la del release');
  assert.strictEqual(web.estado, 'sin-cambios');
  assert.strictEqual(porApp(plan, 'shared').estado, 'sin-cambios');
});

test('publicar en el fixture: tagea SOLO la app cambiada, sobre main', () => {
  const dir = conCambioEnApi(monorepoPublicado());
  mergeAMain(dir);
  const r = release(dir);
  const res = r.tagearApps('main');
  assert.deepStrictEqual(res.filter((x) => x.ok && x.tag).map((x) => x.tag), ['api@1.3.0'], JSON.stringify(res));
  assert.strictEqual(gitCtx(dir)('rev-list', '-n', '1', 'api@1.3.0'), gitCtx(dir)('rev-parse', 'main'), 'el tag va sobre main');
  assert.strictEqual(gitCtx(dir)('tag', '-l', 'web@*'), 'web@0.3.0', 'web no tiene cambios: ningun tag nuevo');
  // Idempotente: reintentar no duplica ni rompe.
  const otra = r.tagearApps('main');
  assert.strictEqual(otra.filter((x) => x.tag === 'api@1.3.0' && !x.ok).length, 0, JSON.stringify(otra));
});

test('app cambiada SIN entrada en su CHANGELOG: la coherencia por app falla (no se publica)', () => {
  const dir = conCambioEnApi(monorepoPublicado(), { entrada: false });
  const r = release(dir);
  assert.strictEqual(porApp(r.planApps('HEAD'), 'api').estado, 'sin-changelog');
  const c = r.coherenciaApps('HEAD');
  assert.strictEqual(c.ok, false);
  assert.match(c.errores.join('\n'), /apps\/api\/CHANGELOG\.md.*1\.3\.0/);
});

test('app cambiada con su version YA tageada: se avisa y se sugiere el salto, no se tagea', () => {
  const dir = conCambioEnApi(monorepoPublicado(), { bump: false, entrada: false });
  const r = release(dir);
  const api = porApp(r.planApps('HEAD'), 'api');
  assert.strictEqual(api.estado, 'ya-tageada');
  assert.strictEqual(api.sugerida, '1.3.0', 'feat -> MINOR sobre la 1.2.0');
  const c = r.coherenciaApps('HEAD');
  assert.strictEqual(c.ok, true, 'no cancela: es un aviso');
  assert.match(c.avisos.join('\n'), /api.*1\.2\.0/);
});

test('tag heredado v0.2.0 en un monorepo: se reporta como ambiguo, no rompe', () => {
  const dir = conCambioEnApi(monorepoPublicado());
  const r = release(dir);
  assert.deepStrictEqual(r.tagsHeredados(), ['v0.2.0']);
  const { out, status } = harness(dir, 'release');
  assert.strictEqual(status, 0, out);
  assert.match(out, /v0\.2\.0.*ambiguo/i, out);
  assert.match(out, /api.*api@1\.3\.0/, out);
  assert.match(out, /web.*sin cambios/i, out);
});

test('harness release en monorepo: propone la version por app desde su [Unreleased]', () => {
  const dir = monorepoPublicado();
  escribir(dir, 'apps/web/src/main.ts', 'export const x = 1;\n');
  escribir(dir, 'apps/web/CHANGELOG.md', '# Changelog — web\n\n## [Unreleased]\n\n- **Arreglo** del panel.\n\n## 0.3.0 — 2026-10-01\n\n- Panel inicial.\n');
  commit(dir, 'fix(web): arreglo del panel');
  const { out } = harness(dir, 'release');
  assert.match(out, /web.*0\.3\.1/, out);
  assert.match(out, /Arreglo/, 'muestra lo acumulado en el [Unreleased] de la app');
  assert.match(out, /api.*sin cambios/i, out);
});

// ---------- no regresion ----------

test('repo simple: planApps vacio y release sin bloque por app', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-relsimple-'));
  sh(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) sh(dir, 'config', k, v);
  escribir(dir, 'package.json', pkg('simple', '1.0.0'));
  commit(dir, 'feat: base');
  sh(dir, 'tag', '-a', 'v1.0.0', '-m', '1.0.0');
  // Lo pendiente se mide contra main (#116): el trabajo sin publicar vive en develop, no en main.
  sh(dir, 'switch', '-q', '-c', 'develop');
  escribir(dir, 'a.txt', 'a');
  commit(dir, 'fix: algo');
  const r = release(dir);
  assert.deepStrictEqual(r.planApps('HEAD'), []);
  assert.deepStrictEqual(r.tagsHeredados(), []);
  assert.strictEqual(r.versionActual(), '1.0.0');
  const { out } = harness(dir, 'release');
  assert.match(out, /Acumulado desde v1\.0\.0/, out);
  assert.doesNotMatch(out, /por app|ambiguo/i, out);
});

// ---------- seguridad: inyeccion de argumentos en git (revision de #140) ----------
// El tag se construye con datos del REPO (version del package.json y plantilla de .faro.json) y va
// como argumento posicional a 'git tag'. Un valor que empiece por '-' git lo tomaria como OPCION.
// Sin shell no es inyeccion de comandos, pero si de argumentos: se valida y no se llama a git.

// git espia: registra cada llamada y delega en el git real.
function gitEspia(dir) {
  const llamadas = [];
  const g = gitCtx(dir);
  return { llamadas, git: (...a) => { llamadas.push(a); return g(...a); } };
}
const llamoATag = (llamadas, valor) => llamadas.some((a) => a[0] === 'tag' && a.includes(valor));

test('seguridad: version "--force" en una app -> sin tag, mensaje claro y git sin ese argumento', () => {
  const dir = monorepoPublicado();
  escribir(dir, 'apps/api/package.json', pkg('mono-api', '--force'));
  escribir(dir, 'apps/api/src/index.ts', 'export const y = 2;\n');
  commit(dir, 'feat(api): algo');
  const espia = gitEspia(dir);
  const r = releaseFactory({ ROOT: dir, git: espia.git });
  const res = r.tagVersionSiProcede('HEAD', 'api');
  assert.strictEqual(res.ok, false);
  assert.match(res.msg, /version.*no es SemVer|no valid/i, res.msg);
  const api = porApp(r.planApps('HEAD'), 'api');
  assert.strictEqual(api.estado, 'version-invalida');
  assert.strictEqual(api.tag, null);
  assert.strictEqual(r.coherenciaApps('HEAD').ok, false, 'una version invalida en una app cambiada bloquea');
  assert.deepStrictEqual(r.tagearApps('HEAD').filter((x) => x.ok), []);
  assert.ok(!llamoATag(espia.llamadas, '--force'), JSON.stringify(espia.llamadas.filter((a) => a[0] === 'tag')));
});

test('seguridad: plantilla "{version}" con version "--force" tampoco llega a git', () => {
  const dir = monorepoPublicado();
  escribir(dir, '.faro.json', JSON.stringify({ ...FARO, monorepo: { ...FARO.monorepo, tag: '{version}' } }, null, 2));
  escribir(dir, 'apps/api/package.json', pkg('mono-api', '--force'));
  commit(dir, 'feat(api): plantilla');
  const espia = gitEspia(dir);
  const r = releaseFactory({ ROOT: dir, git: espia.git });
  assert.strictEqual(r.tagVersionSiProcede('HEAD', 'api').ok, false);
  r.planApps('HEAD'); r.tagearApps('HEAD');
  assert.ok(!llamoATag(espia.llamadas, '--force'));
});

test('seguridad: una plantilla que produce un tag que empieza por "-" o con caracteres raros se rechaza', () => {
  const dir = monorepoPublicado();
  escribir(dir, '.faro.json', JSON.stringify({ ...FARO, monorepo: { ...FARO.monorepo, tag: '-{app}@{version}' } }, null, 2));
  escribir(dir, 'apps/api/package.json', pkg('mono-api', '1.3.0'));
  commit(dir, 'feat(api): x');
  const espia = gitEspia(dir);
  const r = releaseFactory({ ROOT: dir, git: espia.git });
  const res = r.tagVersionSiProcede('HEAD', 'api');
  assert.strictEqual(res.ok, false);
  assert.match(res.msg, /tag.*no valid|no es un nombre de tag/i, res.msg);
  assert.ok(!llamoATag(espia.llamadas, '-api@1.3.0'));
  escribir(dir, '.faro.json', JSON.stringify({ ...FARO, monorepo: { ...FARO.monorepo, tag: '{app} {version}' } }, null, 2));
  assert.strictEqual(releaseFactory({ ROOT: dir, git: gitCtx(dir) }).tagVersionSiProcede('HEAD', 'api').ok, false);
});

test('seguridad: repo simple con version "--force" -> sin tag y sin llamar a git tag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-relinj-'));
  sh(dir, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) sh(dir, 'config', k, v);
  escribir(dir, 'package.json', pkg('simple', '--force'));
  commit(dir, 'feat: base');
  const espia = gitEspia(dir);
  const r = releaseFactory({ ROOT: dir, git: espia.git });
  const res = r.tagVersionSiProcede('HEAD');
  assert.strictEqual(res.ok, false);
  assert.match(res.msg, /SemVer/, res.msg);
  assert.ok(!espia.llamadas.some((a) => a[0] === 'tag'), JSON.stringify(espia.llamadas));
});

// ---------- RUTAS_GESTION ----------

function ramaQueToca(cambios) {
  const dir = monorepoPublicado();
  sh(dir, 'switch', '-q', '-c', 'chore/release-api');
  for (const [rel, txt] of Object.entries(cambios)) escribir(dir, rel, txt);
  commit(dir, 'cambios');
  return gitLibFactory({ ROOT: dir, fs, path });
}

test('RUTAS_GESTION: el bump de version + CHANGELOG de una app es gestion (cierre de ciclo)', () => {
  const g = ramaQueToca({
    'apps/api/package.json': pkg('mono-api', '1.3.0'),
    'apps/api/CHANGELOG.md': '# Changelog — api\n\n## 1.3.0\n\n- x\n',
  });
  assert.strictEqual(g.ramaEsSoloGestion('develop'), true);
});

test('RUTAS_GESTION: tocar las dependencias de una app NO es gestion (es trabajo)', () => {
  const g = ramaQueToca({
    'apps/api/package.json': JSON.stringify({ name: 'mono-api', version: '1.2.0', dependencies: { hono: '^4.0.0' } }, null, 2),
  });
  assert.strictEqual(g.ramaEsSoloGestion('develop'), false);
});

// ---------- cableado ----------

test('publicar esta enchufado a la release por app (gate, tags, push y Release por app)', () => {
  const src = fs.readFileSync(HARNESS, 'utf8');
  const cuerpo = src.slice(src.indexOf('async function cmdPublicar()'), src.indexOf('// ---------- One-pager'));
  assert.match(cuerpo, /coherenciaApps\(/, 'gate de coherencia por app antes del merge');
  assert.match(cuerpo, /tagearApps\(main\)/, 'tags por app sobre main');
  assert.match(cuerpo, /notasDeVersion\([^)]*\.app\)/, 'notas del CHANGELOG de la app');
});
