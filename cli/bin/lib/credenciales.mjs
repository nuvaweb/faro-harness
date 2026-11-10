// credenciales.mjs — ALMACEN DE CREDENCIALES POR HOST (~/.faro.json > tokens[host]).
//
// Misma forma que lib/credenciales.js del plugin faro (fuente de verdad COMPARTIDA): quien necesita
// credencial pregunta por HOST, no por forja. Una persona puede tener sesion a la vez en github.com,
// gitlab.com y el GitLab de un cliente: tres hosts, tres tokens, tres apps OAuth.
//
//   tokens: { "github.com": { token, user, scopes, forja, actualizado },
//             "gitlab.com": { token, refresh_token?, expira?, user, scopes, client_id, forja, actualizado } }
//
// El 'token' plano antiguo se migra a tokens["github.com"] UNA vez y se mantiene ESPEJADO (token +
// token_scopes) mientras el plugin lo lea. Antes el wizard solo escribia el plano y el plugin solo
// leia tokens[host] tras la primera migracion: cada login nuevo del wizard quedaba invisible para el
// harness (seguia con el token viejo o revocado). Con este modulo los dos escriben lo mismo.
//
// Este modulo es PURO sobre un objeto cfg: la carga/guardado del fichero la hace core.mjs
// (loadConfig/saveConfig). Asi es testeable sin tocar ~/.faro.json.
import { execFileSync } from 'node:child_process';

const esGithub = (host) => /(^|\.)github\.com$/i.test(String(host || ''));
// Solo gitlab.com: un servidor con «gitlab» en el nombre no es por eso una forja conocida.
const esGitlab = (host) => /(^|.)gitlab.com$/i.test(String(host || ''));
const h = (host) => String(host || '').toLowerCase();
const hostPublico = (host) => ['github.com', 'gitlab.com'].includes(h(host));

// Un host recibe tokens globales (entorno, CLI gh) solo si es público o el usuario lo ha declarado:
// tiene sesión guardada en ~/.faro.json o un perfil propio. Nunca por cómo se llama.
function hostConfiable(host, cfg = {}, perfiles = []) {
  const k = h(host);
  if (!k) return false;
  if (hostPublico(k)) return true;
  if (cfg && cfg.tokens && Object.keys(cfg.tokens).some((t) => h(t) === k)) return true;
  return (perfiles || []).some((p) => p && h(p.host) === k);
}

// Migra el 'token' plano a tokens["github.com"] UNA vez. Idempotente. Si la entrada de host ya tiene
// token, MANDA la entrada (mismo criterio que el plugin: no se re-migra un plano cambiado a mano).
function cfgMigrada(cfg) {
  cfg.tokens = cfg.tokens || {};
  const gh = cfg.tokens['github.com'];
  if (cfg.token && !(gh && gh.token)) {
    cfg.tokens['github.com'] = { token: String(cfg.token), forja: 'github', scopes: cfg.token_scopes || null, user: cfg.user || null, actualizado: new Date().toISOString(), migrado: true };
  }
  return cfg;
}

// Variables de entorno por forja (override explícito, p. ej. en CI). Valen para los hosts públicos; un
// servidor propio solo las recibe si quien llama lo da por confiable y dice qué forja es.
const VARIABLES = { github: ['FARO_GITHUB_TOKEN', 'GITHUB_TOKEN'], gitlab: ['FARO_GITLAB_TOKEN', 'GITLAB_TOKEN'] };
function tokenDeEntorno(host, env = process.env, { forja = null, confiable = false } = {}) {
  const k = h(host);
  const f = k === 'github.com' ? 'github' : k === 'gitlab.com' ? 'gitlab' : (confiable ? forja : null);
  if (!VARIABLES[f]) return null;
  return VARIABLES[f].map((v) => String(env[v] || '').trim()).find(Boolean) || null;
}

function ghAuthToken() {
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, windowsHide: true }).trim() || null; } catch { return null; }
}

function entrada(host, cfg) {
  const t = (cfg && cfg.tokens) || {};
  return t[h(host)] || null;
}

// tokenPara(host) -> token o null. Cascada: entorno -> tokens[host] -> (solo GitHub) plano -> (solo
// GitHub) CLI gh. `gh` inyectable para tests.
function tokenPara(host, cfg, { env = process.env, gh = ghAuthToken } = {}) {
  const en = entrada(host, cfg);
  const e = tokenDeEntorno(host, env, { forja: en && en.forja, confiable: hostConfiable(host, cfg) }); if (e) return e; if (en && en.token) return String(en.token);
  if (h(host) === 'github.com') {
    if (cfg && cfg.token) return String(cfg.token);
    return gh() || null;
  }
  return null;
}

// guardarToken(host, {token, user, scopes, client_id, forja, refresh_token, expira}) -> entrada.
// MERGE sobre lo previo (un login nuevo no pierde user/scopes ya conocidos si no los trae).
function guardarToken(host, datos, cfg) {
  cfgMigrada(cfg);
  const k = h(host);
  cfg.tokens[k] = { ...(cfg.tokens[k] || {}), ...datos, actualizado: new Date().toISOString() };
  delete cfg.tokens[k].migrado;
  // ESPEJO del campo plano para GitHub mientras el plugin (y el helper de git legado) lo lean.
  if (esGithub(k) && datos.token) { cfg.token = datos.token; if (datos.scopes) cfg.token_scopes = datos.scopes; }
  return cfg.tokens[k];
}

function borrarToken(host, cfg) {
  const k = h(host);
  if (cfg.tokens) delete cfg.tokens[k];
  if (esGithub(k)) { delete cfg.token; delete cfg.token_scopes; }
}

// Tokens con caducidad (GitLab OAuth: 2 h). true si queda menos que el margen (por defecto 10 min).
const caduca = (en, margenMs = 600000, ahora = Date.now()) => !!(en && en.expira && (Number(en.expira) - ahora) < margenMs);

export { esGithub, esGitlab, hostPublico, hostConfiable, cfgMigrada, tokenDeEntorno, ghAuthToken, entrada, tokenPara, guardarToken, borrarToken, caduca };
