// #18 — Caché en el CI generado: dependencias por gestor detectado (clave = lockfile), resultados de
// Turborepo/Nx (reutiliza tareas ya validadas) y providers de Terraform, en GitHub y en GitLab.
// Sin lockfile no hay caché: setup-node/setup-python fallan si se les pide cachear sin él.
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
const codeModule = require(path.join(HOOKS, 'lib', 'code.js'));

function repo(ficheros) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-ci-cache-'));
  for (const [rel, txt] of Object.entries(ficheros)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  }
  return dir;
}
const PKG = JSON.stringify({ name: 'a', scripts: { test: 'echo t' } });
const generar = (dir, remoto) => {
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true });
  git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', remoto);
  if (!fs.existsSync(path.join(dir, '.git', 'config'))) throw new Error('git init');
  const r = spawnSync(process.execPath, [HARNESS, 'ci'], { cwd: dir, encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const rel = /gitlab/.test(remoto) ? '.gitlab-ci.yml' : path.join('.github', 'workflows', 'ci.yml');
  return fs.readFileSync(path.join(dir, rel), 'utf8');
};
const GH = 'git@github.com:org/r.git';
const GL = 'git@gitlab.com:g/r.git';

// ---------- dependencias: el plan ----------

test('npm y yarn con lockfile: setup-node cachea y GitLab guarda la caché del gestor', () => {
  const casos = [
    ['npm', 'package-lock.json', '.npm', 'npm_config_cache'],
    ['yarn', 'yarn.lock', '.yarn-cache', 'YARN_CACHE_FOLDER'],
  ];
  for (const [pm, lock, carpeta, variable] of casos) {
    const rt = codeModule(repo({ 'package.json': PKG, [lock]: '{}\n' })).ciPlan().runtime;
    assert.strictEqual(rt.ghSetup.with.cache, pm, pm);
    assert.deepStrictEqual(rt.gitlabCache, { key: lock, paths: [carpeta] }, pm);
    assert.strictEqual(rt.gitlabVars[variable], `$CI_PROJECT_DIR/${carpeta}`, pm);
  }
});

test('npm SIN lockfile: no se pide caché (setup-node fallaría)', () => {
  const rt = codeModule(repo({ 'package.json': PKG })).ciPlan().runtime;
  assert.ok(!rt.ghSetup.with.cache, JSON.stringify(rt));
  assert.ok(!rt.gitlabCache, JSON.stringify(rt));
});

test('otros stacks: cada setup cachea con su mecanismo nativo y GitLab con su carpeta', () => {
  const casos = [
    [{ 'requirements.txt': 'x\n' }, 'actions/setup-python@v7', { cache: 'pip' }, 'requirements.txt', 'PIP_CACHE_DIR'],
    [{ 'pom.xml': '<p/>\n' }, 'actions/setup-java@v6', { cache: 'maven' }, 'pom.xml', 'MAVEN_OPTS'],
    [{ 'build.gradle': '\n' }, 'actions/setup-java@v6', { cache: 'gradle' }, 'build.gradle', 'GRADLE_USER_HOME'],
    [{ 'go.mod': 'module a\n', 'go.sum': '\n' }, 'actions/setup-go@v7', {}, 'go.sum', 'GOMODCACHE'],
    [{ Gemfile: '\n', 'Gemfile.lock': '\n' }, 'ruby/setup-ruby@v1', { 'bundler-cache': true }, 'Gemfile.lock', 'BUNDLE_PATH'],
  ];
  for (const [fich, uses, conCache, lock, variable] of casos) {
    const rt = codeModule(repo(fich)).ciPlan().runtime;
    assert.strictEqual(rt.ghSetup.uses, uses, lock);
    for (const [k, v] of Object.entries(conCache)) assert.strictEqual(rt.ghSetup.with[k], v, `${lock}: ${k}`);
    assert.strictEqual(rt.gitlabCache.key, lock, lock);
    assert.ok(rt.gitlabVars[variable], `${lock}: ${JSON.stringify(rt.gitlabVars)}`);
  }
});

test('python con solo pyproject.toml: cachea pip apuntando a pyproject; con uv.lock o poetry.lock, no', () => {
  const rt = codeModule(repo({ 'pyproject.toml': '[project]\n' })).ciPlan().runtime;
  assert.strictEqual(rt.ghSetup.with.cache, 'pip');
  assert.strictEqual(rt.ghSetup.with['cache-dependency-path'], 'pyproject.toml');
  for (const lock of ['uv.lock', 'poetry.lock']) {
    const r2 = codeModule(repo({ 'pyproject.toml': '[project]\n', [lock]: '\n' })).ciPlan().runtime;
    assert.ok(!r2.ghSetup.with.cache, lock);
    assert.ok(!r2.gitlabCache, lock);
  }
});

// ---------- YAML ----------

test('YAML GitHub npm: setup-node con cache: npm', () => {
  const yml = generar(repo({ 'package.json': PKG, 'package-lock.json': '{}\n' }), GH);
  assert.match(yml, /uses: actions\/setup-node@v7\n {8}with:\n(?: {10}.+\n)*? {10}cache: npm\n/, yml);
});

test('YAML GitLab npm: variable de caché del gestor y cache por lockfile', () => {
  const yml = generar(repo({ 'package.json': PKG, 'package-lock.json': '{}\n' }), GL);
  assert.match(yml, /^ {4}npm_config_cache: "\$CI_PROJECT_DIR\/\.npm"$/m, yml);
  assert.match(yml, /^ {2}cache:\n {4}key:\n {6}files:\n {8}- package-lock\.json\n {4}paths:\n {6}- \.npm$/m, yml);
});

// ---------- Turborepo / Nx: reutilizar tareas ya validadas ----------

test('turbo.json: GitHub restaura .turbo/cache (clave por commit, restore de la última) y GitLab la guarda por rama', () => {
  const fich = { 'package.json': PKG, 'package-lock.json': '{}\n', 'turbo.json': '{}\n' };
  const gh = generar(repo(fich), GH);
  assert.match(gh, /uses: actions\/cache@v6\n {8}with:\n {10}path: \.turbo\/cache\n {10}key: turbo-\$\{\{ runner\.os \}\}-\$\{\{ github\.sha \}\}\n {10}restore-keys: turbo-\$\{\{ runner\.os \}\}-\n/, gh);
  assert.ok(gh.indexOf('actions/cache@v6') < gh.indexOf('run: npm ci'), 'la caché se restaura antes de los gates');
  const gl = generar(repo(fich), GL);
  assert.match(gl, /^ {2}cache:\n {4}- key:\n {8}files:\n {10}- package-lock\.json\n {6}paths:\n {8}- \.npm\n {4}- key: turbo-\$CI_COMMIT_REF_SLUG\n {6}fallback_keys:\n {8}- turbo-\$CI_DEFAULT_BRANCH\n {6}paths:\n {8}- \.turbo\/cache$/m, gl);
});

test('nx.json: la caché de tareas es .nx/cache', () => {
  const rt = codeModule(repo({ 'package.json': PKG, 'nx.json': '{}\n' })).ciPlan().runtime;
  assert.deepStrictEqual(rt.cacheTareas, { id: 'nx', dir: '.nx/cache' });
});

test('sin Turborepo ni Nx no hay caché de tareas', () => {
  const rt = codeModule(repo({ 'package.json': PKG, 'package-lock.json': '{}\n' })).ciPlan().runtime;
  assert.ok(!rt.cacheTareas);
});

// ---------- Terraform: providers ----------

const TF = { 'package.json': PKG, 'infra/main.tf': 'terraform {}\n', 'infra/.terraform.lock.hcl': '# lock\n' };

test('YAML GitHub IaC: providers de Terraform en caché por el lock, sin credenciales', () => {
  const yml = generar(repo(TF), GH);
  const iac = yml.slice(yml.indexOf('\n  iac:'));
  assert.match(iac, /TF_PLUGIN_CACHE_DIR=\$RUNNER_TEMP\/tf-plugins/, iac);
  assert.match(iac, /uses: actions\/cache@v6\n {8}with:\n {10}path: \$\{\{ runner\.temp \}\}\/tf-plugins\n {10}key: tf-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('\*\*\/\.terraform\.lock\.hcl'\) \}\}\n/, iac);
  assert.ok(iac.indexOf('tf-plugins') < iac.indexOf('init -backend=false'), 'la caché va antes del init');
  assert.doesNotMatch(iac, /secrets\./);
});

