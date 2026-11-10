// gitcred.mjs — credenciales de GIT derivadas del almacen por host (~/.faro.json > tokens[host]) y
// reescritura url.insteadOf para el marketplace del plugin.
//
// 1) HELPER de credenciales, acotado por git a host/org (credential.https://<host>/<org>.helper,
//    nunca global a todo el host): git le pasa 'host=<host>' por stdin y el helper responde con el
//    token de ESE host. Usuario 'x-access-token' en GitHub y 'oauth2' en GitLab (asi lo esperan).
// 2) REESCRITURA url.<con token>.insteadOf <url limpia>, acotada al repo del marketplace: las
//    actualizaciones EN SEGUNDO PLANO de un marketplace privado desactivan los credential helpers
//    (documentado por Claude Code), asi que el helper de arriba sirve para instalar pero el
//    autoUpdate podia fallar en silencio. La via documentada es esta reescritura. Se retira y se
//    reescribe en cada login (token fresco) y se retira en --reautorizar antes de revocar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const gitGlobal = (args) => { try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch { return ''; } };
const usuarioHttp = (forja) => (forja === 'github' ? 'x-access-token' : 'oauth2');
// Correo noreply de la forja: atribuye el commit a la cuenta sin exponer el real.
const noreplyDe = (auth, perfil) => `${auth.id ? auth.id + (perfil.forja === 'gitlab' ? '-' : '+') : ''}${auth.login}@users.noreply.${perfil.host}`;
const claveHelper = (host, org) => `credential.https://${host}/${org}.helper`;
// Override del marketplace del plugin (misma clave que lee el harness): un cliente con espejo propio.
const overrideMarketplace = () => gitGlobal(['config', '--global', 'faro.marketplaceUrl']).trim();

function contenidoHelper() {
  return [
    '#!/bin/sh',
    '# Credential helper de git generado por el CLI FARO: token del almacen por host (~/.faro.json > tokens[host]).',
    '# Acotado por git a host/org (credential.https://<host>/<org>.helper); nunca global.',
    'if [ "$1" != "get" ]; then exit 0; fi',
    'HOST=""',
    'while IFS= read -r line; do case "$line" in host=*) HOST="${line#host=}";; esac; done',
    'FARO_HOST="$HOST" node -e "',
    "const fs=require('fs'), os=require('os'), path=require('path');",
    "const host=String(process.env.FARO_HOST||'').toLowerCase();",
    "const esGithub=/(^|[.])github[.]com$/.test(host);",
    "try { const cfg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.faro.json'),'utf8'));",
    "  const e=(cfg.tokens||{})[host]; let tok=e&&e.token;",
    "  if(!tok && esGithub) tok=cfg.token;",
    "  if(tok){ console.log('username='+(esGithub?'x-access-token':'oauth2')); console.log('password='+tok); } } catch {}",
    '"',
    '',
  ].join('\n');
}

function escribirScriptHelper() {
  const dir = path.join(os.homedir(), '.faro');
  const p = path.join(dir, 'git-credential-faro.sh');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, contenidoHelper(), { mode: 0o700 });
  return p.replace(/\\/g, '/');
}

// Registra el helper para host/org con RESET explicito antes (helper='' corta la cadena heredada de
// --system, p. ej. Git Credential Manager, que si no lanza su propio modal primero). Idempotente.
function cablearHelper(host, org, { git = gitGlobal, escribirScript = escribirScriptHelper } = {}) {
  const ruta = escribirScript();
  const k = claveHelper(host, org);
  git(['config', '--global', '--unset-all', k]);
  git(['config', '--global', k, '']);
  git(['config', '--global', '--add', k, `!sh '${ruta}'`]);
}

const urlConToken = (url, usuario, token) => String(url).replace(/^https:\/\//, `https://${usuario}:${token}@`);

// Claves url.*.insteadOf cuyo valor es la URL limpia del marketplace (una por token que se escribio).
function entradasPrevias(urlLimpia, git) {
  const re = `^${urlLimpia.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  const out = git(['config', '--global', '--get-regexp', 'url\\..*\\.insteadof', re]) || '';
  return out.split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
}
function retirarReescritura(urlLimpia, { git = gitGlobal } = {}) {
  for (const k of entradasPrevias(urlLimpia, git)) git(['config', '--global', '--unset-all', k.replace(/\.insteadof$/i, '.insteadOf')]);
}
function reescrituraMarketplace(urlLimpia, usuario, token, { git = gitGlobal } = {}) {
  retirarReescritura(urlLimpia, { git });
  git(['config', '--global', `url.${urlConToken(urlLimpia, usuario, token)}.insteadOf`, urlLimpia]);
}

export { contenidoHelper, escribirScriptHelper, claveHelper, cablearHelper, urlConToken, reescrituraMarketplace, retirarReescritura, usuarioHttp, noreplyDe, overrideMarketplace };
