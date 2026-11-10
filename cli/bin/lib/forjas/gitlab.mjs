// forjas/gitlab.mjs — ADAPTADOR DE GITLAB (modo PREPARAR: login, validación, check, abrir,
// adoptar). Misma interfaz que forjas/github.mjs: los flujos hablan con FORJA_GITLAB, no con la API.
//
// Decisiones validadas contra docs.gitlab.com el 2026-09-11 (alineadas con lib/forge-gitlab.js del plugin):
//   · Id de proyecto = ruta COMPLETA codificada (grupo%2Fsub%2Fproyecto): GitLab anida subgrupos.
//   · Token vía Authorization: Bearer — vale tanto para el del device flow como para un token personal.
//   · Los tokens OAuth CADUCAN a las 2 h; si el intercambio trae refresh_token se guarda con 'expira'.
//   · Device flow (GA en 17.9): POST /oauth/authorize_device + sondeo de /oauth/token; 'slow_down'
//     suma 5 s al intervalo (RFC 8628). La app debe ser PÚBLICA (sin secreto) y con el grant activado.
//   · No se gatea por plan: se intenta y se lee la respuesta real (403/404/vacío según versión).
//   · 'Equipo' no existe: el proyecto vive en el subgrupo y sus miembros heredan el acceso.
//   · Crear desde plantilla NO existe (no hay /generate): el alta sale del esqueleto del paquete.
import { guardarToken } from '../credenciales.mjs';

const pid = (p) => encodeURIComponent(String(p || ''));

