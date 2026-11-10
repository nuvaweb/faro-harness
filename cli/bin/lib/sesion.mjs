// sesion.mjs — «ESTE ES TU GIT»: busca una sesión válida sin preguntar quién eres.
//
// Por host, el primer origen que la forja acepta gana: ~/.faro.json, entorno, CLI gh (solo github.com)
// y `git credential` en modo no interactivo. El entorno solo viaja a un host de confianza (público, con
// sesión guardada o con perfil): nunca a uno deducido por cómo se llama. Con remoto solo se mira su host: es el repo sobre el que se
// va a operar. Todo es inyectable (fetchImpl, credencialGit, gh, env) y nada escribe en la
// configuración: guardar la sesión elegida es cosa del login de cada forja.
import { execFileSync } from 'node:child_process';
import { PERFILES, perfilesConocidos } from './perfil.mjs';
import { esGithub, esGitlab, hostConfiable, cfgMigrada, tokenDeEntorno, ghAuthToken, caduca } from './credenciales.mjs';
import { ghHost } from './forjas/github.mjs';
import { api } from './forjas/gitlab.mjs';

const low = (s) => String(s || '').toLowerCase();
const nombreForja = (forja) => (forja === 'gitlab' ? 'GitLab' : 'GitHub');

// Token que git ya tiene para el host. Nunca abre un diálogo: si git necesitara preguntar, falla.
function leerCredencialGit(host, { ejecutar = execFileSync, env = process.env } = {}) {
  try {
    const salida = ejecutar('git', ['-c', 'credential.interactive=false', 'credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 8000, windowsHide: true,
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' },
    });
    const linea = String(salida).split(/\r?\n/).find((l) => l.startsWith('password='));
    return (linea && linea.slice('password='.length)) || null;
  } catch { return null; }
}

// {login, id, name, email} si la forja acepta el token · null si lo rechaza · 'sin-red' si no se sabe.
async function validar(forja, host, token, fetchImpl) {
  if (forja === 'gitlab') {
    const r = await api(host, token, 'user', { fetchImpl });
    if (r.status === 0 || r.status >= 500) return 'sin-red';
    return r.ok && r.body && r.body.username ? { login: r.body.username, id: r.body.id, name: r.body.name || null, email: r.body.email || null } : null;
  }
  try {
    const r = await ghHost(token, host, '/user', {}, fetchImpl);
    if (r.status >= 500) return 'sin-red';
    return r.status === 200 && r.body && r.body.login ? { login: r.body.login, id: r.body.id, name: r.body.name || null, email: r.body.email || null } : null;
  } catch { return 'sin-red'; }
}

// La forja del host: perfil, sesión guardada, forja declarada en git config o host público.
function forjaDeHost(host, entradaHost, perfil, declarada = null) {
  return (perfil && perfil.forja) || (entradaHost && entradaHost.forja) || declarada || (esGithub(host) ? 'github' : esGitlab(host) ? 'gitlab' : null);
}

// Perfil del host: el conocido o uno derivado de la forja, sin app OAuth si no consta ninguna.
function perfilDeHost(host, forja, perfil, entradaHost) {
  return perfil || { ...PERFILES[forja], id: `${forja}@${host}`, host, client_id: (entradaHost && entradaHost.client_id) || null, etiqueta: `${nombreForja(forja)} · ${host}`, derivado: true };
}

async function sesionDeHost(host, { cfg, lista, env, gh, credencialGit, fetchImpl, declarada = null }) {
  const guardada = cfg.tokens[host] || null;
  const conocido = lista.find((p) => low(p.host) === host) || null;
  const forja = forjaDeHost(host, guardada, conocido, declarada);
  if (!forja) return null;
  const perfil = perfilDeHost(host, forja, conocido, guardada);
  const nueva = (u, via, token, extra = {}) => ({ perfil, forja, host, login: u.login, id: u.id, name: u.name || null, email: u.email || null, via, token, ...extra });
  const usuarioGuardado = guardada && guardada.user && guardada.user.login ? guardada.user : null;

  if (guardada && guardada.token && usuarioGuardado && caduca(guardada) && guardada.refresh_token && guardada.client_id) {
    return nueva(usuarioGuardado, 'sesión guardada', String(guardada.token), { renovable: true });
  }
  const origenes = [
    ['sesión guardada', () => guardada && guardada.token],
    ['entorno', () => tokenDeEntorno(host, env, { forja, confiable: hostConfiable(host, cfg, lista) })],
    ...(host === 'github.com' ? [['GitHub CLI', () => gh()]] : []),
    ['git credential', () => credencialGit(host)],
  ];
  for (const [via, leer] of origenes) {
    const token = leer();
    if (!token) continue;
    const u = await validar(forja, host, token, fetchImpl);
    if (u === 'sin-red') {
      if (via === 'sesión guardada' && usuarioGuardado) return nueva(usuarioGuardado, via, String(token), { sinRed: true });
      continue;
    }
    if (u) return nueva(u, via, String(token));
  }
  return null;
}

