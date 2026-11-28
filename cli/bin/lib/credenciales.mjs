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

// VARIAS CUENTAS EN LA MISMA FORJA (misma forma que el plugin, lib/credenciales.js): cada login vive
// ademas en tokens[host].cuentas[login] = { token, ..., user, orgs, orgs_ts }. Un login con otra cuenta
// no borra la anterior; tokens[host] sigue siendo el ULTIMO login para quien solo lee el primer nivel.
//
// cuentaPara(host, cfg, owner): la cuenta guardada que llega a 'owner' (org de GitHub, grupo de GitLab o
// la propia cuenta). En GitLab el owner puede ser un subgrupo ('grupo/sub'): las orgs guardadas son los
// grupos RAIZ, asi que tambien vale el primer segmento. -> { ...cuenta, login } o null.
function cuentaPara(host, cfg, owner) {
  const o = String(owner || '').toLowerCase();
  const raiz = o.split('/')[0];
  const en = entrada(host, cfg);
  if (!o || !en || !en.cuentas) return null;
  const tiene = (c, x) => Array.isArray(c.orgs) && c.orgs.includes(x);
  const llega = ([login, c]) => c && c.token && (login === o || login === raiz || tiene(c, o) || tiene(c, raiz));
  const hit = Object.entries(en.cuentas).find(llega);
  return hit ? { ...hit[1], login: hit[0] } : null;
}

// Los datos de sesion (token, user, expira, refresh_token, client_id...) de la cuenta de 'owner' o, si no
// hay ninguna que llegue, el primer nivel (ultimo login), como antes.
function entradaPara(host, cfg, owner) {
  return cuentaPara(host, cfg, owner) || entrada(host, cfg);
}

// Las cuentas guardadas del host con token: [{ login, token, user, orgs, ... }].
function cuentasDe(host, cfg) {
  const en = entrada(host, cfg);
  return en && en.cuentas ? Object.entries(en.cuentas).filter(([, c]) => c && c.token).map(([login, c]) => ({ ...c, login })) : [];
}

// Anota que la cuenta 'login' llega a 'owner' (comprobado por API). -> true si cambia algo.
function anotarOrg(host, cfg, login, owner) {
  const en = entrada(host, cfg);
  const l = String(login || '').toLowerCase();
  const o = String(owner || '').toLowerCase();
  if (!o || !en || !en.cuentas || !en.cuentas[l]) return false;
  const orgs = Array.isArray(en.cuentas[l].orgs) ? en.cuentas[l].orgs : [];
  if (orgs.includes(o)) return false;
  en.cuentas[l].orgs = [...orgs, o];
  return true;
}

// Guarda la lista COMPLETA de organizaciones (GitHub) o grupos raiz (GitLab) de la cuenta, leida de la
// API tras autorizar, con su marca de tiempo (orgs + orgs_ts, la misma forma que escribe el plugin).
function guardarOrgs(host, cfg, login, orgs, ahora = Date.now()) {
  const en = entrada(host, cfg);
  const l = String(login || '').toLowerCase();
  if (!en || !en.cuentas || !en.cuentas[l] || !Array.isArray(orgs)) return false;
  en.cuentas[l].orgs = [...new Set(orgs.map((o) => String(o).toLowerCase()).filter(Boolean))];
  en.cuentas[l].orgs_ts = ahora;
  return true;
}

// tokenPara(host) -> token o null. Cascada: entorno -> cuenta que llega a 'owner' -> tokens[host] ->
// (solo GitHub) plano -> (solo GitHub) CLI gh. `gh` inyectable para tests.
function tokenPara(host, cfg, { env = process.env, gh = ghAuthToken, owner = null } = {}) {
  const en = entrada(host, cfg);
  const e = tokenDeEntorno(host, env, { forja: en && en.forja, confiable: hostConfiable(host, cfg) }); if (e) return e;
  const c = cuentaPara(host, cfg, owner); if (c) return String(c.token);
  if (en && en.token) return String(en.token);
  if (h(host) === 'github.com') {
    if (cfg && cfg.token) return String(cfg.token);
    return gh() || null;
  }
  return null;
}

