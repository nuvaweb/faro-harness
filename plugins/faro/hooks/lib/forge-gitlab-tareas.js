// lib/forge-gitlab-tareas.js — Lectura y ciclo de tareas en GitLab con el contrato de lib/forge-contrato.js.
// Normaliza incidencias y merge requests a la forma que consume la logica comun (lib/tarea.js, ciclo.js):
// esa logica no sabe de 'iid', 'opened' ni 'source_branch'.
// GitLab no tiene motivo de cierre: 'descartada' se reconoce por su etiqueta (la pone descartar-tarea).
'use strict';
const { NOMBRE_BACKLOG } = require('./tarea.js');
const HD = require('./hito-destino.js');

const esDescartado = (nombres) => nombres.some((n) => /(^|:)descartado$/i.test(n));
// 'tipo::bug' es solo como GitLab hace exclusiva la etiqueta: hacia dentro es la misma 'faro:bug'.
const etiquetaComun = (n) => String(n).replace(/^tipo::/i, 'faro:');

function hitoComun(m) {
  return { number: m.iid, id: m.id, title: m.title, state: m.state === 'closed' ? 'closed' : 'open', description: m.description || '', due_on: m.due_date || null };
}
function issueComun(i) {
  const nombres = (i.labels || []).map((l) => etiquetaComun(typeof l === 'string' ? l : l.name));
  const cerrada = i.state === 'closed';
  return {
    number: i.iid, title: i.title, body: i.description || '',
    state: cerrada ? 'closed' : 'open',
    state_reason: cerrada ? (esDescartado(nombres) ? 'not_planned' : 'completed') : null,
    labels: nombres.map((name) => ({ name })),
    milestone: i.milestone ? hitoComun(i.milestone) : null,
    assignees: (i.assignees || []).map((a) => ({ login: a.username })),
    html_url: i.web_url, updated_at: i.updated_at, closed_at: i.closed_at || null,
  };
}
const prComun = (m) => ({
  number: m.iid, title: m.title, body: m.description || '',
  state: m.state === 'opened' || m.state === 'locked' ? 'open' : 'closed',
  merged_at: m.merged_at || null, merge_commit_sha: m.merge_commit_sha || m.squash_commit_sha || null,
  html_url: m.web_url, head: { ref: m.source_branch }, base: { ref: m.target_branch },
});

