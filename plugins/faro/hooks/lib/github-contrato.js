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

  // Estado del CI de un PR (#289): head SHA -> check-runs + estado combinado; de los fallidos se leen las
  // anotaciones para separar "sin minutos" de un fallo del codigo. La normalizacion es dominio puro.
  async function estadoCi(numero) {
    const R = ghRepo();
    if (!R) return sinRepo;
    const base = `repos/${R.org}/${R.repo}`;
    const pr = await ghApi(`${base}/pulls/${numero}`);
    if (pr.sinToken) return { ok: false, sinToken: true };
    if (!pr.ok || !pr.body || !pr.body.head) return { ok: false, msg: `No pude leer el PR #${numero} (HTTP ${pr.status}).` };
    return estadoCiCommit(pr.body.head.sha);
  }

  // Lo mismo para un commit concreto (p. ej. la punta de develop al publicar).
  async function estadoCiCommit(sha) {
    const R = ghRepo();
    if (!R) return sinRepo;
    const base = `repos/${R.org}/${R.repo}`;
    const [cr, st] = await Promise.all([ghApi(`${base}/commits/${sha}/check-runs?per_page=100`), ghApi(`${base}/commits/${sha}/status`)]);
    if (cr.sinToken) return { ok: false, sinToken: true };
    const checkRuns = cr.ok && cr.body && Array.isArray(cr.body.check_runs) ? cr.body.check_runs : [];
    const statuses = st.ok && st.body && Array.isArray(st.body.statuses) ? st.body.statuses : [];
    const ci = require('./estado-ci.js');
    const anotaciones = {};
    await Promise.all(ci.fallidosGithub(checkRuns).slice(0, 10).map(async (c) => {
      const a = await ghApi(`${base}/check-runs/${c.id}/annotations`);
      anotaciones[c.id] = a.ok && Array.isArray(a.body) ? a.body : [];
    }));
    return { ok: true, sha, ...ci.normalizarGithub({ checkRuns, statuses, anotaciones }) };
  }

  return { leerIssue, leerComentarios, editarCuerpoIssue, pedirRevision, adjuntosDeIssue, asegurarEtiquetaApp, estadoCi, estadoCiCommit };
};
