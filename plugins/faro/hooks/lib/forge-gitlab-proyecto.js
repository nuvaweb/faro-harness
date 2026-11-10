// lib/forge-gitlab-proyecto.js — AJUSTES DEL PROYECTO en GitLab: renombrar, proteger ramas, exigir
// pipeline, reglas de push y bloqueo entre peticiones. Extraido de forge-gitlab.js por atomicidad
// (~400 lineas por modulo): el nucleo se queda con identidad, rol, peticiones, tareas y resumen.
// Mismo criterio que el resto del adaptador: se intenta, se RELEE y se dice lo que quedo de verdad.
'use strict';
const fs = require('fs');
const path = require('path');

module.exports = function (g) {
  const { api, pid, f, git, SIN_TOKEN, ROOT, roleInfo } = g;

  // ---- RENOMBRAR el proyecto (GitLab conserva REDIRECCIONES del path viejo, como GitHub) ----
  // Uso: harness.js renombrar "<Nombre nuevo>" [--path <slug-nuevo>]. Sin --path, el slug se deriva
  // del nombre. Se relee el proyecto tras escribir (patron 'clave') y se actualiza el origin local.
  async function cmdRenombrar() {
    const argv = process.argv.slice(3);
    const iP = argv.indexOf('--path');
    const nuevoPath = iP >= 0 ? String(argv[iP + 1] || '').trim() : null;
    const nombre = argv.filter((a, i) => a !== '--path' && (iP < 0 || i !== iP + 1)).join(' ').trim();
    if (!nombre) { console.log('Uso: node .claude/hooks/harness.js renombrar "<Nombre nuevo>" [--path <slug-nuevo>]'); process.exit(1); }
    const slug = nuevoPath || nombre.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const antes = f();
    const r = await api(`projects/${pid()}`, { method: 'PUT', body: { name: nombre, path: slug } });
    if (r.sinToken) { console.log(SIN_TOKEN()); process.exit(2); }
    if (!r.ok) { console.log(`No pude renombrar (HTTP ${r.status})${r.body && r.body.message ? `: ${JSON.stringify(r.body.message)}` : ''}. Hace falta nivel Owner del proyecto.`); return; }
    const v = await api(`projects/${encodeURIComponent(antes.path.replace(/[^/]+$/, slug))}`);
    if (!v.ok || !v.body) { console.log('GitLab acepto el cambio pero no pude releer el proyecto con la ruta nueva. Comprueba en la web.'); return; }
    const nuevaRuta = v.body.path_with_namespace;
    const remoto = git('remote', 'get-url', 'origin') || '';
    const nuevoRemoto = remoto.replace(antes.path, nuevaRuta);
    if (nuevoRemoto !== remoto) git('remote', 'set-url', 'origin', nuevoRemoto);
    console.log(`✅ Renombrado: ${antes.path} -> ${nuevaRuta} (nombre: "${v.body.name}").`);
    console.log(`   GitLab mantiene una REDIRECCION desde la ruta vieja; el origin local ya apunta a la nueva: ${nuevoRemoto}`);
    console.log('   Recuerda: el slug del CONCEPTO en el metadato NO cambia (es el ancla); el nombre viejo va a aliases.');
  }

  // ---- 9) PROTECCION DE RAMA (Free) + APROBACION MINIMA (Premium/Ultimate) ----
  // GitLab NO gatea por plan en la respuesta: una funcion de pago responde 403/404/vacio segun la
  // version, nunca un codigo uniforme "esto es de pago". Por eso aqui se INTENTA y se lee el
  // resultado real (mismo patron que 'clave': escribir y releer), en vez de negarse de antemano.
  // Proteccion basica de rama (push/merge solo Maintainer+) esta en TODOS los planes desde siempre.
  async function cmdProteger() {
    const rama = process.argv[3] || 'main';
    // Reemplaza cualquier regla previa de esa rama (evita 409 si ya existia con otros niveles).
    await api(`projects/${pid()}/protected_branches/${encodeURIComponent(rama)}`, { method: 'DELETE' }).catch(() => {});
    // push_access_level 0 = NADIE empuja directo (ni Maintainer, ni Owner): la rama SOLO se toca por
    // peticion de integracion. Es la traduccion literal del gobierno del harness ("main/develop
    // vetados a TODOS"), que con nivel 40 quedaba a medias: un Maintainer aun podia empujar directo.
    // merge_access_level 40 = la FUSION (via MR) sigue siendo de Maintainer/Owner.
    // unprotect_access_level 40: un Developer no puede QUITAR la proteccion (si no, la regla se
    // desmonta sola y el gobierno es decorativo).
    const r = await api(`projects/${pid()}/protected_branches`, { method: 'POST', body: { name: rama, push_access_level: 0, merge_access_level: 40, unprotect_access_level: 40, allow_force_push: false } });
    if (r.sinToken) { console.log(SIN_TOKEN()); process.exit(2); }
    if (!r.ok) { console.log(`No pude proteger '${rama}' (HTTP ${r.status})${r.body && r.body.message ? `: ${JSON.stringify(r.body.message)}` : ''}. Revisa que tengas nivel Maintainer/Owner.`); return; }
    console.log(`✅ '${rama}' protegida: NADIE empuja directo (tampoco Maintainer/Owner) — solo se entra por peticion de integracion, que fusiona un Maintainer+; force-push desactivado.`);
    // Aprobacion minima: PREMIUM/ULTIMATE. Si el plan no la trae, GitLab lo dice al intentar (403/402/
    // 404 segun version) — se informa en llano, sin tratarlo como fallo del comando anterior (que SI aplico).
    const ap = await api(`projects/${pid()}/approval_rules`, { method: 'POST', body: { name: 'faro-aprobacion', approvals_required: 1, protected_branch_ids: [] } });
    if (ap.ok) console.log(`✅ Aprobacion minima: 1 revisor antes de mergear a '${rama}' (regla 'faro-aprobacion', nivel Premium/Ultimate detectado).`);
    else console.log(`ℹ Aprobacion minima (revisor obligatorio) NO disponible en este proyecto (HTTP ${ap.status} — de plan Premium/Ultimate en adelante). La proteccion de rama de arriba SI quedo aplicada; el resto se acuerda por convencion de equipo.`);
    // Lo que NINGUNA forja impone de forma nativa: 'a main solo se entra DESDE develop'. No existe
    // una regla de rama ORIGEN en GitLab ni en GitHub — lo sostienen el flujo del harness y quien aprueba.
    console.log('Nota: "a esta rama solo se entra desde develop" NO es una regla que la plataforma sepa imponer (no hay restriccion por rama ORIGEN). Eso lo sostienen el flujo del harness y la persona que aprueba.');
  }
  // EXIGIR PIPELINE: 'only_allow_merge_if_pipeline_succeeds'. Va POR PROYECTO y NO al crearlo:
  // un proyecto recien creado (y uno DOCUMENTAL para siempre) no tiene pipeline, y exigirlo sin
  // pipeline bloquea TODA fusion. El momento correcto es cuando el repo ya tiene su fichero de CI
  // — por eso 'harness.js ci' lo sugiere justo despues de generarlo. Free en todos los planes.
  async function cmdExigirPipeline() {
    const apagar = process.argv.includes('--no');
    if (!apagar && !fs.existsSync(path.join(ROOT, '.gitlab-ci.yml'))) {
      console.log('Este repo NO tiene .gitlab-ci.yml: si exiges pipeline ahora, NINGUNA peticion se podra fusionar (no hay pipeline que pueda pasar).');
      console.log('Genera antes el tuyo: node .claude/hooks/harness.js ci   ·   (si de verdad lo quieres igual: --forzar)');
      if (!process.argv.includes('--forzar')) return;
    }
    const r = await api(`projects/${pid()}`, { method: 'PUT', body: { only_allow_merge_if_pipeline_succeeds: !apagar } });
    if (r.sinToken) { console.log(SIN_TOKEN()); process.exit(2); }
    if (!r.ok) { console.log(`No pude cambiarlo (HTTP ${r.status})${r.body && r.body.message ? `: ${JSON.stringify(r.body.message)}` : ''}. Hace falta nivel Maintainer/Owner.`); return; }
    // Se RELEE: GitLab acepta el PUT y devuelve 200 aunque el campo no cambie (patron ya visto en 'clave').
    const v = await api(`projects/${pid()}`);
    const real = v.ok && v.body ? v.body.only_allow_merge_if_pipeline_succeeds : null;
    if (real === !apagar) console.log(apagar ? '✅ El pipeline ya NO es obligatorio para fusionar.' : '✅ Pipeline OBLIGATORIO: con el pipeline en rojo, la peticion no se puede fusionar (tampoco por un Maintainer).');
    else console.log(`⚠ GitLab acepto la peticion pero el ajuste sigue en '${real}'. Revisalo en Settings > Merge requests.`);
  }

  // Reglas de PUSH del proyecto (Premium/Ultimate): patron de mensaje de commit, tamaño max de fichero,
  // rechazo de secretos conocidos, exigir autor verificado. Solo LEE/aplica lo que se le pida; nunca
  // decide valores por su cuenta salvo los que se pasan.
  async function cmdReglasPush() {
    const sub = process.argv[3];   // sin args: muestra las reglas actuales
    if (!sub || sub === 'ver') {
      const r = await api(`projects/${pid()}/push_rule`);
      if (r.sinToken) { console.log(SIN_TOKEN()); process.exit(2); }
      if (!r.ok) { console.log(`Reglas de push NO disponibles en este proyecto (HTTP ${r.status} — funcion Premium/Ultimate; en Free no hay nada que leer aqui).`); return; }
      console.log(`Reglas de push de ${f().path}: ${JSON.stringify(r.body)}`);
      return;
    }
    console.log('Uso: harness.js reglas-push [ver]  ·  para cambiarlas, pide un valor concreto (ej. "exige que el commit mencione una tarea") y se aplica con PUT a push_rule.');
  }
  // Enlaces de BLOQUEO entre peticiones de integracion (Premium/Ultimate): !X no se puede mergear
  // mientras !Y siga abierta. Por INTENCION: bloquea la peticion actual (o la indicada) con otra.
  async function cmdBloquearMr() {
    const iid = process.argv[3], bloqueaCon = process.argv[4];
    if (!iid || !bloqueaCon) { console.log('Uso: harness.js bloquear-pr <iid-bloqueada> <iid-que-la-bloquea>'); process.exit(1); }
    const r = await api(`projects/${pid()}/merge_requests/${iid}/block`, { method: 'POST', body: { target_project_id: pid(), target_merge_request_iid: Number(bloqueaCon) } });
    if (r.sinToken) { console.log(SIN_TOKEN()); process.exit(2); }
    console.log(r.ok ? `✅ !${iid} queda bloqueada hasta que se cierre !${bloqueaCon}.` : `No pude enlazarlas (HTTP ${r.status} — enlaces de bloqueo son Premium/Ultimate; en Free no existe esta relacion).`);
  }

  // ---- PETICION por la API: ver estado de aprobacion, aprobar, fusionar ----
  // El gobierno del harness no cambia: fusionar a main ES la aprobacion, y la aplica quien PUEDE
  // (nivel 40+) con --confirmo. Aqui se hace por la API porque main esta protegida contra push directo
  // y la unica entrada real es la propia peticion. Se RELEE tras cada escritura (patron del adaptador).
  async function estadoPr(iid) {
    const [mr, ap] = await Promise.all([api(`projects/${pid()}/merge_requests/${iid}`), api(`projects/${pid()}/merge_requests/${iid}/approvals`)]);
    if (mr.sinToken) { console.log(SIN_TOKEN()); process.exit(2); }
    if (!mr.ok || !mr.body) return null;
    const a = ap.ok && ap.body ? ap.body : {};
    return { mr: mr.body, aprobada: !!a.approved, faltan: a.approvals_left, requeridas: a.approvals_required, por: (a.approved_by || []).map((x) => x.user && x.user.username).filter(Boolean), reglas: a.rules || [] };
  }
  const pintarPr = (e) => {
    const m = e.mr;
    console.log(`!${m.iid} ${m.source_branch} -> ${m.target_branch} · ${m.title}
   estado: ${m.state}${m.draft ? ' (borrador)' : ''} · pipeline: ${m.head_pipeline ? m.head_pipeline.status : 'sin pipeline'} · conflictos: ${m.has_conflicts ? 'SI' : 'no'} · fusionable: ${m.detailed_merge_status || m.merge_status || '?'}`);
    console.log(`   aprobaciones: ${e.aprobada ? 'COMPLETAS' : 'pendientes'} (requeridas ${e.requeridas ?? '?'}, faltan ${e.faltan ?? '?'})${e.por.length ? ' · aprobado por ' + e.por.join(', ') : ''}`);
    for (const r of e.reglas) console.log(`   regla '${r.name}': ${r.approvals_required} requerida(s) · elegibles: ${(r.eligible_approvers || []).map((u) => u.username).join(', ') || '(nadie)'}`);
    console.log(`   ${m.web_url}`);
  };
  async function cmdPrVer(iid) {
    const e = await estadoPr(iid);
    if (!e) { console.log(`No encuentro la peticion !${iid}.`); process.exit(1); }
    pintarPr(e);
  }
  async function cmdPrAprobar(iid) {
    const r = await api(`projects/${pid()}/merge_requests/${iid}/approve`, { method: 'POST' });
    if (r.sinToken) { console.log(SIN_TOKEN()); process.exit(2); }
    if (!r.ok) { console.log(`No pude aprobar !${iid} (HTTP ${r.status})${r.body && r.body.message ? `: ${JSON.stringify(r.body.message)}` : ''}. Causas tipicas: eres el autor y el proyecto no permite autoaprobacion, o no estas entre los aprobadores elegibles.`); process.exit(1); }
    const e = await estadoPr(iid);   // relectura: ¿la aprobacion cuenta de verdad?
    console.log(`✅ Aprobacion registrada en !${iid}.`); if (e) pintarPr(e);
  }
  async function cmdPrMergear(iid, argv) {
    if (!argv.includes('--confirmo')) { console.log(`Fusionar !${iid} es la APROBACION: requiere --confirmo (el usuario debe haberlo confirmado en esta conversacion). Antes: harness.js pr ver ${iid}`); process.exit(1); }
    const ri = await roleInfo(); if (ri && ri.sinToken) { console.log(SIN_TOKEN()); process.exit(2); }
    if (!ri || !ri.puedeAprobar) { console.log(`Tu rol (${ri ? ri.perm : '?'}) no puede fusionar. Lo aplica un Maintainer/Owner.`); process.exit(1); }
    const antes = await estadoPr(iid); if (!antes) { console.log(`No encuentro la peticion !${iid}.`); process.exit(1); }
    const squash = argv.includes('--squash') ? true : (argv.includes('--sin-squash') ? false : undefined);
    // #262: el SHA de cabeza leido justo antes. GitLab lo EXIGE si el grupo tiene require_sha_for_merge
    // («SHA must be provided when merging») y, en todo caso, impide fusionar una rama que cambio tras revisarla.
    const sha = shaCabeza(antes.mr);
    const body = { should_remove_source_branch: true, ...(squash === undefined ? {} : { squash }), ...(sha ? { sha } : {}) };
    const r = await api(`projects/${pid()}/merge_requests/${iid}/merge`, { method: 'PUT', body });
    if (!r.ok) { console.log(`GitLab NO fusiono !${iid} (HTTP ${r.status})${r.body && r.body.message ? `: ${JSON.stringify(r.body.message)}` : ''}.${r.status === 409 ? avisoCambio(iid) : ''}`); pintarPr(antes); process.exit(1); }
    const v = await api(`projects/${pid()}/merge_requests/${iid}`);
    const st = v.ok && v.body ? v.body.state : '?';
    console.log(st === 'merged' ? `✅ !${iid} FUSIONADA en ${antes.mr.target_branch} (commit ${(v.body.merge_commit_sha || v.body.sha || '').slice(0, 7)}).` : `⚠ GitLab acepto la fusion pero la peticion sigue en '${st}' (¿fusion en cola hasta que pase el pipeline?).`);
  }

  // integrarPorPeticion({head, base, titulo, cuerpo}) -> {ok, numero, url, sha, msg, sinToken} (#194).
  // Misma intencion que en github.js: abre (o reutiliza) la peticion y la fusiona por la API. Aqui
  // NO se usa crearPr: ese pide remove_source_branch, y la rama origen es develop.
  // SHA de cabeza de una MR: 'sha' en la API v4; 'diff_refs.head_sha' como respaldo (#262).
  const shaCabeza = (mr) => (mr && (mr.sha || (mr.diff_refs && mr.diff_refs.head_sha))) || null;
  const avisoCambio = (ref) => ` La rama cambio despues de leerla (alguien subio commits): revisala con  harness.js pr ver ${ref}  y vuelve a intentarlo.`;

  // 'sha' (opcional): la cabeza que quien llama acaba de subir; manda sobre la que diga la MR.
  async function integrarPorPeticion({ head, base, titulo, cuerpo, esperaMs = 2000, sha: esperado = null }) {
    const ex = await api(`projects/${pid()}/merge_requests?state=opened&source_branch=${encodeURIComponent(head)}&target_branch=${encodeURIComponent(base)}&per_page=1`);
    if (ex.sinToken) return { ok: false, sinToken: true, msg: 'SIN_TOKEN: conectate -> node .claude/hooks/harness.js auth' };
    let numero = ex.ok && Array.isArray(ex.body) && ex.body[0] ? ex.body[0].iid : null;
    let url = numero ? ex.body[0].web_url : null;
    if (!numero) {
      const c = await api(`projects/${pid()}/merge_requests`, { method: 'POST', body: { title: titulo, description: cuerpo || '', source_branch: head, target_branch: base, remove_source_branch: false } });
      if (!c.ok) return { ok: false, sinToken: !!c.sinToken, msg: `no pude abrir la peticion ${head} -> ${base} (HTTP ${c.status})${c.body && c.body.message ? `: ${JSON.stringify(c.body.message)}` : ''}` };
      numero = c.body.iid; url = c.body.web_url;
    }
    // GitLab calcula la fusionabilidad de forma ASINCRONA: una MR recien abierta responde 405/406/422
    // durante unos segundos. Unos reintentos breves antes de darla por no fusionable.
    // #262: el SHA de cabeza (require_sha_for_merge): el que subio quien llama o, si no lo da, el de la
    // MR releida (la lista no siempre lo trae). Sin ninguno, se fusiona como antes.
    let sha = esperado;
    if (!sha) { const leida = await api(`projects/${pid()}/merge_requests/${numero}`); sha = shaCabeza(leida.ok ? leida.body : null); }
    let m;
    for (let i = 0; i < 6; i++) {
      m = await api(`projects/${pid()}/merge_requests/${numero}/merge`, { method: 'PUT', body: { should_remove_source_branch: false, squash: false, ...(sha ? { sha } : {}) } });
      if (m.ok || ![405, 406, 422].includes(m.status) || i === 5) break;
      await new Promise((r) => setTimeout(r, esperaMs));
    }
    if (!m.ok) return { ok: false, numero, url, msg: `GitLab no fusiono !${numero} (HTTP ${m.status})${m.body && m.body.message ? `: ${JSON.stringify(m.body.message)}` : ''}.${m.status === 409 ? avisoCambio(numero) : ''} La peticion queda abierta: ${url}` };
    return { ok: true, numero, url, sha: (m.body && (m.body.merge_commit_sha || m.body.sha)) || null };
  }

  // Estado del CI de un MR (#289): head_pipeline del MR; si fallo, los jobs fallidos y su failure_reason
  // (ci_quota_exceeded = sin minutos, no un fallo del codigo). La normalizacion es dominio puro.
  async function estadoCi(iid) {
    const mr = await api(`projects/${pid()}/merge_requests/${iid}`);
    if (mr.sinToken) return { ok: false, sinToken: true };
    if (!mr.ok || !mr.body) return { ok: false, msg: `No pude leer la peticion !${iid} (HTTP ${mr.status}).` };
    const pipeline = mr.body.head_pipeline || null;
    return { ok: true, sha: mr.body.sha || (pipeline && pipeline.sha) || null, ...(await normalizarPipeline(pipeline)) };
  }
  async function normalizarPipeline(pipeline) {
    let jobsFallidos = [];
    if (pipeline && pipeline.status === 'failed') {
      const j = await api(`projects/${pid()}/pipelines/${pipeline.id}/jobs?scope[]=failed&per_page=100`);
      jobsFallidos = j.ok && Array.isArray(j.body) ? j.body : [];
    }
    return require('./estado-ci.js').normalizarGitlab({ pipeline, jobsFallidos });
  }
  // Lo mismo para un commit concreto (p. ej. la punta de develop al publicar): su ultimo pipeline.
  async function estadoCiCommit(sha) {
    const r = await api(`projects/${pid()}/pipelines?sha=${encodeURIComponent(sha)}&order_by=id&sort=desc&per_page=1`);
    if (r.sinToken) return { ok: false, sinToken: true };
    if (!r.ok) return { ok: false, msg: `No pude leer los pipelines de ${sha} (HTTP ${r.status}).` };
    return { ok: true, sha, ...(await normalizarPipeline((Array.isArray(r.body) && r.body[0]) || null)) };
  }

  return { cmdRenombrar, cmdProteger, cmdExigirPipeline, cmdReglasPush, cmdBloquearMr, cmdPrVer, cmdPrAprobar, cmdPrMergear, integrarPorPeticion, estadoCi, estadoCiCommit };
};
