// Task 6 del plan de despliegue agnóstico: `harness.js despliegue`, `harness.js local` y la exigencia
// de hexagonal en `validate` cuando el repo despliega. Repos temporales; nada de red.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');
const ENTORNO = { GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' };

function repoCon(ficheros, { estado = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-desp-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...ENTORNO } });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  if (estado) {
    fs.mkdirSync(path.join(dir, 'documentos', 'funcional'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'documentos', 'funcional', 'f.md'), '# F\n## Fuera de alcance\n- Nada mas\n');
    fs.writeFileSync(path.join(dir, 'ESTADO.md'), '---\niniciativa: T\nfases_total: 1\nfase_actual: 1\nowner: t\nfuncional: documentos/funcional/f.md\n---\n\n### Fase 1 · Una — in_progress\nLo que trae esta fase.\nObjetivo: 2026-12-01\n- [ ] #1 · Algo — @t\n');
  }
  for (const [rel, txt] of Object.entries(ficheros)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), txt);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [HARNESS, ...args], {
  cwd: dir, encoding: 'utf8', timeout: 90000, env: { ...process.env, ...ENTORNO, CLAUDE_PROJECT_DIR: dir },
});
const bloqueantes = (s) => String(s).split(/Avisos \(NO bloquean/)[0];

const WRANGLER_CON_SECRETO = '{ "name": "api", "main": "src/index.ts", "compatibility_date": "2025-01-01", "vars": { "API_TOKEN": "x" } }\n';
const SECCION_EN = '## Hexagonal\n- dominio: src/dominio/\n- aplicacion: src/aplicacion/\n- puertos: src/puertos/\n- adaptadores: src/adaptadores/\n- composicion: src/index.ts\n';
const SECCION_ES = '## Hexagonal\n- domain: src/dominio/\n- application: src/aplicacion/\n- ports: src/puertos/\n- adapters: src/adaptadores/\n- composition: src/index.ts\n';
const arq = (seccion) => `# Arquitectura\n## Mapa de módulos\n- x\n\n${seccion}\n## Testing\nnode --test\n`;
const DESPLIEGA = (seccion) => ({
  'wrangler.jsonc': WRANGLER_CON_SECRETO,
  'ARCHITECTURE.md': arq(seccion),
  'src/dominio/a.ts': 'export const a = 1;\n',
  'src/index.ts': "import { a } from './dominio/a.ts';\nexport default a;\n",
});

test('despliegue: wrangler con un secreto en vars sale con 1 y muestra cf-secreto-en-vars', () => {
  const r = run(repoCon({ 'wrangler.jsonc': WRANGLER_CON_SECRETO }), 'despliegue');
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /cf-secreto-en-vars/);
  assert.match(r.stdout, /cloudflare/);
});

test('despliegue --json imprime el objeto de diagnosticar', () => {
  const r = run(repoCon({ 'wrangler.jsonc': WRANGLER_CON_SECRETO }), 'despliegue', '--json');
  const j = JSON.parse(r.stdout);
  assert.ok(Array.isArray(j.detectados) && j.detectados.some((d) => d.id === 'cloudflare'));
  assert.ok(j.hallazgos.some((h) => h.codigo === 'cf-secreto-en-vars'));
});

test('despliegue en un repo sin destino: sale con 0 y lo dice', () => {
  const r = run(repoCon({ 'README.md': '# x\n' }), 'despliegue');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /sin despliegue/i);
});

test('despliegue --ci no escribe nada: los gates de IaC van en el CI de tests', () => {
  const dir = repoCon({ 'wrangler.jsonc': WRANGLER_CON_SECRETO });
  const r = run(dir, 'despliegue', '--ci');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /harness\.js ci/);
  assert.match(r.stdout, /devops/);
  assert.ok(!fs.existsSync(path.join(dir, '.github', 'workflows', 'deploy.yml')));
  assert.ok(!fs.existsSync(path.join(dir, '.gitlab', 'deploy.yml')));
});

test('despliegue --gates sin gates que correr no falla (repo sin destino)', () => {
  const r = run(repoCon({ 'README.md': '# x\n' }), 'despliegue', '--gates');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('local imprime wrangler dev y la nota', () => {
  const r = run(repoCon({ 'wrangler.jsonc': WRANGLER_CON_SECRETO }), 'local');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /wrangler dev/);
  assert.match(r.stdout, /Miniflare/);
});

test('local sin destino con comando local lo dice y sale con 0', () => {
  const r = run(repoCon({ 'README.md': '# x\n' }), 'local');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no hay/i);
});

