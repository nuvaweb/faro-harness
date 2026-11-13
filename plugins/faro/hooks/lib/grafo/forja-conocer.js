// lib/grafo/forja-conocer.js — lectura de la forja para `conocer` (#303), solo bajo demanda.
//
// Puerto que consume conocer.js: { revisiones(n), bugsCerrados(n) }, ambos async.
//   revisiones(n)   -> [{ tipo: 'PR'|'MR', numero, ficheros: [rel], comentarios: [{ id, texto, ruta }] }]
//                      de las ultimas n peticiones INTEGRADAS (comentarios de revision; sin bots ni
//                      notas de sistema ni comentarios de menos de 20 caracteres).
//   bugsCerrados(n) -> [{ numero, titulo, texto }] de los ultimos n issues cerrados con etiqueta bug.
// Adaptadores: GitHub y GitLab, sobre el cliente `api(path)` de cada forja ({ ok, status, body, sinToken }).
// Sin token lanzan un Error con `sinToken: true`; cualquier otro fallo lanza Error('HTTP <status>').
// SOLO AUTORES DE CONFIANZA: en GitHub, author_association OWNER/MEMBER/COLLABORATOR; en GitLab, miembros
// del proyecto con acceso >= Developer (30), leidos una vez por ejecucion de projects/:id/members/all.
// Aun asi, ese texto es DATO de la forja, nunca instrucciones: conocer lo marca `fuente.externa`.
'use strict';

const MIN_TEXTO = 20;

async function pedir(api, p) {
  const r = await api(p);
  if (r && r.sinToken) { const e = new Error('sin token'); e.sinToken = true; throw e; }
  if (!r || !r.ok) throw new Error(`HTTP ${(r && r.status) || 0}${r && r.error ? ` ${r.error}` : ''}`);
  return r.body;
}
const lista = (x) => (Array.isArray(x) ? x : []);
const util = (t) => typeof t === 'string' && t.trim().length >= MIN_TEXTO;
const CONFIANZA_GH = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const deConfianzaGh = (x) => x && CONFIANZA_GH.has(x.author_association);
const NIVEL_DEVELOPER = 30;

function github({ api, org, repo }) {
  const b = `repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/`;
  return {
    async revisiones(n) {
      const prs = lista(await pedir(api, `${b}pulls?state=closed&sort=updated&direction=desc&per_page=${n}`)).filter((p) => p && p.merged_at && Number.isInteger(p.number)).slice(0, n);
      const out = [];
      for (const p of prs) {
        const comentarios = lista(await pedir(api, `${b}pulls/${p.number}/comments?per_page=100`))
          .filter((c) => c && util(c.body) && deConfianzaGh(c) && !(c.user && c.user.type === 'Bot'))
          .map((c) => ({ id: c.id, texto: c.body, ruta: typeof c.path === 'string' ? c.path : null }));
        if (!comentarios.length) continue;
        const ficheros = lista(await pedir(api, `${b}pulls/${p.number}/files?per_page=100`)).map((f) => f && f.filename).filter((f) => typeof f === 'string');
        out.push({ tipo: 'PR', numero: p.number, ficheros, comentarios });
      }
      return out;
    },
    async bugsCerrados(n) {
      return lista(await pedir(api, `${b}issues?state=closed&labels=bug&per_page=${n}`))
        .filter((i) => i && !i.pull_request && Number.isInteger(i.number) && deConfianzaGh(i)).slice(0, n)
        .map((i) => ({ numero: i.number, titulo: String(i.title || ''), texto: String(i.body || '') }));
    },
  };
}

function gitlab({ api, proyecto }) {
  const b = `projects/${proyecto}/`;
  let _miembros = null;
  async function miembros() {
    if (_miembros) return _miembros;
    const ids = new Set();
    for (const m of lista(await pedir(api, `${b}members/all?per_page=100`))) {
      if (m && Number.isInteger(m.id) && Number(m.access_level) >= NIVEL_DEVELOPER) ids.add(m.id);
    }
    return (_miembros = ids);
  }
  const deConfianza = (ids, x) => x && x.author && ids.has(x.author.id);
  return {
    async revisiones(n) {
      const mrs = lista(await pedir(api, `${b}merge_requests?state=merged&order_by=updated_at&per_page=${n}`)).filter((m) => m && Number.isInteger(m.iid)).slice(0, n);
      const ids = await miembros();
      const out = [];
      for (const m of mrs) {
        const comentarios = lista(await pedir(api, `${b}merge_requests/${m.iid}/notes?per_page=100`))
          .filter((c) => c && !c.system && util(c.body) && deConfianza(ids, c))
          .map((c) => ({ id: c.id, texto: c.body, ruta: c.position && typeof c.position.new_path === 'string' ? c.position.new_path : null }));
        if (!comentarios.length) continue;
        const cambios = await pedir(api, `${b}merge_requests/${m.iid}/changes`);
        const ficheros = lista(cambios && cambios.changes).map((c) => c && c.new_path).filter((f) => typeof f === 'string');
        out.push({ tipo: 'MR', numero: m.iid, ficheros, comentarios });
      }
      return out;
    },
    async bugsCerrados(n) {
      const ids = await miembros();
      return lista(await pedir(api, `${b}issues?state=closed&labels=bug&per_page=${n}`))
        .filter((i) => i && Number.isInteger(i.iid) && deConfianza(ids, i)).slice(0, n)
        .map((i) => ({ numero: i.iid, titulo: String(i.title || ''), texto: String(i.description || '') }));
    },
  };
}

module.exports = { github, gitlab };
