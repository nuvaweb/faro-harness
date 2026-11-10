// Aislamiento de git para la suite (#169). Los tests crean repos temporales y commitean; si heredan la
// config del usuario (commit.gpgsign=true + agente de firma como 1Password) cada commit invoca el agente:
// con el agente bloqueado la bateria cae en bloque y con el agente activo lanza avisos de aprobacion.
// Aqui se fija una config GLOBAL propia (sin firma, identidad fija) y se anula la del sistema y la
// inyectada por variables (GIT_CONFIG_COUNT/PARAMETERS pesan mas que cualquier fichero).
// Uso: aislarGit(env) devuelve una COPIA de env aislada; aislarGit() la aplica a process.env (run.js).
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');

const CONFIG = [
  '[user]', '\tname = FARO Test', '\temail = test@faro.invalid',
  '[commit]', '\tgpgsign = false',
  '[tag]', '\tgpgsign = false',
  '[init]', '\tdefaultBranch = main',
  '',
].join('\n');

let _fichero = null;
function ficheroConfig() {
  if (_fichero && fs.existsSync(_fichero)) return _fichero;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-gitcfg-'));
  _fichero = path.join(dir, 'gitconfig');
  fs.writeFileSync(_fichero, CONFIG);
  return _fichero;
}

function aislarGit(env) {
  const destino = env || process.env;
  const out = env ? { ...env } : destino;
  for (const k of Object.keys(out)) {
    if (k === 'GIT_CONFIG_COUNT' || k === 'GIT_CONFIG_PARAMETERS' || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete out[k];
  }
  const f = ficheroConfig();
  out.GIT_CONFIG_GLOBAL = f;
  out.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'NUL' : '/dev/null';
  out.GIT_CONFIG_NOSYSTEM = '1';
  return out;
}

module.exports = { aislarGit };
