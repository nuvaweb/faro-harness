// Un Worker desplegado tiene que decir DE QUE REPO salio.
//
// El caso que lo motiva: alguien abre el dashboard de Cloudflare mirando un incidente, ve un worker
// con un nombre generico ('api', 'worker-prod') y no tiene forma de llegar al codigo. Eso duele
// justo cuando mas prisa hay.
//
// Cloudflare NO tiene campo estandar para esto —verificado en su documentacion de configuracion:
// existe 'vars' para texto libre y nada mas— asi que la convencion la pone FARO: una var 'REPO_URL'.
// Y como el harness YA sabe cual es el remoto, no se limita a pedirla: dice CUAL poner.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS = path.join(RAIZ, 'plugins', 'faro', 'hooks', 'harness.js');

// Worker con remoto conocido: es lo que permite comparar lo declarado con la realidad.
function worker(wrangler, { remoto = 'https://github.com/acme-org/mi-worker.git' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-wk-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  if (remoto) git('remote', 'add', 'origin', remoto);
  fs.writeFileSync(path.join(dir, 'wrangler.json'), JSON.stringify(wrangler));
  return dir;
}
const infra = (dir) => {
  const r = spawnSync(process.execPath, [HARNESS, 'infra'], {
    cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  return r.stdout + r.stderr;
};
const BASE = { name: 'api', compatibility_date: '2026-01-01' };

test('sin REPO_URL avisa, y dice QUE url poner (no solo que falta)', () => {
  const s = infra(worker(BASE));
  assert.match(s, /REPO_URL/, s.slice(0, 400));
  // Lo que separa un aviso util de uno que solo da trabajo: trae la respuesta puesta.
  assert.match(s, /https:\/\/github\.com\/acme-org\/mi-worker/, `debe decir el remoto real: ${s.slice(0, 500)}`);
  assert.match(s, /de que repo salio|dashboard/i, 'y POR QUE importa, no solo la regla');
});

test('con REPO_URL correcta CALLA (el silencio es lo normal)', () => {
  const s = infra(worker({ ...BASE, vars: { REPO_URL: 'https://github.com/acme-org/mi-worker' } }));
  assert.ok(!/REPO_URL/.test(s), `no deberia avisar:\n${s.slice(0, 400)}`);
});

// Peor que no tenerla es tenerla MAL: una url que apunta a otro repo manda a leer el codigo
// equivocado, y nadie duda de un dato que esta escrito.
test('con REPO_URL de OTRO repo avisa del desajuste', () => {
  const s = infra(worker({ ...BASE, vars: { REPO_URL: 'https://github.com/otro/distinto' } }));
  assert.match(s, /NO coincide/i, s.slice(0, 400));
  assert.match(s, /peor que ninguna/i, 'debe explicar por que importa mas que la ausencia');
});

test('acepta los otros nombres habituales de la variable', () => {
  for (const clave of ['GIT_REPO', 'SOURCE_REPO']) {
    const s = infra(worker({ ...BASE, vars: { [clave]: 'https://github.com/acme-org/mi-worker' } }));
    assert.ok(!/sin 'REPO_URL'/.test(s), `'${clave}' deberia valer igual:\n${s.slice(0, 300)}`);
  }
});

// Sin remoto no se puede decir cual poner, pero el aviso sigue teniendo sentido: el worker sigue sin
// declarar su origen. Lo que NO puede hacer es inventarse una url.
test('sin remoto avisa igual, pero no inventa una url', () => {
  const s = infra(worker(BASE, { remoto: null }));
  assert.match(s, /REPO_URL/, s.slice(0, 300));
  assert.match(s, /<url del repo>/, 'sin remoto, deja el hueco marcado en vez de rellenarlo');
});

// Es un AVISO de infra, no un gate: un worker sin REPO_URL se despliega igual. Bloquear por esto
// pararia un despliegue urgente por un dato de trazabilidad.
test('es un aviso, no bloquea', () => {
  const r = spawnSync(process.execPath, [HARNESS, 'infra'], {
    cwd: worker(BASE), encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: worker(BASE) },
  });
  assert.strictEqual(r.status, 0, 'infra informa; no es un gate');
});
