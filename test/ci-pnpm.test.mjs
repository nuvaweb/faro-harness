// #143 — El CI que genera `harness.js ci` para un repo pnpm (simple o monorepo) HABILITA pnpm en el
// runner antes de `pnpm install --frozen-lockfile`. Un runner limpio no trae pnpm: sin este paso el
// workflow fallaba con "pnpm: command not found".
//
// GitHub Actions: `pnpm/action-setup` ANTES de `actions/setup-node` (que cachea con `cache: pnpm`).
// Sin `version:` cuando package.json declara `packageManager` (la accion la lee de ahi).
// GitLab: corepack en before_script y cache del store de pnpm keyed por el lockfile.
//
// Y el reverso: el CI de npm/yarn no cambia.
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

const escribir = (dir, rel, txt) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, txt);
};
const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const harness = (dir, ...args) => {
  const r = spawnSync(process.execPath, [HARNESS, ...args], { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  return { out: r.stdout + r.stderr, status: r.status };
};
const iniciarGit = (dir, remoto) => {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', remoto);
};

// Repo simple: package.json con scripts y el gestor que se pida.
function simple({ pm = 'pnpm', packageManager } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-ci-pnpm-'));
  escribir(dir, 'package.json', JSON.stringify({ name: 'simple', ...(packageManager ? { packageManager } : {}), scripts: { lint: 'echo l', test: 'echo t' } }));
  if (pm === 'pnpm') escribir(dir, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  if (pm === 'yarn') escribir(dir, 'yarn.lock', '# yarn\n');
  if (pm === 'npm') escribir(dir, 'package-lock.json', '{}\n');
  return dir;
}
// Monorepo pnpm minimo (dos apps con scripts), con packageManager en la raiz.
function monorepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-ci-pnpm-mono-'));
  escribir(dir, 'package.json', JSON.stringify({ name: 'mono', private: true, packageManager: 'pnpm@11.0.0' }));
  escribir(dir, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n');
  escribir(dir, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  escribir(dir, 'apps/api/package.json', JSON.stringify({ name: 'mono-api', version: '1.0.0', scripts: { test: 'echo t' } }));
  escribir(dir, 'apps/web/package.json', JSON.stringify({ name: 'mono-web', version: '1.0.0', scripts: { lint: 'echo l' } }));
  escribir(dir, '.faro.json', JSON.stringify({ monorepo: { apps: { api: { rol: 'API' }, web: { rol: 'Panel' } } } }));
  return dir;
}

// Indice de la primera linea que casa; -1 si ninguna.
const linea = (yml, re) => yml.split('\n').findIndex((l) => re.test(l));

// ---------- ciPlan ----------

test('ciPlan pnpm simple con packageManager: pnpm/action-setup sin version, setup-node con cache pnpm, corepack en GitLab', () => {
  const plan = codeModule(simple({ packageManager: 'pnpm@11.0.0' })).ciPlan();
  assert.strictEqual(plan.install, 'pnpm install --frozen-lockfile');
  const pre = plan.runtime.ghPre;
  assert.ok(Array.isArray(pre) && pre.length === 1, JSON.stringify(plan.runtime));
  assert.match(pre[0].uses, /^pnpm\/action-setup@v\d+$/);
  assert.ok(!pre[0].with || !('version' in pre[0].with), 'con packageManager la accion lee la version de package.json');
  assert.strictEqual(plan.runtime.ghSetup.with.cache, 'pnpm');
  assert.ok(plan.runtime.gitlabBefore.some((l) => /corepack enable/.test(l)), JSON.stringify(plan.runtime.gitlabBefore));
  assert.ok(!plan.runtime.gitlabBefore.some((l) => /corepack prepare/.test(l)), 'con packageManager corepack ya sabe la version');
  assert.ok(plan.runtime.gitlabBefore.some((l) => /store-dir \.pnpm-store/.test(l)));
  assert.deepStrictEqual(plan.runtime.gitlabCache, { key: 'pnpm-lock.yaml', paths: ['.pnpm-store'] });
});

test('ciPlan pnpm simple SIN packageManager: la accion necesita version y corepack la prepara', () => {
  const plan = codeModule(simple()).ciPlan();
  assert.ok(plan.runtime.ghPre[0].with && plan.runtime.ghPre[0].with.version, JSON.stringify(plan.runtime.ghPre));
  assert.ok(plan.runtime.gitlabBefore.some((l) => /corepack prepare pnpm@\S+ --activate/.test(l)), JSON.stringify(plan.runtime.gitlabBefore));
});

test('ciPlan monorepo pnpm: tambien habilita pnpm (y conserva el filtro de apps de #130)', () => {
  const plan = codeModule(monorepo()).ciPlan();
  assert.strictEqual(plan.mode, 'monorepo');
  assert.strictEqual(plan.filtroCambios, 'FARO_FILTRO');
  assert.match(plan.runtime.ghPre[0].uses, /^pnpm\/action-setup@/);
  assert.strictEqual(plan.runtime.ghSetup.with.cache, 'pnpm');
  assert.ok(plan.runtime.gitlabBefore.some((l) => /corepack enable/.test(l)));
});

test('NO REGRESION: ciPlan npm y yarn no llevan pasos de pnpm ni cache nueva', () => {
  for (const pm of ['npm', 'yarn']) {
    const plan = codeModule(simple({ pm })).ciPlan();
    assert.ok(!plan.runtime.ghPre || !plan.runtime.ghPre.length, `${pm}: ${JSON.stringify(plan.runtime)}`);
    assert.deepStrictEqual(plan.runtime.ghSetup, { uses: 'actions/setup-node@v7', with: { 'node-version': '22' } }, pm);
    assert.ok(!plan.runtime.gitlabBefore || !plan.runtime.gitlabBefore.length, pm);
    assert.ok(!plan.runtime.gitlabCache, pm);
  }
});

// ---------- YAML generado ----------

test('ci GitHub (pnpm simple): pnpm/action-setup va antes de setup-node y de pnpm install', () => {
  const dir = simple({ packageManager: 'pnpm@11.0.0' });
  iniciarGit(dir, 'git@github.com:org/simple.git');
  const r = harness(dir, 'ci');
  assert.strictEqual(r.status, 0, r.out);
  const yml = fs.readFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'utf8');
  const iPnpm = linea(yml, /uses: pnpm\/action-setup@/);
  const iNode = linea(yml, /uses: actions\/setup-node@/);
  const iInstall = linea(yml, /run: pnpm install --frozen-lockfile/);
  assert.ok(iPnpm >= 0 && iPnpm < iNode && iNode < iInstall, yml);
  assert.match(yml, /cache: pnpm/, yml);
  assert.doesNotMatch(yml, /^\s+version:/m, 'sin version: la lee de packageManager');
});

test('ci GitHub (monorepo pnpm): habilita pnpm y mantiene el filtro', () => {
  const dir = monorepo();
  iniciarGit(dir, 'git@github.com:org/mono.git');
  const r = harness(dir, 'ci');
  assert.strictEqual(r.status, 0, r.out);
  const yml = fs.readFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(linea(yml, /uses: pnpm\/action-setup@/) < linea(yml, /uses: actions\/setup-node@/), yml);
  assert.ok(linea(yml, /uses: pnpm\/action-setup@/) >= 0, yml);
  assert.match(yml, /--filter=\.\.\.\[origin\//, yml);
});

test('ci GitLab (pnpm simple y monorepo): corepack en before_script y cache del store', () => {
  for (const dir of [simple({ packageManager: 'pnpm@11.0.0' }), monorepo()]) {
    iniciarGit(dir, 'git@gitlab.com:grupo/repo.git');
    const r = harness(dir, 'ci');
    assert.strictEqual(r.status, 0, r.out);
    const yml = fs.readFileSync(path.join(dir, '.gitlab-ci.yml'), 'utf8');
    const iBefore = linea(yml, /^ {2}before_script:/);
    const iCorepack = linea(yml, /- corepack enable/);
    const iInstall = linea(yml, /- pnpm install --frozen-lockfile/);
    assert.ok(iBefore >= 0 && iBefore < iCorepack && iCorepack < iInstall, yml);
    assert.match(yml, /^ {2}cache:\n {4}key:\n {6}files:\n {8}- pnpm-lock\.yaml\n {4}paths:\n {6}- \.pnpm-store$/m, yml);
  }
});

test('NO REGRESION: el CI generado para npm no cambia (ni pnpm/action-setup ni before_script)', () => {
  const gh = simple({ pm: 'npm' });
  iniciarGit(gh, 'git@github.com:org/n.git');
  assert.strictEqual(harness(gh, 'ci').status, 0);
  const y1 = fs.readFileSync(path.join(gh, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.doesNotMatch(y1, /pnpm|cache:/, y1);
  assert.match(y1, /- run: npm ci/, y1);
  const gl = simple({ pm: 'npm' });
  iniciarGit(gl, 'git@gitlab.com:g/n.git');
  assert.strictEqual(harness(gl, 'ci').status, 0);
  const y2 = fs.readFileSync(path.join(gl, '.gitlab-ci.yml'), 'utf8');
  assert.doesNotMatch(y2, /before_script|corepack|cache:/, y2);
});
