// lib/github-contrato.js — Las operaciones del contrato de forja que el adaptador de GitHub aun no tenia
// con nombre propio: leer y editar una tarea, sus comentarios y adjuntos, y pedir revision de un PR.
// El contrato completo esta en lib/forge-contrato.js.
'use strict';

module.exports = function (g) {
  const { ghApi, ghRepo, ghToken, ghHost, ensureUser } = g;
  const issuePath = (R, num) => `repos/${R.org}/${R.repo}/issues/${num}`;
  const sinRepo = { ok: false, status: 0, body: null, msg: 'No detecto el repo remoto (origin).' };

  async function leerIssue(num) {
    const R = ghRepo();
    if (!R) return sinRepo;
    return ghApi(issuePath(R, num));
  }

  const comentarioComun = (c) => ({ autor: c.user && c.user.login, fecha: c.created_at, body: c.body || '' });

  async function leerComentarios(num, repo) {
    const R = repo || ghRepo();
    if (!R) return null;
    const r = await ghApi(`${issuePath(R, num)}/comments?per_page=100`);
    return r.ok && Array.isArray(r.body) ? r.body.map(comentarioComun) : null;
  }

  async function editarCuerpoIssue(num, cuerpo) {
    const R = ghRepo();
    if (!R) return sinRepo;
    return ghApi(issuePath(R, num), { method: 'PATCH', body: { body: cuerpo } });
  }

  // GitHub no deja auto-asignarse la revision: se filtra al autor. true si no queda nadie que pedir.
  async function pedirRevision(numero, logins) {
    const R = ghRepo();
    if (!R) return false;
    const yo = (await ensureUser()) || {};
    const revisores = (logins || []).filter((l) => l && l.toLowerCase() !== String(yo.login || '').toLowerCase());
    if (!revisores.length) return true;
    const r = await ghApi(`repos/${R.org}/${R.repo}/pulls/${numero}/requested_reviewers`, { method: 'POST', body: { reviewers: revisores } });
    return !!r.ok;
  }

  // proyecto: 'org/repo' para leer otro repo; sin el, el de origin.
  async function adjuntosDeIssue(num, proyecto) {
    const partes = proyecto ? String(proyecto).split('/') : null;
    const R = partes ? { org: partes[0], repo: partes[1] } : ghRepo();
    if (!R) return { ok: false, msg: 'No se de que repo es el issue: usa <org>/<repo>#<N>.' };
    if (!ghToken()) return { ok: false, sinToken: true };
    const [issue, comentarios] = await Promise.all([ghApi(issuePath(R, num)), leerComentarios(num, R)]);
    if (!issue.ok) return { ok: false, msg: `No pude leer ${R.org}/${R.repo}#${num} (HTTP ${issue.status}).` };
    return {
      ok: true,
      nombre: `${R.org}/${R.repo}#${num}`,
      carpeta: `${R.repo}-${num}`,
      textos: [issue.body.body || '', ...(comentarios || []).map((c) => c.body)],
      token: ghToken(),
      host: ghHost ? ghHost() : null,
    };
  }

  async function asegurarEtiquetaApp(id, descripcion) {
    const R = ghRepo();
    if (!R) return null;
    return require('./apps-forja.js').asegurarEtiquetaGithub(ghApi, R.org, R.repo, id, descripcion);
  }

  return { leerIssue, leerComentarios, editarCuerpoIssue, pedirRevision, adjuntosDeIssue, asegurarEtiquetaApp };
};