const CAMPOS_CUENTA = ['token', 'refresh_token', 'expira', 'client_id', 'client_secret', 'redirect_uri', 'scopes', 'forja', 'user'];
const camposCuenta = (e) => Object.fromEntries(CAMPOS_CUENTA.filter((k) => e[k] !== undefined && e[k] !== null).map((k) => [k, e[k]]));
const loginDe = (u) => (u && (u.login || u.username) ? String(u.login || u.username).toLowerCase() : null);
const cuentaDelToken = (cuentas, token) => Object.keys(cuentas).find((k) => token && cuentas[k] && cuentas[k].token === token);

// Las cuentas tras guardar 'datos' sobre 'previo': el token anterior nunca se pierde. Si no era cuenta,
// se guarda bajo su user; sin user conocido, bajo una clave provisional que el plugin identifica por API.
function cuentasTras(previo, datos) {
  const cuentas = { ...(previo.cuentas || {}) };
  const ahora = new Date().toISOString();
  if (previo.token && previo.token !== datos.token && !cuentaDelToken(cuentas, previo.token)) {
    const kp = loginDe(previo.user) || `sin-identificar-${String(previo.token).slice(-6)}`;
    if (!cuentas[kp]) cuentas[kp] = { ...camposCuenta(previo), actualizado: ahora };
  }
  const k = loginDe(datos.user) || cuentaDelToken(cuentas, previo.token);
  if (k && datos.token) cuentas[k] = { ...(cuentas[k] || {}), ...camposCuenta(datos), actualizado: ahora };
  return cuentas;
}

// guardarToken(host, {token, user, scopes, client_id, forja, refresh_token, expira}) -> entrada.
// MERGE sobre lo previo (un login nuevo no pierde user/scopes ya conocidos si no los trae). Con user la
// cuenta va a cuentas[login]; sin user (renovacion) se actualiza la cuenta cuyo token se sustituye.
function guardarToken(host, datos, cfg) {
  cfgMigrada(cfg);
  const k = h(host);
  const previo = cfg.tokens[k] || {};
  const cuentas = cuentasTras(previo, datos);
  cfg.tokens[k] = { ...previo, ...datos, actualizado: new Date().toISOString() };
  if (Object.keys(cuentas).length) cfg.tokens[k].cuentas = cuentas;
  delete cfg.tokens[k].migrado;
  // ESPEJO del campo plano para GitHub mientras el plugin (y el helper de git legado) lo lean.
  if (esGithub(k) && datos.token) { cfg.token = datos.token; if (datos.scopes) cfg.token_scopes = datos.scopes; }
  return cfg.tokens[k];
}

// borrarToken(host, cfg[, login]): con login borra SOLO esa cuenta (las demas siguen) y, si el primer
// nivel era suyo, pasa a otra de las que quedan. Sin login, o si no queda otra, borra el host entero.
function borrarToken(host, cfg, login = null) {
  const k = h(host);
  const en = cfg.tokens && cfg.tokens[k];
  const l = login && String(login).toLowerCase();
  const otras = l && en && en.cuentas ? Object.entries(en.cuentas).filter(([x, c]) => x !== l && c && c.token) : [];
  if (otras.length) {
    const ido = en.cuentas[l];
    delete en.cuentas[l];
    if (!ido || en.token === ido.token) {
      for (const x of CAMPOS_CUENTA) delete en[x];
      Object.assign(en, camposCuenta(otras[0][1]), { actualizado: new Date().toISOString() });
      if (esGithub(k)) { cfg.token = en.token; delete cfg.token_scopes; }
    }
    return;
  }
  if (cfg.tokens) delete cfg.tokens[k];
  if (esGithub(k)) { delete cfg.token; delete cfg.token_scopes; }
}

// Tokens con caducidad (GitLab OAuth: 2 h). true si queda menos que el margen (por defecto 10 min).
const caduca = (en, margenMs = 600000, ahora = Date.now()) => !!(en && en.expira && (Number(en.expira) - ahora) < margenMs);

export { esGithub, esGitlab, hostPublico, hostConfiable, cfgMigrada, tokenDeEntorno, ghAuthToken, entrada, cuentaPara, entradaPara, cuentasDe, anotarOrg, guardarOrgs, tokenPara, guardarToken, borrarToken, caduca };
