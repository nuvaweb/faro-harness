// forjas/github.mjs — ADAPTADOR DE GITHUB: autenticación (device flow + cascada de tokens), validación
// del token, topics y listado de repos. Todo lo que habla con la API
// de GitHub. El token se lee/escribe en ~/.faro.json > tokens[host] (credenciales.mjs), compartido con
// el plugin. FORJA_GITHUB expone la interfaz común que consumen los flujos (misma forma que gitlab.mjs).

import { execFileSync } from 'node:child_process';
import { gh, ok, warn, say, caja, spinner, C, YES, argFlag, saveConfig, secreto, confirma } from '../core.mjs';
import { SCOPES_PEDIDOS, SCOPES_CRITICOS, SCOPES_CI, SCOPE_AYUDA } from '../model.mjs';
import { cablearHelper, retirarReescritura, noreplyDe } from '../gitcred.mjs';
import { tokenPara, guardarToken, borrarToken, entrada, cfgMigrada, tokenDeEntorno } from '../credenciales.mjs';
import { PERFILES } from '../perfil.mjs';
import fs from 'node:fs';
import path from 'node:path';

// ---------- git cableado (sistema INTELIGENTE: comprueba, no asume — decisión 2026-07-30) ----------
// Objetivo: que clonar/hacer push a repos de la org NUNCA dispare un modal de credenciales.
// Orden de preferencia: 1) SSH si YA autentica de verdad contra github.com (agente activo + clave
// registrada) — reusa cuentaSshGithub() de repo.mjs (misma prueba real que ya hace la validación
// anti-cruce de cuentas; no duplicar la lógica de conexión SSH aquí).
// 2) si no, credential helper HTTPS con el token de sesión, ACOTADO a la org (nunca global a todo
// github.com: así no se filtra a otras cuentas/orgs del usuario en la misma máquina).

// Credential helper HTTPS acotado a la org (NO global a todo github.com): resuelve el token
// leyendo el mismo archivo de config del CLI (~/.faro.json, con fallback legado ya migrado en
// core.mjs). Idempotente: se puede llamar en cada crear/adoptar sin duplicar líneas de config.
function cablearCredentialHelper(org, host = 'github.com') { cablearHelper(host, org); }

// Decide y aplica UNA vez por sesión de CLI (no repetir en cada llamada): SSH si funciona de
// verdad, si no credential helper HTTPS acotado. `sshLogin` es el resultado YA calculado de
// cuentaSshGithub() (repo.mjs) — se reusa en vez de volver a probar la conexión SSH dos veces.
// Devuelve la vía elegida (para informar al usuario o para tests).
let _gitCableadoVia = null;
function asegurarGitCableado(org, sshLogin, host = 'github.com') {
  if (_gitCableadoVia) return _gitCableadoVia;
  // El helper HTTPS se cablea SIEMPRE, tambien con SSH disponible: NO son alternativas, son canales
  // PARALELOS. El SSH mueve tu codigo (push), pero CLAUDE CODE clona los marketplaces de plugins
  // SIEMPRE por HTTPS y desde su propio directorio (~/.claude/plugins/marketplaces), donde ni tu
  // clave SSH ni el token en memoria del CLI existen. Sin este cableado, quien tiene SSH se queda
  // sin canal HTTPS y /plugin install faro@faro-marketplace falla (el marketplace puede ser privado).
  // Sigue acotado a la org (nunca global a github.com): los marketplaces publicos no necesitan
  // credencial, asi que el token no se expone fuera de la org.
  cablearCredentialHelper(org, host);
  if (sshLogin) {
    _gitCableadoVia = 'ssh';
    ok(`Git usará SSH (ya autenticado con ${host} en esta máquina) — sin más configuración.`);
    return _gitCableadoVia;
  }
  _gitCableadoVia = 'https-token';
  ok(`Git configurado para clonar/hacer push a ${org}/* sin pedir credenciales (token de sesión, acotado a la org).`);
  return _gitCableadoVia;
}

