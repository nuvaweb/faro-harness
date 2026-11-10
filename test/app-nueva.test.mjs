// #216 — harness.js app nueva: instanciar una app de un monorepo desde una plantilla de la org, y
// `--inicial` para el repo recien creado por el wizard (un solo commit, sin rama anclada).
//
// Garantias fijadas aqui (repos git temporales, sin red; la plantilla es una ruta local con remote
// de la org, igual que en monorepo importar):
//   - la plantilla llega a apps/<id> SIN su historial, sin su workspace/lock/gestion, con su paquete
//     renombrado al id y su config de pnpm fusionada en la raiz;
//   - los Workers se renombran a <repo>-<id>-dev|prod (dos apps no chocan);
//   - id ocupado o plantilla de otra org -> exit 1 sin tocar nada;
//   - nunca crea commits; --inicial solo relaja los gates si la historia tiene UN commit.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');

const w = (dir, rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };
const r = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n');
const hay = (dir, rel) => fs.existsSync(path.join(dir, rel));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const harness = (cwd, ...a) => spawnSync(process.execPath, [HARNESS, ...a], { cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } });
const commits = (dir) => Number(git(dir, 'rev-list', '--count', 'HEAD').trim());
const estado = (dir) => git(dir, 'status', '--porcelain', '--untracked-files=all');

