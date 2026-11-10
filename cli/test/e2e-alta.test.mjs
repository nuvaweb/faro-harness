// Perfil limpio de extremo a extremo: el CLI real en un proceso aparte, HOME temporal, forja simulada
// (test/apoyo/api-simulada.mjs) y el remoto git redirigido a repos bare locales con url.insteadOf. Lo
// que se comprueba es lo que queda en el remoto y lo que recibió la API, no los mensajes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'crear.mjs');
const PRELOAD = pathToFileURL(path.join(ROOT, 'test', 'apoyo', 'api-simulada.mjs')).href;
const TOKEN = 'token-de-prueba-123';
const FORJAS = {
  github: { host: 'github.com', usuario: 'x-access-token', variable: 'GITHUB_TOKEN', crear: 'POST /user/repos' },
  gitlab: { host: 'gitlab.com', usuario: 'oauth2', variable: 'GITLAB_TOKEN', crear: 'POST /projects' },
};

const tmp = (pre) => fs.mkdtempSync(path.join(os.tmpdir(), pre));
const dirDeGit = () => path.dirname(execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim());
const enBare = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// cuentaLimpia: la URL sin credenciales de esa cuenta también cae en los bare (la migración no mete
// el token en la URL: lo pasa por entorno).
function escenario(id, { cuentaLimpia = null } = {}) {
  const f = FORJAS[id];
  const raiz = tmp('faro-e2e-');
  const home = path.join(raiz, 'home'); const trabajo = path.join(raiz, 'trabajo'); const remotos = path.join(raiz, 'remotos');
  for (const d of [home, trabajo, path.join(remotos, 'ana')]) fs.mkdirSync(d, { recursive: true });
  const bare = path.join(remotos, 'ana', 'mi-repo.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  const log = path.join(raiz, 'api.log');
  const base = `${pathToFileURL(remotos).href}/`;
  const env = {
    PATH: [path.dirname(process.execPath), dirDeGit()].join(path.delimiter),
    HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR,
    API_LOG: log, [f.variable]: TOKEN, GIT_TERMINAL_PROMPT: '0',
    // Sin esto hereda el credential.helper del sistema y el token de prueba acaba en el almacén real.
    GIT_CONFIG_NOSYSTEM: '1',
    // Todo git hacia la forja cae en los bare locales; el resto (p. ej. el plugin público), en una ruta inexistente.
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: `url.${base}.insteadOf`, GIT_CONFIG_VALUE_0: `https://${f.usuario}:${TOKEN}@${f.host}/`,
    GIT_CONFIG_KEY_1: `url.${base}nada-github/.insteadOf`, GIT_CONFIG_VALUE_1: 'https://github.com/',
    GIT_CONFIG_KEY_2: `url.${base}nada-gitlab/.insteadOf`, GIT_CONFIG_VALUE_2: 'https://gitlab.com/',
  };
  if (cuentaLimpia) Object.assign(env, { GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_3: `url.${base}${cuentaLimpia}/.insteadOf`, GIT_CONFIG_VALUE_3: `https://${f.host}/${cuentaLimpia}/` });
  const lanzar = (args, cwd = trabajo) => spawnSync(process.execPath, ['--import', PRELOAD, CLI, ...args], {
    cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000,
  });
  const llamadas = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { id, f, bare, trabajo, home, remotos, lanzar, llamadas };
}

const API_DE = { github: 'api.github.com', gitlab: 'gitlab.com' };
const NOREPLY = { github: '7+ana@users.noreply.github.com', gitlab: '7-ana@users.noreply.gitlab.com' };
const enLocal = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const salida = (r) => `${r.stdout}\n${r.stderr}`;
const verbos = (ll) => ll.map((l) => `${l.metodo} ${l.ruta}`);

for (const id of Object.keys(FORJAS)) {
  test(`crear en ${id}, cuenta personal: repo con esqueleto, main y develop, y sin plantillas remotas`, () => {
    const e = escenario(id);
    const r = e.lanzar([`--perfil=${id}`, '--yes', '--domain=sistemas', '--naturaleza=documental', '--nombre=mi-repo', '--no-open']);
    assert.equal(r.status, 0, salida(r));
    assert.equal(salida(r).includes(TOKEN), false, 'el token no sale por pantalla');
    assert.equal(enBare(e.bare, 'rev-parse', '--verify', 'main').length, 40);
    const enDevelop = enBare(e.bare, 'ls-tree', '-r', '--name-only', 'develop').split('\n');
    for (const f of ['CLAUDE.md', '.gitignore', '.faro.json', '.claude/settings.json', 'gestion/risks.md']) assert.ok(enDevelop.includes(f), `${f} en develop\n${enDevelop}`);
    const meta = JSON.parse(enBare(e.bare, 'show', 'develop:.faro.json'));
    assert.equal(meta.domain, 'sistemas'); assert.equal(meta.naturaleza, 'documental');
    const v = verbos(e.llamadas());
    assert.ok(v.includes(e.f.crear), v.join('\n'));
    assert.equal(v.some((x) => x.includes('/generate')), false);
    assert.equal(v.some((x) => /templates|catalog/.test(x)), false, 'ninguna ruta pide un catálogo remoto');
    assert.ok(fs.existsSync(path.join(e.trabajo, 'mi-repo', 'CLAUDE.md')), 'clon local');
    const cfg = fs.readFileSync(path.join(e.trabajo, 'mi-repo', '.git', 'config'), 'utf8');
    assert.equal(cfg.includes(TOKEN), false, 'sin token en .git/config');
    assert.deepEqual([...new Set(e.llamadas().map((l) => l.host))], [API_DE[id]], 'solo se habla con la forja elegida');
    assert.equal(enLocal(path.join(e.trabajo, 'mi-repo'), 'config', 'user.email'), NOREPLY[id]);
  });

  test(`abrir en ${id} un repo compartido de otro dueño: clona y deja cableado su acceso`, () => {
    const e = escenario(id);
    const bare = path.join(e.remotos, 'ajena', 'compartido.git');
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
    const sem = path.join(e.trabajo, 'sem');
    execFileSync('git', ['init', '-q', '-b', 'main', sem], { stdio: 'ignore' });
    fs.writeFileSync(path.join(sem, 'dato.txt'), 'x');
    enLocal(sem, 'add', '-A'); enLocal(sem, '-c', 'user.name=a', '-c', 'user.email=a@b.c', 'commit', '-qm', 'x'); enLocal(sem, 'push', '-q', bare, 'main');
    const r = e.lanzar([`--perfil=${id}`, '--abrir=ajena/compartido', '--yes', '--no-open', '--dir=.']);
    assert.equal(r.status, 0, salida(r));
    assert.ok(fs.existsSync(path.join(e.trabajo, 'compartido', 'dato.txt')), salida(r));
    assert.match(fs.readFileSync(path.join(e.home, '.gitconfig'), 'utf8'), new RegExp(`${e.f.host}/ajena`), 'el helper cubre al dueño del repo abierto');
  });

  test(`crear en ${id} con una plantilla sin URL pública: avisa y sigue con el esqueleto`, () => {
    const e = escenario(id);
    const r = e.lanzar([`--perfil=${id}`, '--yes', '--domain=sistemas', '--naturaleza=worker', '--plantilla=tanstack-ui', '--nombre=mi-repo', '--no-open']);
    assert.equal(r.status, 0, salida(r));
    assert.match(salida(r), /tanstack-ui.*no está disponible/);
    const enDevelop = enBare(e.bare, 'ls-tree', '-r', '--name-only', 'develop').split('\n');
    assert.ok(enDevelop.includes('CLAUDE.md'));
    assert.equal(JSON.parse(enBare(e.bare, 'show', 'develop:.faro.json')).plantilla ?? null, null);
  });

  test(`adoptar en ${id}, cuenta personal: conserva el código, añade la capa y deja develop en el remoto`, () => {
    const e = escenario(id);
    const dir = path.join(e.trabajo, 'mi-repo'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'app.py'), 'print(1)\n');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'mío\n');
    const r = e.lanzar([`--perfil=${id}`, '--adoptar', '--yes', `--dir=${dir}`, '--domain=sistemas', '--naturaleza=app', '--nombre=mi-repo', '--no-open'], e.trabajo);
    assert.equal(r.status, 0, salida(r));
    assert.equal(salida(r).includes(TOKEN), false, 'el token no sale por pantalla');
    assert.equal(/Subi(r|endo) .*GitHub/.test(salida(r)) && id === 'gitlab', false, 'no nombra a la otra forja');
    const enDevelop = enBare(e.bare, 'ls-tree', '-r', '--name-only', 'develop').split('\n');
    for (const f of ['app.py', 'CLAUDE.md', '.gitignore', '.faro.json']) assert.ok(enDevelop.includes(f), `${f} en develop\n${enDevelop}`);
    // El sidecar es local: *.faro está en el .gitignore y lo lee /faro:adoptar para fundirlo.
    assert.ok(fs.existsSync(path.join(dir, 'CLAUDE.md.faro')), 'la versión FARO queda al lado');
    assert.equal(enDevelop.includes('CLAUDE.md.faro'), false);
    assert.match(enBare(e.bare, 'show', 'develop:CLAUDE.md'), /^mío$/m, 'el CLAUDE.md propio no se pisa');
    const v = verbos(e.llamadas());
    assert.ok(v.includes(e.f.crear), v.join('\n'));
    assert.equal(v.some((x) => x.includes('/orgs/')), false);
  });
}

