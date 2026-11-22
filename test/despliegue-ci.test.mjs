// Gates de IaC en el CI de TESTS generado por `harness.js ci`: se arman desde gates() de los adaptadores
// de despliegue, sin credenciales (ni secrets ni tokens), y sin IaC el YAML no cambia.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks', 'harness.js');
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 120000 });
const run = (args, cwd) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: cwd }, timeout: 60000 });

const TF = 'terraform {\n  required_version = ">= 1.6"\n}\n';
const WRANGLER = '{ "name": "app", "main": "src/index.ts", "compatibility_date": "2025-01-01" }\n';

// Repo con remoto, un package.json con test (hay gates de codigo) y los ficheros dados.
function repo(remote, ficheros, cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-iac-ci-'));
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · P — in_progress\n- [ ] t\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }));
  if (cfg) { fs.mkdirSync(path.join(dir, 'faro')); fs.writeFileSync(path.join(dir, 'faro', 'config.json'), JSON.stringify(cfg)); }
  for (const [rel, txt] of Object.entries(ficheros)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}
const GH = 'git@github.com:org/app.git';
const GL = 'git@gitlab.com:grupo/app.git';
function genera(dir, destino) {
  const r = run([HARNESS, 'ci'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  return fs.readFileSync(path.join(dir, ...destino), 'utf8');
}
const ghYml = (dir) => genera(dir, ['.github', 'workflows', 'ci.yml']);
const glYml = (dir) => genera(dir, ['.gitlab-ci.yml']);
const sinCredenciales = (yml) => {
  assert.ok(!yml.includes('secrets.'), `no debe usar secrets:\n${yml}`);
  assert.ok(!/TOKEN|API_KEY/.test(yml), `no debe usar tokens:\n${yml}`);
};

test('github + wrangler.jsonc: job iac con wrangler deploy --dry-run tras instalar dependencias', () => {
  const yml = ghYml(repo(GH, { 'wrangler.jsonc': WRANGLER }));
  assert.match(yml, /\n {2}iac:\n/);
  const iac = yml.slice(yml.indexOf('\n  iac:'));
  assert.ok(iac.includes('npx wrangler deploy --dry-run'), yml);
  assert.ok(iac.indexOf('npm ci') < iac.indexOf('wrangler deploy --dry-run'), 'instalar antes del dry-run');
  assert.ok(!iac.includes('setup-terraform'));
  sinCredenciales(yml);
});

test('github + infra/*.tf: setup-terraform e init -backend=false antes de validate', () => {
  const yml = ghYml(repo(GH, { 'infra/main.tf': TF }));
  assert.ok(yml.includes('hashicorp/setup-terraform@'), yml);
  assert.ok(yml.indexOf('init -backend=false') > -1 && yml.indexOf('init -backend=false') < yml.indexOf('validate'), yml);
  assert.ok(!/tflint|checkov/.test(yml), 'tflint/checkov no van al CI generado');
  sinCredenciales(yml);
});

test('github + terraform.binario tofu: setup-opentofu', () => {
  const yml = ghYml(repo(GH, { 'infra/main.tf': TF }, { despliegue: { terraform: { binario: 'tofu' } } }));
  assert.ok(yml.includes('opentofu/setup-opentofu@'), yml);
  assert.ok(!yml.includes('setup-terraform'));
  assert.ok(/tofu .*init -backend=false/.test(yml), yml);
  sinCredenciales(yml);
});

test('gitlab: jobs iac con imagen oficial de terraform y con node para wrangler', () => {
  const yml = glYml(repo(GL, { 'infra/main.tf': TF, 'wrangler.jsonc': WRANGLER }));
  assert.match(yml, /\niac-terraform:\n/);
  assert.ok(yml.includes('hashicorp/terraform'), yml);
  assert.ok(yml.indexOf('init -backend=false') < yml.indexOf('validate'), yml);
  assert.match(yml, /\niac-cloudflare:\n/);
  assert.ok(yml.includes('npx wrangler deploy --dry-run'));
  assert.strictEqual((yml.match(/merge_request_event/g) || []).length, 3, 'cada job corre en MR y en main');
  assert.ok(!/paths:|changes:/.test(yml), 'sin filtros por ruta');
  sinCredenciales(yml);
});

test('gitlab + tofu: imagen de opentofu', () => {
  const yml = glYml(repo(GL, { 'infra/main.tf': TF }, { despliegue: { terraform: { binario: 'tofu' } } }));
  assert.match(yml, /\niac-opentofu:\n/);
  assert.ok(yml.includes('ghcr.io/opentofu/opentofu'), yml);
  sinCredenciales(yml);
});

test('sin IaC el YAML no menciona iac (github y gitlab)', () => {
  assert.ok(!/iac/.test(ghYml(repo(GH, {}))));
  assert.ok(!/iac/.test(glYml(repo(GL, {}))));
});
