// subir (#194): TODA subida del harness pasa por lib/subir.js. Si el 'git push' normal falla por
// credenciales o red (sin SSH, sin credential manager, sin red al remoto configurado), se reintenta
// por HTTPS con el TOKEN que el harness ya guarda — sin escribirlo en la config de git ni en la linea
// de comandos. Si la forja RECHAZA (rama protegida), no se reintenta con token: se informa
// 'rechazado' para que el llamante tome la via API (PR + merge).
//
// Sin red: el remoto es un bare en disco; la "URL con token" de los tests apunta a otro bare.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `faro-${n}-`));
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });
const subirMod = async () => (await import(`file://${path.join(HOOKS, 'lib', 'subir.js').replace(/\\/g, '/')}`)).default;

function repoConRemoto(nombre) {
  const bare = tmp(`${nombre}-remoto`);
  git(bare, 'init', '--bare', '-b', 'main');
  const dir = tmp(nombre);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'base');
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-u', 'origin', 'main');
  return { dir, bare };
}
const commitNuevo = (dir, f = 'b.txt') => { fs.writeFileSync(path.join(dir, f), String(Math.random())); git(dir, 'add', '-A'); git(dir, 'commit', '-m', 'mas'); };
const cabeza = (repo, ref) => (git(repo, 'rev-parse', ref).stdout || '').trim();

test('con el remoto accesible sube por la via normal (git) y no toca el token', async () => {
  const subir = await subirMod();
  const { dir, bare } = repoConRemoto('subir-normal');
  commitNuevo(dir);
  const r = subir(['main'], { ROOT: dir, token: 'tok', urlAlternativa: 'no-deberia-usarse' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.via, 'git');
  assert.strictEqual(cabeza(bare, 'main'), cabeza(dir, 'main'));
});

test('si el push normal falla (remoto inaccesible) y hay token, reintenta por HTTPS con el token', async () => {
  const subir = await subirMod();
  const { dir } = repoConRemoto('subir-token');
  const otro = tmp('subir-token-https');
  git(otro, 'init', '--bare', '-b', 'main');
  const origenRoto = path.join(tmp('nada'), 'no-existe.git');
  git(dir, 'remote', 'set-url', 'origin', origenRoto);
  commitNuevo(dir);
  const r = subir(['main'], { ROOT: dir, token: 'tok-secreto', urlAlternativa: otro });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.via, 'token');
  assert.strictEqual(cabeza(otro, 'main'), cabeza(dir, 'main'), 'el trabajo llega al remoto por la via del token');
  const cfg = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
  assert.doesNotMatch(cfg, /tok-secreto|extraheader/i, 'el token NO se guarda en la config de git');
  assert.strictEqual((git(dir, 'remote', 'get-url', 'origin').stdout || '').trim(), origenRoto, 'origin no se reescribe');
});

test('con -u tras subir por token, la rama queda siguiendo a origin (no a la URL del token)', async () => {
  const subir = await subirMod();
  const { dir } = repoConRemoto('subir-upstream');
  const otro = tmp('subir-upstream-https');
  git(otro, 'init', '--bare', '-b', 'main');
  git(dir, 'remote', 'set-url', 'origin', path.join(tmp('nada'), 'no-existe.git'));
  git(dir, 'switch', '-c', 'feat/x');
  commitNuevo(dir);
  const r = subir(['feat/x'], { ROOT: dir, token: 'tok', urlAlternativa: otro, upstream: true });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual((git(dir, 'config', 'branch.feat/x.remote').stdout || '').trim(), 'origin');
});

test('sin token y con el push normal fallando: no inventa nada, dice como conectarse', async () => {
  const subir = await subirMod();
  const { dir } = repoConRemoto('subir-sin-token');
  git(dir, 'remote', 'set-url', 'origin', path.join(tmp('nada'), 'no-existe.git'));
  commitNuevo(dir);
  const r = subir(['main'], { ROOT: dir, token: null, urlAlternativa: null });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.via, null);
  assert.match(r.msg, /harness\.js auth/);
});

