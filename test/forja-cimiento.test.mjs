// Cambio 'forja-cimiento-token-por-host': credenciales por host, seleccion de adaptador por forja y
// adaptador de GitLab. Un test por escenario de los deltas. SIN RED: se prueban el enrutado, el
// almacen y las traducciones puras; las llamadas reales a la API quedan para pruebas manuales.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const HARNESS = path.join(HOOKS, 'harness.js');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));

// HOME aislado: el almacen de credenciales vive en ~/.faro.json y NO se toca el del desarrollador.
function homeAislado(contenido) {
  const home = tmp('home');
  if (contenido) fs.writeFileSync(path.join(home, '.faro.json'), JSON.stringify(contenido));
  return home;
}
const envCon = (home, dir) => ({
  ...process.env, CLAUDE_PROJECT_DIR: dir, HOME: home, USERPROFILE: home, FARO_CONFIG_PATH: path.join(home, '.faro.json'),
  // sin tokens de entorno ni CLI gh: solo cuenta el almacen
  FARO_GITHUB_TOKEN: '', GITHUB_TOKEN: '', FARO_GITLAB_TOKEN: '', GITLAB_TOKEN: '',
});
function repo(remote) {
  const dir = tmp('repo');
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false'); git('config', 'tag.gpgsign', 'false');
  if (remote) git('remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(dir, 'README.md'), '# t\n');
  git('add', '-A'); git('commit', '-q', '-m', 'init');
  git('switch', '-q', '-c', 'feat/x');
  return dir;
}
const run = (args, dir, home, input) => spawnSync(process.execPath, [HARNESS, ...args], {
  cwd: dir, encoding: 'utf8', timeout: 60000, input: input || '{}', env: envCon(home, dir),
});

// ---------- spec: token-por-host ----------

test('credenciales: el token plano antiguo se migra a tokens["github.com"] sin perder la sesion', async () => {
  const home = homeAislado({ token: 'ghp_viejo', user: { login: 'ana' } });
  const cred = (await import(`file://${path.join(HOOKS, 'lib', 'credenciales.js').replace(/\\/g, '/')}`)).default;
  const prevHome = process.env.HOME, prevUP = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.FARO_CONFIG_PATH = path.join(home, '.faro.json');
  try {
    const c = cred();
    assert.strictEqual(c.tokenPara('github.com'), 'ghp_viejo', 'la sesion antigua debe seguir valiendo para GitHub');
    const j = JSON.parse(fs.readFileSync(path.join(home, '.faro.json'), 'utf8'));
    assert.ok(j.tokens && j.tokens['github.com'] && j.tokens['github.com'].token === 'ghp_viejo', 'debe quedar reescrito por host');
  } finally { process.env.HOME = prevHome; process.env.USERPROFILE = prevUP; delete process.env.FARO_CONFIG_PATH; }
});

test('credenciales: dos hosts conviven y cada uno devuelve SOLO el suyo', async () => {
  const home = homeAislado({ tokens: { 'github.com': { token: 'gh-1' }, 'gitlab.cliente.com': { token: 'gl-1' } } });
  const cred = (await import(`file://${path.join(HOOKS, 'lib', 'credenciales.js').replace(/\\/g, '/')}`)).default;
  const prevHome = process.env.HOME, prevUP = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.FARO_CONFIG_PATH = path.join(home, '.faro.json');
  process.env.FARO_GITHUB_TOKEN = ''; process.env.GITHUB_TOKEN = ''; process.env.FARO_GITLAB_TOKEN = ''; process.env.GITLAB_TOKEN = '';
  try {
    const c = cred();
    assert.strictEqual(c.tokenPara('gitlab.cliente.com'), 'gl-1');
    assert.strictEqual(c.tokenPara('github.com'), 'gh-1');
    assert.strictEqual(c.tokenPara('gitlab.com'), null, 'un host sin credencial no hereda la de otro');
  } finally { process.env.HOME = prevHome; process.env.USERPROFILE = prevUP; delete process.env.FARO_CONFIG_PATH; }
});

test('credenciales: guardar en GitHub ESPEJA el campo plano mientras el CLI lo lea', async () => {
  const home = homeAislado({});
  const cred = (await import(`file://${path.join(HOOKS, 'lib', 'credenciales.js').replace(/\\/g, '/')}`)).default;
  const prevHome = process.env.HOME, prevUP = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.FARO_CONFIG_PATH = path.join(home, '.faro.json');
  try {
    cred().guardarToken('github.com', { token: 'gh-nuevo', forja: 'github' });
    const j = JSON.parse(fs.readFileSync(path.join(home, '.faro.json'), 'utf8'));
    assert.strictEqual(j.token, 'gh-nuevo', 'el CLI faro aun lee el campo plano (issue faro-cli#3)');
    cred().guardarToken('gitlab.com', { token: 'gl-nuevo', forja: 'gitlab' });
    const k = JSON.parse(fs.readFileSync(path.join(home, '.faro.json'), 'utf8'));
    assert.strictEqual(k.token, 'gh-nuevo', 'guardar GitLab NO pisa el espejo de GitHub');
  } finally { process.env.HOME = prevHome; process.env.USERPROFILE = prevUP; delete process.env.FARO_CONFIG_PATH; }
});

test('auth en repo de GitLab sin app ni token EXPLICA las dos vias y no lanza el login de GitHub', () => {
  const dir = repo('git@gitlab.com:grupo/sub/proyecto.git');
  const r = run(['auth'], dir, homeAislado({}));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /APLICACION OAuth/i, 'debe explicar la via de aplicacion');
  assert.match(r.stdout, /TOKEN PERSONAL/i, 'debe explicar la via de token personal');
  assert.ok(!/github\.com\/login\/device/.test(r.stdout), 'no debe mandar al login de GitHub');
});