// Plantilla sintetica con la forma de TANSTACK-WORKER-UI (repo de un solo paquete).
function plantilla({ org = 'acme-org', nombre = 'TANSTACK-WORKER-UI' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-tpl-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', `https://github.com/${org}/${nombre}.git`);
  w(dir, 'package.json', JSON.stringify({ name: 'app', private: true, packageManager: 'pnpm@11.17.0', scripts: { build: 'vite build' } }, null, 2));
  w(dir, 'pnpm-workspace.yaml', 'packages: []\n\nallowBuilds:\n  esbuild: true\n  workerd: true\n\nminimumReleaseAgeExclude:\n  - mi-ds\n');
  w(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  w(dir, '.node-version', '24\n');
  w(dir, 'wrangler.jsonc', '{\n  "name": "name-dev",\n  "main": "src/server.ts",\n  "env": { "prod": { "name": "name-prod" } }\n}\n');
  w(dir, 'src/server.ts', 'export default {};\n');
  w(dir, 'gestion/brainstorming/idea.md', '# idea\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'plantilla');
  w(dir, 'src/server.ts', 'export default { v: 2 };\n');
  git(dir, 'commit', '-qam', 'segundo');
  return dir;
}

// Repo recien creado por el wizard: un unico commit en develop, monorepo vacio.
function recienCreado({ repo = 'portal', rama = 'develop', historia = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-nuevo-'));
  git(dir, 'init', '-q', '-b', rama);
  git(dir, 'remote', 'add', 'origin', `https://github.com/acme-org/${repo}.git`);
  w(dir, '.faro.json', JSON.stringify({ domain: 'x', teams: [], tags: [] }, null, 2) + '\n');
  w(dir, 'README.md', '# portal\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'inicial');
  if (historia) { w(dir, 'README.md', '# portal 2\n'); git(dir, 'commit', '-qam', 'segundo'); }
  return dir;
}

// Monorepo ya en marcha, en una rama de trabajo anclada.
function monorepo({ repo = 'portal' } = {}) {
  const dir = recienCreado({ repo, historia: true });
  w(dir, 'pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  w(dir, 'package.json', JSON.stringify({ name: 'portal-monorepo', private: true }, null, 2) + '\n');
  const cfg = JSON.parse(r(dir, '.faro.json'));
  cfg.monorepo = { apps: {} };
  w(dir, '.faro.json', JSON.stringify(cfg, null, 2) + '\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'monorepo');
  git(dir, 'switch', '-q', '-c', 'feat/216-app');
  return dir;
}

test('app web desde la plantilla TanStack: apps/web sin historial, registrada con rol y plantilla, sin commit', () => {
  const tpl = plantilla(); const dir = monorepo();
  const antes = commits(dir);
  const res = harness(dir, 'app', 'nueva', 'web', '--plantilla', tpl, '--rol', 'front', '--confirmo');
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.ok(hay(dir, 'apps/web/package.json') && hay(dir, 'apps/web/CLAUDE.md') && hay(dir, 'apps/web/src/server.ts'));
  assert.ok(!hay(dir, 'apps/web/.git'));
  const cfg = JSON.parse(r(dir, '.faro.json'));
  assert.strictEqual(cfg.monorepo.apps.web.rol, 'front');
  assert.strictEqual(cfg.monorepo.apps.web.plantilla, 'TANSTACK-WORKER-UI');
  assert.strictEqual(commits(dir), antes, 'no debe crear commits');
  assert.match(git(dir, 'diff', '--cached', '--name-only'), /apps\/web\/src\/server\.ts/);
});

test('dry-run por defecto: muestra el plan y no toca nada', () => {
  const tpl = plantilla(); const dir = monorepo();
  const res = harness(dir, 'app', 'nueva', 'web', '--plantilla', tpl, '--rol', 'front');
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /DRY-RUN/);
  assert.strictEqual(estado(dir), '');
});

test('la plantilla trae workspace propio: se normaliza al del monorepo', () => {
  const tpl = plantilla(); const dir = monorepo();
  const res = harness(dir, 'app', 'nueva', 'web', '--plantilla', tpl, '--rol', 'front', '--confirmo');
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  for (const f of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'gestion', '.node-version']) assert.ok(!hay(dir, `apps/web/${f}`), `apps/web/${f} no debería existir`);
  const ws = r(dir, 'pnpm-workspace.yaml');
  assert.match(ws, /"apps\/\*"/);
  assert.match(ws, /^ {2}esbuild: true$/m);
  assert.match(ws, /^ {2}workerd: true$/m);
  assert.match(ws, /^minimumReleaseAgeExclude:\n {2}- mi-ds$/m);
  assert.strictEqual(JSON.parse(r(dir, 'apps/web/package.json')).name, 'web');
  assert.strictEqual(JSON.parse(r(dir, 'package.json')).packageManager, 'pnpm@11.17.0');
  assert.strictEqual(r(dir, '.node-version').trim(), '24');
});

test('dos apps con Worker: cada una con su nombre <repo>-<id>-dev|prod y config fusionada sin duplicar', () => {
  const tpl = plantilla(); const dir = monorepo({ repo: 'portal' });
  assert.strictEqual(harness(dir, 'app', 'nueva', 'web', '--plantilla', tpl, '--rol', 'front', '--confirmo').status, 0);
  git(dir, 'commit', '-qm', 'web');
  const res = harness(dir, 'app', 'nueva', 'admin', '--plantilla', tpl, '--rol', 'back office', '--confirmo');
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(r(dir, 'apps/web/wrangler.jsonc'), /"name": "portal-web-dev"/);
  assert.match(r(dir, 'apps/web/wrangler.jsonc'), /"name": "portal-web-prod"/);
  assert.match(r(dir, 'apps/admin/wrangler.jsonc'), /"name": "portal-admin-dev"/);
  const ws = r(dir, 'pnpm-workspace.yaml');
  assert.strictEqual(ws.match(/esbuild: true/g).length, 1);
  assert.strictEqual(ws.match(/- mi-ds/g).length, 1);
});

test('id ya usado: exit 1 y el árbol no cambia', () => {
  const tpl = plantilla(); const dir = monorepo();
  w(dir, 'apps/web/package.json', '{"name":"web"}\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'web a mano');
  const res = harness(dir, 'app', 'nueva', 'web', '--plantilla', tpl, '--rol', 'x', '--confirmo');
  assert.strictEqual(res.status, 1, res.stdout + res.stderr);
  assert.strictEqual(estado(dir), '');
});

test('plantilla de otra organización: exit 1 sin escribir nada', () => {
  const tpl = plantilla({ org: 'OTRA-ORG' }); const dir = monorepo();
  const res = harness(dir, 'app', 'nueva', 'web', '--plantilla', tpl, '--rol', 'front', '--confirmo');
  assert.strictEqual(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /otra organización/);
  assert.strictEqual(estado(dir), '');
});

test('sin --inicial, una rama no anclada bloquea --confirmo', () => {
  const tpl = plantilla(); const dir = recienCreado();
  const res = harness(dir, 'app', 'nueva', 'web', '--plantilla', tpl, '--rol', 'front', '--confirmo');
  assert.strictEqual(res.status, 1, res.stdout + res.stderr);
  assert.strictEqual(estado(dir), '');
});

test('dos apps seguidas sin commit intermedio con --inicial: un solo commit en la historia', () => {
  const tpl = plantilla(); const dir = recienCreado();
  const a = harness(dir, 'app', 'nueva', 'web', '--plantilla', tpl, '--rol', 'front', '--inicial', '--confirmo');
  assert.strictEqual(a.status, 0, a.stdout + a.stderr);
  const b = harness(dir, 'app', 'nueva', 'admin', '--plantilla', tpl, '--rol', 'back office', '--inicial', '--confirmo');
  assert.strictEqual(b.status, 0, b.stdout + b.stderr);
  assert.ok(hay(dir, 'apps/web/package.json') && hay(dir, 'apps/admin/package.json'));
  assert.strictEqual(commits(dir), 1);
  const cfg = JSON.parse(r(dir, '.faro.json'));
  assert.deepStrictEqual(Object.keys(cfg.monorepo.apps).sort(), ['admin', 'web']);
  assert.ok(hay(dir, 'pnpm-workspace.yaml') && hay(dir, 'package.json'));
});

test('monorepo init --inicial en el primer commit del wizard: aplica en develop', () => {
  const dir = recienCreado();
  const res = harness(dir, 'monorepo', 'init', '--app', 'web', '--rol', 'front', '--inicial', '--confirmo');
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.ok(hay(dir, 'pnpm-workspace.yaml'));
  assert.strictEqual(JSON.parse(r(dir, '.faro.json')).monorepo.apps.web.rol, 'front');
  assert.strictEqual(commits(dir), 1);
});

test('monorepo init --inicial en un repo con historia: mantiene el bloqueo de develop', () => {
  const dir = recienCreado({ historia: true });
  const res = harness(dir, 'monorepo', 'init', '--app', 'web', '--rol', 'front', '--inicial', '--confirmo');
  assert.strictEqual(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /develop/);
  assert.strictEqual(estado(dir), '');
});