test('si la forja RECHAZA (rama protegida) no reintenta con token: informa rechazado para ir por API', async () => {
  const subir = await subirMod();
  const { dir, bare } = repoConRemoto('subir-protegida');
  const hook = path.join(bare, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  const otro = tmp('subir-protegida-https');
  git(otro, 'init', '--bare', '-b', 'main');
  commitNuevo(dir);
  const r = subir(['main'], { ROOT: dir, token: 'tok', urlAlternativa: otro });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.rechazado, true, JSON.stringify(r));
  assert.strictEqual((git(otro, 'branch').stdout || '').trim(), '', 'no debe haber subido nada por la via del token');
});

test('urlHttps: deduce la URL HTTPS del remoto (SSH o HTTPS) en GitHub y GitLab; null si no es una forja conocida', async () => {
  const subir = await subirMod();
  const { urlHttps } = subir;
  assert.strictEqual(urlHttps({ forge: 'github', host: 'github.com', path: 'org/repo' }), 'https://github.com/org/repo.git');
  assert.strictEqual(urlHttps({ forge: 'gitlab', host: 'gitlab.com', path: 'grupo/sub/proy' }), 'https://gitlab.com/grupo/sub/proy.git');
  assert.strictEqual(urlHttps({ forge: 'desconocida', host: null, path: null }), null);
});

// ---- Rama protegida -> peticion por API, verificada (#194, revision) ----
// La forja simulada: un pre-receive que rechaza SOLO la rama protegida, y un adaptador falso cuyo
// integrarPorPeticion "fusiona" moviendo la rama en el bare (como haria la forja al aceptar la peticion).
function proteger(bare, rama) {
  const hook = path.join(bare, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, `#!/bin/sh\nwhile read o n r; do if [ "$r" = "refs/heads/${rama}" ]; then echo "GH006: Protected branch update failed for $r." >&2; exit 1; fi; done\nexit 0\n`);
  fs.chmodSync(hook, 0o755);
}
function forjaFalsa(bare, { mentir = false } = {}) {
  const llamadas = [];
  return {
    llamadas,
    async integrarPorPeticion({ head, base, sha: esperado }) {
      llamadas.push({ head, base, esperado });
      const sha = cabeza(bare, `refs/heads/${head}`);
      if (!mentir) git(bare, 'update-ref', `refs/heads/${base}`, sha);
      return { ok: true, numero: 7, url: 'u7', sha: mentir ? 'f'.repeat(40) : sha };
    },
  };
}

