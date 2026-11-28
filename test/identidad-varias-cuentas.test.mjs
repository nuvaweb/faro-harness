// Varias cuentas en la MISMA forja + una clave SSH (que es de UNA sola cuenta). La identidad del repo
// es la cuenta de la org de ESE repo (no el ultimo login), y una clave SSH de otra cuenta solo AVISA:
// propone pasar el remoto a HTTPS. Sin red: git, almacen y ssh son falsos.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const crear = require('../plugins/faro/hooks/lib/github-identidad.js');

function modulo({ remote = 'git@github.com:OrgA/repo.git', saludo = 'Hi ana-b! You\'ve successfully authenticated, but GitHub does not provide shell access.' } = {}) {
  const ssh = [];
  const git = (...a) => (a[0] === 'remote' && a[1] === 'get-url' ? remote : '');
  const CRED = {
    // ultimo login: ana-b (OrgB); la cuenta de OrgA es ana-a
    entrada: () => ({ token: 'x', user: { login: 'ana-b' } }),
    cuentaPara: (host, owner) => (String(owner).toLowerCase() === 'orga' ? { token: 'y', user: { login: 'ana-a', email: 'ana@a.test' } } : null),
  };
  const runCmd = (cmd, args) => { ssh.push([cmd, ...args].join(' ')); return /ssh/.test(cmd) ? saludo : ''; };
  const m = crear({ git, CRED, ROOT: process.cwd(), IS_TEMPLATE: false, runCmd, ghApi: () => null, ghRepo: () => null,
    ghHost: () => 'github.com', ghApiBase: () => 'https://api.github.com/', ghWebBase: () => 'https://github.com/',
    readCfg: () => ({}), writeCfg: () => {}, cachedUser: () => null });
  return { m, ssh };
}

test('la identidad del repo es la cuenta de SU org, no el ultimo login (sin tocar la red)', () => {
  const { m, ssh } = modulo();
  const id = m.authIdentity();
  assert.strictEqual(id.login, 'ana-a');
  assert.strictEqual(id.source, 'almacen');
  assert.strictEqual(ssh.length, 0, 'el arranque normal no hace ssh -T');
});

test('clave SSH de otra cuenta: avisa con la URL HTTPS del repo, sin bloquear', () => {
  const { m } = modulo();
  assert.strictEqual(m.sshIdentity(), 'ana-b');
  const aviso = m.avisoSshAjeno('ana-a');
  assert.match(aviso, /@ana-b/);
  assert.ok(aviso.includes('git remote set-url origin https://github.com/OrgA/repo.git'), aviso);
});

test('sin aviso si la clave es de la misma cuenta o si el remoto ya es HTTPS', () => {
  assert.strictEqual(modulo().m.avisoSshAjeno('ANA-B'), null);
  const https = modulo({ remote: 'https://github.com/OrgA/repo.git' });
  assert.strictEqual(https.m.avisoSshAjeno('ana-a'), null);
  assert.strictEqual(https.ssh.length, 0);
});

test('GitLab: reconoce el saludo SSH', () => {
  const { m } = modulo({ remote: 'git@gitlab.com:grupo/proy.git', saludo: 'Welcome to GitLab, @Ana.B!' });
  assert.strictEqual(m.sshIdentity(), 'ana.b');
  assert.ok(m.avisoSshAjeno('ana-a').includes('https://gitlab.com/grupo/proy.git'));
});
