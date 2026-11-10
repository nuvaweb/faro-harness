import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contenidoHelper, claveHelper, urlConToken, reescrituraMarketplace, retirarReescritura, usuarioHttp, cablearHelper } from '../bin/lib/gitcred.mjs';

test('contenidoHelper: lee host de stdin, tokens[host] y cae al plano solo en github', () => {
  const s = contenidoHelper();
  assert.match(s, /^#!\/bin\/sh/);
  assert.match(s, /host=/);                       // parsea la peticion de git
  assert.match(s, /tokens/);                       // almacen por host
  assert.match(s, /x-access-token/); assert.match(s, /oauth2/);
  assert.match(s, /github/);                       // fallback plano acotado a github
  assert.match(s, /FARO_HOST/);
});

test('claveHelper y usuarioHttp', () => {
  assert.equal(claveHelper('gitlab.com', 'Acme/plataforma/equipo'), 'credential.https://gitlab.com/Acme/plataforma/equipo.helper');
  assert.equal(usuarioHttp('github'), 'x-access-token'); assert.equal(usuarioHttp('gitlab'), 'oauth2');
});

test('urlConToken inserta usuario:token tras https://', () => {
  assert.equal(urlConToken('https://gitlab.com/g/p.git', 'oauth2', 'T'), 'https://oauth2:T@gitlab.com/g/p.git');
});

test('reescrituraMarketplace: retira entradas previas y escribe la nueva acotada al repo', () => {
  const llamadas = [];
  const git = (args) => { llamadas.push(args.join(' ')); if (args.includes('--get-regexp')) return 'url.https://x:VIEJO@github.com/Acme/faro-espejo.git.insteadof https://github.com/Acme/faro-espejo.git\n'; return ''; };
  reescrituraMarketplace('https://github.com/Acme/faro-espejo.git', 'x-access-token', 'NUEVO', { git });
  assert.ok(llamadas.some((l) => l.includes('--unset-all url.https://x:VIEJO@github.com/Acme/faro-espejo.git.insteadOf')));
  assert.ok(llamadas.some((l) => l === 'config --global url.https://x-access-token:NUEVO@github.com/Acme/faro-espejo.git.insteadOf https://github.com/Acme/faro-espejo.git'));
});

test('retirarReescritura: solo borra, no escribe', () => {
  const llamadas = [];
  const git = (args) => { llamadas.push(args.join(' ')); return args.includes('--get-regexp') ? 'url.https://a:b@h/r.git.insteadof https://h/r.git\n' : ''; };
  retirarReescritura('https://h/r.git', { git });
  assert.equal(llamadas.filter((l) => l.includes('--unset-all')).length, 1);
  assert.ok(!llamadas.some((l) => /insteadOf https/.test(l) && !l.includes('--unset-all')));
});

test('cablearHelper: reset + add con la ruta del script, sin tocar otros helpers', () => {
  const llamadas = [];
  cablearHelper('gitlab.com', 'Acme/plataforma/equipo', { git: (a) => { llamadas.push(a.join(' ')); return ''; }, escribirScript: () => 'C:/u/.faro/git-credential-faro.sh' });
  const k = 'credential.https://gitlab.com/Acme/plataforma/equipo.helper';
  assert.deepEqual(llamadas, [`config --global --unset-all ${k}`, `config --global ${k} `, `config --global --add ${k} !sh 'C:/u/.faro/git-credential-faro.sh'`]);
});
