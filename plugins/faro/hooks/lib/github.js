#!/usr/bin/env node
// github.js — TODA la logica de GitHub e IDENTIDAD del harness (MODULO SEPARADO, mantenible).
// Lo consume harness.js: subcomandos identity/auth/gh/pr/role + identityLines/identityCheck (sesion).
// Sin dependencias: fetch nativo de Node. Factory: require('./github.js')({ ROOT, git, IS_TEMPLATE }).
//
// TOKEN de GitHub (unico punto de verdad, a nivel usuario): ~/.faro.json (nombre VIGENTE, lo crea
// el wizard 'faro' o 'auth').
// La SSH mueve el codigo; la API SIEMPRE va por este token. Cascada de ghToken(): env -> ~/.faro.json -> gh.
// IDENTIDAD cacheada en ese mismo fichero (user: {login,name,email}) para no repetir llamadas.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

module.exports = function (ctx) {
  const { ROOT, git, IS_TEMPLATE, forge } = ctx;
  // HOST real de este repo (github.com o un GitHub Enterprise Server autoalojado en OTRO dominio).
  // Antes todo el modulo llamaba a 'api.github.com' a pelo: en un repo de GHE la API vive en
  // 'https://<host>/api/v3/' y el device-flow en 'https://<host>/login/...'. Sin esto, un cliente
  // con su propio GitHub (imaginemos otro GitHub, autoalojado) recibia respuestas de GitHub.com
  // ajenas a su repo. auth() todavia no tiene remoto que detectar (primera vez): cae a github.com.
  const ghHost = () => (forge && forge().host) || 'github.com';
  const ghApiBase = () => (ghHost() === 'github.com' ? 'https://api.github.com/' : `https://${ghHost()}/api/v3/`);
  const ghWebBase = () => (ghHost() === 'github.com' ? 'https://github.com/' : `https://${ghHost()}/`);
  // Un solo escritor del almacen: credenciales.js (ruta unica y segura en tests). Ver incidente 11 sep 2026.
  const CRED = require('./credenciales.js')();
  const readCfg = () => CRED.leerCfg();
  const writeCfg = (j) => { CRED.escribirCfg(j); };
  // Identidad cacheada (login/nombre/correo) para recuperar info sin llamar a la API (informes).
  const cachedUser = () => { const j = readCfg(); return j && j.user ? j.user : null; };
  // Credenciales POR HOST (lib/credenciales.js): GitHub es un host mas. Migra el 'token' plano al primer uso.

  // ---- CLIENTE UNICO de la API de GitHub (reutilizable; evita duplicar fetch/headers en cada funcion) ----
  const GH_HEADERS = (tok) => ({ Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
  // ghApi(path, {method, body}): resuelve token, headers y JSON. Devuelve {ok, status, body, error}.
  // path relativo ('user', 'repos/o/r/issues') o absoluto. Un solo punto de verdad para TODA llamada REST.
  async function ghApi(p, { method = 'GET', body = null } = {}) {
    const tok = ghToken();
    if (!tok) return { ok: false, status: 0, body: null, sinToken: true };
    const url = /^https?:\/\//.test(p) ? p : `${ghApiBase()}${p.replace(/^\//, '')}`;
    const opts = { method, headers: GH_HEADERS(tok) };
    if (body != null) { opts.headers['Content-Type'] = 'application/json'; opts.body = typeof body === 'string' ? body : JSON.stringify(body); }
    try {
      const r = await fetch(url, opts);
      const j = r.status === 204 ? true : await r.json().catch(() => null);
      return { ok: r.ok, status: r.status, body: j };
    } catch (e) { return { ok: false, status: 0, body: null, error: (e && e.message) || String(e) }; }
  }
  // org/repo del remoto (centralizado): -> {org, repo} o null.
  // Solo devuelve org/repo si el remoto es DE VERDAD de GitHub. La version anterior aplicaba la
  // regex a CUALQUIER cosa, y un remoto que fuese una RUTA LOCAL con barras normales colaba:
  //   '/tmp/proyecto-bare'            -> creia org='tmp',   repo='proyecto-bare'
  //   '/home/runner/work/_temp/x'     -> creia org='_temp', repo='x'
  // Con eso, el harness llamaba a la API de GitHub por un repo inexistente, respondia SIN_TOKEN y
  // ABORTABA la operacion antes de hacer su trabajo (consolidar salia sin avisar de develop sin
  // subir). En Windows no se veia porque las rutas locales llevan contrabarras y la regex no casaba:
  // el bug era invisible en una plataforma y rompia CI en las otras dos. La deteccion de forja ya
  // sabe distinguirlo, asi que manda ella.
  function ghRepo() {
    const f = require('./forge.js').detect(git);
    if (f.forge !== 'github' || !f.owner || !f.project) return null;
    return { org: f.owner, repo: f.project };
  }

  // Clave de proyecto (atomicidad): topics, unicidad en la org, sugerencia y estampado.
  const clave = require('./github-clave.js')({ ghApi, ghRepo, git });
  const { claveValida, claveDeEsteRepo, claveEnUso, sugerirClave, estamparClave, reposParecidos } = clave;

  // Identidad y conexion (atomicidad): quien eres para git y para la forja, y el login por codigo.
  const ident = require('./github-identidad.js')({ ghApi, ghRepo, git, ROOT, IS_TEMPLATE, CRED, ghHost, ghApiBase, ghWebBase, readCfg, writeCfg, cachedUser });
  const { authIdentity, identityLines, asegurarEmailCommit } = ident;


  // Token para la API: env -> ~/.faro.json (CLI o 'auth') -> gh auth token.
  function ghToken() { return CRED.tokenPara(ghHost()); }

  // ensureUser: si HAY token pero NO estan los datos del usuario (login/nombre/correo) en el fichero,
  // hace la peticion a la API (GET /user + /user/emails) y RELLENA ~/.faro.json -> validacion.
  async function ensureUser() {
    const cfg = readCfg();
    if (cfg.user && cfg.user.login && cfg.user.email) return cfg.user;   // ya cacheado, no re-llama
    const tok = ghToken();
    if (!tok) return cfg.user || null;
    try {
      const api = async (p) => { const r = await fetch(ghApiBase() + p, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json' } }); return r.ok ? r.json() : null; };
      const me = await api('user'); if (!me || !me.login) return cfg.user || null;
      let email = me.email; if (!email) { const es = await api('user/emails'); if (Array.isArray(es)) { const p = es.find((e) => e.primary && e.verified) || es.find((e) => e.verified); email = p && p.email; } }
      const name = me.name || (git('config', 'user.name') || '').trim() || null;                 // fallback: nombre git
      if (!email) email = (git('config', 'user.email') || '').trim().toLowerCase() || null;       // fallback: correo git (validado)
      const j = readCfg(); j.user = { login: me.login, name, email: email || null }; writeCfg(j);
      return j.user;
    } catch { return cfg.user || null; }
  }

  // gh: API de GitHub SIN gh (usa ghToken). Uso: harness.js gh <ruta> [METODO] [json].
  async function cmdGh() {
    let p = process.argv[3];
    const method = (process.argv[4] || 'GET').toUpperCase();
    const body = process.argv[5] || null;
    // {org}/{repo} (como los documentan los skills) = los del remoto de la sesion; se expanden ANTES del control de alcance (#245).
    try { p = require('./alcance.js').expandirPlaceholders(p, ghRepo()); } catch { /* sin expandir: el control de alcance decide */ }
    if (!p) { process.stdout.write('Uso: node .claude/hooks/harness.js gh <ruta-api> [METODO] [json-body]\n  ver:   gh "repos/{org}/{repo}/pulls?state=open&base=main"\n  crear: gh repos/{org}/{repo}/pulls POST \'{"title":"..","head":"develop","base":"main","body":".."}\'\n'); return; }
    // ALCANCE (#150): solo la organizacion del remoto de la sesion; en repos que no son el de la sesion,
    // lectura libre y de escritura solo crear issues y comentar. Antes del token: se rechaza sin red.
    {
      let motivo;
      try {
        const AL = require('./alcance.js');
        motivo = AL.evaluarGh(p, method, ghRepo(), { permitidos: AL.leerAlcance(ROOT).repos_permitidos, apiBase: ghApiBase(), cuerpo: body });
      } catch (e) { motivo = `error interno del control de alcance (${(e && e.message) || e})`; }
      if (motivo) { process.stdout.write(`BLOQUEADO: ${motivo}. Para pedir un cambio en otro repo de la organizacion, abre un issue: harness.js asignar-tarea "<titulo>" <login> --repo <org>/<repo> --tipo <tipo>.\n`); process.exit(2); }
    }
    const tok = ghToken();
    if (!tok) { process.stdout.write('SIN_TOKEN: para consultar/gestionar la API de GitHub hace falta conectarse (login por navegador). Ejecuta: node .claude/hooks/harness.js auth\n'); process.exit(2); }
    await ensureUser();   // si falta el user en el fichero, lo rellena (una vez)
    const url = /^https?:/.test(p) ? p : ghApiBase() + p.replace(/^\//, '');
    const opts = { method, headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
    if (body && method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = body; }
    try { const r = await fetch(url, opts); const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; } process.stdout.write((r.ok ? '' : `HTTP ${r.status}\n`) + (typeof j === 'string' ? j : JSON.stringify(j, null, 2)) + '\n'); } catch (e) { process.stdout.write('Error de red: ' + ((e && e.message) || e) + '\n'); }
  }

  // pr: lista los PRs abiertos YA FORMATEADO. Uso: harness.js pr [rama-destino].
  // Estado real de una tarea en la forja: 'open' | 'closed' | null (no se pudo consultar).
  // null NUNCA significa "esta mal": sin red o sin token no se bloquea el trabajo (ver ciclo.js).
  async function issueEstado(num) {
    const remote = git('remote', 'get-url', 'origin') || '';
    const m = remote.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    const tok = ghToken();
    if (!m || !tok || !num) return null;
    try {
      const r = await fetch(`${ghApiBase()}repos/${m[1]}/${m[2]}/issues/${encodeURIComponent(num)}`, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json' } });
      if (!r.ok) return null;
      const j = await r.json();
      return (j && j.state) || null;
    } catch { return null; }
  }

  // Cierra una tarea como COMPLETADA, dejando nota de por que. La usa 'consolidar' con el trabajo ya
  // integrado en develop. Devuelve true/false; nunca lanza (no romper una consolidacion por la API).
  async function cerrarIssue(num, nota) {
    const remote = git('remote', 'get-url', 'origin') || '';
    const m = remote.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    const tok = ghToken();
    if (!m || !tok || !num) return false;
    const h = { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
    try {
      if (nota) await fetch(`${ghApiBase()}repos/${m[1]}/${m[2]}/issues/${num}/comments`, { method: 'POST', headers: h, body: JSON.stringify({ body: nota }) });
      const r = await fetch(`${ghApiBase()}repos/${m[1]}/${m[2]}/issues/${num}`, { method: 'PATCH', headers: h, body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
      return r.ok;
    } catch { return false; }
  }

  // Comenta en un issue sin cambiar su estado (trazabilidad: 'Publicada en vX'). true/false, nunca lanza.
  async function comentarIssue(num, texto) {
    const R = ghRepo(); if (!R || !num || !texto) return false;
    const r = await ghApi(`repos/${R.org}/${R.repo}/issues/${num}/comments`, { method: 'POST', body: { body: texto } });
    return !!r.ok;
  }

  // HECHOS para el reconciliador de tareas (lib/tarea.js): issues abiertos + los cerrados recientes,
  // y los PRs recientes (abiertos y fusionados). Pocas llamadas y paginadas con tope: es lo que cabe
  // en un consolidar o un vigilante sin agotar la API. null si no se pudo consultar (sin token/red):
  // quien llama lo dice, nunca lo trata como "no hay nada que cerrar".
  async function hechosTareas() {
    const R = ghRepo(); if (!R) return null;
    const base = `repos/${R.org}/${R.repo}`;
    const pag = async (ruta, max) => {
      const out = [];
      for (let p = 1; p <= max; p++) {
        const r = await ghApi(`${ruta}${ruta.includes('?') ? '&' : '?'}per_page=100&page=${p}`);
        if (!r.ok || !Array.isArray(r.body)) return p === 1 ? null : out;
        out.push(...r.body);
        if (r.body.length < 100) break;
      }
      return out;
    };
    const abiertos = await pag(`${base}/issues?state=open`, 3);
    if (!abiertos) return null;
    const cerrados = (await pag(`${base}/issues?state=closed&sort=updated&direction=desc`, 1)) || [];
    const prs = (await pag(`${base}/pulls?state=all&sort=updated&direction=desc`, 2)) || [];
    const ramas = (git('branch', '-r', '--format=%(refname:short)') || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const hitos = (await pag(`${base}/milestones?state=all`, 1)) || [];
    return { issues: [...abiertos, ...cerrados].filter((i) => !i.pull_request), prs, ramas, hitos };
  }

  // ¿Esta rama ya tiene peticion abierta? 'terminar' lo consulta para no abrir una segunda.
  // Devuelve la url o null; sin token o sin red, null (no bloquear el cierre por no poder mirar).
  async function prAbiertoDe(rama) {
    const remote = git('remote', 'get-url', 'origin') || '';
    const m = remote.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    const tok = ghToken();
    if (!m || !tok || !rama) return null;
    try {
      const r = await fetch(`${ghApiBase()}repos/${m[1]}/${m[2]}/pulls?state=open&head=${m[1]}:${encodeURIComponent(rama)}&per_page=1`, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json' } });
      const j = await r.json();
      return (Array.isArray(j) && j[0] && j[0].html_url) || null;
    } catch { return null; }
  }

  // PRs (abiertos o ya fusionados) que salen de esta rama: el cierre activo de 'consolidar' los lee
  // para respetar un 'Refs #N' (#91). null si no se pudo consultar; [] si la rama no tiene PR.
  async function prsDeRama(rama) {
    const R = ghRepo(); if (!R || !rama) return null;
    const r = await ghApi(`repos/${R.org}/${R.repo}/pulls?state=all&head=${R.org}:${encodeURIComponent(rama)}&per_page=10`);
    return r.ok && Array.isArray(r.body) ? r.body : null;
  }

  async function cmdPr() {
    const remote = git('remote', 'get-url', 'origin') || '';
    const m = remote.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!m) { process.stdout.write('No detecto el repo remoto (origin).\n'); return; }
    const org = m[1], repo = m[2], base = process.argv[3] || null;
    const tok = ghToken();
    if (!tok) { process.stdout.write('SIN_TOKEN: para ver los PRs hace falta conectarse (login por navegador). Ejecuta: node .claude/hooks/harness.js auth\n'); process.exit(2); }
    await ensureUser();
    try {
      const r = await fetch(`${ghApiBase()}repos/${org}/${repo}/pulls?state=open${base ? '&base=' + base : ''}&per_page=50`, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json' } });
      const j = await r.json();
      if (!Array.isArray(j)) { process.stdout.write(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}\n`); return; }
      if (!j.length) { process.stdout.write((base ? `Sin PRs abiertos hacia ${base}` : `Sin PRs abiertos en ${org}/${repo}`) + '.\n'); return; }
      const out = [`${j.length} PR(s) abierto(s) en ${org}/${repo}${base ? ' hacia ' + base : ''}:`];
      for (const p of j) out.push(`  #${p.number} ${p.draft ? '[DRAFT] ' : ''}${p.head.ref} -> ${p.base.ref}  ·  ${p.title}\n     por @${p.user.login}  ·  ${p.html_url}`);
      process.stdout.write(out.join('\n') + '\n');
    } catch (e) { process.stdout.write('Error de red: ' + ((e && e.message) || e) + '\n'); }
  }

  // crearPr({titulo, cuerpo, head, base, revisores}) -> {ok, url, numero} — por INTENCION (misma firma
  // que forge-gitlab.js). Asigna revisores si se indican (GitHub no deja auto-asignarse: se filtra el autor).
  async function crearPr({ titulo, cuerpo, head, base, revisores = [] }) {
    const R = ghRepo(); if (!R) return { ok: false, msg: 'sin remoto de GitHub' };
    // Que la peticion tenga tarea lo decide 'pr crear' (harness.js, #71) para las dos forjas: aqui ya
    // no se repite el aviso.
    const r = await ghApi(`repos/${R.org}/${R.repo}/pulls`, { method: 'POST', body: { title: titulo, body: cuerpo || '', head, base } });
    if (r.sinToken) return { ok: false, sinToken: true };
    if (!r.ok || !r.body || !r.body.number) return { ok: false, status: r.status, msg: r.body && (r.body.message || JSON.stringify(r.body).slice(0, 200)) };
    const yo = (await ensureUser()) || {};
    const revs = revisores.filter((l) => l && l.toLowerCase() !== String(yo.login || '').toLowerCase());
    if (revs.length) await ghApi(`repos/${R.org}/${R.repo}/pulls/${r.body.number}/requested_reviewers`, { method: 'POST', body: { reviewers: revs } });
    return { ok: true, numero: r.body.number, url: r.body.html_url };
  }

  // integrarPorPeticion({head, base, titulo, cuerpo}) -> {ok, numero, url, sha, msg, sinToken} (#194).
  // La via que una rama protegida SI admite: abre (o reutiliza) la peticion head -> base y la fusiona
  // con el token del harness. 'merge' (no squash): develop -> main conserva la historia. La rama
  // origen NO se borra (es develop). Misma firma que forge-gitlab.js.
  // 'sha' (opcional): la cabeza que quien llama acaba de subir; manda sobre la que diga la peticion.
  async function integrarPorPeticion({ head, base, titulo, cuerpo, esperaMs = 2000, sha: esperado = null }) {
    const R = ghRepo(); if (!R) return { ok: false, msg: 'sin remoto de GitHub' };
    const ex = await ghApi(`repos/${R.org}/${R.repo}/pulls?state=open&head=${R.org}:${encodeURIComponent(head)}&base=${encodeURIComponent(base)}&per_page=1`);
    if (ex.sinToken) return { ok: false, sinToken: true, msg: 'SIN_TOKEN: conectate -> node .claude/hooks/harness.js auth' };
    let numero = ex.ok && Array.isArray(ex.body) && ex.body[0] ? ex.body[0].number : null;
    let url = numero ? ex.body[0].html_url : null;
    if (!numero) {
      const c = await crearPr({ titulo, cuerpo, head, base });
      if (!c.ok) return { ok: false, sinToken: !!c.sinToken, msg: `no pude abrir la peticion ${head} -> ${base}${c.msg ? `: ${c.msg}` : c.status ? ` (HTTP ${c.status})` : ''}` };
      numero = c.numero; url = c.url;
    }
    // Recien abierta, GitHub puede estar aun calculando si es fusionable (405/409): unos reintentos breves.
    // #262: el SHA de cabeza leido ahora: la fusion no se lleva commits que nadie vio.
    let sha = esperado;
    if (!sha) { const leida = await ghApi(`repos/${R.org}/${R.repo}/pulls/${numero}`); sha = (leida.ok && leida.body && leida.body.head && leida.body.head.sha) || null; }
    let m;
    for (let i = 0; i < 4; i++) {
      m = await ghApi(`repos/${R.org}/${R.repo}/pulls/${numero}/merge`, { method: 'PUT', body: { merge_method: 'merge', commit_title: titulo, ...(sha ? { sha } : {}) } });
      if (m.ok || ![405, 409].includes(m.status) || i === 3) break;
      await new Promise((r) => setTimeout(r, esperaMs));
    }
    if (!m.ok) return { ok: false, numero, url, msg: `GitHub no fusiono #${numero} (HTTP ${m.status})${m.body && m.body.message ? `: ${m.body.message}` : ''}.${m.status === 409 && sha ? ` Si la rama cambio despues de leerla, revisala con  harness.js pr ver ${numero}  y vuelve a intentarlo.` : ''} La peticion queda abierta: ${url}` };
    return { ok: true, numero, url, sha: (m.body && m.body.sha) || null };
  }

  // Gestion (atomicidad): hitos, miembros, peticiones por intencion, exigir pipeline, renombrar.
  const gestion = require('./github-gestion.js')({
    ghApi, ghRepo, git, fases: ctx.fases, isDone: ctx.isDone,
    sinToken: () => 'SIN_TOKEN: conectate -> node .claude/hooks/harness.js auth',
    roleInfo: () => roleInfo(), cmdEquipo: () => cmdEquipo(),
  });

  // proteger: activa proteccion de rama (misma intencion y firma que cmdProteger en forge-gitlab.js).
  // Free en las dos forjas: solo admin/maintain puede empujar/mergear directo; sin force-push.
  async function cmdProteger() {
    const R = ghRepo(); if (!R) { process.stdout.write('No detecto un remoto de GitHub.\n'); return; }
    const rama = process.argv[3] || 'main';
    const r = await ghApi(`repos/${R.org}/${R.repo}/branches/${encodeURIComponent(rama)}/protection`, {
      method: 'PUT',
      body: { required_status_checks: null, enforce_admins: true, required_pull_request_reviews: { required_approving_review_count: 1 }, restrictions: null, allow_force_pushes: false },
    });
    if (r.sinToken) { process.stdout.write('SIN_TOKEN: conectate -> node .claude/hooks/harness.js auth\n'); process.exit(2); }
    if (gestion.esLimitePlan(r)) { gestion.avisoPlan(`Proteger la rama '${rama}'`); return; }
    if (!r.ok) { process.stdout.write(`No pude proteger '${rama}' (HTTP ${r.status})${r.body && r.body.message ? `: ${r.body.message}` : ''}. Revisa que tengas rol admin.\n`); return; }
    process.stdout.write(`✅ '${rama}' protegida: solo con PR aprobado (1 revisor) se puede mergear, se aplica tambien a admins, y sin force-push.\n`);
    // Limite REAL de las dos forjas: no existe restriccion por rama ORIGEN ("a main solo desde develop").
    process.stdout.write('Nota: "a esta rama solo se entra desde develop" NO es una regla que la plataforma sepa imponer (no hay restriccion por rama ORIGEN). Eso lo sostienen el flujo del harness y la persona que aprueba.\n');
  }

  // roleInfo: rol REAL del usuario en el repo (API .permissions) SIN imprimir -> {org,repo,perm,puedeAprobar}. Cachea el rol.
  async function roleInfo() {
    const R = ghRepo();
    if (!R) return null;
    const { org, repo } = R;
    const r = await ghApi(`repos/${org}/${repo}`);
    if (r.sinToken) return { org, repo, perm: null, puedeAprobar: false, sinToken: true };
    if (!r.ok) return { org, repo, perm: null, puedeAprobar: false, http: r.status };
    const pm = (r.body && r.body.permissions) || {};
    const perm = pm.admin ? 'admin' : pm.maintain ? 'maintain' : pm.push ? 'write' : pm.pull ? 'read' : '?';
    try { const cfg = readCfg(); cfg.repo_roles = cfg.repo_roles || {}; cfg.repo_roles[`${org}/${repo}`] = perm; writeCfg(cfg); } catch {}
    return { org, repo, perm, puedeAprobar: !!(pm.admin || pm.maintain) };
  }
  // role: imprime el rol y si puede APROBAR el merge a main.
  async function cmdRole() {
    if (!ghToken()) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth  (codigo de 6 digitos). NUNCA busques el token en env/gh.'); process.exit(2); }
    await ensureUser();
    const ri = await roleInfo();
    if (!ri) { console.log('No detecto el repo remoto (origin).'); return; }
    if (ri.perm === null) { console.log(`No pude leer el rol${ri.http ? ` (HTTP ${ri.http})` : ''}${ri.err ? ` (${ri.err})` : ''}.`); return; }
    console.log(`Rol en ${ri.org}/${ri.repo}: ${ri.perm}${ri.perm === 'admin' ? ' (owner/admin)' : ''}`);
    // Cache para el gate sincrono de merge/push (lib/git.js): misma clave host/ruta que forge-gitlab.js.
    try { const j = readCfg(); j.rol_cache = j.rol_cache || {}; j.rol_cache[`${ghHost()}/${ri.org}/${ri.repo}`] = { rol: ri.puedeAprobar ? 'maintainer' : 'developer', forja: 'GitHub', detalle: ri.perm, login: (cachedUser() || {}).login || null, ts: Date.now() }; writeCfg(j); } catch {}
    console.log(ri.puedeAprobar
      ? `PUEDES PUBLICAR (eres ${ri.perm === 'admin' ? 'admin/owner' : ri.perm} de ${ri.org}/${ri.repo}). Flujo: traer trabajo a develop con node .claude/hooks/harness.js consolidar; publicar develop->main con node .claude/hooks/harness.js publicar.`
      : `NO puedes publicar (rol '${ri.perm}'). Tu lanzas el PR con /faro:pr; el merge a develop (/faro:consolidar) y a main (/faro:publicar) los aplica un admin/owner/maintainer.`);
  }

  // approvers: logins de los que PUEDEN aprobar en el repo (admin/maintain) via token del harness.
  // collaborators: listado REAL de usuarios de la repo (el "equipo") via API del harness.
  // affiliation=all (explicito): DIRECTOS del repo + los que heredan de la ORG (org-owners). Cada uno con
  // {login, rol, directo} para poder PRIORIZAR admin del repo frente a owners heredados.
  async function collaborators() {
    const R = ghRepo();
    if (!R) return [];
    const aff = async (a) => { const r = await ghApi(`repos/${R.org}/${R.repo}/collaborators?affiliation=${a}&per_page=100`); return (r.ok && Array.isArray(r.body)) ? r.body : []; };
    const [all, direct] = await Promise.all([aff('all'), aff('direct')]);
    const directos = new Set(direct.map((c) => c.login));
    return all.map((c) => { const p = c.permissions || {}; return { login: c.login, rol: p.admin ? 'admin' : p.maintain ? 'maintain' : p.push ? 'write' : p.pull ? 'read' : '?', directo: directos.has(c.login) }; }).filter((c) => c.login);
  }
  // approvers: logins que PUEDEN aprobar, para asignarlos como reviewers del PR.
  // PRIORIDAD: admin/maintain DIRECTOS del repo. Solo si NO hay ninguno, cae a los owners heredados de la org.
  async function approvers() {
    const cs = await collaborators();
    const directos = cs.filter((c) => (c.rol === 'admin' || c.rol === 'maintain') && c.directo).map((c) => c.login);
    if (directos.length) return directos;
    // Sin admin directo: fallback a los admin heredados (org-owners).
    return cs.filter((c) => c.rol === 'admin' || c.rol === 'maintain').map((c) => c.login);
  }
  // equipo: imprime QUIEN ES QUIEN en la repo (login + rol), marcando quien puede aprobar.
  async function cmdEquipo() {
    if (!ghToken()) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth  (codigo de 6 digitos).'); process.exit(2); }
    const cs = await collaborators();
    if (!cs.length) { console.log('No pude leer los usuarios de la repo (¿sin permiso o repo sin remoto?).'); return; }
    console.log(`Equipo de la repo (${cs.length} usuario/s) — fuente: API GitHub (permiso efectivo real):`);
    for (const c of cs.sort((a, b) => (a.rol === 'admin' ? -1 : 1))) {
      const puede = (c.rol === 'admin' || c.rol === 'maintain') ? '  ← puede APROBAR (recibe los PRs como revisor)' : '';
      console.log(`  - ${c.login} · ${c.rol}${puede}`);
    }
    console.log(`\nLos PRs (/faro:pr) se asignan como revisores a los admin/maintain (filtrando al autor). El rol es el permiso EFECTIVO (suma acceso directo + teams + org-owner), no la config del team.`);
  }

  // cmdAsignarTarea: crea un ISSUE de GitHub para la tarea de un change y lo ASIGNA al responsable
  // (POST /issues con assignees) -> le llega EMAIL "se te ha asignado". Es como la industria reparte
  // trabajo (admin -> developer): assignee = quien la HACE (distinto del reviewer del PR = quien APRUEBA).
  // Uso CLI: harness.js asignar-tarea "<titulo>" <login-o-@usuario> [<slug-del-change>] ["<cuerpo>"]
  // Crea un ISSUE de GitHub (la TAREA) asignado al responsable -> email "se te ha asignado". Si se pasa el
  // slug del change, lo ENLAZA en el cuerpo (trazabilidad). El cierre se hace con el keyword nativo "Closes #N"
  // en el PR (GitHub cierra el issue al mergear) — NO inventamos sincronizacion propia.
  // --- LABELS de issue (tipos de tarea: requerimiento/bug/mejora...) — OBLIGATORIO: todo issue lleva 1 ---
  // Fuente de verdad: .claude/faro-schema.json > enums.labels [{slug, github, descripcion, color}].
  // MODELO HIBRIDO: se REUTILIZA el label que ya existe en el repo (primero el nativo de GitHub 'github',
  // luego 'faro:<slug>'); solo se CREA 'faro:<slug>' si no hay ninguno -> no duplica los labels por defecto.
  function labelsCatalogo() {
    try { const j = JSON.parse(fs.readFileSync((fs.existsSync(path.join(ROOT, '.claude', 'faro-schema.json')) ? path.join(ROOT, '.claude', 'faro-schema.json') : path.join(__dirname, '..', 'faro-schema.json')), 'utf8')); return (j && j.enums && Array.isArray(j.enums.labels)) ? j.enums.labels : []; }
    catch { return []; }
  }
  const labelName = (slug) => `faro:${String(slug).toLowerCase()}`;
  // Labels NATIVOS que GitHub crea por defecto en cada repo -> asumidos presentes (sin query).
  // Se leen del schema (enums.labels_github_nativos); fallback a la lista estandar si no esta.
  function githubNativos() {
    try { const j = JSON.parse(fs.readFileSync((fs.existsSync(path.join(ROOT, '.claude', 'faro-schema.json')) ? path.join(ROOT, '.claude', 'faro-schema.json') : path.join(__dirname, '..', 'faro-schema.json')), 'utf8')); if (j && j.enums && Array.isArray(j.enums.labels_github_nativos)) return new Set(j.enums.labels_github_nativos.map((s) => String(s).toLowerCase())); } catch {}
    return new Set(['bug', 'documentation', 'duplicate', 'enhancement', 'good first issue', 'help wanted', 'invalid', 'question', 'wontfix']);
  }
  let _repoLabels;   // cache de labels del repo (solo se consulta para los faro:<slug>)
  async function faroLabelsDelRepo(org, repo) {
    if (_repoLabels !== undefined) return _repoLabels;
    const set = new Set();
    for (let page = 1; page <= 5; page++) {
      const r = await ghApi(`repos/${org}/${repo}/labels?per_page=100&page=${page}`);
      if (!r.ok || !Array.isArray(r.body) || !r.body.length) break;
      for (const l of r.body) set.add(String(l.name).toLowerCase());
      if (r.body.length < 100) break;
    }
    _repoLabels = set;
    return set;
  }
  // Resuelve el label a aplicar (hibrido + barato): nativo equivalente -> DIRECTO sin query.
  // Si no hay nativo, faro:<slug> (consulta la lista 1 vez y crea si falta). Devuelve nombre o null.
  async function resolverLabel(org, repo, def) {
    if (def.github && githubNativos().has(String(def.github).toLowerCase())) return def.github;   // barato: nativo asumido presente
    const faro = labelName(def.slug);
    const existentes = await faroLabelsDelRepo(org, repo);
    if (existentes.has(faro.toLowerCase())) return faro;
    const cr = await ghApi(`repos/${org}/${repo}/labels`, { method: 'POST', body: { name: faro, color: String(def.color || 'CFD3D7').replace(/^#/, ''), description: def.descripcion || '' } });
    if (cr.ok || cr.status === 201) { existentes.add(faro.toLowerCase()); return faro; }
    return null;
  }

  // Tareas y resumen (atomicidad): issues, etiquetas de tipo y el snapshot cacheado de sesion.
  // CABLEADO COMPLETO: lo que el codigo movido USA tiene que ENTRAR aqui. labelsCatalogo/resolverLabel
  // viven en este modulo y cmdAsignarTarea los llama; olvidarlos rompia el comando entero (0.29.0).
  // fases/hitos/buscarHito/crearHito/tituloFase: para que 'asignar-tarea --hito' ancle el issue al
  // hito de su fase (creandolo si falta) reusando la MISMA logica que 'hito sync', no una paralela.
  const tareas = require('./github-tareas.js')({ ROOT, ghApi, ghRepo, git, faroSchema: ctx.faroSchema, specBase: ctx.specBase, ensureUser, cachedUser, collaborators, CRED, ghHost, ghToken, readCfg, writeCfg, labelsCatalogo, resolverLabel, fases: ctx.fases, hitos: gestion.hitos, buscarHito: gestion.buscarHito, crearHito: gestion.crearHito, tituloFase: gestion.tituloFase, planificacion: ctx.planificacion || null });


  // CLI para el agente: harness.js clave [<CLAVE>|--sugerir "<nombre>"]
  // Sin args: informa la clave actual del repo (topic clave-*) y si esta en uso en otro repo.
  // --sugerir "<nombre>": propone una clave libre a partir del nombre (no fija nada).
  // <CLAVE>: la FIJA siempre. Si ya esta en otro repo de la org, avisa (COMPARTIDA) con la
  // implicacion real —la numeracion de doc_id es por repo— pero NO bloquea: compartir clave entre
  // repos de un mismo proyecto (back/pipeline/front) es un caso legitimo.

  // ghApi/ghRepo salen tambien hacia fuera: otros modulos (el planificador, los comandos de
  // tareas) LEEN la forja con el mismo token del harness.
  const contrato = require('./github-contrato.js')({ ghApi, ghRepo, ghToken, ghHost, ensureUser });
  return { CRED, crearPr, integrarPorPeticion, prAbiertoDe, prsDeRama,issueEstado, cerrarIssue, comentarIssue, hechosTareas, ghApi, ghRepo, ...ident, ghToken, cmdGh, cmdPr, cmdRole, roleInfo, collaborators, approvers, cmdEquipo, ...tareas, cachedUser, ensureUser, ...clave, cmdProteger, ...gestion, ...contrato };
};