test('validate: repo que despliega sin ## Hexagonal falla y sugiere hexagonal --plan', () => {
  const dir = repoCon(DESPLIEGA(''), { estado: true }); // ARCHITECTURE.md sin sección
  const r = run(dir, 'validate');
  assert.notStrictEqual(r.status, 0, r.stdout);
  assert.match(bloqueantes(r.stdout), /repo que despliega sin hexagonal declarada/);
  assert.match(bloqueantes(r.stdout), /harness\.js hexagonal --plan/);
});

test('validate: sin ARCHITECTURE.md pero con código que despliega, también falla', () => {
  const f = DESPLIEGA('');
  delete f['ARCHITECTURE.md'];
  const r = run(repoCon(f, { estado: true }), 'validate');
  assert.match(bloqueantes(r.stdout), /repo que despliega sin hexagonal declarada/);
});

test('validate (FR): con la sección en inglés o en español no pide hexagonal; los errores de despliegue son avisos', () => {
  for (const sec of [SECCION_EN, SECCION_ES]) {
    const r = run(repoCon(DESPLIEGA(sec), { estado: true }), 'validate');
    assert.doesNotMatch(r.stdout, /repo que despliega sin hexagonal declarada/, r.stdout);
    assert.doesNotMatch(bloqueantes(r.stdout), /\[despliegue\]/, r.stdout);
    assert.match(r.stdout, /\[despliegue\][^\n]*cf-secreto-en-vars/);
  }
});

test('validate: repo sin destino de despliegue no dice nada de despliegue', () => {
  const r = run(repoCon({ 'ARCHITECTURE.md': arq(''), 'src/a.ts': 'export const a = 1;\n' }, { estado: true }), 'validate');
  assert.doesNotMatch(r.stdout, /despliega|\[despliegue\]/);
});

test('enValidate: si falla la lectura de la hexagonal o el diagnóstico, avisa y no calla', () => {
  const DC = createRequire(import.meta.url)(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'despliegue-cli.js'));
  const diag = { detectados: [{ id: 'cloudflare', det: {} }], hallazgos: [{ nivel: 'error', codigo: 'x', mensaje: 'm' }] };
  const a = DC.enValidate({ diagnosticar: () => diag, bases: () => { throw new Error('boom'); } });
  assert.deepStrictEqual(a.errs, []);
  assert.ok(a.warns.some((w) => /\[despliegue\] x/.test(w)), 'conserva los avisos de despliegue');
  assert.ok(a.warns.some((w) => /no se pudo comprobar la hexagonal.*boom/.test(w)));
  const b = DC.enValidate({ diagnosticar: () => { throw new Error('caida'); }, bases: () => [] });
  assert.ok(b.warns.some((w) => /no disponible.*caida/.test(w)));
});

test('despliegue: sección «Para devops» con providers, variables sin default y bindings, sin valores', () => {
  const tf = `terraform {
  required_version = ">= 1.6"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }
  }
  backend "s3" { bucket = "estado" }
}
variable "account_id" { type = string }
variable "region" {
  type    = string
  default = "eu"
}
variable "api_token" {
  type      = string
  sensitive = true
}
`;
  const wr = '{ "name": "api", "compatibility_date": "2025-01-01", "d1_databases": [{ "binding": "DB", "database_name": "d", "database_id": "ID-SECRETO-123" }], "kv_namespaces": [{ "binding": "CACHE", "id": "kv-id-9" }] }\n';
  const r = run(repoCon({ 'infra/main.tf': tf, 'infra/.terraform.lock.hcl': '', '.gitignore': '.terraform/\n', 'wrangler.jsonc': wr }), 'despliegue');
  const sec = r.stdout.split('Para devops')[1] || '';
  assert.ok(sec, r.stdout);
  assert.match(sec, /provider \[terraform\]: cloudflare\/cloudflare ~> 5\.0/);
  assert.match(sec, /variable \[terraform\]: account_id \(sin default\)/);
  assert.match(sec, /variable \[terraform\]: api_token \(sin default\)/);
  assert.doesNotMatch(sec, /region/);
  assert.match(sec, /binding \[cloudflare\]: d1 DB/);
  assert.match(sec, /binding \[cloudflare\]: kv CACHE/);
  assert.doesNotMatch(r.stdout, /ID-SECRETO-123|kv-id-9/);
  const j = JSON.parse(run(repoCon({ 'infra/main.tf': tf, 'wrangler.jsonc': wr }), 'despliegue', '--json').stdout);
  assert.ok(j.devops.some((x) => x.tipo === 'provider') && j.devops.some((x) => x.tipo === 'binding'));
});

test('despliegue: sin destino no hay sección «Para devops»', () => {
  const r = run(repoCon({ 'README.md': '# x\n' }), 'despliegue');
  assert.doesNotMatch(r.stdout, /Para devops/);
});