test('YAML GitLab IaC: TF_PLUGIN_CACHE_DIR y cache por el lock del directorio de Terraform', () => {
  const yml = generar(repo(TF), GL);
  const job = yml.slice(yml.indexOf('iac-terraform:'));
  assert.match(job, /^ {4}TF_PLUGIN_CACHE_DIR: "\$CI_PROJECT_DIR\/\.terraform-plugins"$/m, job);
  assert.match(job, /^ {2}cache:\n {4}key:\n {6}files:\n {8}- infra\/\.terraform\.lock\.hcl\n {4}paths:\n {6}- \.terraform-plugins$/m, job);
  assert.match(job, /- mkdir -p "\$TF_PLUGIN_CACHE_DIR"/, job);
});

// ---------- CI ya existente ----------

test('ci con CI existente (npm): el aviso de «mergea a mano» incluye la caché', () => {
  const gh = repo({ 'package.json': PKG, 'package-lock.json': '{}\n', '.github/workflows/ci.yml': 'name: propio\n' });
  generarSinLeer(gh, GH, /cache: npm/);
  const gl = repo({ 'package.json': PKG, 'package-lock.json': '{}\n', '.gitlab-ci.yml': 'stages: [x]\n' });
  generarSinLeer(gl, GL, /npm_config_cache/);
});
function generarSinLeer(dir, remoto, esperado) {
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, windowsHide: true });
  spawnSync('git', ['remote', 'add', 'origin', remoto], { cwd: dir, windowsHide: true });
  const r = spawnSync(process.execPath, [HARNESS, 'ci'], { cwd: dir, encoding: 'utf8', timeout: 120000, windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  assert.match(r.stdout + r.stderr, esperado, r.stdout + r.stderr);
}
