// Cambio 'ci-desde-tus-gates': `harness.js ci` traduce los gates que ya corre el harness en local
// (scripts de package.json / git config faro.gates) al fichero de CI de la forja del repo, para que
// se ejecuten de verdad en cada peticion de integracion y no solo cuando alguien los corre a mano.
// Es DETERMINISTA (tabla fija de runtimes + los comandos del propio repo) y NUNCA sobrescribe.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', timeout: 120000 });
const run = (args, cwd) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: cwd }, timeout: 60000 });

// Instancia FARO con remoto y ficheros de stack a medida de cada escenario.
function repo(name, remote, extra = () => {}) {
  const dir = tmp(name);
  fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\nowner: t\n---\n### Fase 1 · P — in_progress\n- [ ] t\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  extra(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}
const pkg = (scripts, engines) => (d) => fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', ...(engines ? { engines } : {}), scripts }));

test('ci: repo Node en GitLab genera .gitlab-ci.yml con SUS scripts y la imagen de node', () => {
  const dir = repo('ci-node-gitlab', 'git@gitlab.com:grupo/sub/proyecto.git', pkg({ lint: 'eslint .', test: 'vitest run', build: 'tsc' }, { node: '>=20' }));
  const r = run([HARNESS, 'ci'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const yml = fs.readFileSync(path.join(dir, '.gitlab-ci.yml'), 'utf8');
  assert.match(yml, /image: node:20/, 'debe usar la version de node que declara el propio package.json');
  for (const cmd of ['npm ci', 'npm run lint', 'npm run test', 'npm run build']) assert.ok(yml.includes(cmd), `falta '${cmd}' en el YAML:\n${yml}`);
  assert.match(yml, /merge_request_event/, 'debe correr en cada peticion de integracion');
});

test('ci: repo Python en GitLab usa la imagen de python y el comando declarado en faro.gates', () => {
  const dir = repo('ci-python-gitlab', 'git@gitlab.com:grupo/api.git', (d) => {
    fs.writeFileSync(path.join(d, 'pyproject.toml'), '[project]\nname = "x"\n');
  });
  git(dir, 'config', 'faro.gates', 'pytest -q && ruff check .');
  const r = run([HARNESS, 'ci'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const yml = fs.readFileSync(path.join(dir, '.gitlab-ci.yml'), 'utf8');
  assert.match(yml, /image: python:/, `stack python mal resuelto:\n${yml}`);
  assert.ok(yml.includes('pytest -q && ruff check .'), 'debe correr EXACTAMENTE el comando declarado');
  assert.ok(!/npm ci/.test(yml), 'un repo sin package.json no debe instalar con npm');
});

test('ci: repo Node en GitHub genera el workflow de Actions con la version ENTRECOMILLADA', () => {
  const dir = repo('ci-node-github', 'git@github.com:org/app.git', pkg({ test: 'vitest run' }, { node: '20.10' }));
  const r = run([HARNESS, 'ci'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  const yml = fs.readFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(yml, /actions\/setup-node@v7/);
  // Sin comillas, YAML lee 20.10 como numero y lo convierte en 20.1 (una version que no existe).
  assert.match(yml, /node-version: '20'/, `la version debe ir entrecomillada:\n${yml}`);
  assert.ok(yml.includes('npm run test'));
});

test('ci: NUNCA sobrescribe un fichero de CI que ya existe', () => {
  const dir = repo('ci-existente', 'git@gitlab.com:grupo/proyecto.git', pkg({ test: 'vitest run' }));
  const previo = '# CI escrito a mano por el equipo\nstages: [mio]\n';
  fs.writeFileSync(path.join(dir, '.gitlab-ci.yml'), previo);
  const r = run([HARNESS, 'ci'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.gitlab-ci.yml'), 'utf8'), previo, 'piso un CI existente');
  assert.match(r.stdout, /Ya existe .*NO lo sobrescribe/s, r.stdout);
  assert.ok(r.stdout.includes('npm run test'), 'si no lo escribe, al menos dice que comandos mergear a mano');
});

test('ci: sin gates declarados no genera un CI vacio, explica que declarar primero', () => {
  const dir = repo('ci-sin-gates', 'git@gitlab.com:grupo/proyecto.git', (d) => {
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x' })); // sin scripts
  });
  const r = run([HARNESS, 'ci'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, '.gitlab-ci.yml')), 'no debe escribir un CI sin nada que correr');
  assert.match(r.stdout, /Sin gates declarados/i, r.stdout);
});

test('ci: repo documental (sin codigo) no genera CI', () => {
  const dir = repo('ci-documental', 'git@gitlab.com:grupo/docs.git');
  const r = run([HARNESS, 'ci'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, '.gitlab-ci.yml')));
  assert.match(r.stdout, /repo documental/i, r.stdout);
});

test('ci: forja desconocida no escribe nada, imprime el YAML para pegarlo a mano', () => {
  const dir = repo('ci-sin-forja', null, pkg({ test: 'vitest run' }));
  const r = run([HARNESS, 'ci'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, '.gitlab-ci.yml')), 'sin forja conocida no se elige fichero por el usuario');
  assert.match(r.stdout, /stages: \[gates\]/, r.stdout);
});

test('exigir-pipeline: en un repo SIN fichero de CI se NIEGA (exigirlo bloquearia toda fusion)', () => {
  const dir = repo('exigir-sin-ci', 'git@gitlab.com:grupo/doc.git');
  const r = run([HARNESS, 'exigir-pipeline'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /NO tiene \.gitlab-ci\.yml/, r.stdout);
  assert.match(r.stdout, /harness\.js ci/, 'debe encaminar a generar antes el pipeline');
});

test('ci: tras generar el pipeline en GitLab, encamina a exigirlo (el orden correcto)', () => {
  const dir = repo('ci-encadena', 'git@gitlab.com:grupo/app.git', pkg({ test: 'vitest run' }));
  const r = run([HARNESS, 'ci'], dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /exigir-pipeline/, `debe sugerir el paso siguiente:\n${r.stdout}`);
});
