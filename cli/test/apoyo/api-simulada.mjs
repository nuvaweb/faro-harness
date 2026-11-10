// Preload de los tests de extremo a extremo (`node --import`): sustituye fetch por una forja en memoria
// y deja cada llamada en API_LOG. Nunca sale a la red: lo que no está aquí responde 404.
import fs from 'node:fs';

const USUARIO = { login: 'ana', username: 'ana', id: 7, name: 'Ana', email: null };
const creados = new Set();
const COMPARTIDOS = { 'ajena/compartido': 30 };   // repo de otro dueño → nivel de acceso de la cuenta en GitLab
const json = (status, cuerpo, headers = {}) => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json', ...headers } });

function github(metodo, ruta, cuerpo) {
  if (metodo === 'GET' && ruta === '/user') return json(200, USUARIO, { 'x-oauth-scopes': 'repo, read:org, workflow, admin:org, delete_repo' });
  if (metodo === 'GET' && ruta.startsWith('/user/orgs')) return json(200, []);
  if (metodo === 'GET' && ruta.startsWith('/user/repos')) return json(200, []);
  if (metodo === 'POST' && ruta === '/user/repos') {
    creados.add(`ana/${cuerpo.name}`);
    return json(201, { full_name: `ana/${cuerpo.name}`, html_url: `https://github.com/ana/${cuerpo.name}`, default_branch: 'main' });
  }
  const repo = ruta.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
  if (!repo) return json(404, { message: 'Not Found' });
  if (!creados.has(repo[1])) return json(404, { message: 'Not Found' });
  if (ruta.endsWith('/protection')) return json(403, { message: 'Upgrade to GitHub Pro' });
  return json(200, { full_name: repo[1], topics: [], owner: { login: 'ana' } });
}

function gitlab(metodo, ruta, cuerpo) {
  if (metodo === 'GET' && ruta === '/user') return json(200, USUARIO);
  if (metodo === 'GET' && ruta.startsWith('/groups')) return json(200, []);
  if (metodo === 'POST' && ruta === '/projects') {
    creados.add(`ana/${cuerpo.path}`);
    return json(201, { id: 9, path: cuerpo.path, name: cuerpo.name, path_with_namespace: `ana/${cuerpo.path}`, web_url: `https://gitlab.com/ana/${cuerpo.path}`, default_branch: 'main' });
  }
  if (metodo === 'GET' && ruta.startsWith('/projects?')) return json(200, []);
  const repo = ruta.match(/^\/projects\/([^/?]+)(.*)$/);
  if (!repo) return json(404, { message: '404 Not Found' });
  const compartido = COMPARTIDOS[decodeURIComponent(repo[1])];
  if (compartido) return json(200, { id: 10, path: 'compartido', path_with_namespace: decodeURIComponent(repo[1]), permissions: { project_access: { access_level: compartido } } });
  if (!creados.has(decodeURIComponent(repo[1]))) return json(404, { message: '404 Project Not Found' });
  return json(200, { id: 9, path: repo[1].split('%2F').pop(), path_with_namespace: decodeURIComponent(repo[1]) });
}

globalThis.fetch = async (destino, init = {}) => {
  const url = new URL(String(destino.url || destino));
  const metodo = (init.method || 'GET').toUpperCase();
  const cuerpo = init.body ? JSON.parse(init.body) : null;
  const ruta = url.pathname.replace(/^\/api\/v4/, '').replace(/^\/api\/v3/, '') + url.search;
  fs.appendFileSync(process.env.API_LOG, `${JSON.stringify({ host: url.hostname, metodo, ruta, cuerpo })}\n`);
  if (url.hostname === 'registry.npmjs.org') {
    if (process.env.NPM_SIMULADO === 'caido') throw new TypeError('fetch failed');
    return json(200, { version: process.env.NPM_SIMULADO });
  }
  if (url.hostname === 'api.github.com') return github(metodo, ruta, cuerpo);
  if (url.hostname === 'gitlab.com') return gitlab(metodo, ruta, cuerpo);
  return json(404, {});
};
