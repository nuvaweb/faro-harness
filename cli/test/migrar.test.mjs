// Migrar un repo a otra forja o cuenta: crea el destino, sube todas las ramas y tags, cambia origin y
// archiva el viejo solo si se pide. git y la API van simulados: nada sale a la red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrarRepo, archivarRepo, entornoConToken, sanear } from '../bin/lib/migrar.mjs';

const altaSimulada = (existe = false, ok = true) => {
  const llamadas = [];
  return {
    llamadas,
    existe: async (s, ruta) => { llamadas.push(['existe', ruta]); return existe; },
    crearRepo: async (s, cuenta, datos) => { llamadas.push(['crearRepo', cuenta, datos.nombre]); return ok ? { ok: true, ruta: `${cuenta.org}/${datos.nombre}` } : { ok: false, mensaje: 'nombre ocupado' }; },
  };
};
const gitSimulado = () => { const ordenes = []; const entornos = []; return { ordenes, entornos, git: (dir, a, env) => { ordenes.push(a); entornos.push(env); } }; };
const TOKEN = 'glpat-SECRETO-123';
const base = { dir: '/repo', sesion: { host: 'gitlab.com', token: TOKEN }, cuenta: { org: 'g', personal: false }, nombre: 'app', ruta: 'g/app', usuario: 'oauth2', url: 'https://gitlab.com/g/app.git' };

test('crea el destino, sube todas las ramas y los tags y cambia origin', async () => {
  const alta = altaSimulada(false); const { git, ordenes } = gitSimulado();
  const r = await migrarRepo({ ...base, alta, git, remotoViejo: 'git@github.com:ana/app.git' });
  assert.equal(r.creado, true);
  assert.deepEqual(alta.llamadas[1], ['crearRepo', { org: 'g', personal: false }, 'app']);
  assert.deepEqual(ordenes, [
    ['push', base.url, 'refs/heads/*:refs/heads/*'],
    ['push', base.url, 'refs/tags/*:refs/tags/*'],
    ['remote', 'set-url', 'origin', base.url],
  ]);
});

test('si el destino ya existe no lo crea; sin origin previo, lo añade', async () => {
  const alta = altaSimulada(true); const { git, ordenes } = gitSimulado();
  const r = await migrarRepo({ ...base, alta, git, remotoViejo: null });
  assert.equal(r.creado, false);
  assert.ok(!alta.llamadas.some((l) => l[0] === 'crearRepo'));
  assert.deepEqual(ordenes.at(-1), ['remote', 'add', 'origin', base.url]);
});

test('si no puede crear el destino, para antes de empujar nada', async () => {
  const { git, ordenes } = gitSimulado();
  await assert.rejects(migrarRepo({ ...base, alta: altaSimulada(false, false), git }), /nombre ocupado/);
  assert.deepEqual(ordenes, []);
});

test('el token no va en los argumentos de git: viaja por entorno, acotado al host destino', async () => {
  const { git, ordenes, entornos } = gitSimulado();
  await migrarRepo({ ...base, alta: altaSimulada(false), git, remotoViejo: 'x' });
  for (const a of ordenes) assert.ok(!a.join(' ').includes(TOKEN), a.join(' '));
  const cifrado = Buffer.from(`oauth2:${TOKEN}`).toString('base64');
  for (const env of entornos.slice(0, 2)) {
    const n = Number(env.GIT_CONFIG_COUNT) - 1;
    assert.equal(env[`GIT_CONFIG_KEY_${n}`], 'http.https://gitlab.com/.extraHeader');
    assert.equal(env[`GIT_CONFIG_VALUE_${n}`], `Authorization: Basic ${cifrado}`);
  }
  assert.ok(!JSON.stringify(entornos[2] || {}).includes(cifrado), 'cambiar origin no necesita la credencial');
});

test('entornoConToken respeta la configuración por entorno que ya hubiera', () => {
  const env = entornoConToken('gitlab.com', 'oauth2', 't', { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'b' });
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.GIT_CONFIG_KEY_0, 'a');
  assert.equal(env.GIT_CONFIG_KEY_2, 'http.https://gitlab.com/.extraHeader');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('un error de git no enseña el token ni credenciales de una URL', async () => {
  const git = () => { throw new Error(`fatal: https://oauth2:${TOKEN}@gitlab.com/g/app.git y Authorization: Basic ${Buffer.from(`oauth2:${TOKEN}`).toString('base64')} ${TOKEN}`); };
  const e = await migrarRepo({ ...base, alta: altaSimulada(true), git }).catch((x) => x);
  assert.ok(e instanceof Error);
  assert.ok(!e.message.includes(TOKEN), e.message);
  assert.ok(!e.message.includes(Buffer.from(`oauth2:${TOKEN}`).toString('base64')), e.message);
  assert.match(sanear('https://u:p@host/x y glpat-1', 'glpat-1'), /^https:\/\/\*\*\*@host\/x y \*\*\*$/);
});

test('archivar: GitHub con PATCH archived, GitLab con POST archive', async () => {
  const pedidas = [];
  const fetchImpl = async (url, init) => { pedidas.push([url, init.method, init.body || null, init.headers.Authorization]); return { ok: true, status: 200 }; };
  assert.equal((await archivarRepo({ forja: 'github', host: 'github.com', ruta: 'ana/app', token: 't', fetchImpl })).ok, true);
  await archivarRepo({ forja: 'github', host: 'ghe.empresa.com', ruta: 'eq/app', token: 't', fetchImpl });
  await archivarRepo({ forja: 'gitlab', host: 'gitlab.com', ruta: 'g/sub/app', token: 't', fetchImpl });
  assert.deepEqual(pedidas[0], ['https://api.github.com/repos/ana/app', 'PATCH', '{"archived":true}', 'Bearer t']);
  assert.equal(pedidas[1][0], 'https://ghe.empresa.com/api/v3/repos/eq/app');
  assert.deepEqual(pedidas[2].slice(0, 2), ['https://gitlab.com/api/v4/projects/g%2Fsub%2Fapp/archive', 'POST']);
});

test('archivar sin token o con forja desconocida no llama a nada', async () => {
  const fetchImpl = async () => { throw new Error('no debe llamar'); };
  assert.equal((await archivarRepo({ forja: 'github', host: 'github.com', ruta: 'a/b', token: null, fetchImpl })).ok, false);
  assert.equal((await archivarRepo({ forja: 'desconocida', host: 'x', ruta: 'a/b', token: 't', fetchImpl })).ok, false);
});