test('subirOIntegrar: develop protegida -> sube lo local a una temporal, la integra por peticion, alinea y borra la temporal', async () => {
  const subir = await subirMod();
  const { dir, bare } = repoConRemoto('soi');
  git(dir, 'switch', '-c', 'develop'); git(dir, 'push', '-u', 'origin', 'develop');
  proteger(bare, 'develop');
  commitNuevo(dir, 'c1.txt'); commitNuevo(dir, 'c2.txt');   // p. ej. merges de consolidar + commit previo
  const local = cabeza(dir, 'develop');
  const gh = forjaFalsa(bare);
  const r = await subir.subirOIntegrar('develop', { ROOT: dir, gh, esperaMs: 0 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.via, 'api');
  assert.strictEqual(gh.llamadas[0].base, 'develop');
  assert.match(gh.llamadas[0].head, /^faro\/integrar-develop-/);
  assert.strictEqual(gh.llamadas[0].esperado, local, '#262: el adaptador fusiona exactamente el commit subido (SHA de cabeza)');
  assert.strictEqual(cabeza(bare, 'develop'), local, 'todos los commits locales llegan a la forja');
  assert.strictEqual(cabeza(dir, 'develop'), cabeza(bare, 'develop'), 'develop local queda igual que la forja');
  assert.doesNotMatch(git(bare, 'branch').stdout || '', /faro\/integrar-/, 'la rama temporal se borra');
});

test('integrar: si la forja dice que fusiono pero el resultado no se ve, NO se da por bueno (ni se alinea ni se tagea)', async () => {
  const subir = await subirMod();
  const { dir, bare } = repoConRemoto('integrar-mentira');
  git(dir, 'switch', '-c', 'develop'); commitNuevo(dir); git(dir, 'push', '-u', 'origin', 'develop');
  const r = await subir.integrar({ ROOT: dir, gh: forjaFalsa(bare, { mentir: true }), head: 'develop', base: 'main', debeContener: cabeza(dir, 'develop') });
  assert.strictEqual(r.ok, false);
  assert.match(r.msg, /no pude comprobar el resultado/);
});

test('integrar: con la peticion fusionada de verdad devuelve el sha de la forja, que contiene lo integrado', async () => {
  const subir = await subirMod();
  const { dir, bare } = repoConRemoto('integrar-ok');
  git(dir, 'switch', '-c', 'develop'); commitNuevo(dir); git(dir, 'push', '-u', 'origin', 'develop');
  const r = await subir.integrar({ ROOT: dir, gh: forjaFalsa(bare), head: 'develop', base: 'main', debeContener: cabeza(dir, 'develop') });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.sha, cabeza(bare, 'main'));
  assert.strictEqual(cabeza(dir, 'origin/main'), r.sha, 'origin/main ya refleja la forja');
});

test('traer: si el fetch normal falla, trae por la via del token (origin/<rama> no se queda con el valor viejo)', async () => {
  const subir = await subirMod();
  const { dir, bare } = repoConRemoto('traer-token');
  const otro = path.join(tmp('clon'), 'c'); git(path.dirname(otro), 'clone', bare, 'c');
  git(otro, 'config', 'user.email', 't@t'); git(otro, 'config', 'user.name', 'T'); git(otro, 'config', 'commit.gpgsign', 'false');
  commitNuevo(otro); git(otro, 'push', 'origin', 'main');
  git(dir, 'remote', 'set-url', 'origin', path.join(tmp('nada'), 'no-existe.git'));
  const r = subir.traer('main', { ROOT: dir, token: 'tok', urlAlternativa: bare });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.via, 'token');
  assert.strictEqual(cabeza(dir, 'origin/main'), cabeza(bare, 'main'));
});

test('subir: ir POR DETRAS de la forja no se "arregla" con el token: se dice que hay que traer primero', async () => {
  const subir = await subirMod();
  const { dir, bare } = repoConRemoto('detras');
  const otro = path.join(tmp('clon2'), 'c'); git(path.dirname(otro), 'clone', bare, 'c');
  git(otro, 'config', 'user.email', 't@t'); git(otro, 'config', 'user.name', 'T'); git(otro, 'config', 'commit.gpgsign', 'false');
  commitNuevo(otro, 'x.txt'); git(otro, 'push', 'origin', 'main');
  commitNuevo(dir, 'y.txt');
  const r = subir(['main'], { ROOT: dir, token: 'tok', urlAlternativa: 'no-deberia-usarse' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.detras, true, JSON.stringify(r));
  assert.match(r.msg, /sincronizar/);
});

test('moverRama: en la rama en curso usa reset --keep (el arbol sigue coherente); fuera, mueve la ref', async () => {
  const subir = await subirMod();
  const { dir } = repoConRemoto('mover');
  const base = cabeza(dir, 'main');
  commitNuevo(dir, 'z.txt');
  const r = subir.moverRama('main', base, { ROOT: dir });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(cabeza(dir, 'HEAD'), base);
  assert.ok(!fs.existsSync(path.join(dir, 'z.txt')), 'el arbol sigue a la rama');
  assert.strictEqual((git(dir, 'status', '--porcelain').stdout || '').trim(), '');
});