// ---------- spec: adaptador-gitlab ----------

test('forja: role en GitLab sin credencial responde SIN_TOKEN nombrando ese host (no el de GitHub)', () => {
  const dir = repo('git@gitlab.cliente.com:grupo/sub/proyecto.git');
  const r = run(['role'], dir, homeAislado({ tokens: { 'github.com': { token: 'gh-1' } } }));
  assert.match(r.stdout, /SIN_TOKEN/);
  assert.match(r.stdout, /gitlab\.cliente\.com/, 'el mensaje debe nombrar el host que falta');
});

test('forja: el transporte gh no existe en GitLab y reconduce a los comandos por intencion', () => {
  const dir = repo('git@gitlab.com:grupo/proyecto.git');
  const r = run(['gh', 'user'], dir, homeAislado({}));
  assert.match(r.stdout, /no hay adaptador|por intencion/i);
});

test('forja: en una forja DESCONOCIDA los comandos lo dicen en vez de fallar raro', () => {
  const dir = repo('git@bitbucket.org:equipo/proyecto.git');
  for (const c of [['role'], ['pr'], ['mis-tareas'], ['auth']]) {
    const r = run(c, dir, homeAislado({}));
    assert.match(r.stdout, /no hay adaptador para esta forja/i, `${c[0]} deberia declarar la forja desconocida:\n${r.stdout}`);
  }
});

test('forja: el rol de GitLab se traduce por nivel (40+ aprueba, 30 no)', async () => {
  const mod = (await import(`file://${path.join(HOOKS, 'lib', 'forge-gitlab.js').replace(/\\/g, '/')}`)).default;
  const m = mod({ ROOT: '.', git: () => null, forge: () => ({ forge: 'gitlab', host: 'gitlab.com', path: 'g/p', owner: 'g', project: 'p' }), tokenPara: () => null, guardarToken: () => null, faroSchema: () => null, specBase: 'x' });
  assert.strictEqual(m.nivelARol(50), 'owner');
  assert.strictEqual(m.nivelARol(40), 'maintainer');
  assert.strictEqual(m.nivelARol(30), 'developer');
  assert.strictEqual(m.nivelARol(20), 'reporter');
});

test('forja: el identificador de proyecto es la ruta COMPLETA codificada, no dos segmentos', async () => {
  const { detect } = await import(`file://${path.join(HOOKS, 'lib', 'forge.js').replace(/\\/g, '/')}`);
  const f = detect('git@gitlab.com:grupo/sub/proyecto.git');
  assert.strictEqual(encodeURIComponent(f.path), 'grupo%2Fsub%2Fproyecto');
});

test('forja: el mapa de capacidades declara GitLab soportado y la sesion ya no dice que falta adaptador', () => {
  const dir = repo('git@gitlab.com:grupo/proyecto.git');
  const r = run(['session'], dir, homeAislado({}), '{"start_reason":"startup"}');
  const c = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(c, /PLATAFORMA = GITLAB/);
  assert.ok(!/AUN NO tiene adaptador/.test(c), 'la regla de plataforma debe reflejar el soporte real');
  assert.match(c, /por INTENCION/, 'debe orientar a los comandos por intencion');
});

test('pr crear: desde una rama protegida se niega; sin titulo explica el uso', () => {
  const dir = repo('git@github.com:acme-org/x.git');
  const r = run(['pr', 'crear', '--base', 'develop'], dir, homeAislado({}));
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stdout, /Uso: .*pr crear/);
});

test('cableado: /faro:pr y el gestor usan pr crear y ya no mandan parar en GitLab', () => {
  const pr = fs.readFileSync(path.join(RAIZ, 'plugins/faro/skills/pr/SKILL.md'), 'utf8');
  assert.match(pr, /pr crear --base/);
  const g = fs.readFileSync(path.join(RAIZ, 'plugins/faro/agents/gestor-forja.md'), 'utf8');
  assert.ok(!/harness todavía no sabe operarlo/.test(g), 'GitLab ya se opera; el agente no debe decir lo contrario');
});
