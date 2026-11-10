// lib/forge-gitlab.js — ADAPTADOR DE GITLAB. Mismo contrato que github.js para las operaciones de
// plataforma que consume el motor: rol, peticiones, revisores, tareas, etiquetas, clave y resumen.
// Lo selecciona forjaMod() en harness.js por la forja detectada; el resto del motor no sabe cual es.
//
// DECISIONES VALIDADAS (11 sep 2026, ver gestion/cambios/changes/forja-cimiento-token-por-host):
//   · Identificador de proyecto = ruta COMPLETA codificada (grupo%2Fsub%2Fproyecto). GitLab anida
//     subgrupos sin limite; recortar a dos segmentos era el bug que rompio el parseo en GitHub.
//   · NO se gatea nada por plan. El campo 'plan' solo lo ven Owners, un subgrupo devuelve null, y
//     GitLab responde a funciones no incluidas con 400 vacio, 404 o SILENCIO. Se intenta y se lee
//     el resultado real (patron Renovate/glab). Para lo silencioso, se relee el recurso tras escribir.
//   · Rol por nivel de acceso: 50 Owner, 40 Maintainer -> puede aprobar; 30 Developer o menos -> no.
//   · Token via Authorization: Bearer — vale tanto para el token del device flow como para un PAT.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = function (ctx) {
  const { ROOT, git, forge, tokenPara, guardarToken, faroSchema, specBase } = ctx;
  const planificacion = ctx.planificacion || null;   // dominio ya configurado por el cableado (o null)

  const f = () => forge();                       // deteccion (host, path, owner, project)
  const base = () => `https://${f().host}/api/v4/`;
  const pid = () => encodeURIComponent(f().path); // ruta completa codificada = id del proyecto
  const gid = () => encodeURIComponent(f().owner); // grupo raiz (para busquedas en "la org")

  // Cliente unico: {ok, status, body, sinToken}. Nunca lanza.
  async function api(p, { method = 'GET', body = null, token = null } = {}) {
    const tok = token || tokenPara(f().host);
    if (!tok) return { ok: false, status: 0, body: null, sinToken: true };
    const url = /^https?:\/\//.test(p) ? p : base() + p.replace(/^\//, '');
    const opts = { method, headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' } };
    if (body != null) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    try {
      const r = await fetch(url, opts);
      const j = r.status === 204 ? true : await r.json().catch(() => null);
      return { ok: r.ok, status: r.status, body: j };
    } catch (e) { return { ok: false, status: 0, body: null, error: (e && e.message) || String(e) }; }
  }

  const SIN_TOKEN = () => `SIN_TOKEN: no hay credencial para ${f().host}. Conectate: node .claude/hooks/harness.js auth`;

  // ---- 1) IDENTIDAD ----
  let _me;
  async function me() {
    if (_me !== undefined) return _me;
    const r = await api('user');
    _me = (r.ok && r.body && r.body.username) ? { id: r.body.id, login: r.body.username, name: r.body.name || null, email: (r.body.email || '').toLowerCase() || null } : null;
    return _me;
  }

  // ---- 2) ROL ----  (members/all incluye los heredados del grupo)
  const nivelARol = (n) => (n >= 50 ? 'owner' : n >= 40 ? 'maintainer' : n >= 30 ? 'developer' : n >= 20 ? 'reporter' : n >= 10 ? 'guest' : '?');
  async function roleInfo() {
    const d = f();
    if (d.forge !== 'gitlab') return null;
    const yo = await me();
    if (!yo) { const r = await api('user'); return r.sinToken ? { org: d.owner, repo: d.project, perm: null, puedeAprobar: false, sinToken: true } : { org: d.owner, repo: d.project, perm: null, puedeAprobar: false, http: r.status }; }
    const r = await api(`projects/${pid()}/members/all/${yo.id}`);
    if (!r.ok) {
      // Sin fila de miembro: puede ser acceso por visibilidad publica. Cae a permissions del proyecto.
      const p = await api(`projects/${pid()}`);
      const pa = p.ok && p.body && p.body.permissions;
      const lvl = Math.max((pa && pa.project_access && pa.project_access.access_level) || 0, (pa && pa.group_access && pa.group_access.access_level) || 0);
      if (!lvl) return { org: d.owner, repo: d.project, perm: null, puedeAprobar: false, http: r.status };
      return { org: d.owner, repo: d.project, perm: nivelARol(lvl), nivel: lvl, puedeAprobar: lvl >= 40 };
    }
    const lvl = r.body.access_level || 0;
    return { org: d.owner, repo: d.project, perm: nivelARol(lvl), nivel: lvl, puedeAprobar: lvl >= 40 };
  }
  async function cmdRole() {
    const ri = await roleInfo();
    if (!ri) { console.log('No detecto un remoto de GitLab.'); return; }
    if (ri.sinToken) { console.log(SIN_TOKEN()); process.exit(2); }
    if (ri.perm === null) { console.log(`No pude leer el rol en ${ri.org}/${ri.repo}${ri.http ? ` (HTTP ${ri.http})` : ''}.`); return; }
    console.log(`Rol en ${f().path} (GitLab, nivel ${ri.nivel}): ${ri.perm}`);
    guardarRolCache({ rol: ri.puedeAprobar ? 'maintainer' : 'developer', forja: 'GitLab', detalle: `nivel ${ri.nivel} = ${ri.perm}`, login: (await me() || {}).login || null });
    console.log(ri.puedeAprobar
      ? `PUEDES PUBLICAR (nivel ${ri.nivel} = ${ri.perm}). Flujo: /faro:consolidar -> develop · /faro:publicar -> main.`
      : `NO puedes publicar (nivel ${ri.nivel} = ${ri.perm}). Tu lanzas /faro:pr; /faro:consolidar y /faro:publicar los aplica un Maintainer u Owner.`);
  }

  // Equipo (atomicidad): miembros directos, heredados, aprobadores y construccion del equipo.
  const equipo = require('./forge-gitlab-equipo.js')({ api, pid, f, SIN_TOKEN, nivelARol });
  const { collaborators, heredados, approvers, esRobot } = equipo;

  // ---- 4) PETICIONES (merge requests) ----
  async function cmdPr() {
    const target = process.argv[3] || null;
    const r = await api(`projects/${pid()}/merge_requests?state=opened${target ? '&target_branch=' + encodeURIComponent(target) : ''}&per_page=50`);
    if (r.sinToken) { console.log(SIN_TOKEN()); process.exit(2); }
    if (!r.ok || !Array.isArray(r.body)) { console.log(`HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`); return; }
    if (!r.body.length) { console.log(target ? `Sin peticiones abiertas hacia ${target}.` : `Sin peticiones abiertas en ${f().path}.`); return; }
    console.log(`${r.body.length} peticion(es) abierta(s) en ${f().path}${target ? ' hacia ' + target : ''}:`);
    for (const m of r.body) console.log(`  !${m.iid} ${m.draft ? '[DRAFT] ' : ''}${m.source_branch} -> ${m.target_branch}  ·  ${m.title}\n     por @${m.author && m.author.username}  ·  ${m.web_url}`);
  }
  // crearPr({titulo, cuerpo, head, base, revisores:[login]}) -> {ok, url, iid} — por INTENCION.
  async function crearPr({ titulo, cuerpo, head, base, revisores = [] }) {
    let reviewer_ids;
    if (revisores.length) {
      const cs = await collaborators();
      reviewer_ids = revisores.map((l) => (cs.find((c) => c.login.toLowerCase() === l.toLowerCase()) || {}).id).filter(Boolean);
    }
    const r = await api(`projects/${pid()}/merge_requests`, { method: 'POST', body: { title: titulo, description: cuerpo || '', source_branch: head, target_branch: base, remove_source_branch: true, ...(reviewer_ids && reviewer_ids.length ? { reviewer_ids } : {}) } });
    if (r.sinToken) return { ok: false, sinToken: true };
    if (!r.ok) return { ok: false, status: r.status, msg: r.body && (r.body.message || JSON.stringify(r.body).slice(0, 200)) };
    return { ok: true, iid: r.body.iid, url: r.body.web_url };
  }

  // ---- 5) ETIQUETAS (tipo obligatorio, mismo catalogo que GitHub) ----
  function labelsCatalogo() {
    const s = faroSchema(); return (s && s.enums && Array.isArray(s.enums.labels)) ? s.enums.labels : [];
  }
  let _labels;
  async function labelsDelProyecto() {
    if (_labels !== undefined) return _labels;
    const set = new Map();
    for (let page = 1; page <= 5; page++) {
      const r = await api(`projects/${pid()}/labels?per_page=100&page=${page}`);
      if (!r.ok || !Array.isArray(r.body) || !r.body.length) break;
      for (const l of r.body) set.set(String(l.name).toLowerCase(), l.name);
      if (r.body.length < 100) break;
    }
    return (_labels = set);
  }
  // En GitLab no hay etiquetas "nativas" por defecto: se crean si faltan. Las de TIPO llevan AMBITO
  // ('tipo::bug'): en Premium/Ultimate GitLab las hace EXCLUSIVAS (una incidencia no puede tener dos
  // tipos), que es exactamente la regla del harness; en Free es una etiqueta normal con '::' en el
  // nombre. Se desactiva con enums.gitlab.etiquetas_con_ambito=false en faro-schema.json.
  const conAmbito = () => { const s = faroSchema(); const g = s && s.enums && s.enums.gitlab; return !(g && g.etiquetas_con_ambito === false); };
  async function resolverLabel(def) {
    const nombre = (!def.transversal && conAmbito()) ? `tipo::${String(def.slug).toLowerCase()}` : `faro:${String(def.slug).toLowerCase()}`;
    const ex = await labelsDelProyecto();
    if (ex.has(nombre.toLowerCase())) return ex.get(nombre.toLowerCase());
    const cr = await api(`projects/${pid()}/labels`, { method: 'POST', body: { name: nombre, color: '#' + String(def.color || 'CFD3D7').replace(/^#/, ''), description: def.descripcion || '' } });
    if (cr.ok) { ex.set(nombre.toLowerCase(), nombre); return nombre; }
    // 409 = ya existia (carrera o mayusculas): se acepta el nombre.
    if (cr.status === 409) { ex.set(nombre.toLowerCase(), nombre); return nombre; }
    return null;
  }

  // ---- 6) TAREAS (incidencias) ----
  async function usuarioPorLogin(login) {
    const cs = await collaborators();
    const c = cs.find((x) => x.login.toLowerCase() === String(login).toLowerCase());
    return c || null;
  }
  async function cmdAsignarTarea() {
    // --hito (#217): igual que en GitHub; --fase queda como alias con aviso.
    const ph = require('./flag-hito.js').extraer(process.argv.slice(3));
    if (ph.alias) console.log(require('./flag-hito.js').AVISO_ALIAS);
    const raw = ph.resto;
    let tipo = null; const extras = []; const argv = []; let appArg = null;
    // Modificadores NATIVOS de GitLab (los aplica forge-gitlab-gestion.js): hito, estimacion, fecha, peso, bloqueo.
    const opts = {}; if (ph.valor !== null) opts.hito = ph.valor;
    const OPT = { '--estimacion': 'estimacion', '--vence': 'vence', '--peso': 'peso', '--bloqueada-por': 'bloqueadaPor' };
    for (let i = 0; i < raw.length; i++) {
      if (OPT[raw[i]]) { opts[OPT[raw[i]]] = raw[i + 1] || ''; i++; continue; }
      // --repo (#150): abrir el issue en OTRO repo solo existe en GitHub por ahora; no se ignora en silencio.
      if (raw[i] === '--repo' || raw[i].startsWith('--repo=')) { console.log('--repo (abrir el issue en otro repo) aun no esta disponible en GitLab: pidele al usuario que lo abra el mismo en ese repo.'); process.exit(1); }
      if (raw[i] === '--tipo' || raw[i] === '--label') { tipo = (raw[i + 1] || '').toLowerCase(); i++; continue; }
      const mEq = raw[i].match(/^--(?:tipo|label)=(.+)$/); if (mEq) { tipo = mEq[1].toLowerCase(); continue; }
      if (raw[i] === '--extra') { (raw[i + 1] || '').toLowerCase().split(',').forEach((x) => x.trim() && extras.push(x.trim())); i++; continue; }
      const mX = raw[i].match(/^--extra=(.+)$/); if (mX) { mX[1].toLowerCase().split(',').forEach((x) => x.trim() && extras.push(x.trim())); continue; }
      // --app <id> (#134): etiqueta 'app:<id>' en un monorepo (mismo criterio que en GitHub, lib/apps-forja.js).
      if (raw[i] === '--app') { (appArg = appArg || []).push((raw[i + 1] || '').trim()); i++; continue; }
      const mA = raw[i].match(/^--app=(.+)$/); if (mA) { (appArg = appArg || []).push(mA[1].trim()); continue; }
      argv.push(raw[i]);
    }
    const titulo = argv[0], quien = (argv[1] || '').replace(/^@/, ''), slug = argv[2] || '', cuerpo = argv[3] || '';
    const cat = labelsCatalogo();
    const tipos = cat.filter((l) => !l.transversal);
    const uso = `Uso: node .claude/hooks/harness.js asignar-tarea "<titulo>" <usuario> [<slug-del-change>] ["<cuerpo>"] --tipo <tipo> [--extra <slug[,slug]>] [--app <app[,app]>] [--hito <N|backlog|titulo>] [--estimacion 2h] [--vence AAAA-MM-DD] [--peso N] [--bloqueada-por <N>]\n   Tipos: ${tipos.map((l) => l.slug).join(' · ')}`;
    if (!titulo || !quien) { console.log(uso); process.exit(1); }
    if (!tipo) { console.log(`FALTA --tipo: toda tarea lleva etiqueta de tipo.\n${uso}`); process.exit(1); }
    const def = tipos.find((l) => l.slug === tipo);
    if (cat.length && !def) { console.log(`Tipo '${tipo}' no esta en el catalogo.\n${uso}`); process.exit(1); }
    const af = require('./apps-forja.js');
    const esquema = faroSchema ? faroSchema() : undefined;
    let appDefs = [];
    if (appArg !== null) {
      const v = af.validarApps(ROOT, appArg, { schema: esquema });
      if (v.error) { console.log(v.error); process.exit(1); }
      appDefs = v.apps;
    } else {
      const av = af.avisoSinApp(ROOT, [], { schema: esquema });
      if (av) console.log(av);
    }
    const u = await usuarioPorLogin(quien);
    if (!u) {
      const r = await api('user'); if (r.sinToken) { console.log(SIN_TOKEN()); process.exit(2); }
      // Distinguir "no existe" de "tiene acceso pero no es del equipo": el segundo caso tiene arreglo.
      const h = (await heredados()).find((c) => c.login.toLowerCase() === String(quien).toLowerCase());
      if (h) {
        console.log(`⚠ '${quien}' tiene acceso HEREDADO del grupo, pero NO es del equipo de este proyecto. NO asigno.`);
        console.log(`   Si va a trabajar aqui, anadelo primero:  node .claude/hooks/harness.js miembro anadir ${h.login} developer`);
      } else {
        const eq = (await collaborators()).filter((c) => !esRobot(c.login));
        console.log(`⚠ '${quien}' no es miembro del proyecto. NO asigno.`);
        console.log(eq.length ? `   Equipo actual: ${eq.map((c) => c.login).join(' · ')}` : `   Este proyecto no tiene equipo todavia: harness.js miembro anadir <usuario> developer`);
      }
      return;
    }
    const labels = [];
    const l1 = def ? await resolverLabel(def) : null;
    if (def && !l1) { console.log(`No pude crear/resolver la etiqueta para '${tipo}'. La tarea NO se crea sin tipo.`); return; }
    if (l1) labels.push(l1);
    for (const x of extras) { const d = cat.find((l) => l.slug === x && l.transversal); if (d) { const n = await resolverLabel(d); if (n) labels.push(n); } }
    for (const appDef of appDefs) {
      const n = await af.asegurarEtiquetaGitlab(api, f().path, appDef.id, appDef.rol ? `App ${appDef.id}: ${appDef.rol}`.slice(0, 100) : null);
      if (n) labels.push(n); else console.log(`⚠ No pude crear la etiqueta 'app:${appDef.id}'; la tarea se crea sin ella.`);
    }
    const sb = specBase || require('./paths.js')().specBase;   // #293
    const desc = slug ? `${cuerpo}\n\nCambio spec-driven: \`${sb}/changes/${slug}/\`.`.trim() : cuerpo;
    // 'entrada' (reporte): va SIN hito, a la bandeja de entrada, hasta el triaje (#84). Igual que en GitHub.
    const nativo = await gestion.opcionesTarea({ ...opts, ciclo: (def && def.ciclo) || 'surge' });
    if (nativo.avisos.length) console.log(`   Aviso: ${nativo.avisos.join(' · ')}`);
    const r = await api(`projects/${pid()}/issues`, { method: 'POST', body: { title: titulo, description: desc, assignee_ids: [u.id], labels: labels.join(','), ...nativo.body } });
    if (!r.ok || !r.body || !r.body.iid) { console.log(`No pude crear la tarea (HTTP ${r.status})${r.body && r.body.message ? `: ${JSON.stringify(r.body.message)}` : ''}.`); return; }
    console.log(`✅ Tarea #${r.body.iid} asignada a ${quien} · tipo: ${tipo} — ${r.body.web_url}\n   Le llega aviso de GitLab. (En GitLab, una Tarea es una "incidencia".)`);
    const epica = planificacion ? planificacion.lineaEpica(r.body.milestone) : '';
    if (epica) console.log(`   ${epica}`);
    console.log(`   Al abrir la peticion de integracion, pon "Closes #${r.body.iid}" en la descripcion: se cierra sola al integrarse.`);
    await gestion.trasCrearTarea(r.body.iid, opts, r.body);
  }
  async function cmdDescartarTarea() {
    const num = process.argv[3], motivo = process.argv[4] || '';
    if (!num) { console.log('Uso: node .claude/hooks/harness.js descartar-tarea <numero> ["<motivo>"]'); process.exit(1); }
    if (motivo) await api(`projects/${pid()}/issues/${num}/notes`, { method: 'POST', body: { body: `Descartado: ${motivo}` } });
    // GitLab no guarda motivo de cierre: la etiqueta distingue una descartada de una hecha.
    const defDescarte = labelsCatalogo().find((l) => l.slug === 'descartado');
    const marca = (defDescarte && await resolverLabel(defDescarte)) || 'faro:descartado';
    const r = await api(`projects/${pid()}/issues/${num}`, { method: 'PUT', body: { state_event: 'close', add_labels: marca } });
    if (r.sinToken) { console.log(SIN_TOKEN()); return; }
    console.log(r.ok ? `✅ Tarea #${num} descartada${motivo ? ` — ${motivo}` : ''}.` : `No pude descartar la tarea #${num} (HTTP ${r.status}).`);
    if (r.ok) invalidarResumen();
  }
  // Lo asignado a mi: en el proyecto, y en TODO lo que el token ve (scope=assigned_to_me).
  async function cmdMisTareas() {
    const all = process.argv.includes('--all');
    const soloRepo = process.argv.includes('--repo');
    const verTodas = process.argv.includes('--todas');
    const yo = await me();
    if (!yo) { const r = await api('user'); if (r.sinToken) { console.log(SIN_TOKEN()); process.exit(2); } console.log('No pude leer tu usuario.'); return; }
    const estado = all ? 'all' : 'opened';
    const aqui = await api(`projects/${pid()}/issues?assignee_id=${yo.id}&state=${estado}&per_page=50`);
    const propias = (aqui.ok && Array.isArray(aqui.body)) ? aqui.body : [];
    if (propias.length) { console.log(`Tus tareas en ESTE proyecto (${f().path}) — ${propias.length}:`); for (const t of propias) console.log(`  #${t.iid} [${t.state}] ${t.title}  ·  ${t.web_url}`); }
    else console.log(`No tienes tareas ${all ? '' : 'abiertas '}asignadas en este proyecto.`);
    if (soloRepo) return;
    const otras = await api(`issues?scope=assigned_to_me&state=${estado}&per_page=50&order_by=updated_at`);
    const lista = (otras.ok && Array.isArray(otras.body)) ? otras.body.filter((t) => String(t.references && t.references.full || '').split('#')[0] !== f().path) : [];
    if (!lista.length) return;
    const porProy = new Map();
    for (const t of lista) { const p = String(t.references && t.references.full || '?').split('#')[0]; porProy.set(p, (porProy.get(p) || 0) + 1); }
    if (verTodas) { console.log(`\nEn otros proyectos — ${lista.length}:`); for (const [p] of porProy) { console.log(`  ${p}:`); for (const t of lista.filter((x) => String(x.references.full).split('#')[0] === p)) console.log(`    #${t.iid} [${t.state}] ${t.title}  ·  ${t.web_url}`); } }
    else console.log(`\nEn otros proyectos tienes ${lista.length} tarea(s): ${[...porProy.entries()].map(([p, n]) => `${p} (${n})`).join(' · ')}\n  Detalle: harness.js mis-tareas --todas`);
  }

  // ---- 7) CLAVE de proyecto (topic clave-<clave>, unica en el grupo raiz) ----
  const CLAVE_RE = /^[A-Z][A-Z0-9]{3,9}$/;
  async function topics() { const r = await api(`projects/${pid()}`); return (r.ok && r.body && Array.isArray(r.body.topics)) ? r.body.topics : []; }
  async function claveDeEsteRepo() { const t = (await topics()).find((x) => /^clave-[a-z0-9]{2,10}$/.test(x)); return t ? t.slice(6).toUpperCase() : null; }
  async function claveEnUso(clave) {
    const r = await api(`groups/${gid()}/projects?topic=${encodeURIComponent('clave-' + String(clave).toLowerCase())}&include_subgroups=true&per_page=50`);
    if (!r.ok || !Array.isArray(r.body)) return undefined;
    const hit = r.body.find((p) => p.path_with_namespace !== f().path);
    return hit ? hit.path_with_namespace : null;
  }
  async function estamparClave(clave) {
    const cur = (await topics()).filter((t) => !/^clave-[a-z0-9]{2,10}$/.test(t));
    const nuevos = [...new Set([...cur, `clave-${clave.toLowerCase()}`])];
    const r = await api(`projects/${pid()}`, { method: 'PUT', body: { topics: nuevos } });
    // SILENCIO POSIBLE: se relee para comprobar que el topic quedo de verdad (patron validado).
    if (r.ok) { const tras = await topics(); return { ok: tras.includes(`clave-${clave.toLowerCase()}`), status: r.status }; }
    return { ok: false, status: r.status };
  }
  async function cmdClave() {
    const arg = process.argv[3];
    if (!arg) {
      const actual = await claveDeEsteRepo();
      if (!actual) { const r = await api('user'); if (r.sinToken) { console.log(SIN_TOKEN()); process.exit(2); } console.log('SIN_CLAVE: este proyecto no tiene clave declarada (topic clave-*). Fijala: harness.js clave <CLAVE>'); return; }
      const enOtro = await claveEnUso(actual);
      console.log(`CLAVE: ${actual}${enOtro ? `\nCOLISION: la clave '${actual}' tambien es del proyecto '${enOtro}'. Las claves son UNA POR PROYECTO.` : ''}`);
      return;
    }
    const clave = String(arg).toUpperCase();
    if (!CLAVE_RE.test(clave)) { console.log(`INVALIDA: '${clave}' no cumple el formato (4-10 caracteres, empieza por letra, solo A-Z0-9).`); return; }
    const enOtro = await claveEnUso(clave);
    if (enOtro) { console.log(`EN_USO: la clave '${clave}' ya es del proyecto '${enOtro}'. Elige otra.`); return; }
    if (enOtro === undefined) console.log('AVISO: no pude verificar unicidad en el grupo (busqueda no disponible) — fijo igualmente.');
    const r = await estamparClave(clave);
    console.log(r.ok ? `FIJADA: ${clave} (topic clave-${clave.toLowerCase()} en ${f().path}). Escribe 'clave: ${clave}' en el frontmatter de ESTADO.md.` : `ERROR: no pude estampar el topic (HTTP ${r.status}).`);
  }

  // ---- 8) RESUMEN cacheado para la sesion (misma forma que GitHub) ----
  const cacheKey = () => `${f().host}/${f().path}`;
  // Un solo escritor del almacen: credenciales.js (ruta unica y segura en tests). Ver incidente 11 sep 2026.
  const CRED = require('./credenciales.js')();
  function leerCfg() { return CRED.leerCfg(); }
  function escribirCfg(j) { CRED.escribirCfg(j); }
  function ghResumenCache() { const c = (leerCfg().gh_resumen || {})[cacheKey()]; return c || null; }
  function ghResumenFresco(nowMs) { const c = ghResumenCache(); return !!(c && c.ts && (nowMs - c.ts) < 5 * 60000); }
  function invalidarResumen() { try { const j = leerCfg(); if (j.gh_resumen && j.gh_resumen[cacheKey()]) { j.gh_resumen[cacheKey()].ts = 0; escribirCfg(j); } } catch {} }
  async function refrescarResumen(nowMs) {
    const yo = await me(); if (!yo) return null;
    const cnt = async (p) => { const r = await api(p); return (r.ok && Array.isArray(r.body)) ? r.body.length : 0; };
    const [mis_tareas, prs_por_revisar, mis_prs, sin_label] = await Promise.all([
      cnt(`projects/${pid()}/issues?assignee_id=${yo.id}&state=opened&per_page=100`),
      cnt(`projects/${pid()}/merge_requests?state=opened&reviewer_id=${yo.id}&per_page=100`),
      cnt(`projects/${pid()}/merge_requests?state=opened&author_id=${yo.id}&per_page=100`),
      cnt(`projects/${pid()}/issues?state=opened&labels=None&per_page=100`),
    ]);
    // Menciones: la API de pendientes (todos) las cubre de forma nativa — ventaja de GitLab.
    const td = await api(`todos?state=pending&action=mentioned&per_page=100`);
    const menciones = (td.ok && Array.isArray(td.body)) ? td.body.filter((t) => t.project && t.project.path_with_namespace === f().path).length : 0;
    // Progreso NATIVO de la fase activa (su hito): tareas y horas. Se calcula aqui, en el refresco en
    // segundo plano, para que el arranque de sesion lo lea de cache sin pagar llamadas.
    let fase_hito = null;
    try {
      const act = (ctx.fases ? ctx.fases() : []).find((x) => ctx.isActive && ctx.isActive(x.estado));
      if (act) { const t = (await gestion.tiempoPorHito()).get(gestion.tituloFase(act)); if (t) fase_hito = { titulo: gestion.tituloFase(act), ...t }; }
    } catch {}
    // Planificador externo (#218, #277): mismo dominio que en GitHub; el arranque lo pinta desde la cache.
    const plan = planificacion ? await planificacion.leerRelacion(api, f()) : null;
    const snap = { mis_tareas, prs_por_revisar, mis_prs, menciones, sin_label, fase_hito, planificacion: plan, login: yo.login, ts: nowMs };
    try { const j = leerCfg(); j.gh_resumen = j.gh_resumen || {}; j.gh_resumen[cacheKey()] = snap; escribirCfg(j); } catch {}
    return snap;
  }
  async function cmdGhRefresh() { const nowMs = Number(process.argv[3]) || 0; if (nowMs) await refrescarResumen(nowMs); }

  // ---- CONEXION: device flow de GitLab (17.9+) o token personal ----
  async function cmdAuth() {
    const host = f().host;
    const argv = process.argv.slice(3);
    const iTok = argv.indexOf('--token');
    const pat = iTok >= 0 ? argv[iTok + 1] : (process.env.FARO_GITLAB_TOKEN || process.env.GITLAB_TOKEN || null);
    const clientId = process.env.FARO_GITLAB_CLIENT_ID || git('config', 'faro.gitlabClientId') || (leerCfg().tokens && leerCfg().tokens[host] && leerCfg().tokens[host].client_id) || null;
    let token = pat ? String(pat).trim() : null; let refresh = null; let expira = null;
    if (!token && !clientId) {
      process.stdout.write(
        `Para conectar con ${host} hacen falta una de dos cosas:\n` +
        `  1) Una APLICACION OAuth registrada en ${host} (Settings -> Applications, scope 'api', con "Device flow" habilitado; GitLab 17.9+):\n` +
        `     git config --global faro.gitlabClientId <client_id>   y repite: node .claude/hooks/harness.js auth\n` +
        `  2) Un TOKEN PERSONAL con scope 'api' (${host} -> Preferences -> Access tokens):\n` +
        `     node .claude/hooks/harness.js auth --token <token>\n` +
        'Explicaselo al usuario en llano y que elija.\n',
      );
      return;
    }
    if (!token) {
      const form = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      const post = async (u, b) => { try { const r = await fetch(u, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(b) }); return await r.json(); } catch { return {}; } };
      const d = await post(`https://${host}/oauth/authorize_device`, { client_id: clientId, scope: 'api' });
      if (!d.device_code) { process.stdout.write(`No pude iniciar el login por codigo en ${host} (¿aplicacion sin device flow, o GitLab < 17.9?). Alternativa: auth --token <token personal>\n`); return; }
      process.stdout.write(`\n  Abre en el navegador:  ${d.verification_uri_complete || d.verification_uri}\n  CODIGO:  ${d.user_code}\n  (esperando a que autorices…)\n`);
      const t0 = Date.now();
      while (Date.now() - t0 < (d.expires_in || 900) * 1000) {
        await new Promise((r) => setTimeout(r, (d.interval || 5) * 1000));
        const t = await post(`https://${host}/oauth/token`, { client_id: clientId, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
        if (t.access_token) { token = t.access_token; refresh = t.refresh_token || null; expira = t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : null; break; }
        if (t.error && t.error !== 'authorization_pending' && t.error !== 'slow_down') { process.stdout.write(`Login: ${t.error}\n`); return; }
      }
      if (!token) { process.stdout.write('Login caducado. Reintenta: node .claude/hooks/harness.js auth\n'); return; }
    }
    const r = await api('user', { token });
    if (!r.ok || !r.body || !r.body.username) { process.stdout.write(`El token no vale para ${host} (HTTP ${r.status}).\n`); return; }
    const u = { login: r.body.username, id: r.body.id, name: r.body.name || null, email: (r.body.email || '').toLowerCase() || null };
    // Con refresh_token + expira, credenciales.js renueva solo: nadie vuelve a teclear el codigo.
    guardarToken(host, { token, user: u, scopes: 'api', client_id: clientId || undefined, forja: 'gitlab', ...(refresh ? { refresh_token: refresh, expira } : {}) });
    if (u.name) git('config', 'user.name', u.name);
    if (u.email) git('config', 'user.email', u.email);
    git('config', 'faro.identityLogin', u.login);
    process.stdout.write(`\n✅ Conectado a ${host} como ${u.login}${u.email ? ` · ${u.email}` : ''}. Ya puedes: node .claude/hooks/harness.js role · pr · mis-tareas\n`);
  }

  // Cache del rol para el gate SINCRONO de merge/push (lib/git.js resolveRole): el gate no puede
  // esperar a la API, asi que lee lo que este comando dejo. Misma clave host/ruta en las dos forjas.
  function guardarRolCache(datos) {
    try { const j = leerCfg(); j.rol_cache = j.rol_cache || {}; j.rol_cache[cacheKey()] = { ...datos, ts: Date.now() }; escribirCfg(j); } catch {}
  }

  // Submodulos (atomicidad): ajustes del proyecto y gestion nativa (hitos, tiempo, enlaces).
  const proyecto = require('./forge-gitlab-proyecto.js')({ api, pid, f, git, SIN_TOKEN, ROOT, roleInfo });
  const gestion = require('./forge-gitlab-gestion.js')({ api, pid, f, SIN_TOKEN, invalidarResumen, fases: ctx.fases, isDone: ctx.isDone });
  const tareas = require('./forge-gitlab-tareas.js')({ api, pid, f, git, SIN_TOKEN, invalidarResumen, fases: ctx.fases, labelsCatalogo, collaborators, gestion, tokenPara, planificacion });

  return { api, me, roleInfo, cmdRole, collaborators, approvers, cmdPr, crearPr, cmdAsignarTarea, cmdDescartarTarea, ...equipo, cmdMisTareas, cmdClave, claveDeEsteRepo, claveEnUso, estamparClave, ghResumenCache, ghResumenFresco, refrescarResumen, cmdGhRefresh, invalidarResumen, cmdAuth, nivelARol, ...proyecto, ...gestion, ...tareas };
};