test('un clon fallido no enseña el token', () => {
  const e = escenario('github');
  const r = e.lanzar(['--perfil=github', '--abrir=ajena/no-existe', '--yes', '--no-open', '--dir=.']);
  assert.notEqual(r.status, 0);
  assert.equal(salida(r).includes(TOKEN), false, salida(r));
  assert.match(salida(r), /ajena\/no-existe/, 'el error dice qué repo falló');
});

test('adoptar en gitlab con un webhook heredado en el perfil: no llama a nadie más que a la forja', () => {
  const e = escenario('gitlab');
  fs.writeFileSync(path.join(e.home, '.faro.json'), JSON.stringify({ perfiles: [{ id: 'gitlab', webhook: 'https://n8n.ejemplo.es/w', webhook_token: 'S' }] }));
  const dir = path.join(e.trabajo, 'mi-repo');
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'app.txt'), 'hola');
  const r = e.lanzar(['--perfil=gitlab', '--adoptar', '--yes', '--dir=.', '--domain=sistemas', '--naturaleza=documental', '--nombre=mi-repo', '--no-open'], dir);
  assert.equal(r.status, 0, salida(r));
  assert.deepEqual([...new Set(e.llamadas().map((l) => l.host))], ['gitlab.com']);
});

test('traer y migrar a gitlab: crea el destino, sube todas las ramas y tags, cambia origin y adopta', () => {
  const e = escenario('gitlab', { cuentaLimpia: 'ana' });
  const dir = path.join(e.trabajo, 'app'); fs.mkdirSync(dir);
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'a@b.c'); g('config', 'user.name', 'A');
  fs.writeFileSync(path.join(dir, 'app.py'), 'print(1)\n'); g('add', '.'); g('commit', '-qm', 'uno'); g('tag', 'v1');
  g('checkout', '-qb', 'feature/x'); fs.writeFileSync(path.join(dir, 'x.txt'), 'x'); g('add', '.'); g('commit', '-qm', 'dos'); g('checkout', '-q', 'main');
  g('remote', 'add', 'origin', 'https://github.com/viejo/app.git');
  const r = e.lanzar(['--perfil=gitlab', '--traer', '--migrar=https://gitlab.com/ana/mi-repo.git', '--yes', '--dir=.', '--domain=sistemas', '--naturaleza=app', '--no-open'], dir);
  assert.equal(r.status, 0, salida(r));
  assert.equal(salida(r).includes(TOKEN), false, 'el token no sale por pantalla');
  assert.equal(enBare(e.bare, 'rev-parse', '--verify', 'feature/x').length, 40, 'la rama de trabajo viaja');
  assert.equal(enBare(e.bare, 'rev-parse', '--verify', 'v1').length, 40, 'los tags viajan');
  assert.ok(enBare(e.bare, 'ls-tree', '-r', '--name-only', 'develop').split('\n').includes('app.py'), 'adoptado: develop con el código');
  assert.equal(enLocal(dir, 'remote', 'get-url', 'origin'), 'https://gitlab.com/ana/mi-repo.git');
  assert.equal(fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8').includes(TOKEN), false, 'el token no queda en .git/config');
  const v = verbos(e.llamadas());
  assert.equal(v.filter((x) => x === 'POST /projects').length, 1, v.join('\n'));
  assert.equal(e.llamadas().some((l) => l.host !== 'gitlab.com'), false, 'sin --yes no se archiva nada; con --yes, tampoco');
});