function abrirNavegador(url) {
  try {
    if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    else if (process.platform === 'darwin') execFileSync('open', [url], { stdio: 'ignore' });
    else execFileSync('xdg-open', [url], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Copia texto al portapapeles (best-effort multiplataforma; NO rompe si no hay utilidad).
function copiarPortapapeles(txt) {
  const intentos = process.platform === 'win32' ? [['clip', []]]
    : process.platform === 'darwin' ? [['pbcopy', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of intentos) { try { execFileSync(cmd, args, { input: txt, stdio: ['pipe', 'ignore', 'ignore'] }); return true; } catch {} }
  return false;
}

async function deviceFlow(clientId) {
  const form = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const post = async (url, data) => {
    const res = await fetch(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(data) });
    return res.json();
  };
  // 'workflow' es OBLIGATORIO para poder crear/actualizar .github/workflows/*.yml (CI) por push;
  // sin él, GitHub rechaza el push COMPLETO (no solo el archivo) con 'refusing to allow an OAuth
  // App to create or update workflow ... without workflow scope' (reproducido 2026-07-30, plugin
  // faro). Si el usuario YA tenía una sesión sin este scope, hay que REVOCAR y reautorizar desde
  // cero (GitHub no siempre re-pide consentimiento solo por ampliar el scope de una app existente).
  const d = await post('https://github.com/login/device/code', { client_id: clientId, scope: SCOPES_PEDIDOS.join(' ') });
  if (!d.device_code) throw new Error(`device flow: ${JSON.stringify(d)}`);
  const abierto = abrirNavegador(d.verification_uri);
  say('');
  const copiado = copiarPortapapeles(d.user_code);
  caja([
    `${C.b}Inicia sesión en GitHub${C.x} ${C.d}(una sola vez en esta máquina)${C.x}`,
    '',
    `${abierto ? 'Te he abierto el navegador en:' : 'Abre en el navegador:'}  ${C.c}${d.verification_uri}${C.x}`,
    `Teclea este código:  ${C.b}${C.g}${d.user_code}${C.x}`,
  ], { titulo: 'Login', color: C.c });
  // Código también en línea PLANA (sin color = fácil de seleccionar) + ya en el portapapeles.
  say(`  Código: ${d.user_code}${copiado ? `   ${C.g}✓ copiado al portapapeles (pégalo con Ctrl-V)${C.x}` : ''}`);
  const spin = spinner('Esperando a que autorices en el navegador');
  const intervalo = (d.interval || 5) * 1000;
  // LIMITE de espera: sin esto el bucle es infinito. GitHub caduca el device_code (expires_in, ~15
  // min) y a partir de ahi los sondeos solo devuelven 'expired_token'... salvo que la red falle y
  // el error no llegue nunca. En CI/no interactivo eso colgaba el proceso para siempre.
  const limite = Date.now() + Math.min((d.expires_in || 900), 900) * 1000;
  for (;;) {
    if (Date.now() > limite) { spin(); throw new Error('device flow: caducó el código sin autorizar (vuelve a intentarlo)'); }
    await new Promise((r) => setTimeout(r, intervalo));
    const t = await post('https://github.com/login/oauth/access_token', {
      client_id: clientId, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (t.access_token) { spin(); return t.access_token; }
    if (t.error && t.error !== 'authorization_pending' && t.error !== 'slow_down') { spin(); throw new Error(`device flow: ${t.error}`); }
  }
}

// ---------- API por host + validación del token (sin subprocesos: todo async sobre fetch) ----------
// github.com usa api.github.com; un GitHub Enterprise autoalojado expone la API en /api/v3.
const apiBase = (host) => (/(^|\.)github\.com$/i.test(host) ? 'https://api.github.com' : `https://${host}/api/v3`);

async function ghHost(token, host, ruta, init = {}, fetchImpl = fetch) {
  const res = await fetchImpl(`${apiBase(host)}${ruta}`, { ...init, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) } });
  const text = await res.text(); let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  const headers = Object.fromEntries([...res.headers].map(([k, v]) => [String(k).toLowerCase(), v]));
  return { status: res.status, ok: res.ok, body, headers };
}

// Estado REAL del token según GitHub (X-OAuth-Scopes / X-GitHub-SSO). Un token que responde 200 en
// /user puede no servir: sin 'repo' no clona privados. null = sin red (no se puede juzgar).
async function estadoToken(token, host = 'github.com', { fetchImpl = fetch } = {}) {
  if (!token) return null;
  try {
    const r = await ghHost(token, host, '/user', {}, fetchImpl);
    if (r.status !== 200) return { valido: false, scopes: [], faltan: SCOPES_PEDIDOS, ssoPendiente: false, login: null };
    const scopes = String(r.headers['x-oauth-scopes'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    // 'repo' implica todos los repo:*; el resto se comprueba literal.
    const faltan = SCOPES_PEDIDOS.filter((s) => !scopes.includes(s) && !(s.startsWith('repo') && scopes.includes('repo')));
    return { valido: true, scopes, faltan, ssoPendiente: !!r.headers['x-github-sso'], login: r.body && r.body.login };
  } catch { return null; }
}

// ¿La cuenta del token pertenece a la org? Distingue "token caducado" de "no eres miembro": son dos
// problemas DISTINTOS (uno lo arregla el usuario re-logueándose; el otro solo un admin invitándole).
// true/false, o null si no se pudo comprobar (sin red, sin token) -> el caller no afirma nada.
async function miembroDe(token, org, host = 'github.com', { fetchImpl = fetch } = {}) {
  if (!token) return null;
  try {
    const r = await ghHost(token, host, `/user/memberships/orgs/${org}`, {}, fetchImpl);
    if (r.status === 200) return true;
    if (r.status === 403 || r.status === 404) return false;   // 404 = no eres miembro (GitHub oculta la membresía)
    return null;
  } catch { return null; }
}

// 'workflow' es CRÍTICO solo si el repo tiene CI: sin él, GitHub rechaza el push COMPLETO en un repo
// con .github/workflows/, pero en un repo sin CI no estorba.
function criticosPara(destino) {
  let conCI = false;
  try { conCI = !!destino && fs.existsSync(path.join(destino, '.github', 'workflows')); } catch {}
  return conCI ? [...SCOPES_CRITICOS, ...SCOPES_CI] : SCOPES_CRITICOS;
}

// Valida el TOKEN de sesión en TODOS los flujos antes de trabajar: un token sin 'repo' o con SSO sin
// autorizar pasa las comprobaciones de API pero NO puede clonar el repo privado del plugin, y el fallo
// aparece mucho después, dentro de Claude Code, sin pista. Cachea el resultado 24 h en la entrada del
// host (scopes_cache) para no llamar a la API en cada flujo. `ok:false` = hay que re-loguearse.
async function validarTokenSesion(cfg, perfil = PERFILES.github, { silencioSiOk = true, destino = null, fetchImpl = fetch, ui = null, gh: ghTok = undefined, guardar = saveConfig } = {}) {
  const U = ui || { say, ok, caja };
  const tok = tokenPara(perfil.host, cfg, ghTok ? { gh: ghTok } : {});
  if (!tok) return { ok: false, faltan: SCOPES_PEDIDOS, ssoPendiente: false };
  const huella = String(tok).slice(-8);
  const en = entrada(perfil.host, cfg) || {};
  const cache = en.scopes_cache || cfg.token_scopes;   // token_scopes: forma antigua, como fallback
  const fresca = cache && cache.huella === huella && cache.ts && (Date.now() - cache.ts) < 24 * 3600 * 1000;
  const est = fresca ? cache : await estadoToken(tok, perfil.host, { fetchImpl });
  if (!est) return { ok: true, faltan: [], ssoPendiente: false, sinRed: true };   // sin red: no bloquear el flujo
  if (!fresca) {
    try {
      const sc = { huella, ts: Date.now(), valido: est.valido, scopes: est.scopes, faltan: est.faltan, ssoPendiente: est.ssoPendiente };
      cfgMigrada(cfg);
      cfg.tokens[perfil.host] = { ...(cfg.tokens[perfil.host] || {}), scopes_cache: sc };
      cfg.token_scopes = sc;
      guardar(cfg);
    } catch {}
  }
  const faltan = est.faltan || [];
  const CRIT = criticosPara(destino);
  const criticos = faltan.filter((s) => CRIT.includes(s));
  const opcionales = faltan.filter((s) => !CRIT.includes(s));
  if (est.valido && !criticos.length && !est.ssoPendiente) {
    if (!silencioSiOk) U.ok(`Token de sesión: permisos correctos (${CRIT.join(', ')}).`);
    if (opcionales.length) {
      U.say(`  ${C.d}Al token le falta '${opcionales.join(', ')}' → ${opcionales.map((s) => SCOPE_AYUDA[s] || s).join(' · ')}.${C.x}`);
      U.say(`  ${C.d}Para añadirlo: ${C.c}faro --login --reautorizar${C.x}${C.d} (revoca y vuelve a pedir permisos).${C.x}`);
    }
    return { ok: true, faltan, ssoPendiente: false };
  }
  const lineas = [];
  if (!est.valido) lineas.push(`El token guardado ya ${C.b}no es válido${C.x} (caducado o revocado).`);
  for (const s of criticos) lineas.push(`Falta ${C.c}${s}${C.x} → ${SCOPE_AYUDA[s] || 'permiso necesario'}.`);
  if (est.ssoPendiente) lineas.push(`Tiene ${C.b}SSO sin autorizar${C.x}: autorízalo para la organización donde vayas a trabajar.`);
  lineas.push('');
  lineas.push(`Arréglalo con:  ${C.c}faro --login --reautorizar${C.x}`);
  lineas.push(`${C.d}(revoca la autorización y la vuelve a pedir: repetir el login a secas NO amplía permisos${C.x}`);
  lineas.push(`${C.d} si la app ya estaba autorizada con menos — GitHub no vuelve a preguntar.)${C.x}`);
  U.caja(lineas, { titulo: 'Sesión de GitHub incompleta', color: C.c });
  return { ok: false, faltan, ssoPendiente: !!est.ssoPendiente };
}

// Cascada de autenticación. Devuelve también id/name/email (Item 9: identidad git).
// `tokenInicial` ({token, via}): sesión ya encontrada por sesion.mjs; va primero y evita repetir la búsqueda.
async function obtenerToken(cfg, perfil = PERFILES.github, { reautorizar = false, tokenInicial = null } = {}) {
  // El client_id global (entorno o ~/.faro.json) es el de github.com: un GitHub Enterprise usa el de su perfil.
  const publico = String(perfil.host).toLowerCase() === 'github.com';
  const clientIdCfg = (publico && (process.env.FARO_CLIENT_ID || cfg.client_id)) || perfil.client_id;
  const candidatos = [];
  if (tokenInicial) candidatos.push([tokenInicial.via, tokenInicial.token]);
  else {
    const envTok = tokenDeEntorno(perfil.host);
    if (envTok) candidatos.push(['variable de entorno (FARO_GITHUB_TOKEN / GITHUB_TOKEN)', envTok]);
    // Sesión guardada: tokens[host] (forma compartida con el plugin); el plano antiguo solo como fallback.
    const guardada = entrada(perfil.host, cfg);
    if (guardada && guardada.token) candidatos.push(['sesión guardada (~/.faro.json)', guardada.token]);
    else if (publico && cfg.token) candidatos.push(['sesión guardada (~/.faro.json, formato antiguo)', cfg.token]);
    // El token de la CLI gh es el de github.com: no viaja a ningún otro servidor.
    if (publico) try {
      const t = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).trim();
      if (t) candidatos.push(['GitHub CLI (gh auth token)', t]);
    } catch {}
  }
  // desde(): construye la identidad Y la PERSISTE en ~/.faro.json (fuente de verdad UNICA que
  // el harness reutiliza sin re-llamar a la API). Guarda token + user{login,name,email} SIEMPRE, venga
  // de donde venga el token (env/gh/sesion/device). Asi el email de commit sale siempre de aqui.
  // GET /user devuelve email:null cuando el usuario tiene el correo en privado — que es el caso
  // habitual en cuentas de empresa. Antes se caia directo al noreply, y ese alias NO RECIBE correo:
  // sirve para ATRIBUIR commits, no para contactar. El correo real esta en /user/emails (scope
  // 'user:email', que ya pedimos). Se guardan los DOS, separados, porque son cosas distintas:
  //   email        -> el que firma los commits (noreply si es privado: atribuye sin exponer el real)
  //   email_contacto -> el verificado de verdad, para notificar (informes, avisos del equipo)
  const desde = async (tok, me, via, scopes = null) => {
    let contacto = me.email || null;                       // publico en el perfil: ya vale
    if (!contacto) {
      const r = await gh(tok, '/user/emails');             // requiere 'user:email'; si falta, 403 -> se ignora
      if (r.ok && Array.isArray(r.body)) {
        const p = r.body.find((e) => e.primary && e.verified) || r.body.find((e) => e.verified);
        contacto = (p && p.email) || null;
      }
    }
    const email = me.email || noreplyDe(me, perfil);       // firma de commits (privado -> noreply)
    try {
      // tokens[host] es lo que lee el plugin (y el helper de git); el plano queda espejado por guardarToken.
      guardarToken(perfil.host, { token: tok, forja: 'github', user: { login: me.login, id: me.id, name: me.name || null, email }, ...(scopes ? { scopes } : {}) }, cfg);
      cfg.user = {
        login: me.login, id: me.id, name: me.name || null, email,
        email_contacto: contacto, company: me.company || null,
        avatar: me.avatar_url || null, perfil: me.html_url || null,
        actualizado: new Date().toISOString(),
      };
      saveConfig(cfg);
    } catch {}
    return { token: tok, login: me.login, id: me.id, name: me.name, email, email_contacto: contacto, via };
  };
  // --reautorizar: AMPLIAR permisos de una sesion existente. Repetir el login a secas NO sirve —
  // GitHub no vuelve a pedir consentimiento a una OAuth App ya autorizada, asi que reemite el token
  // con los permisos VIEJOS. Hay que REVOCAR primero, y eso solo puede hacerlo el usuario en su
  // cuenta (no hay API para revocar la propia autorizacion). Se le lleva a la pagina exacta.
  if (reautorizar || argFlag('reautorizar') || argFlag('reauth')) {
    const url = `https://github.com/settings/connections/applications/${clientIdCfg}`;
    caja([
      `${C.b}Ampliar los permisos de tu sesión de GitHub${C.x}`,
      `Permisos que pide el CLI: ${C.c}${SCOPES_PEDIDOS.join(', ')}${C.x}`,
      '',
      `GitHub no vuelve a preguntar si la app ya estaba autorizada con menos permisos, así que hay`,
      `que revocarla primero (es tu cuenta: solo puedes hacerlo tú):`,
      `  1) Te abro  ${C.c}${url}${C.x}`,
      `  2) Abajo del todo: ${C.b}Revoke access${C.x}`,
      `  3) Vuelve aquí y confirma — te pediré el login otra vez`,
    ], { titulo: 'Reautorizar', color: C.c });
    abrirNavegador(url);
    if (!YES) await confirma('¿Ya has revocado el acceso? Continúo con el login', 's');
    borrarToken(perfil.host, cfg);                              // fuerza device flow limpio
    try { retirarReescritura(perfil.plugin.url); } catch {}      // la reescritura del marketplace llevaba el token que se va a revocar
    try { saveConfig(cfg); } catch {}
    const tokR = await deviceFlow(clientIdCfg);
    const meR = await gh(tokR, '/user');
    if (!meR.ok) throw new Error('el token del device flow no valida');
    const scR = String(meR.headers['x-oauth-scopes'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const faltanR = scR.length ? SCOPES_PEDIDOS.filter((s) => !scR.includes(s)) : [];
    guardarToken(perfil.host, { token: tokR, scopes: scR, forja: 'github' }, cfg); saveConfig(cfg);
    if (faltanR.length) warn(`La sesión nueva SIGUE sin: ${faltanR.join(', ')}. ¿Seguro que revocaste el acceso en el paso 2? Repite ${C.c}faro --login --reautorizar${C.x}.`);
    else ok(`Sesión reautorizada: @${meR.body.login} con todos los permisos (${SCOPES_PEDIDOS.join(', ')}).`);
    return await desde(tokR, meR.body, 'login FARO (reautorizado)', scR);
  }
  // Un token VALIDO puede no servir: sin 'repo' no clona ni empuja repos privados, y el fallo
  // aparece MUCHO despues sin pista de la causa. GitHub declara los permisos reales en la cabecera
  // X-OAuth-Scopes: se comprueban AQUI y, si faltan criticos, el candidato se DESCARTA y la cascada
  // sigue -> acaba en el device flow, que los pide de nuevo.
  const CRITICOS = SCOPES_CRITICOS;   // fuente unica en model.mjs (no re-declarar la lista aqui)
  let degradado = null;   // 1er token valido pero corto de scopes: respaldo si no hay nada mejor
  for (const [via, tok] of candidatos) {
    const me = await gh(tok, '/user');
    if (!me.ok) continue;
    const scopes = String((me.headers && (me.headers['x-oauth-scopes'] || me.headers.get?.('x-oauth-scopes'))) || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    // Sin cabecera (p.ej. token fine-grained, que no la expone) no se puede juzgar: se acepta.
    const faltan = scopes.length ? CRITICOS.filter((s) => !scopes.includes(s)) : [];
    if (!faltan.length) {
      if (!tokenInicial) ok(`Sesión GitHub válida vía ${via}: @${me.body.login}`);
      return await desde(tok, me.body, via, scopes.length ? scopes : null);
    }
    warn(`Ignoro la sesión de ${via} (@${me.body.login}): le faltan permisos ${faltan.join(', ')} — no podría clonar repositorios privados.`);
    if (!degradado) degradado = { tok, me, via, faltan };
  }
  // Se llega aqui sin token utilizable. Si habia uno VALIDO pero corto de scopes, se explica por que
  // hay que repetir el login: el usuario acaba de ver "sesion guardada" y merece saber que no basta.
  // SIN TTY (CI, pipe, hook) el device flow es IMPOSIBLE: nadie puede teclear el codigo en el
  // navegador. Forzarlo colgaria el proceso hasta el timeout. Ahi se sigue con el token corto y se
  // avisa: sirve para todo menos para los privados, y el fallo (si llega) sera explicito.
  if (degradado && !process.stdin.isTTY) {
    warn(`Sesión con permisos limitados (falta ${degradado.faltan.join(', ')}) y no hay terminal interactiva para renovarla — continúo; fallará con repositorios privados.`);
    return await desde(degradado.tok, degradado.me.body, degradado.via + ' · permisos limitados');
  }
  if (degradado) {
    caja([
      `Tu sesión de GitHub (@${degradado.me.body.login}) ${C.b}no tiene los permisos necesarios${C.x}: falta ${C.c}${degradado.faltan.join(', ')}${C.x}.`,
      `Sin ellos no se pueden clonar ni empujar repositorios privados.`,
      `Vamos a reconectar para pedirlos — es el mismo login de siempre.`,
    ], { titulo: 'Hay que ampliar los permisos', color: C.c });
  }
  const clientId = clientIdCfg;
  if (clientId) {
    let tok = null;
    try { tok = await deviceFlow(clientId); } catch (e) {
      // Si el re-login falla (sin red, el usuario cancela) y teniamos un token corto, es mejor
      // seguir con el que hay que abortar: sirve para casi todo menos para los repos privados.
      if (degradado) { warn('No pude ampliar los permisos — sigo con la sesión actual (limitada: fallará con repositorios privados).'); return await desde(degradado.tok, degradado.me.body, degradado.via + ' · permisos limitados'); }
      throw e;
    }
    const me = await gh(tok, '/user');
    if (!me.ok) throw new Error('el token del device flow no valida');
    // El token RECIEN emitido puede seguir corto: GitHub no siempre re-pide consentimiento al
    // ampliar scopes de una OAuth App ya autorizada (reproducido con 'workflow', ver arriba) —
    // devuelve los permisos VIEJOS sin avisar. Si pasa, re-loguear no sirve: hay que revocar.
    // Se comprueban los CUATRO scopes pedidos, no solo los criticos: 'workflow' es el que mas veces
    // se queda corto (es el ultimo que se anadio) y su ausencia rompe el push COMPLETO en cuanto el
    // repo tiene .github/workflows/ — no es un extra.
    const scNuevo = String(me.headers['x-oauth-scopes'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cortos = scNuevo.length ? SCOPES_PEDIDOS.filter((s) => !scNuevo.includes(s)) : [];
    if (cortos.length) {
      caja([
        `GitHub emitió la sesión ${C.b}sin los permisos pedidos${C.x} (falta ${C.c}${cortos.join(', ')}${C.x}).`,
        `Pasa cuando la app ya estaba autorizada con permisos menores: ${C.b}no vuelve a pedir consentimiento${C.x},`,
        `así que repetir el login NO lo arregla — hay que revocar la autorización y volver a entrar:`,
        ``,
        `  1) Abre  ${C.c}https://github.com/settings/connections/applications/${clientId}${C.x}`,
        `  2) Abajo del todo: ${C.b}Revoke access${C.x}`,
        `  3) Vuelve a ejecutar  ${C.c}faro --login${C.x}  y acepta los permisos`,
        ``,
        cortos.includes('workflow')
          ? `${C.d}Sin 'workflow', GitHub rechaza el push ENTERO (no solo el fichero) en repos con .github/workflows/.${C.x}`
          : `${C.d}Sin 'user:email' el commit se atribuye con tu noreply de GitHub (funciona, pero no lleva tu correo real).${C.x}`,
      ], { titulo: 'Permisos no concedidos', color: C.c });
      try { abrirNavegador(`https://github.com/settings/connections/applications/${clientId}`); } catch {}
    }
    guardarToken(perfil.host, { token: tok, scopes: scNuevo, forja: 'github' }, cfg); saveConfig(cfg);
    ok(`Sesión iniciada: @${me.body.login} (guardada para próximas veces)`);
    return await desde(tok, me.body, 'login FARO (device flow)', scNuevo);
  }
  say('');
  warn('Login por navegador no disponible todavía (falta configurar la OAuth App de la organización).');
  say(`${C.d}  Crea un token en https://github.com/settings/tokens (classic, scopes: repo + read:org + workflow + user:email) y pégalo.${C.x}`);
  const tok = await secreto('Token de GitHub (ghp_...)');
  const me = await gh(tok, '/user');
  if (!me.ok) throw new Error('el token pegado no es válido');
  guardarToken(perfil.host, { token: tok, forja: 'github' }, cfg); saveConfig(cfg);
  ok(`Sesión iniciada: @${me.body.login} (guardada para próximas veces)`);
  return await desde(tok, me.body, 'token pegado a mano');
}

// Config higiénica del repo (best-effort; GRATIS en plan Free para repos privados). No bloquea si falla.
async function aplicarConfigRepo(auth, org, repo, { descripcion } = {}) {
  const body = {
    delete_branch_on_merge: true,   // limpia la rama de feature tras el merge (encaja con develop/feature)
    has_wiki: false,
    has_projects: false,
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
  };
  if (descripcion) body.description = descripcion;
  const r = await gh(auth.token, `/repos/${org}/${repo}`, { method: 'PATCH', body: JSON.stringify(body) });
  if (r.ok) ok('Config del repo aplicada (borra rama al mergear · sin wiki/projects · squash-merge).');
  else warn('No pude aplicar toda la config del repo (no bloquea).');
}

// ¿El nombre de plan permite branch protection en repos PRIVADOS? Free = NO (GitHub exige Pro/Team/
// Enterprise, o repo público). Puro y testeable. Desconocido/undefined -> se trata como NO de pago.
const esPlanDePago = (planName) => ['team', 'enterprise', 'pro', 'business'].includes(String(planName || '').toLowerCase());

// Lee el plan de la org (GET /orgs/{org}). Devuelve el nombre del plan o null si no se puede leer.
async function planDeOrg(auth, org) {
  const r = await gh(auth.token, `/orgs/${org}`);
  return (r.ok && r.body && r.body.plan && r.body.plan.name) || null;
}

// Protege una rama SOLO si el plan de la org es de pago (en Free la API da 403 en privados: no lo
// intentamos para no ensuciar con errores; se auto-activará cuando la org pase a Team). Best-effort.
async function protegerRama(auth, org, repo, rama, plan) {
  if (!esPlanDePago(plan)) {
    warn(`Protección de '${rama}' en servidor: no disponible en plan Free (privado). El harness la protege en local; se aplicará sola al pasar a GitHub Team.`);
    return false;
  }
  const r = await gh(auth.token, `/repos/${org}/${repo}/branches/${rama}/protection`, {
    method: 'PUT',
    body: JSON.stringify({ required_pull_request_reviews: { required_approving_review_count: 1 }, enforce_admins: false, required_status_checks: null, restrictions: null }),
  });
  if (r.ok) { ok(`Rama '${rama}' protegida en servidor (solo por PR/merge).`); return true; }
  warn(`No pude proteger '${rama}' en servidor (no bloquea).`);
  return false;
}

// Estampa topics en el repo (clasificación machine-readable).
async function estamparTopics(auth, org, repo, topics) {
  const names = [...new Set(topics.filter(Boolean))];
  const r = await gh(auth.token, `/repos/${org}/${repo}/topics`, { method: 'PUT', body: JSON.stringify({ names }) });
  if (r.ok) ok(`Topics aplicados: ${names.join(' · ')}`);
  else warn('No pude aplicar los topics (no bloquea; puedes ponerlos en GitHub → About).');
}

// Team(s) a los que pertenece un repo (feedback: 'de qué equipo es'). Global, sin filtrar por el usuario.
async function teamsDeRepo(auth, org, repo, { slugs = false } = {}) {
  const r = await gh(auth.token, `/repos/${org}/${repo}/teams?per_page=100`);
  if (!r.ok || !Array.isArray(r.body)) return [];
  return r.body.map((t) => (slugs ? t.slug : (t.name || t.slug)));
}

// Item 11: listado escalable de repos de TRABAJO FARO. El marcador REAL es el topic `faro`
// (lo estampan crear/adoptar), NO el nombre: así se excluye la tooling (faro-cli), los templates
// y el catálogo aunque su nombre empiece por 'faro-'.
// org null = todo lo que la cuenta ve (propio, compartido y de sus organizaciones).
async function listarReposFaro(auth, org, { soloFaro = true, fetchImpl = null, host = 'github.com' } = {}) {
  let repos = [];
  for (let page = 1; page <= 10; page++) {
    const ruta = `${org ? `/orgs/${org}/repos` : '/user/repos'}?per_page=100&sort=pushed&type=all&page=${page}`;
    const r = fetchImpl ? await ghHost(auth.token, host, ruta, {}, fetchImpl) : await gh(auth.token, ruta);
    if (!r.ok || !Array.isArray(r.body) || r.body.length === 0) break;
    repos.push(...r.body);
    if (r.body.length < 100) break;
  }
  // Repo de TRABAJO = marcado con el topic `faro`. La tooling y las plantillas no lo llevan: quedan
  // fuera sin lista negra por nombre. La API ya devuelve solo lo accesible; `is_template` es la red de seguridad.
  // soloFaro:false = TODOS los repos del destino (lo usa crear para detectar parecidos y sugerir libres).
  return repos.filter((x) => !x.is_template && (!soloFaro || (x.topics || []).includes('faro')));
}

// Interfaz común de forja (misma forma que forjas/gitlab.mjs): los flujos hablan con esto.
// Firma de la interfaz comun: login(perfil, cfg, opts). obtenerToken conserva su firma historica (cfg, perfil).
const login = (perfil, cfg, opts = {}) => obtenerToken(cfg, perfil, opts);

// Alta de un repo: misma firma en las dos forjas. s = {host, token}; destino = {org, personal}; ruta =
// 'org/nombre'. Devuelve datos y no escribe en pantalla: los mensajes son del flujo. Sin red no lanza.
const pedir = async (s, ruta, init, { fetchImpl = fetch } = {}) => {
  try { return await ghHost(s.token, s.host, ruta, init, fetchImpl); } catch { return { ok: false, status: 0, body: null, headers: {} }; }
};
const conCuerpo = (metodo, cuerpo) => ({ method: metodo, body: JSON.stringify(cuerpo) });
// Repos del DESTINO, no todo lo que la cuenta ve: en una cuenta personal /user/repos trae también lo
// ajeno, y por eso se filtra por dueño.
async function reposDelDestino(s, { org, personal }, { soloFaro = false, fetchImpl = fetch } = {}) {
  const repos = await listarReposFaro({ token: s.token }, personal ? null : org, { soloFaro, fetchImpl, host: s.host });
  return repos.filter((r) => !personal || (r.owner && r.owner.login === org));
}
const alta = {
  async existe(s, ruta, o) {
    const r = await pedir(s, `/repos/${ruta}`, {}, o);
    if (r.ok) return true;
    return r.status === 404 ? false : null;
  },
  async nombres(s, destino, { fetchImpl = fetch } = {}) {
    return (await reposDelDestino(s, destino, { fetchImpl }).catch(() => [])).map((r) => r.name);
  },
  // Lo que la forja devuelve a la cuenta, incluidos los repos compartidos sin estar en la organización.
  async accesibles(s, { fetchImpl = fetch } = {}) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const r = await pedir(s, `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`, {}, { fetchImpl });
      if (!r.ok || !Array.isArray(r.body) || !r.body.length) break;
      out.push(...r.body);
      if (r.body.length < 100) break;
    }
    return out.filter((r) => !r.is_template).map((r) => ({ ruta: r.full_name, nombre: r.name, topics: r.topics || [], pushed_at: r.pushed_at }));
  },
  async crearRepo(s, { org, personal }, { nombre, descripcion }, o) {
    const r = await pedir(s, personal ? '/user/repos' : `/orgs/${org}/repos`, conCuerpo('POST', { name: nombre, private: true, description: descripcion, auto_init: false }), o);
    if (!r.ok) return { ok: false, status: r.status, ruta: null, web: null, mensaje: (r.body && r.body.message) || 'sin respuesta de la forja' };
    return { ok: true, status: r.status, ruta: r.body.full_name, web: r.body.html_url, mensaje: null };
  },
  // Higiene del repo; lo único que sale de aquí es si se aplicó.
  configurar: (s, ruta, { descripcion } = {}, o) => pedir(s, `/repos/${ruta}`, conCuerpo('PATCH', {
    delete_branch_on_merge: true, has_wiki: false, has_projects: false, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false,
    ...(descripcion ? { description: descripcion } : {}),
  }), o),
  ramaPorDefecto: (s, ruta, rama, o) => pedir(s, `/repos/${ruta}`, conCuerpo('PATCH', { default_branch: rama }), o),
  estamparTopics: (s, ruta, topics, o) => pedir(s, `/repos/${ruta}/topics`, conCuerpo('PUT', { names: [...new Set(topics.filter(Boolean))] }), o),
  // Sin plan de pago GitHub responde 403 en privados: el flujo lo cuenta y el harness protege en local.
  proteger: (s, ruta, rama, o) => pedir(s, `/repos/${ruta}/branches/${rama}/protection`, conCuerpo('PUT', {
    required_pull_request_reviews: { required_approving_review_count: 1 }, enforce_admins: false, required_status_checks: null, restrictions: null,
  }), o),
};

const FORJA_GITHUB = { id: 'github', apiBase, login, validarTokenSesion, miembroDe, estadoToken, repos: listarReposFaro, protegerRama, estamparTopics, alta, usuarioHttp: 'x-access-token' };

export {
  apiBase, ghHost, estadoToken, miembroDe, criticosPara, validarTokenSesion, login, FORJA_GITHUB, abrirNavegador, copiarPortapapeles,
  obtenerToken, estamparTopics, aplicarConfigRepo,
  esPlanDePago, planDeOrg, protegerRama,
  teamsDeRepo,
  listarReposFaro, reposDelDestino,
  asegurarGitCableado, cablearCredentialHelper,
};