// Sesiones válidas, una por host como mucho. `remoto` es el resultado de detectarForja.
async function buscarSesiones({ cfg = {}, perfiles = null, env = process.env, credencialGit = leerCredencialGit, gh = ghAuthToken, fetchImpl = fetch, remoto = null } = {}) {
  const copia = cfgMigrada({ ...cfg, tokens: { ...(cfg.tokens || {}) } });
  copia.tokens = Object.fromEntries(Object.entries(copia.tokens).map(([k, v]) => [low(k), v]));
  const lista = perfiles || perfilesConocidos(cfg);
  const hosts = remoto && remoto.host ? [low(remoto.host)] : [...new Set([...lista.map((p) => low(p.host)), ...Object.keys(copia.tokens)])];
  const declarada = remoto && remoto.declarada ? remoto.forja : null;
  const halladas = await Promise.all(hosts.map((host) => sesionDeHost(host, { cfg: copia, lista, env, gh, credencialGit, fetchImpl, declarada })));
  return halladas.filter(Boolean);
}

// Primero la última usada: por id exacto o, si era un perfil derivado (github@Org), por su base.
function ordenar(sesiones, ultimo) {
  if (!ultimo) return sesiones;
  const id = ultimo;
  const u = sesiones.find((s) => s.perfil.id === id) || sesiones.find((s) => s.perfil.id === id.split('@')[0]);
  return u ? [u, ...sesiones.filter((s) => s !== u)] : sesiones;
}

async function elegirSesion({ sesiones = [], ultimo = null, interactivo = false, preguntar = null } = {}) {
  if (!sesiones.length) return null;
  if (sesiones.length === 1) return sesiones[0];
  const orden = ordenar(sesiones, ultimo);
  if (!interactivo || !preguntar) return orden[0];
  const ops = Object.fromEntries(orden.map((s) => [s.perfil.id, { etiqueta: `${nombreForja(s.forja)} · @${s.login}`, explica: s.host }]));
  const id = await preguntar(ops);
  return orden.find((s) => s.perfil.id === id) || orden[0];
}

const hostPublico = (host) => ['github.com', 'gitlab.com'].includes(low(host));

function textoSesion(s) {
  const forja = hostPublico(s.host) ? nombreForja(s.forja) : `${nombreForja(s.forja)} (${s.host})`;
  return `Este es tu git: ${forja} · @${s.login}`;
}

const mensajeSinSesion = () => 'No he encontrado ninguna sesión de git y no hay terminal para conectar. Ejecuta `npx faro-harness --login` en una terminal, o define GITHUB_TOKEN o GITLAB_TOKEN.';

// Organizaciones o grupos donde la cuenta puede crear. Si no se pueden leer, lista vacía.
async function destinosDe({ forja, host, token }, fetchImpl) {
  try {
    if (forja === 'gitlab') {
      const r = await api(host, token, 'groups?min_access_level=30&per_page=100', { fetchImpl });
      return r.ok && Array.isArray(r.body) ? r.body.map((g) => g.full_path) : [];
    }
    const r = await ghHost(token, host, '/user/orgs?per_page=100', {}, fetchImpl);
    return r.ok && Array.isArray(r.body) ? r.body.map((o) => o.login) : [];
  } catch { return []; }
}

// Dónde se trabaja: --org > fijado por remoto o perfil > elección. Sin organizaciones o sin nadie a
// quien preguntar, la cuenta personal. Una sesión basta: ninguna rama exige pertenecer a nada.
async function resolverDestino({ sesion, org = null, fijo = null, preguntar = null, fetchImpl = fetch }) {
  const personal = { org: sesion.login, personal: true };
  const dado = org || fijo;
  if (dado) return { org: dado, personal: low(dado) === low(sesion.login) };
  if (!preguntar) return personal;
  const lista = await destinosDe(sesion, fetchImpl);
  if (!lista.length) return personal;
  const ops = { __personal: { etiqueta: `Tu cuenta personal (@${sesion.login})` }, ...Object.fromEntries(lista.map((o) => [o, { etiqueta: o }])) };
  const elegido = await preguntar(ops);
  return elegido && elegido !== '__personal' ? { org: elegido, personal: false } : personal;
}

// ¿Puede administrar el destino? Solo orienta: desbloquea permisos de owner, nunca impide trabajar.
async function rolDestino({ sesion, destino, fetchImpl = fetch }) {
  if (destino.personal) return true;
  try {
    if (sesion.forja === 'gitlab') {
      const r = await api(sesion.host, sesion.token, `groups/${encodeURIComponent(destino.org)}/members/all/${sesion.id}`, { fetchImpl });
      return r.ok && !!r.body && r.body.access_level >= 50;
    }
    const r = await ghHost(sesion.token, sesion.host, `/user/memberships/orgs/${destino.org}`, {}, fetchImpl);
    return r.status === 200 && r.body.state === 'active' && r.body.role === 'admin';
  } catch { return false; }
}

export { buscarSesiones, elegirSesion, textoSesion, mensajeSinSesion, leerCredencialGit, nombreForja, perfilDeHost, resolverDestino, rolDestino };
