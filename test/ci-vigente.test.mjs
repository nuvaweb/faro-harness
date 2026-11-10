// #155 — CI generado con las acciones en su versión mayor vigente (verificada en la fuente el
// 2026-10-11), aviso de «mergea a mano» completo y workflow del labeler en monorepo GitHub.
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
};
const harness = (dir, ...args) => {
  const r = spawnSync(process.execPath, [HARNESS, ...args], { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
  return { out: r.stdout + r.stderr, status: r.status };
};
const iniciar = (dir, remoto) => { git(dir, 'init', '-q', '-b', 'main'); git(dir, 'remote', 'add', 'origin', remoto); };

function simple(pm) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-ci-vig-'));
  escribir(dir, 'package.json', JSON.stringify({ name: 's', ...(pm === 'pnpm' ? { packageManager: 'pnpm@11.0.0' } : {}), scripts: { lint: 'echo l', test: 'echo t' } }));
  escribir(dir, { npm: 'package-lock.json', yarn: 'yarn.lock', pnpm: 'pnpm-lock.yaml' }[pm], pm === 'npm' ? '{}\n' : '# lock\n');
  return dir;
}
function monorepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-ci-vig-mono-'));
  escribir(dir, 'package.json', JSON.stringify({ name: 'mono', private: true, packageManager: 'pnpm@11.0.0' }));
  escribir(dir, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n');
  escribir(dir, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  escribir(dir, 'apps/api/package.json', JSON.stringify({ name: 'mono-api', version: '1.0.0', scripts: { test: 'echo t' } }));
  escribir(dir, 'apps/web/package.json', JSON.stringify({ name: 'mono-web', version: '1.0.0', scripts: { lint: 'echo l' } }));
  escribir(dir, '.faro.json', JSON.stringify({ monorepo: { apps: { api: { rol: 'API', equipo: 'api-team' }, web: { rol: 'Panel', equipo: 'web-team' } } } }));
  return dir;
}
const CI = (d) => path.join(d, '.github', 'workflows', 'ci.yml');
const LB = (d) => path.join(d, '.github', 'workflows', 'labeler.yml');

// ---------- versiones vigentes ----------

test('ciPlan: setup-node en su mayor vigente (v7) para npm, yarn y pnpm', () => {
  for (const pm of ['npm', 'yarn', 'pnpm']) {
    const plan = codeModule(simple(pm)).ciPlan();
    assert.strictEqual(plan.runtime.ghSetup.uses, 'actions/setup-node@v7', pm);
  }
  assert.strictEqual(codeModule(monorepo()).ciPlan().runtime.ghSetup.uses, 'actions/setup-node@v7');
});

test('YAML GitHub: checkout@v7 y setup-node@v7 en las tres gestoras y en monorepo; pnpm/action-setup@v6', () => {
  const casos = [['npm', simple('npm')], ['yarn', simple('yarn')], ['pnpm', simple('pnpm')], ['monorepo', monorepo()]];
  for (const [n, dir] of casos) {
    iniciar(dir, 'git@github.com:org/r.git');
    const r = harness(dir, 'ci');
    assert.strictEqual(r.status, 0, r.out);
    const yml = fs.readFileSync(CI(dir), 'utf8');
    assert.match(yml, /uses: actions\/checkout@v7/, n);
    assert.match(yml, /uses: actions\/setup-node@v7/, n);
    assert.doesNotMatch(yml, /@v4/, n);
    if (n === 'pnpm' || n === 'monorepo') assert.match(yml, /uses: pnpm\/action-setup@v6/, n);
  }
});

test('YAML GitLab: las tres gestoras y monorepo generan su pipeline sin acciones de GitHub ni labeler', () => {
  for (const dir of [simple('npm'), simple('yarn'), simple('pnpm'), monorepo()]) {
    iniciar(dir, 'git@gitlab.com:org/r.git');
    const r = harness(dir, 'ci');
    assert.strictEqual(r.status, 0, r.out);
    const yml = fs.readFileSync(path.join(dir, '.gitlab-ci.yml'), 'utf8');
    assert.doesNotMatch(yml, /actions\//);
    assert.match(yml, /image: node:/);
    assert.ok(!fs.existsSync(LB(dir)), 'GitLab no lleva workflow de labeler');
  }
});

// ---------- aviso de merge manual ----------

test('ci con ci.yml existente (pnpm): el aviso lista instalación, gates y el paso que habilita pnpm', () => {
  const dir = simple('pnpm');
  iniciar(dir, 'git@github.com:org/r.git');
  escribir(dir, '.github/workflows/ci.yml', 'name: mio\n');
  const r = harness(dir, 'ci');
  assert.match(r.out, /NO lo sobrescribe/);
  assert.match(r.out, /pnpm install --frozen-lockfile/);
  assert.match(r.out, /pnpm\/action-setup@v6/, r.out);
  assert.match(r.out, /actions\/setup-node@v7/, r.out);
  assert.strictEqual(fs.readFileSync(CI(dir), 'utf8'), 'name: mio\n');
});

test('ci con .gitlab-ci.yml existente (pnpm): el aviso lista corepack', () => {
  const dir = simple('pnpm');
  iniciar(dir, 'git@gitlab.com:org/r.git');
  escribir(dir, '.gitlab-ci.yml', 'x: 1\n');
  const r = harness(dir, 'ci');
  assert.match(r.out, /corepack enable/, r.out);
});

test('ci con ci.yml existente (npm): el aviso NO inventa pasos de pnpm', () => {
  const dir = simple('npm');
  iniciar(dir, 'git@github.com:org/r.git');
  escribir(dir, '.github/workflows/ci.yml', 'name: mio\n');
  const r = harness(dir, 'ci');
  assert.doesNotMatch(r.out, /pnpm/i);
  assert.match(r.out, /npm ci/);
});

test('ci con ci.yml y labeler.yml existentes en monorepo: el aviso menciona el paso de labeler', () => {
  const dir = monorepo();
  iniciar(dir, 'git@github.com:org/r.git');
  escribir(dir, '.github/workflows/ci.yml', 'name: mio\n');
  escribir(dir, '.github/workflows/labeler.yml', 'name: mi-labeler\n');
  const r = harness(dir, 'ci');
  assert.match(r.out, /actions\/labeler/, r.out);
  assert.strictEqual(fs.readFileSync(LB(dir), 'utf8'), 'name: mi-labeler\n');
});

// ---------- workflow del labeler ----------

test('ci monorepo GitHub escribe labeler.yml: pull_request_target, permisos mínimos y SIN checkout del PR', () => {
  const dir = monorepo();
  iniciar(dir, 'git@github.com:org/mono.git');
  const r = harness(dir, 'ci');
  assert.strictEqual(r.status, 0, r.out);
  const yml = fs.readFileSync(LB(dir), 'utf8');
  assert.match(yml, /^on:\s*pull_request_target/m, yml);
  assert.match(yml, /uses: actions\/labeler@v7/, yml);
  assert.doesNotMatch(yml, /actions\/checkout/, 'pull_request_target jamás debe traer el código del PR');
  assert.doesNotMatch(yml, /github\.event\.pull_request\.head/, yml);
  assert.match(yml, /permissions:\s*\n\s+contents: read\s*\n\s+pull-requests: write/, yml);
  assert.doesNotMatch(yml, /write-all|contents: write/, yml);
  assert.match(r.out, /codeowners/, 'informa de que codeowners genera CODEOWNERS y labeler.yml');
});

test('ci no pisa un labeler.yml existente', () => {
  const dir = monorepo();
  iniciar(dir, 'git@github.com:org/mono.git');
  escribir(dir, '.github/workflows/labeler.yml', 'name: propio\n');
  harness(dir, 'ci');
  assert.strictEqual(fs.readFileSync(LB(dir), 'utf8'), 'name: propio\n');
});

test('ci en repo simple GitHub no genera labeler', () => {
  const dir = simple('npm');
  iniciar(dir, 'git@github.com:org/r.git');
  harness(dir, 'ci');
  assert.ok(!fs.existsSync(LB(dir)));
});

test('ci --con-codeowners genera también CODEOWNERS y .github/labeler.yml', () => {
  const dir = monorepo();
  iniciar(dir, 'git@github.com:org/mono.git');
  const r = harness(dir, 'ci', '--con-codeowners');
  assert.strictEqual(r.status, 0, r.out);
  assert.match(fs.readFileSync(path.join(dir, '.github', 'CODEOWNERS'), 'utf8'), /\/apps\/api\/ @org\/api-team/);
  assert.match(fs.readFileSync(path.join(dir, '.github', 'labeler.yml'), 'utf8'), /app:api/);
  assert.ok(fs.existsSync(LB(dir)));
});

test('ci sin --con-codeowners no toca CODEOWNERS', () => {
  const dir = monorepo();
  iniciar(dir, 'git@github.com:org/mono.git');
  harness(dir, 'ci');
  assert.ok(!fs.existsSync(path.join(dir, '.github', 'CODEOWNERS')));
});