module.exports = function (g) {
  const { api, pid, f, git, SIN_TOKEN, invalidarResumen, fases, labelsCatalogo, collaborators, gestion, tokenPara, planificacion = null } = g;
  const { hitos, buscarHito, crearHito, tituloFase } = gestion;
  const issuePath = (num) => `projects/${pid()}/issues/${encodeURIComponent(num)}`;
  const mrPath = (extra) => `projects/${pid()}/merge_requests${extra}`;
  const hitoDestino = HD.crear({ hitos, buscarHito, crearHito, fases, tituloFase, idDe: (m) => m.id });
  const enBacklog = (i) => !!(i.milestone && String(i.milestone.title).toLowerCase() === NOMBRE_BACKLOG.toLowerCase());

  async function leerIssue(num) {
    const r = await api(issuePath(num));
    return r.ok && r.body ? { ...r, body: issueComun(r.body) } : r;
  }
  async function issueEstado(num) {
    if (!num) return null;
    const r = await leerIssue(num);
    return r.ok ? r.body.state : null;
  }
  async function comentarIssue(num, texto) {
    if (!num || !texto) return false;
    return !!(await api(`${issuePath(num)}/notes`, { method: 'POST', body: { body: texto } })).ok;
  }
  async function cerrarIssue(num, nota) {
    if (!num) return false;
    if (nota) await comentarIssue(num, nota);
    return !!(await api(issuePath(num), { method: 'PUT', body: { state_event: 'close' } })).ok;
  }
  const editarCuerpoIssue = (num, cuerpo) => api(issuePath(num), { method: 'PUT', body: { description: cuerpo } });
  async function leerComentarios(num, proyecto) {
    const base = proyecto ? `projects/${encodeURIComponent(proyecto)}/issues/${num}` : issuePath(num);
    const r = await api(`${base}/notes?per_page=100&sort=asc`);
    if (!r.ok || !Array.isArray(r.body)) return null;
    return r.body.filter((n) => !n.system).map((n) => ({ autor: n.author && n.author.username, fecha: n.created_at, body: n.body || '' }));
  }

  // Los mismos topes que en GitHub: lo que cabe en un consolidar o un vigilante sin agotar la API.
  async function paginas(ruta, max) {
    const out = [];
    for (let p = 1; p <= max; p++) {
      const r = await api(`${ruta}${ruta.includes('?') ? '&' : '?'}per_page=100&page=${p}`);
      if (!r.ok || !Array.isArray(r.body)) return p === 1 ? null : out;
      out.push(...r.body);
      if (r.body.length < 100) break;
    }
    return out;
  }
  async function hechosTareas() {
    const abiertas = await paginas(`projects/${pid()}/issues?state=opened`, 3);
    if (!abiertas) return null;
    const cerradas = (await paginas(`projects/${pid()}/issues?state=closed&order_by=updated_at&sort=desc`, 1)) || [];
    const prs = (await paginas(mrPath('?state=all&order_by=updated_at&sort=desc'), 2)) || [];
    const ramas = (git('branch', '-r', '--format=%(refname:short)') || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const lista = (await paginas(`projects/${pid()}/milestones`, 1)) || [];
    return { issues: [...abiertas, ...cerradas].map(issueComun), prs: prs.map(prComun), ramas, hitos: lista.map(hitoComun) };
  }

  async function prsDeRama(rama) {
    if (!rama) return null;
    const r = await api(mrPath(`?state=all&source_branch=${encodeURIComponent(rama)}&per_page=10`));
    return r.ok && Array.isArray(r.body) ? r.body.map(prComun) : null;
  }
  async function prAbiertoDe(rama) {
    if (!rama) return null;
    const r = await api(mrPath(`?state=opened&source_branch=${encodeURIComponent(rama)}&per_page=1`));
    return (r.ok && Array.isArray(r.body) && r.body[0] && r.body[0].web_url) || null;
  }
  async function pedirRevision(numero, logins) {
    const cs = await collaborators();
    const ids = (logins || []).map((l) => (cs.find((c) => c.login.toLowerCase() === String(l).toLowerCase()) || {}).id).filter(Boolean);
    if (!ids.length) return false;
    return !!(await api(mrPath(`/${numero}`), { method: 'PUT', body: { reviewer_ids: ids } })).ok;
  }

  // Las subidas de GitLab son rutas relativas: se apuntan a la API del proyecto, que acepta el token.
  async function adjuntosDeIssue(num, proyecto) {
    const ruta = proyecto || f().path;
    const id = encodeURIComponent(ruta);
    const r = await api(`projects/${id}/issues/${num}`);
    if (r.sinToken) return { ok: false, sinToken: true };
    if (!r.ok || !r.body) return { ok: false, msg: `No pude leer ${ruta}#${num} (HTTP ${r.status}).` };
    const notas = (await leerComentarios(num, proyecto)) || [];
    const absoluta = (t) => String(t).replace(/\]\(\/uploads\/([^/\s)]+)\/([^\s)]+)\)/g, (_, secreto, nombre) => `](https://${f().host}/api/v4/projects/${id}/uploads/${secreto}/${nombre})`);
    return {
      ok: true, nombre: `${ruta}#${num}`, carpeta: `${ruta.split('/').pop()}-${num}`,
      textos: [r.body.description || '', ...notas.map((n) => n.body)].map(absoluta),
      token: tokenPara(f().host), host: f().host,
    };
  }

  async function publicarRelease(tag, notas) {
    const ya = await api(`projects/${pid()}/releases/${encodeURIComponent(tag)}`);
    if (ya.ok && ya.body && ya.body.tag_name) return { ok: true, yaExistia: true, url: ya.body._links && ya.body._links.self };
    const r = await api(`projects/${pid()}/releases`, { method: 'POST', body: { tag_name: tag, name: tag, description: notas || '' } });
    if (!r.ok) return { ok: false, msg: `HTTP ${r.status}${r.body && r.body.message ? `: ${JSON.stringify(r.body.message)}` : ''}` };
    return { ok: true, url: r.body && r.body._links && r.body._links.self };
  }
  const asegurarEtiquetaApp = (id, descripcion) => require('./apps-forja.js').asegurarEtiquetaGitlab(api, f().path, id, descripcion);

  const sinLeer = (r, num) => console.log(r.sinToken ? SIN_TOKEN() : `No pude leer la tarea #${num} (HTTP ${r.status}).`);

  async function cmdCerrarTarea() {
    const num = process.argv[3];
    if (!num) { console.log('Uso: node .claude/hooks/harness.js cerrar-tarea <numero-issue>'); process.exit(1); }
    const actual = await leerIssue(num);
    if (!actual.ok) { sinLeer(actual, num); return; }
    if (enBacklog(actual.body)) {
      console.log(`La tarea #${num} sigue en '${NOMBRE_BACKLOG}': una tarea NO se completa desde la sala de espera.`);
      console.log(`   Si se ha hecho, pertenecia a alguna fase: muevela primero —  harness.js mover-tarea ${num} --hito <N>  — y cierrala despues.`);
      console.log(`   Si NO se va a hacer, no es un cierre por completado:  harness.js descartar-tarea ${num} "<motivo>"`);
      process.exit(1);
    }
    const r = await api(issuePath(num), { method: 'PUT', body: { state_event: 'close' } });
    if (!r.ok) { console.log(`No pude cerrar la tarea #${num} (HTTP ${r.status}).`); return; }
    console.log(`✅ Tarea #${num} cerrada como completada.`);
    invalidarResumen();
  }

  async function listarHito(ref) {
    const destino = await hitoDestino(ref);
    if (!destino) return;
    const r = await api(`projects/${pid()}/issues?milestone=${encodeURIComponent(destino.titulo)}&state=opened&per_page=100`);
    if (r.sinToken) { console.log(SIN_TOKEN()); return; }
    const items = (r.ok && Array.isArray(r.body)) ? r.body.map(issueComun) : [];
    if (!items.length) { console.log(`'${destino.titulo}' esta vacio: no hay nada esperando.`); return; }
    console.log(`'${destino.titulo}' — ${items.length} tarea(s) esperando fase:`);
    for (const i of items) {
      const dias = Math.round((Date.now() - new Date(i.updated_at)) / 86400000);
      const tipos = i.labels.map((l) => l.name).join(', ');
      console.log(`  #${i.number} ${i.title}${tipos ? ` [${tipos}]` : ''} · sin tocar hace ${dias}d`);
    }
    console.log('Saca una a su fase con:  harness.js mover-tarea <numero> --hito <N> ["<motivo>"]');
  }

  async function cmdMoverTarea() {
    const FH = require('./flag-hito.js');
    const ph = FH.extraer(process.argv.slice(3));
    if (ph.alias) console.log(FH.AVISO_ALIAS);
    let listar = null; const argv = [];
    for (let i = 0; i < ph.resto.length; i++) {
      const a = ph.resto[i];
      if (a === '--listar') { listar = ph.resto[i + 1] || 'backlog'; i++; continue; }
      const mL = a.match(/^--listar=(.+)$/); if (mL) { listar = mL[1]; continue; }
      argv.push(a);
    }
    if (listar) return listarHito(listar);
    const num = argv[0], motivo = argv[1] || '';
    if (!num || !ph.valor) { console.log('Uso: node .claude/hooks/harness.js mover-tarea <numero> --hito <N|backlog> ["<motivo>"]\n     node .claude/hooks/harness.js mover-tarea --listar backlog   (que espera sin fase)'); process.exit(1); }
    const actual = await leerIssue(num);
    if (!actual.ok) { sinLeer(actual, num); return; }
    const issue = actual.body;
    const origen = issue.milestone ? issue.milestone.title : '(sin fase)';
    const destino = await hitoDestino(ph.valor);
    if (!destino) return;
    if (issue.milestone && issue.milestone.id === destino.numero) { console.log(`La tarea #${num} ya esta en '${destino.titulo}'. Nada que mover.`); return; }
    if ((!issue.milestone || enBacklog(issue)) && destino.titulo !== NOMBRE_BACKLOG) {
      const tipo = require('./ciclo.js').tipoDeEtiquetas(issue.labels, labelsCatalogo());
      const bloqueo = HD.bloqueoAlEntrarEnFase({ num, tipo, cuerpo: issue.body, tieneHito: !!issue.milestone, destino: destino.titulo, comoCompletar: `Completa la descripcion de la incidencia (${issue.html_url}) y repite el mover.` });
      if (bloqueo) { console.log(bloqueo.join('\n')); process.exit(1); }
    }
    const r = await api(issuePath(num), { method: 'PUT', body: { milestone_id: destino.numero } });
    if (!r.ok) { console.log(`No pude mover la tarea #${num} (HTTP ${r.status}).`); return; }
    // La constancia va DESPUES del cambio: si falla, no queda una nota mintiendo.
    await comentarIssue(num, `Movida de **${origen}** a **${destino.titulo}**.${motivo ? ` Motivo: ${motivo}` : ''}`);
    console.log(`✅ Tarea #${num} movida de '${origen}' a '${destino.titulo}'${motivo ? ` — ${motivo}` : ''}.`);
    const epica = planificacion ? planificacion.lineaEpica(r.body && r.body.milestone) : '';
    if (epica) console.log(`   ${epica}`);
    invalidarResumen();
  }

  async function cmdAmpliarTarea() {
    const raw = process.argv.slice(3); const subs = []; let num = null;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '--subtarea') { const s = (raw[i + 1] || '').trim(); if (s) subs.push(s); i++; continue; }
      const m = raw[i].match(/^--subtarea=(.+)$/); if (m) { subs.push(m[1].trim()); continue; }
      if (!num) num = String(raw[i]).replace(/^#/, '');
    }
    if (!num || !/^\d+$/.test(num) || !subs.length) { console.log('Uso: harness.js ampliar-tarea <numero> --subtarea "<texto>" [--subtarea "<texto>" ...]'); process.exit(1); }
    const r = await leerIssue(num);
    if (!r.ok) { sinLeer(r, num); return; }
    const nuevo = require('./ciclo.js').ampliarCuerpo(r.body.body, subs);
    if (nuevo === r.body.body) { console.log(`#${num} ya tenia esas subtareas: nada que anadir.`); return; }
    const up = await editarCuerpoIssue(num, nuevo);
    if (!up.ok) { console.log(`No pude actualizar la incidencia (HTTP ${up.status}).`); return; }
    console.log(`✅ #${num} ampliado con ${subs.length} subtarea(s) — ${r.body.html_url}`);
  }

  return { leerIssue, leerComentarios, adjuntosDeIssue, issueEstado, comentarIssue, cerrarIssue, editarCuerpoIssue, hechosTareas, prsDeRama, prAbiertoDe, pedirRevision, publicarRelease, asegurarEtiquetaApp, cmdCerrarTarea, cmdMoverTarea, cmdAmpliarTarea };
};