// Cliente único: {ok, status, body, sinToken}. Nunca lanza.
async function api(host, token, ruta, { method = 'GET', body = null, fetchImpl = fetch } = {}) {
  if (!token) return { ok: false, status: 0, body: null, sinToken: true };
  try {
    const r = await fetchImpl(`https://${host}/api/v4/${ruta}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, body: j, sinToken: false };
  } catch { return { ok: false, status: 0, body: null, sinToken: false }; }
}

// Login por código (device flow). `ui.mostrar(d)` recibe la respuesta de authorize_device para
// abrir navegador / copiar el código (lo hace el flujo, no este módulo). Devuelve {token, refresh_token, expira}.
async function deviceFlow(host, clientId, { fetchImpl = fetch, esperar = (ms) => new Promise((r) => setTimeout(r, ms)), ui = null, ahora = Date.now } = {}) {
  const form = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const post = async (u, b) => { try { const r = await fetchImpl(u, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(b) }); try { return await r.json(); } catch { return {}; } } catch { return {}; } };
  const d = await post(`https://${host}/oauth/authorize_device`, { client_id: clientId, scope: 'api' });
  if (!d.device_code) throw new Error(`No pude iniciar el login por código en ${host}: la aplicación OAuth debe tener "Device authorization grant" activado, ser pública (no confidencial) y tener el scope api (GitLab 17.9+). Alternativa: --token <token personal con scope api>.`);
  if (ui && ui.mostrar) ui.mostrar(d);
  let intervalo = (d.interval || 5) * 1000;
  const limite = ahora() + Math.min(d.expires_in || 300, 900) * 1000;
  for (;;) {
    if (ahora() > limite) throw new Error('El código caducó sin autorizar. Vuelve a ejecutar el login.');
    await esperar(intervalo);
    const t = await post(`https://${host}/oauth/token`, { client_id: clientId, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (t.access_token) return { token: t.access_token, refresh_token: t.refresh_token || null, expira: t.expires_in ? ahora() + t.expires_in * 1000 : null };
    if (t.error === 'slow_down') { intervalo += 5000; continue; }
    if (t.error && t.error !== 'authorization_pending') throw new Error(`Login en ${host}: ${t.error}${t.error_description ? ` (${t.error_description})` : ''}`);
  }
}

// Renovar SIN navegador con el refresh_token (grant refresh_token; app publica: solo client_id).
// GitLab rota el refresh_token en cada uso: hay que guardar el NUEVO. null si no se pudo (caducado,
// revocado, sin red) -> el flujo vuelve al login por codigo.
async function renovar(host, clientId, refreshToken, { fetchImpl = fetch, ahora = Date.now } = {}) {
  if (!clientId || !refreshToken) return null;
  try {
    const body = new URLSearchParams({ client_id: clientId, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString();
    const r = await fetchImpl(`https://${host}/oauth/token`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const t = await r.json();
    if (!t.access_token) return null;
    return { token: t.access_token, refresh_token: t.refresh_token || refreshToken, expira: t.expires_in ? ahora() + t.expires_in * 1000 : null };
  } catch { return null; }
}

async function usuario(host, token, o = {}) {
  const r = await api(host, token, 'user', o);
  if (!r.ok || !r.body || !r.body.username) return null;
  return { login: r.body.username, id: r.body.id, name: r.body.name || null, email: String(r.body.email || r.body.public_email || '').toLowerCase() || null };
}

// Scopes reales: un token PERSONAL los declara en /personal_access_tokens/self; un token OAuth no
// tiene ese recurso (404) y su alcance es el que pidió la app (api) si /user responde.
async function scopesToken(host, token, o = {}) {
  const s = await api(host, token, 'personal_access_tokens/self', o);
  if (s.ok && s.body && Array.isArray(s.body.scopes)) return s.body.scopes;
  const u = await api(host, token, 'user', o);
  return u.ok ? ['api'] : null;
}

// Miembro del grupo (directo o heredado). true/false, null si no se pudo comprobar.
async function miembroDe(host, token, grupo, userId, o = {}) {
  const r = await api(host, token, `groups/${pid(grupo)}/members/all/${userId}`, o);
  if (r.ok) return true;
  if (r.status === 404 || r.status === 403) return false;
  return null;
}

// Nivel de acceso al proyecto: 50 Owner · 40 Maintainer (puede proteger) · 30 Developer o menos.
async function rolEn(host, token, path, o = {}) {
  const r = await api(host, token, `projects/${pid(path)}`, o);
  const p = (r.ok && r.body && r.body.permissions) || {};
  const nivel = Math.max((p.project_access && p.project_access.access_level) || 0, (p.group_access && p.group_access.access_level) || 0);
  return { nivel, esOwner: nivel >= 50 };
}

const repo = (host, token, path, o) => api(host, token, `projects/${pid(path)}`, o);
async function ramas(host, token, path, o) {
  const r = await api(host, token, `projects/${pid(path)}/repository/branches?per_page=100`, o);
  return r.ok && Array.isArray(r.body) ? r.body.map((b) => b.name) : null;
}
const ramaPorDefecto = (host, token, path, rama, o) => api(host, token, `projects/${pid(path)}`, { ...o, method: 'PUT', body: { default_branch: rama } });
// Protección (Free): NADIE empuja directo (push 0), la fusión es de Maintainer+ (40), un Developer
// no puede desproteger (40), sin force-push. Reemplaza la regla previa (evita 409).
async function proteger(host, token, path, rama, o = {}) {
  await api(host, token, `projects/${pid(path)}/protected_branches/${encodeURIComponent(rama)}`, { ...o, method: 'DELETE' });
  return api(host, token, `projects/${pid(path)}/protected_branches`, { ...o, method: 'POST', body: { name: rama, push_access_level: 0, merge_access_level: 40, unprotect_access_level: 40, allow_force_push: false } });
}
async function topics(host, token, path, o) { const r = await repo(host, token, path, o); return (r.ok && r.body && r.body.topics) || []; }
const estamparTopics = (host, token, path, lista, o) => api(host, token, `projects/${pid(path)}`, { ...o, method: 'PUT', body: { topics: [...new Set(lista.filter(Boolean))] } });
// Proyectos del grupo (incluye subgrupos) con un topic, normalizados a la forma que ya usan los flujos.
async function repos(host, token, grupo, { topic = 'faro', fetchImpl } = {}) {
  const r = await api(host, token, `groups/${pid(grupo)}/projects?include_subgroups=true&per_page=100&order_by=last_activity_at${topic ? `&topic=${encodeURIComponent(topic)}` : ''}`, { fetchImpl });
  return r.ok && Array.isArray(r.body) ? r.body.map((p) => ({ name: p.path, path: p.path_with_namespace, topics: p.topics || [], pushed_at: p.last_activity_at, web_url: p.web_url, permissions: p.permissions || {} })) : [];
}
// Subgrupos del grupo (para ORDENAR los proyectos: clientes, areas...). Solo los que el usuario ve.
async function subgrupos(host, token, grupo, o = {}) {
  const r = await api(host, token, `groups/${pid(grupo)}/subgroups?per_page=100&order_by=name&sort=asc`, o);
  return r.ok && Array.isArray(r.body) ? r.body.map((s) => ({ path: s.full_path, name: s.name, id: s.id })) : [];
}
// Crear proyecto en el grupo (adoptar). El id del namespace se resuelve por ruta.
async function crearProyecto(host, token, grupo, { name, path, description }, o = {}) {
  const g = await api(host, token, `groups/${pid(grupo)}`, o);
  if (!g.ok || !g.body || !g.body.id) return { ok: false, status: g.status, body: { message: `no pude resolver el grupo ${grupo}` } };
  return api(host, token, 'projects', { ...o, method: 'POST', body: { name, path, namespace_id: g.body.id, visibility: 'private', description, initialize_with_readme: false } });
}

// Niveles de acceso: 30 Developer · 40 Maintainer · 50 Owner.
// Miembro EXPLICITO del proyecto (quien lo crea queda como Maintainer aunque en el grupo sea Developer).
// Requiere Maintainer+ en el proyecto: justo despues de crearlo, el creador lo tiene. 409 = ya miembro.
const anadirMiembro = (host, token, path, userId, level = 40, o) => api(host, token, `projects/${pid(path)}/members`, { ...o, method: 'POST', body: { user_id: userId, access_level: level } });
// Crear un SUBGRUPO bajo un grupo (ordenar proyectos: clientes, areas). Exige Owner del padre (o
// Maintainer si el grupo lo permite). Devuelve {ok, status, body} con full_path.
async function crearSubgrupo(host, token, padre, nombre, o = {}) {
  const g = await api(host, token, `groups/${pid(padre)}`, o);
  if (!g.ok || !g.body || !g.body.id) return { ok: false, status: g.status, body: { message: `no pude resolver el grupo ${padre}` } };
  const path = String(nombre).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return api(host, token, 'groups', { ...o, method: 'POST', body: { name: nombre, path, parent_id: g.body.id, visibility: 'private' } });
}

// Login: token personal (--token / pegado) o device flow con la app del perfil. Guarda tokens[host]
// con el client_id del perfil: es la tercera fuente que el plugin consulta (harness.js auth), así el
// harness queda conectado sin 'git config faro.gitlabClientId'.
async function login(perfil, cfg, { tokenPegado = null, ui = {}, fetchImpl = fetch } = {}) {
  const host = perfil.host;
  let cred = null;
  if (tokenPegado) cred = { token: String(tokenPegado).trim() };
  else if (perfil.client_id) cred = await deviceFlow(host, perfil.client_id, { ui, fetchImpl });
  else throw new Error(`El perfil ${perfil.id} no tiene app OAuth: usa --token <token personal con scope api>.`);
  const u = await usuario(host, cred.token, { fetchImpl });
  if (!u) throw new Error(`El token no vale para ${host} (¿scope api? ¿caducado?).`);
  const scopes = (await scopesToken(host, cred.token, { fetchImpl })) || ['api'];
  guardarToken(host, {
    token: cred.token, user: u, scopes, forja: 'gitlab',
    client_id: perfil.client_id || undefined,
    ...(cred.refresh_token ? { refresh_token: cred.refresh_token } : {}),
    ...(cred.expira ? { expira: cred.expira } : {}),
  }, cfg);
  return { token: cred.token, login: u.login, id: u.id, name: u.name, email: u.email, email_contacto: u.email, via: tokenPegado ? 'token personal' : 'login GitLab (device flow)', scopes, expira: cred.expira || null };
}

// Alta de un repo: misma firma que GitHub. s = {host, token}; destino = {org, personal}; ruta = la
// ruta completa del proyecto. En cuenta personal no hay namespace_id: GitLab usa el del usuario.
const textoError = (m) => (typeof m === 'string' ? m : JSON.stringify(m));
const alta = {
  async existe(s, ruta, o) {
    const r = await repo(s.host, s.token, ruta, o);
    if (r.ok) return true;
    return r.status === 404 ? false : null;
  },
  async nombres(s, { org, personal }, { fetchImpl } = {}) {
    if (!personal) return (await repos(s.host, s.token, org, { topic: null, fetchImpl })).map((p) => p.name);
    const r = await api(s.host, s.token, 'projects?owned=true&per_page=100&order_by=last_activity_at', { fetchImpl });
    return r.ok && Array.isArray(r.body) ? r.body.filter((p) => p.path_with_namespace === `${org}/${p.path}`).map((p) => p.path) : [];
  },
  // Lo que la forja devuelve a la cuenta, incluidos los proyectos compartidos sin estar en el grupo.
  async accesibles(s, { fetchImpl } = {}) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const r = await api(s.host, s.token, `projects?membership=true&per_page=100&order_by=last_activity_at&page=${page}`, { fetchImpl });
      if (!r.ok || !Array.isArray(r.body)) break;
      out.push(...r.body.map((p) => ({ ruta: p.path_with_namespace, nombre: p.path, topics: p.topics || [], pushed_at: p.last_activity_at })));
      if (r.body.length < 100) break;
    }
    return out;
  },
  async crearRepo(s, { org, personal }, { nombre, descripcion }, o = {}) {
    let r;
    if (personal) {
      r = await api(s.host, s.token, 'projects', { ...o, method: 'POST', body: { name: nombre, path: nombre, visibility: 'private', description: descripcion, initialize_with_readme: false } });
    } else {
      r = await crearProyecto(s.host, s.token, org, { name: nombre, path: nombre, description: descripcion }, o);
    }
    if (!r.ok) return { ok: false, status: r.status, ruta: null, web: null, mensaje: r.body && r.body.message ? textoError(r.body.message) : 'sin respuesta de la forja' };
    return { ok: true, status: r.status, ruta: r.body.path_with_namespace, web: r.body.web_url, mensaje: null };
  },
  configurar: (s, ruta, { descripcion } = {}, o = {}) => api(s.host, s.token, `projects/${pid(ruta)}`, { ...o, method: 'PUT', body: { remove_source_branch_after_merge: true, squash_option: 'default_on', ...(descripcion ? { description: descripcion } : {}) } }),
  ramaPorDefecto: (s, ruta, rama, o) => ramaPorDefecto(s.host, s.token, ruta, rama, o),
  estamparTopics: (s, ruta, lista, o) => estamparTopics(s.host, s.token, ruta, lista, o),
  proteger: (s, ruta, rama, o) => proteger(s.host, s.token, ruta, rama, o),
  // Plan del destino (#289): el del grupo o el del usuario (namespace). Sin campo 'plan' (instancia
  // propia sin licencia) o 'free'/'default' -> gratuito.
  async plan(s, { org }, o = {}) {
    const r = await api(s.host, s.token, `namespaces/${pid(org)}`, o);
    const nombre = (r.ok && r.body && r.body.plan) || null;
    return { nombre, dePago: !!nombre && !['free', 'default'].includes(String(nombre).toLowerCase()) };
  },
  // «El pipeline debe pasar» (todos los planes). Solo se llama si el repo ya tiene CI.
  exigirPipeline: (s, ruta, o = {}) => api(s.host, s.token, `projects/${pid(ruta)}`, { ...o, method: 'PUT', body: { only_allow_merge_if_pipeline_succeeds: true } }),
};

const FORJA_GITLAB = {
  id: 'gitlab', alta, api, pid, login, usuario, scopesToken, miembroDe, rolEn, repo, ramas, ramaPorDefecto, proteger, topics, estamparTopics,
  repos, crearProyecto, renovar, anadirMiembro, subgrupos, crearSubgrupo, usuarioHttp: 'oauth2',
};
export { FORJA_GITLAB, api, pid, deviceFlow, renovar, subgrupos, crearSubgrupo, anadirMiembro, usuario, scopesToken, miembroDe, rolEn, repo, ramas, ramaPorDefecto, proteger, topics, estamparTopics, repos, crearProyecto, login };
