// lib/github-identidad.js — IDENTIDAD del usuario y CONEXION en GitHub. Extraido de github.js por
// atomicidad (~400 lineas por modulo).
//
// Identidad: quien eres para git (nombre y correo) y para la forja (cuenta), y que ambas cuadren —
// si no, tu trabajo NO se te atribuye. Conexion: login por codigo de 6 digitos (device flow), que
// guarda el token por HOST en el almacen del harness. Soporta GitHub Enterprise autoalojado: la API y
// el login salen del host REAL del remoto, y ese host necesita su PROPIA aplicacion OAuth.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// client_id de la OAuth App de FARO para github.com (device flow; NO es secreto). Mientras sea null,
// `auth` pide `git config --global faro.githubClientId <id>` o la variable FARO_CLIENT_ID.
const CLIENT_ID_GITHUB = null;

module.exports = function (g) {
  const { ghApi, ghRepo, git, ROOT, IS_TEMPLATE, CRED, ghHost, ghApiBase, ghWebBase, readCfg, writeCfg, cachedUser } = g;

  // Identidad cacheada POR PROCESO: resolverla toca git y, a veces, la red. Se calcula una vez.
  let _authId;
  function authIdentity() {
    if (_authId !== undefined) return _authId;
    _authId = { login: null, email: null, source: null };
    const run = (cmd, args, ms) => { try { return execFileSync(cmd, args, { windowsHide: true, cwd: ROOT, encoding: 'utf8', timeout: ms || 6000, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); } catch (e) { return String((e && (e.stdout || e.stderr)) || ''); } };
    const remote = git('remote', 'get-url', 'origin') || '';
    const host = (remote.match(/@([^:/]+)/) || [])[1] || (remote.match(/\/\/([^/]+)\//) || [])[1] || null;
    // EL ALMACEN MANDA: el CLI ya guardo QUIEN eres en cada forja al autenticarte (tokens[host].user).
    // Sin esto se sondeaba la RED en cada arranque de sesion — gh api (6s), ssh -T (8s) y curl de
    // eventos (8s) — y con gh sin instalar el arranque costaba ~12s medidos. La respuesta ya la
    // teniamos en disco. Las sondas siguen abajo como respaldo para quien no se haya autenticado.
    const guardado = (host && CRED && typeof CRED.entrada === 'function') ? CRED.entrada(host) : null;
    if (guardado && guardado.user && guardado.user.login) {
      const em = guardado.user.email ? String(guardado.user.email).toLowerCase() : null;
      _authId = { login: String(guardado.user.login), email: em, source: 'almacen' };
      return _authId;
    }
    if (/github/.test(remote)) {
      const login = String(run('gh', ['api', 'user', '--jq', '.login'], 6000)).trim();
      if (login && !/\s/.test(login) && login[0] !== '{' && !/not found|error/i.test(login)) {
        const email = String(run('gh', ['api', 'user', '--jq', '.email'], 6000)).trim();
        _authId = { login, email: (email && email !== 'null') ? email.toLowerCase() : null, source: 'gh' };
        return _authId;
      }
    }
    if (host && !_authId.login) {
      const sshRaw = (git('config', 'core.sshCommand') || process.env.GIT_SSH || 'ssh').trim();
      const sshExe = /^".*"$/.test(sshRaw) ? sshRaw.replace(/^"|"$/g, '') : (/\s/.test(sshRaw) ? sshRaw.split(/\s+/)[0] : sshRaw);
      const out = run(sshExe, ['-T', '-o', 'StrictHostKeyChecking=accept-new', `git@${host}`], 8000);
      const m = out.match(/\bHi\s+([A-Za-z0-9-]+)!/) || out.match(/Welcome to GitLab,\s*@([A-Za-z0-9._-]+)!/);
      if (m) _authId = { login: m[1], email: null, source: 'ssh' };
    }
    if (_authId.login && !_authId.email && /github/.test(remote)) {
      try {
        const events = JSON.parse(run('curl', ['-s', '--max-time', '6', `${ghApiBase()}users/${_authId.login}/events/public`], 8000));
        const emails = [];
        for (const ev of Array.isArray(events) ? events : []) {
          const commits = ev && ev.payload && ev.payload.commits;
          if (Array.isArray(commits)) for (const cm of commits) { const em = cm && cm.author && cm.author.email; if (em) emails.push(String(em).toLowerCase()); }
        }
        const real = emails.find((e) => !/@users\.noreply\.github\.com$/.test(e)) || emails[0];
        if (real) { _authId.email = real; _authId.source = _authId.source === 'gh' ? 'gh' : 'ssh+events'; }
      } catch {}
    }
    return _authId;
  }

  // FUERZA el email de commit a la cuenta correcta (org). El commit se atribuye por user.email, NO por
  // el SSH: si el git config LOCAL de este repo tiene un email de OTRA cuenta, GitHub lo atribuye mal.
  // Fuente de verdad: ~/.faro.json (user.email, lo escribe el CLI/auth) > email de la cuenta
  // autenticada (gh/ssh) > noreply de esa cuenta. Corrige SOLO el config LOCAL del repo (no el global).
  // Idempotente y barato: si ya coincide, no toca nada. Devuelve el email fijado o null.
  function asegurarEmailCommit() {
    if (IS_TEMPLATE) return null;
    const u = cachedUser();
    let objetivo = (u && u.email) ? String(u.email).toLowerCase() : null;
    if (!objetivo) {
      const auth = authIdentity();
      if (auth && auth.email) objetivo = String(auth.email).toLowerCase();
      else if (auth && auth.login) objetivo = `${auth.login}@users.noreply.github.com`.toLowerCase();   // sin id: noreply por login (mejor que un email de otra cuenta)
    }
    if (!objetivo) return null;   // sin señal de cuenta: no forzamos nada
    const actual = (git('config', 'user.email') || '').trim().toLowerCase() || null;
    if (actual === objetivo) return objetivo;   // ya correcto
    git('config', 'user.email', objetivo);       // corrige el LOCAL del repo (gana sobre el global de otra cuenta)
    if (u && u.name) { const n = (git('config', 'user.name') || '').trim(); if (!n) git('config', 'user.name', u.name); }
    return objetivo;
  }

  function identityCheck() {
    const gitEmail = (git('config', 'user.email') || '').trim().toLowerCase() || null;
    const gitName = (git('config', 'user.name') || '').trim() || null;
    const auth = authIdentity();
    const domain = ((git('config', 'faro.identityDomain') || '').trim().toLowerCase().replace(/^@/, '')) || null;
    let verified = null, why = '';
    if (!gitEmail) { verified = false; why = "git config user.email VACIO — fija tu correo: node .claude/hooks/harness.js identity --set <correo>"; }
    else if (auth.email) { verified = gitEmail === auth.email; if (!verified) why = `el correo git '${gitEmail}' NO es el de la cuenta autenticada '${auth.email}' (${auth.source})`; }
    else if (auth.login) {
      const confirmed = ((git('config', 'faro.identityLogin') || '').trim().toLowerCase()) || null;
      if (confirmed) {
        verified = auth.login.toLowerCase() === confirmed;
        if (!verified) why = `la cuenta SSH autenticada ahora es '${auth.login}' pero confirmaste este repo como '${confirmed}' — clave/cuenta distinta; reconfirma: node .claude/hooks/harness.js identity --set <correo>`;
      } else { verified = null; why = `autenticado como '${auth.login}' (${auth.source}); CONFIRMA que '${gitEmail}' es tu correo y fijalo: node .claude/hooks/harness.js identity --set ${gitEmail}`; }
    }
    else if (domain) { verified = gitEmail.endsWith('@' + domain); if (!verified) why = `el correo git '${gitEmail}' no es del dominio @${domain}`; }
    else { verified = null; why = 'no verificable (sin gh/ssh y sin faro.identityDomain)'; }
    return { verified, why, gitEmail, gitName, auth, domain };
  }

  function identityWarnCheap() {
    const email = (git('config', 'user.email') || '').trim().toLowerCase();
    const domain = ((git('config', 'faro.identityDomain') || '').trim().toLowerCase().replace(/^@/, '')) || null;
    if (!email) return "IDENTIDAD: conectar con GitHub mejora el harness — asi apareces bien (tu nombre y tu equipo) en informes y metricas, y se pueden validar PRs. OFRECELO al usuario en lenguaje LLANO y amable (puede NO ser tecnico; sin jerga): p.ej. 'para que salgas bien en informes, ¿te conecto a GitHub? te doy un codigo y lo pegas en el navegador, un momento'. Si acepta -> ejecuta: node .claude/hooks/harness.js auth. (Alternativa para tecnicos: identity --set <correo>.)";
    if (domain && !email.endsWith('@' + domain)) return `IDENTIDAD: el correo git '${email}' no es del dominio corporativo @${domain}. Confirma con el usuario (AskUserQuestion: 'este es el correo detectado ${email}, sera el que se registre en los commits, es correcto?'); si no, node .claude/hooks/harness.js identity --set <correo>. Verifica la cuenta autenticada real: node .claude/hooks/harness.js identity.`;
    return null;
  }
  // Detecta CUENTA CRUZADA de forma barata: si este repo ya tiene un login CONFIRMADO
  // (faro.identityLogin) y la cuenta autenticada AHORA (gh/ssh) es OTRA distinta -> BLOQUEO.
  // Es el mismo criterio que cmdAuth (token vs ssh), pero aplicado en CADA sesion, no solo al hacer 'auth'.
  function identityBlockLine() {
    if (IS_TEMPLATE) return null;
    const confirmado = ((git('config', 'faro.identityLogin') || '').trim().toLowerCase()) || null;
    if (!confirmado) return null;   // repo aun sin confirmar identidad: lo cubre identityWarnCheap
    const auth = authIdentity();    // cacheado en la sesion (gh api user / ssh -T)
    if (!auth || !auth.login) return null;   // sin senal de cuenta (offline / sin gh ni ssh): no se puede afirmar cruce
    if (auth.login.toLowerCase() === confirmado) return null;   // coincide: todo OK
    return `⛔ CUENTA CRUZADA (BLOQUEO): este repo se confirmo como @${confirmado} pero la cuenta autenticada AHORA es @${auth.login} (via ${auth.source}) — clave/token de OTRA cuenta. Los commits saldrian con el usuario equivocado. NO trabajes hasta reconectar con la cuenta correcta: node .claude/hooks/harness.js auth (o carga la clave SSH de @${confirmado}). Si de verdad cambias de cuenta a proposito, reconfirmalo: node .claude/hooks/harness.js identity --set <correo>.`;
  }
  function identityLines() {
    if (IS_TEMPLATE) return [];
    const block = identityBlockLine();
    if (block) return [block];   // el bloqueo manda sobre el aviso suave (cuenta CRUZADA: no autocorregir)
    asegurarEmailCommit();       // sin cuenta cruzada: FUERZA el email de commit a la cuenta correcta (org)
    const w = identityWarnCheap();
    return w ? [w] : [];
  }

  function cmdIdentity() {
    const argv = process.argv.slice(3);
    const setIdx = argv.indexOf('--set');
    if (setIdx >= 0) {
      const email = argv[setIdx + 1];
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { process.stdout.write('Uso: identity --set <correo valido> [--name "<nombre>"]\n'); process.exit(1); }
      git('config', 'user.email', email);
      const nameIdx = argv.indexOf('--name');
      if (nameIdx >= 0 && argv[nameIdx + 1]) git('config', 'user.name', argv[nameIdx + 1]);
      const al = authIdentity();
      if (al.login) git('config', 'faro.identityLogin', al.login);
      process.stdout.write(`OK: git config user.email = ${email} (LOCAL, solo este repo)${nameIdx >= 0 && argv[nameIdx + 1] ? ` · user.name = ${argv[nameIdx + 1]}` : ''}${al.login ? ` · login autenticado fijado: ${al.login}` : ''}\n`);
      return;
    }
    const c = identityCheck();
    const auth = (c.auth.login || c.auth.email) ? { login: c.auth.login, email: c.auth.email, source: c.auth.source } : null;
    if (argv.includes('--json')) { process.stdout.write(JSON.stringify({ git_email: c.gitEmail, git_name: c.gitName, authenticated: auth, cached: cachedUser(), verified: c.verified, detalle: c.why || 'ok' }, null, 2) + '\n'); return; }
    const lines = [
      `Correo de commit (git config user.email): ${c.gitEmail || '(VACIO)'}`,
      `Cuenta autenticada del remoto: ${auth ? `${auth.login || auth.email} (via ${auth.source})` : '(no detectada: falta gh CLI o ssh -T no autentica; con varias claves usa alias de host en ~/.ssh/config)'}`,
      `Verificado: ${c.verified === true ? 'SI' : c.verified === false ? 'NO' : 'DESCONOCIDO'}${c.why ? ' — ' + c.why : ''}`,
    ];
    if (c.verified !== true) lines.push('Arreglar (por repo): node .claude/hooks/harness.js identity --set <correo>  ·  o conectar con GitHub: node .claude/hooks/harness.js auth');
    process.stdout.write(lines.join('\n') + '\n');
  }

  // auth: DEVICE FLOW (codigo de 6 digitos). Valida cuenta ssh + org, estampa identidad/teams y CACHEA token + user.
  async function cmdAuth() {
    const host = ghHost();
    // Client id propio SOLO tiene sentido para github.com; un GitHub Enterprise Server autoalojado
    // necesita su PROPIA app OAuth (registrada en ese host) — nunca la de github.com.
    const clientId = process.env.FARO_CLIENT_ID || git('config', 'faro.githubClientId') || (host === 'github.com' ? CLIENT_ID_GITHUB : null);
    if (!clientId) { process.stdout.write(`Para conectar con ${host} hace falta una app OAuth${host === 'github.com' ? '' : ' PROPIA de ese host (GitHub Enterprise autoalojado)'} con 'Device Flow' habilitado:
  git config --global faro.githubClientId <client_id>   y repite: node .claude/hooks/harness.js auth
`); return; }
    const post = async (u, b) => { try { const r = await fetch(u, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return await r.json(); } catch { return {}; } };
    // 'workflow' es OBLIGATORIO para poder crear/actualizar .github/workflows/*.yml (CI) por push;
    // sin el, GitHub rechaza el push completo con 'refusing to allow an OAuth App to create or
    // update workflow ... without workflow scope' (reproducido: push a faro-plugin 2026-07-30).
    const d = await post(`${ghWebBase()}login/device/code`, { client_id: clientId, scope: 'repo read:org user:email workflow' });
    if (!d.device_code) { process.stdout.write('No pude iniciar el login (revisa la red). Alternativa: gh auth login\n'); return; }
    process.stdout.write(`\n  Abre en el navegador:  ${d.verification_uri}\n  CODIGO:  ${d.user_code}\n  (esperando a que autorices en el navegador…)\n`);
    let token = null; const t0 = Date.now();
    while (Date.now() - t0 < (d.expires_in || 900) * 1000) {
      await new Promise((r) => setTimeout(r, (d.interval || 5) * 1000));
      const t = await post(`${ghWebBase()}login/oauth/access_token`, { client_id: clientId, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      if (t.access_token) { token = t.access_token; break; }
      if (t.error && t.error !== 'authorization_pending' && t.error !== 'slow_down') { process.stdout.write(`Login: ${t.error}\n`); return; }
    }
    if (!token) { process.stdout.write('Login caducado. Reintenta: node .claude/hooks/harness.js auth\n'); return; }
    const api = async (p) => { try { const r = await fetch(ghApiBase() + p, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } }); return r.status === 204 ? true : await r.json(); } catch { return null; } };
    const me = await api('user'); if (!me || !me.login) { process.stdout.write('No pude leer tu usuario de GitHub.\n'); return; }
    const remote = git('remote', 'get-url', 'origin') || '';
    const org = (remote.match(/[:/]([^/]+)\/[^/]+?(?:\.git)?$/) || [])[1] || null;
    const sshLogin = (authIdentity().login || '').toLowerCase();
    if (sshLogin && me.login.toLowerCase() !== sshLogin) { process.stdout.write(`\n⚠ El token es de '${me.login}' pero tu SSH es '${sshLogin}' — cuenta equivocada. Reintenta con la de la organizacion.\n`); return; }
    if (org && (await api(`orgs/${org}/members/${me.login}`)) !== true) { process.stdout.write(`\n⚠ '${me.login}' no aparece como miembro de ${org}. ¿Cuenta correcta?\n`); return; }
    git('config', 'faro.identityLogin', me.login);
    if (me.name) git('config', 'user.name', me.name);
    let email = me.email; if (!email) { const es = await api('user/emails'); if (Array.isArray(es)) { const p = es.find((e) => e.primary && e.verified) || es.find((e) => e.verified); email = p && p.email; } }
    if (email) git('config', 'user.email', email);
    const teams = ((await api('user/teams')) || []).filter((t) => t && t.organization && (!org || t.organization.login === org)).map((t) => t.slug);
    try {
      // Metadato: los teams del usuario se estampan en faro/config.json.
      const mp = require('./config-repo.js').rutaAbs(ROOT);
      let meta = {}; try { meta = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch {}
      if (teams.length) { meta.teams = teams; fs.writeFileSync(mp, JSON.stringify(meta, null, 2) + '\n'); }
    } catch {}
    // CACHEA token + identidad (login/nombre/correo) en el fichero unico -> ghToken() y las metricas la recuperan sin re-llamar.
    const uName = me.name || (git('config', 'user.name') || '').trim() || null;
    const uEmail = email || (git('config', 'user.email') || '').trim().toLowerCase() || null;
    const usr = { login: me.login, name: uName, email: uEmail };
    CRED.guardarToken(host, { token, user: usr, scopes: 'repo read:org user:email workflow', forja: 'github', client_id: host === 'github.com' ? undefined : clientId });
    const j = readCfg(); j.org = j.org || org || null; j.user = usr; writeCfg(j);
    process.stdout.write(`\n✅ Conectado como ${me.login}${org ? ` · ${org}` : ''}${email ? ` · ${email}` : ''}${teams.length ? ` · equipos: ${teams.join(', ')}` : ''}\n   Identidad y equipos configurados. Ya puedes consultar PRs: node .claude/hooks/harness.js gh repos/<org>/<repo>/pulls?state=open\n`);
  }

  return { authIdentity, identityCheck, asegurarEmailCommit, identityWarnCheap, identityBlockLine, identityLines, cmdIdentity, cmdAuth };
};
