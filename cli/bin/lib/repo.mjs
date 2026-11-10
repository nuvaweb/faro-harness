// repo.mjs — todo lo LOCAL a la máquina/carpeta: prerrequisitos, editor, identidad git, remoto
// "seamless", clon/finalización, elección de destino, overlay del template FARO, plugins y MCP.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run, ok, warn, fail, say, caja, spinner, elige, pregunta, confirma, C, YES, NO_OPEN, DRY, argVal, saveConfig, loadConfig } from './core.mjs';
import { REPO_META, leerMetaRepo, escribirMetaRepo } from './meta.mjs';
import { rutaFaro, detectarLayout } from './layout.mjs';
import { migrarCopiaLegada, escribirSettingsPlugin, revisarPlantillasLegadas } from './plugin.mjs';
import { usuarioHttp, overrideMarketplace, noreplyDe } from './gitcred.mjs';
import { PERFILES } from './perfil.mjs';
import { payloadMeta, fusionarMeta, instanciarMonorepo, clonadorPublico } from './monorepo.mjs';
import { personalizarPlantilla } from './plantilla.mjs';
import { consultaCi, generarCi, exigirPipeline } from './validacion.mjs';

// Prerrequisitos.
function tieneCmd(bins) { for (const b of bins) { try { execFileSync(b, ['--version'], { stdio: 'ignore', timeout: 8000 }); return true; } catch {} } return false; }

// Parseo PURO (testeable) del saludo por SSH: GitHub «Hi <login>! You've successfully authenticated...»
// y GitLab «Welcome to GitLab, @<login>!». Devuelve el login en minúsculas o null. Ninguna da shell (exit≠0).
function parseSshLogin(salida) {
  const m = String(salida || '').match(/\bHi\s+([A-Za-z0-9-]+)!|Welcome to GitLab,\s+@([\w.-]+)!/);
  return m ? (m[1] || m[2]).toLowerCase() : null;
}

// Cuenta de la forja con la que EMPUJARÍA tu SSH (la que mueve el código). No fija clave: lee qué
// login resolvería el `ssh` + `~/.ssh/config` + `ssh-agent` del sistema. Devuelve el login en
// minúsculas, o null si no hay SSH válido a ese host. Misma técnica que el harness (github.js).
// La VERDAD de la identidad es el TOKEN LOGIN; esto solo comprueba que el SSH no sea de OTRA cuenta.
function cuentaSsh(host = 'github.com') {
  let out = '';
  try {
    out = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=6', '-T', `git@${host}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 }).toString();
  } catch (e) { out = `${(e && e.stdout) || ''}${(e && e.stderr) || ''}`; }   // la forja responde por stderr y con exit≠0
  return parseSshLogin(out);
}
const cuentaSshGithub = () => cuentaSsh('github.com');
// Item 13: detecta el editor anfitrión (VS Code / Cursor) y devuelve {cmd, nombre}.
function editorBin() {
  // 1) por PATH (vale en los 3 SO si el 'shell command' está instalado: code/cursor)
  const cands = [['cursor', 'Cursor'], ['cursor.cmd', 'Cursor'], ['code', 'VS Code'], ['code.cmd', 'VS Code']];
  for (const [b, n] of cands) { try { execFileSync(b, ['--version'], { stdio: 'ignore', timeout: 8000 }); return { cmd: b, nombre: n }; } catch {} }
  // 2) fallback por RUTA conocida según el SO
  const home = os.homedir();
  const rutas = process.platform === 'darwin' ? [
    ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor', 'Cursor'],
    [path.join(home, 'Applications', 'Cursor.app', 'Contents', 'Resources', 'app', 'bin', 'cursor'), 'Cursor'],
    ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', 'VS Code'],
    [path.join(home, 'Applications', 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'), 'VS Code'],
  ] : process.platform === 'win32' ? [
    [path.join(home, 'AppData', 'Local', 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'), 'Cursor'],
    [path.join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'), 'VS Code'],
    ['C:/Program Files/Microsoft VS Code/bin/code.cmd', 'VS Code'],
  ] : [   // linux
    ['/usr/bin/cursor', 'Cursor'], ['/usr/local/bin/code', 'VS Code'], ['/usr/bin/code', 'VS Code'], ['/snap/bin/code', 'VS Code'],
  ];
  for (const [c, n] of rutas) { if (fs.existsSync(c)) return { cmd: c, nombre: n }; }
  return null;
}
const enVSCode = process.env.TERM_PROGRAM === 'vscode';
function checkPrerrequisitos() {
  const falta = [];
  if (!tieneCmd(['git'])) falta.push('Git (' + (process.platform === 'darwin' ? 'brew install git' : process.platform === 'win32' ? 'winget install Git.Git' : 'apt install git') + ')');
  if (!editorBin()) warn(enVSCode
    ? 'No detecto el comando del editor ("code"/"cursor") en el PATH — al final te doy la carpeta para abrirla tú.'
    : 'Editor (VS Code/Cursor) no detectado — al final tendrás que abrir la carpeta a mano.');
  if (falta.length) { fail(`Falta instalar: ${falta.join(' · ')}. Instálalo y vuelve a ejecutar.`); process.exit(1); }
}

// Sugerencia de `cd` inteligente: relativa si el destino cuelga del cwd; absoluta si está fuera; null si es el mismo dir.
function cdSugerido(cwd, destino) {
  const rel = path.relative(cwd, destino);
  if (!rel) return null;                                // destino === cwd (opción "raíz")
  if (rel.startsWith('..')) return `cd "${destino}"`;   // fuera del cwd
  return `cd "${rel}"`;                                  // subcarpeta
}

// Comando de instalación de dependencias según el tipo de proyecto detectado en la carpeta.
function comandoDependencias(destino) {
  const has = (f) => fs.existsSync(path.join(destino, f));
  if (has('pnpm-lock.yaml')) return 'pnpm install';
  if (has('yarn.lock')) return 'yarn';
  if (has('package.json')) return 'npm install';
  if (has('requirements.txt')) return 'pip install -r requirements.txt';
  if (has('pyproject.toml')) return 'uv sync';
  if (has('go.mod')) return 'go mod download';
  return null;
}

// Inventario read-only de ramas locales. Recibe gitLocal(args)->stdout|null.
function inventarioRamas(gitLocal) {
  const ramaActual = gitLocal(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
  const existe = (b) => gitLocal(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]) !== null;
  const principalExistente = existe('main') ? 'main' : existe('master') ? 'master' : null;
  const todas = (gitLocal(['for-each-ref', '--format=%(refname:short)', 'refs/heads']) || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const otrasRamas = todas.filter((b) => b !== ramaActual);
  const ramasConMasCommits = otrasRamas.filter((b) => {
    const n = gitLocal(['rev-list', '--count', `${ramaActual}..${b}`]);
    return n !== null && Number(n) > 0;
  });
  return { ramaActual, principalExistente, otrasRamas, ramasConMasCommits };
}

// Diagnóstico de ESTRUCTURA FARO (solo lee FS; sin red ni git). Devuelve una lista de checks.
function diagnosticarEstructura(destino) {
  const has = (f) => fs.existsSync(path.join(destino, f));
  const out = [];
  out.push({ id: 'git', etiqueta: 'Repositorio git', estado: has('.git') ? 'ok' : 'error', detalle: has('.git') ? '.git presente' : 'no es un repo git (usa adoptar)' });
  // Modelo PLUGIN: '.claude' del template ya NO se exige (el motor vive en el plugin y el settings
  // del repo lo escribe escribirSettingsPlugin) — exigirlo reintroducia la copia legada que la
  // migracion retira. El resto del andamio documental si se comprueba.
  const faltanRoots = faroRoots(destino).filter((r) => r !== '.claude' && !has(r));
  out.push({ id: 'faro-roots', etiqueta: 'Capa FARO', estado: faltanRoots.length ? 'aviso' : 'ok', detalle: faltanRoots.length ? `faltan: ${faltanRoots.join(', ')}` : 'completa', faltan: faltanRoots });
  // #293: FARO en la raiz es el layout antiguo; el motor lo sigue leyendo, pero se migra a faro/ con el plugin.
  const legado = detectarLayout(destino) === 'legado';
  out.push({ id: 'layout', etiqueta: 'Layout FARO', estado: legado ? 'aviso' : 'ok', detalle: legado ? 'FARO en la raíz (layout antiguo): en Claude Code, `harness.js migrar-layout --dry-run` enseña el paso a faro/ y `harness.js migrar-layout` lo hace' : 'todo bajo faro/' });
  // Los comandos /faro:* los provee el PLUGIN: si el repo aun lleva la copia local, es LEGADO a migrar.
  const cmdsLegado = has(path.join('.claude', 'commands', 'faro'));
  out.push({ id: 'comandos', etiqueta: 'Comandos faro', estado: cmdsLegado ? 'aviso' : 'ok', detalle: cmdsLegado ? 'copia legada en .claude/commands/faro — el plugin los provee (/faro:*); migra con check/adoptar' : 'los provee el plugin (/faro:*)' });
  // El MCP viaja con el plugin (mcpServers de plugin.json): un .mcp.json local es redundante.
  out.push({ id: 'mcp', etiqueta: 'MCP', estado: 'ok', detalle: 'lo provee el plugin (mcpServers del manifest)' });
  let clasOk = false, clasDet = `${REPO_META} ausente (usa adoptar)`;
  const metaD = leerMetaRepo(destino);
  if (metaD) { clasOk = !!metaD.domain; clasDet = clasOk ? `dom-${metaD.domain}` : 'incompleto (falta domain)'; }
  out.push({ id: 'clasificacion', etiqueta: 'Clasificación (domain)', estado: clasOk ? 'ok' : 'aviso', detalle: clasDet });
  return out;
}

// Diagnóstico de RAMAS locales: inventario + existencia de develop + invariante develop ⊇ main.
function diagnosticarRamasLocal(gitLocal) {
  const inv = inventarioRamas(gitLocal);
  const existe = (b) => gitLocal(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]) !== null;
  const tieneDevelop = existe('develop');
  const principal = inv.principalExistente;
  let developSupersetMain = true;   // true si develop contiene todo lo de la principal
  if (tieneDevelop && principal) {
    const n = gitLocal(['rev-list', '--count', `develop..${principal}`]);
    developSupersetMain = !(n !== null && Number(n) > 0);
  }
  const enPrincipal = inv.ramaActual === 'main' || inv.ramaActual === 'master';
  return { ...inv, tieneDevelop, developSupersetMain, enPrincipal };
}

// Normaliza la principal a 'main': en FARO la principal SIEMPRE es 'main' (y el trabajo, 'develop').
// Solo actua si existe 'master' y NO existe 'main' (si existen ambas es un caso ambiguo: no tocar).
// Devuelve { renombrada, motivo } — 'renombrada' true solo si se hizo el rename local.
function normalizarPrincipalLocal(destino) {
  const gl = (a) => { try { return execFileSync('git', ['-C', destino, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const existe = (b) => gl(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]) !== null;
  if (!existe('master')) return { renombrada: false, motivo: 'sin master' };
  if (existe('main')) return { renombrada: false, motivo: 'existen main Y master — ambiguo, no toco' };
  try { run('git', ['-C', destino, 'branch', '-m', 'master', 'main'], { stdio: 'ignore' }); }
  catch { return { renombrada: false, motivo: 'el rename local fallo' }; }
  return { renombrada: true, motivo: 'master → main' };
}

// Garantiza 'develop' local (desde 'fuente') y deja HEAD en 'develop'. Idempotente.
function asegurarDevelopLocal(destino, fuente) {
  const gl = (a) => { try { return execFileSync('git', ['-C', destino, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const existeDev = gl(['rev-parse', '--verify', '--quiet', 'refs/heads/develop']) !== null;
  if (!existeDev) {
    run('git', ['-C', destino, 'switch', '-c', 'develop', fuente], { stdio: 'ignore' });
    return;
  }
  run('git', ['-C', destino, 'switch', 'develop'], { stdio: 'ignore' });
  if (fuente && fuente !== 'develop') {
    try { run('git', ['-C', destino, 'merge', '--no-edit', fuente], { stdio: 'ignore' }); }
    catch {
      try { run('git', ['-C', destino, 'merge', '--abort'], { stdio: 'ignore' }); } catch {}
      warn(`Conflicto al fusionar '${fuente}' en 'develop'; reconcilia luego:  git switch develop && git merge ${fuente}`);
    }
  }
}

// Item 9: deja git listo para commitear/pushear tras el login.
async function asegurarGitIdentidad(auth, perfil = PERFILES.github) {
  const get = (k) => { try { return execFileSync('git', ['config', '--global', k], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const set = (k, v) => { try { execFileSync('git', ['config', '--global', k, v], { stdio: 'ignore' }); return true; } catch { return false; } };
  if (!get('user.name')) { const n = auth.name || auth.login; if (set('user.name', n)) ok(`Identidad git configurada: ${n}`); }
  if (!get('user.email')) {
    const noreply = noreplyDe(auth, perfil);
    let email = auth.email;
    if (!email) email = (YES || !process.stdin.isTTY) ? noreply : await pregunta('Email para tus commits (privado → usa el sugerido)', noreply);
    if (set('user.email', email)) ok(`Email de commits: ${email}`);
  }
  // Credencial best-effort: siembra el token para que el primer push no pida nada.
  try {
    execFileSync('git', ['credential', 'approve'], {
      input: `protocol=https\nhost=${perfil.host}\nusername=${usuarioHttp(perfil.forja)}\npassword=${auth.token}\n\n`,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  } catch { warn('No pude sembrar la credencial git (el primer push podría pedir login).'); }
}

// Clona, estampa metadatos, identidad y abre editor. Compartida por crear/abrir/resume.
// Deja el remoto listo para pushes SIN modal, sin dejar el token en .git/config.
// Prioridad: SSH ya validado (tu clave) > gh (si está logueado) > HTTPS limpio (GCM pide 1 vez).
async function configurarRemotoSeamless(destino, org, repoName, auth, ctx = null) {
  const host = (ctx && ctx.perfil && ctx.perfil.host) || 'github.com';
  const forjaId = (ctx && ctx.perfil && ctx.perfil.forja) || 'github';
  // GUARDA ANTI-CRUCE: si tu SSH empuja como OTRA cuenta distinta a la del token login, NO ponemos
  // el remoto por SSH (caería en HTTPS con la credencial del token, que es la cuenta correcta).
  // El código lo mueve el SSH, y DEBE ser el mismo usuario que autenticó el token.
  const loginTok = auth && auth.login ? String(auth.login).toLowerCase() : null;
  // Reusa el handshake SSH ya hecho en la sesión (no repetirlo: son hasta 6 s por intento).
  const sshLogin = (ctx && ctx.sshLogin !== undefined) ? ctx.sshLogin : cuentaSsh(host);
  if (loginTok && sshLogin && sshLogin !== loginTok) {
    warn(`Tu SSH empuja como @${sshLogin} pero tu sesión es @${loginTok} — NO configuro el remoto por SSH (evito commits con la cuenta equivocada). Uso HTTPS con tu token.`);
    run('git', ['-C', destino, 'remote', 'set-url', 'origin', `https://${host}/${org}/${repoName}.git`], { stdio: 'ignore' });
    if (forjaId === 'github') try {
      execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
      execFileSync('gh', ['auth', 'setup-git'], { stdio: 'ignore' });
    } catch {}
    say(`  ${C.d}Para empujar con la cuenta correcta: usa el token (HTTPS) o carga en tu agente la clave SSH de @${loginTok}.${C.x}`);
    return;
  }
  // 1) ¿SSH disponible? Test silencioso; y si falla por AGENTE INTERACTIVO (1Password: pide Touch ID
  //    en cada uso y BatchMode lo bloquea), lo detectamos por el agente/IdentityAgent del ~/.ssh/config.
  let ssh = !!sshLogin;   // ya calculado una vez por sesión: no repetir el handshake
  if (!ssh) { try { const l = execFileSync('ssh-add', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); if (l && !/no identities/i.test(l)) ssh = true; } catch {} }
  if (!ssh) { try { const cfgSsh = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8'); if (/IdentityAgent|1password/i.test(cfgSsh) || cfgSsh.includes(host)) ssh = true; } catch {} }
  if (ssh) {
    run('git', ['-C', destino, 'remote', 'set-url', 'origin', `git@${host}:${org}/${repoName}.git`], { stdio: 'ignore' });
    ok('Remoto por SSH (tu clave/agente, p. ej. 1Password) → pushes sin modal (aprobarás en 1Password).');
    return;
  }
  // 2) HTTPS SIN token (no queda en .git/config).
  run('git', ['-C', destino, 'remote', 'set-url', 'origin', `https://${host}/${org}/${repoName}.git`], { stdio: 'ignore' });
  // Si gh está instalado Y logueado, que git use gh como credential helper (sin modal).
  if (forjaId === 'github') try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });   // lanza si gh no está o no logueado
    execFileSync('gh', ['auth', 'setup-git'], { stdio: 'ignore' });
    ok('git configurado con gh (credential helper) → pushes sin modal.');
    return;
  } catch {}
  // 3) No lo detecté (p. ej. agente 1Password no visible en este entorno): PREGUNTA.
  if (!YES && process.stdin.isTTY && await confirma(`¿Usas SSH con ${host} (1Password o clave)? Lo pongo por SSH y no verás el modal`)) {
    run('git', ['-C', destino, 'remote', 'set-url', 'origin', `git@${host}:${org}/${repoName}.git`], { stdio: 'ignore' });
    ok('Remoto por SSH → pushes sin modal (aprobarás en tu agente/1Password).');
    return;
  }
  say(`  ${C.d}Remoto HTTPS. Tu 1er 'git push' pedirá login en ${host} una vez. Para evitarlo: una clave SSH.${C.x}`);
}

// Estampa la identidad AUTENTICADA (del login del CLI, device flow) en el git config LOCAL del repo:
// asi commits y telemetria salen con el usuario CORRECTO desde el minuto 1, sin
// depender del git config GLOBAL (que puede ser de otra cuenta). Amigable: explica que deja puesto.
function estamparIdentidad(destino, auth, perfil = PERFILES.github) {
  if (!auth || !auth.login) return;
  const gl = (a) => { try { execFileSync('git', ['-C', destino, ...a], { stdio: 'ignore' }); } catch {} };
  gl(['config', 'faro.identityLogin', auth.login]);
  // FUERZA la identidad LOCAL del repo (gana sobre el git config GLOBAL, que puede ser de OTRA cuenta).
  // El commit se atribuye por user.email -> DEBE ser el de la cuenta autenticada, SIEMPRE.
  gl(['config', 'user.name', auth.name || auth.login]);
  // Si el correo de la cuenta es privado (auth.email null), usa el NOREPLY de ESA cuenta: la forja lo
  // atribuye igual al usuario correcto. Nunca dejamos el email de otra cuenta.
  const email = auth.email || noreplyDe(auth, perfil);
  gl(['config', 'user.email', email]);
  let porSsh = false;
  try { porSsh = /^git@|^ssh:\/\//.test(execFileSync('git', ['-C', destino, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch {}
  ok(`Identidad de este repo: ${C.b}${email}${C.x} ${C.d}(login ${auth.login} · commits atribuidos a esta cuenta)${C.x}`);
  if (porSsh) say(`${C.d}  Git irá por tu SSH; tu correo sale de tu sesión en la forja (ya conectada). Nada más que hacer.${C.x}`);
  if (!auth.email) say(`${C.d}  (Tu correo es privado → uso tu noreply para que el commit se atribuya a ti. Para poner el corporativo, dentro de Claude Code: harness identity --set <correo>.)${C.x}`);
}

async function finalizarLocal(auth, org, repoName, baseDir, destino, meta, ctx = null) {
  const perfil = (ctx && ctx.perfil) || PERFILES.github;
  const host = perfil.host, usuario = usuarioHttp(perfil.forja);
  const override = (ctx && ctx.mk && ctx.mk.override) || overrideMarketplace();
  fs.mkdirSync(baseDir, { recursive: true });
  const existe = fs.existsSync(destino);
  let vacio = !existe;
  if (existe) { try { vacio = fs.readdirSync(destino).filter((n) => n !== '.git').length === 0; } catch { vacio = false; } }
  if (existe && !vacio) { warn(`La carpeta ${destino} ya existe y NO está vacía: no la sobrescribo.`); }
  else {
    const spin = spinner('Clonando en local');
    // Repo recién creado: a develop. Si la forja no llegó a cambiar la rama por defecto, el commit común iría a main.
    try { run('git', ['clone', ...(meta ? ['--branch', 'develop'] : []), `https://${usuario}:${auth.token}@${host}/${org}/${repoName}.git`, destino], { stdio: 'ignore' }); }
    catch { spin('No se pudo clonar'); throw new Error(`No pude clonar ${host}/${org}/${repoName}: comprueba que existe y que tu cuenta tiene acceso.`); }
    spin(`Clonado en ${destino}`);
    await configurarRemotoSeamless(destino, org, repoName, auth, ctx);   // remoto listo (SSH/gh/https limpio), sin token en .git/config; NO configura SSH de otra cuenta
    estamparIdentidad(destino, auth, perfil);                  // identidad del LOGIN (usuario/correo) al git config local -> telemetria coherente
    // Clasificación (solo al CREAR): domain (+ teams, tags), lo que el harness LEE. La ENTIDAD la
    // clasifica el harness dentro del template, no este CLI.
    // Metadato + clasificacion: depende del template y PUEDE fallar (no bloquea).
    let nuevoMeta = false;
    if (meta && meta.template) {
      try {
        // 'tags' = la válvula de FLEXIBILIDAD (lo que no encaja en el eje fijo domain).
        // teams = team(s) del REPO (para atribuir metricas; el harness lo lee). naturaleza siempre;
        // plantilla (clave del catalogo) solo en app unica — en monorepo cada app registra la suya.
        const payload = payloadMeta({
          domain: meta.domain, teams: meta.teams, tags: meta.tags, naturaleza: meta.naturaleza,
          plantilla: meta.monorepo ? null : meta.plantillaKey,
          validacion: meta.validacion || null,
        });
        // El template puede traer ya un .faro.json (p. ej. solo teams): se COMPLETA, no se deja como
        // estaba — si no, el repo nacía sin domain ni naturaleza.
        const previa = leerMetaRepo(destino);
        const fusion = fusionarMeta(previa, payload);
        nuevoMeta = JSON.stringify(fusion) !== JSON.stringify(previa);
        if (nuevoMeta) escribirMetaRepo(destino, fusion);
      } catch { warn('No pude estampar los metadatos del template (no bloquea).'); }
    }
    // DISTRIBUCION DEL PLUGIN: INCONDICIONAL y FUERA del try anterior. Antes colgaba de
    // 'if (meta && meta.template)' y del mismo catch: un repo sin template —o cualquier fallo al
    // escribir el metadato— nacia SIN plugins declarados y sin que nadie se enterara ("no bloquea").
    // Es justo lo que hace que un repo abra sin FARO y haya que recurrir a /reload-plugins.
    let migro = false, cambioSettings = false, quitoPlantillas = false;
    try {
      migro = migrarCopiaLegada(destino, { perfil, override });          // el repo nace SIN copia legada del motor
      cambioSettings = escribirSettingsPlugin(destino, perfil, { override });  // faro + superpowers declarados (viaja en el clon), fuente según la forja
      // Plantillas de marca: las sirve el plugin. Si el template generado dejo copias, se retiran ya —
      // un repo NUEVO no debe nacer con plantillas congeladas que tapen a las del plugin.
      quitoPlantillas = await revisarPlantillasLegadas(destino);
    } catch { warn('No pude declarar los plugins en el settings del repo — revísalo con `faro check`.'); }
    // INSTANCIAR la plantilla de stack (si el alta eligio una): los marcadores del template pasan a
    // ser los valores de ESTE repo. Va AQUI, con los ficheros ya clonados y ANTES del commit comun:
    // es un solo commit en vez de dos, y —sobre todo— antes del cierre del flujo. Ponerlo despues de
    // finalizarLocal imprimia un paso EXTRA tras los "Siguientes pasos", que es justo cuando el
    // usuario ya da el wizard por terminado.
    let instancio = [];
    if (meta && meta.plantilla && Array.isArray(meta.plantilla.instanciar) && meta.plantilla.instanciar.length) {
      try {
        instancio = personalizarPlantilla(destino, { repoName, marcadores: meta.plantilla.instanciar });
        instancio.forEach((h) => ok(h));
        if (instancio.length) say(`  ${C.y}Pendiente (lo resuelve Claude Code dentro del repo):${C.x} ${C.d}APP_ID del centro de identidad, marca, tema y navegación.${C.x}`);
      } catch { warn('No pude personalizar la plantilla (no bloquea) — hazlo con Claude Code dentro del repo.'); }
    }
    // MONOREPO (#5): cada app a apps/<id> desde su plantilla, ANTES del commit comun: el monorepo nace
    // en un solo commit. Lo hace el CLI solo (no depende del plugin). Fallo CERRADO: si una app falla
    // no queda nada a medias (ni apps/ ni workspace).
    let appsHechas = [];
    if (meta && meta.monorepo && Array.isArray(meta.monorepo.apps) && meta.monorepo.apps.length) {
      const spinMono = spinner(`Creando las apps del monorepo (${meta.monorepo.apps.map((a) => a.id).join(', ')})`);
      const r = instanciarMonorepo({
        destino, repoName, apps: meta.monorepo.apps,
        clonar: clonadorPublico,
      });
      spinMono();
      if (r.ok) {
        appsHechas = r.hechos;
        appsHechas.forEach((id) => ok(`App ${C.b}apps/${id}${C.x} creada desde su plantilla.`));
        say(`  ${C.y}Pendiente:${C.x} ${C.d}pnpm install en la raíz (genera el lockfile del workspace); APP_ID, marca y navegación los resuelve Claude Code.${C.x}`);
      } else {
        warn(`No he creado las apps del monorepo: ${r.error}. El repo queda sin apps/ (nada a medias).`);
        caja(['Créalas después en Claude Code, dentro del repo: /faro:code'], { titulo: 'Crear las apps después', color: C.y });
      }
    }
    // CI de la forja (#289): si se eligio ci o ambos, el motor del plugin escribe el CI con los gates del
    // repo, ANTES del commit comun. No pisa uno existente; sin gates (repo documental) no hay CI todavia.
    let ci = null;
    if (meta && consultaCi(meta.validacion)) {
      ci = generarCi(destino, { forja: perfil.forja });
      if (ci.estado === 'creado') ok(`CI de la forja generado (${ci.ruta}) con los gates del repo.`);
      else if (ci.estado === 'existe') ok(`El repo ya tiene CI (${ci.ruta}): se usa el existente, no lo toco.`);
      else if (ci.estado === 'sin-motor') warn('No encuentro el plugin FARO instalado para generar el CI: dentro del repo, `harness.js ci`.');
      else say(`  ${C.d}Aún no hay gates (lint/test/build) que correr: el CI se genera con \`harness.js ci\` cuando el repo tenga código. Mientras, FARO valida en local.${C.x}`);
    }
    let subido = false;
    if (nuevoMeta || migro || cambioSettings || quitoPlantillas || instancio.length || appsHechas.length || (ci && ci.estado === 'creado')) {
      try {
        const msg = appsHechas.length
          ? `chore: monorepo ${repoName} con apps/${appsHechas.join(', apps/')} + metadato FARO + plugin faro declarado`
          : instancio.length
          ? `chore: metadato FARO + plugin faro declarado + plantilla ${meta.plantilla.repo} instanciada para ${repoName}`
          : 'chore: metadato FARO + plugin faro declarado (sin copia legada)';
        run('git', ['-C', destino, 'add', '-A'], { stdio: 'ignore' });
        run('git', ['-C', destino, 'commit', '-m', msg], { stdio: 'ignore' });
        run('git', ['-c', 'credential.helper=', '-C', destino, 'push', `https://${usuario}:${auth.token}@${host}/${org}/${repoName}.git`, 'HEAD'], { stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        ok(`Clasificación v2 + plugin faro declarado${instancio.length ? ' + plantilla instanciada' : ''}${appsHechas.length ? ' + apps del monorepo' : ''} (settings del repo).`);
        subido = true;
      } catch { warn('No pude subir el commit de clasificación/plugins (no bloquea) — queda en local.'); }
    }
    if (ci) await aplicarExigirPipeline({ ci, meta, perfil, auth, ruta: `${org}/${repoName}`, alta: ctx && ctx.forja && ctx.forja.alta, subido: subido || ci.estado === 'existe' });
  }
  // Item 8/13: abrir en el editor correcto o dar la ruta+comando.
  if (NO_OPEN) { ok(`Listo. Abre la carpeta: ${destino}`); return; }
  const eb = editorBin();
  if (eb) { try { execFileSync(eb.cmd, [destino], { stdio: 'ignore' }); ok(`Abriendo ${eb.nombre}…`); } catch { warn(`Abre a mano:  ${eb.cmd} "${destino}"`); } }
  else warn(`No detecté editor. Abre a mano:  code "${destino}"   (o  cursor "${destino}")`);
  // Siguientes pasos: cd inteligente + recordatorio de dependencias (salida informativa; el cd no se puede aplicar al shell padre).
  const cdCmd = cdSugerido(process.cwd(), destino);
  const dep = comandoDependencias(destino);
  if (cdCmd || dep) {
    say('');
    say(`${C.b}Siguientes pasos${C.x}`);
    if (cdCmd) say(`  ${cdCmd}`);
    if (dep) say(`  ${dep}`);
    say(`  ${C.d}(el editor ya se abrió en la carpeta)${C.x}`);
  }
}

// «El pipeline debe pasar» (#289), solo con el CI ya subido: sin él toda fusión quedaría bloqueada.
async function aplicarExigirPipeline({ ci, meta, perfil, auth, ruta, alta, subido }) {
  const d = exigirPipeline({ forja: perfil.forja, ci: subido ? ci.estado : null, dePago: !!meta.dePago, publico: !!meta.publico });
  if (d.accion === 'api' && alta && alta.exigirPipeline) {
    const r = await alta.exigirPipeline({ host: perfil.host, token: auth.token }, ruta);
    if (r && r.ok) ok('«El pipeline debe pasar» activado: un MR con el CI en rojo no se puede fusionar.');
    else warn('No pude activar «el pipeline debe pasar» (hace falta Maintainer): dentro del repo, `harness.js exigir-pipeline`.');
  } else if (d.aviso) say(`  ${C.d}${d.aviso}${C.x}`);
}

// Dónde clonar (compartido por crear y abrir).
async function elegirDestino(cfg, repoName) {
  const dirFlag = argVal('dir');
  const cwd = process.cwd();
  if (dirFlag) return path.join(dirFlag, repoName);
  if (YES) return path.join(cwd, repoName);
  const esRepo = fs.existsSync(path.join(cwd, '.git'));
  let vacia = false; try { vacia = fs.readdirSync(cwd).filter((n) => n !== '.git' && !n.startsWith('.')).length === 0; } catch {}
  const ops = { sub: { etiqueta: `Aquí, en una subcarpeta  →  ${path.join(cwd, repoName)}`, explica: 'Recomendado: crea la carpeta DENTRO de la actual.' } };
  if (!esRepo && vacia) ops.raiz = { etiqueta: `Esta misma carpeta como raíz  →  ${cwd}`, explica: 'La carpeta actual está vacía.' };
  ops.otra = { etiqueta: 'Otra carpeta…', explica: 'Indicas tú la ruta contenedora.' };
  if (esRepo) warn('La carpeta actual ya es un repositorio git → se usará una subcarpeta.');
  const donde = await elige(`¿Dónde creamos el proyecto?  ${C.d}(estás en ${cwd})${C.x}`, ops);
  if (donde === 'raiz') return cwd;
  if (donde === 'otra') { const base = await pregunta('Ruta de la carpeta contenedora', cfg.workdir || cwd); return path.join(base, repoName); }
  return path.join(cwd, repoName);
}

// SOLO para estos ficheros conservamos la versión FARO al lado (*.faro) cuando colisiona, para que
// la FASE 2 de /adoptar los reconcilie/mejore (el agente compara tu versión con la del template). Para
// CUALQUIER otro fichero (p. ej. docs/plantillas/*.md), si ya existe se RESPETA el del proyecto y NO se
// crea ningún temporal — evita ensuciar el repo con *.faro por todas partes.
const OVERLAY_SIDECAR = new Set(['readme.md', 'claude.md', 'estado.md']);
// NUNCA se copian al repo adoptado, aunque estén en el template (rutas relativas a la raíz, en
// minúsculas y con '/'):
// - .claude/settings.local.json: son los overrides PERSONALES de quien mantiene el template (permisos
//   y rutas de SU máquina). Ni se versiona ni tiene sentido en otro repo; se colaba entero (11 KB).
// - borrador/*.html y borrador/test-full.md: pruebas de usar y tirar del propio template. 'borrador/'
//   es scratch gitignored: se replica la ESTRUCTURA (.gitkeep), no el contenido de nadie.
const OVERLAY_EXCLUIR = new Set([
  '.claude/settings.local.json',
  'borrador/out-doc.html',
  'borrador/out-pres.html',
  'borrador/test-full.md',
  'faro/borrador/out-doc.html',
  'faro/borrador/out-pres.html',
  'faro/borrador/test-full.md',
]);
// Copia src->dst; nunca pisa un fichero existente. Colisión: sidecar *.faro SOLO si está en la
// lista blanca; el resto se deja intacto. `rel` es la ruta relativa acumulada desde la raíz del
// template, necesaria para decidir la exclusión por RUTA (no por nombre: 'README.md' es legítimo en
// casi todas las carpetas, pero 'borrador/out-doc.html' no).
function overlayFaro(src, dst, rel = '') {
  const base = path.basename(src);
  const relActual = rel ? `${rel}/${base}` : base;
  if (OVERLAY_EXCLUIR.has(relActual.toLowerCase())) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const e of fs.readdirSync(src)) overlayFaro(path.join(src, e), path.join(dst, e), relActual); return; }
  if (fs.existsSync(dst)) {
    if (OVERLAY_SIDECAR.has(path.basename(dst).toLowerCase())) fs.copyFileSync(src, `${dst}.faro`);
    return;   // resto: ya existe -> se respeta el del proyecto, sin temporal.
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst);
}
// Roots del andamio FARO que trae el adoptar (NO el stack). TAXONOMIA VIGENTE (#293, espejo de paths.js
// del harness): todo lo de FARO cuelga de faro/ —{documentos,gestion,fuentes,flujos,borrador,notebooks}/—;
// scripts/ es del producto y sigue en la raiz. ESTADO.md (faro/ESTADO.md) lo crea el agente en fase 2.
// Un repo sin migrar se diagnostica con SU layout (todo en la raiz): faroRoots(destino).
const FARO_ROOTS_LOGICOS = ['.claude', 'CLAUDE.md', 'documentos', 'gestion', 'fuentes', 'flujos', 'borrador', 'scripts', 'notebooks'];
const faroRoots = (destino) => FARO_ROOTS_LOGICOS.map((r) => rutaFaro(destino, r));
// Layout nuevo (lo que nace hoy): referencia para tests y mensajes.
const FARO_ROOTS = ['.claude', 'CLAUDE.md', ...FARO_ROOTS_LOGICOS.slice(2).map((r) => (r === 'scripts' ? r : `faro/${r}`))];
// ARBOL FARO completo (espejo de REF_DIRS en el harness, plugin >= 0.8.5). El andamio es estructura
// vacia: no hay nada que copiar de ningun template, se CREA. El harness lo mantiene en cada sesion;
// esto solo lo adelanta desde el CLI para que el repo quede coherente sin esperar a abrir Claude Code.
// Si cambia la taxonomia, la fuente de verdad es paths.js/REF_DIRS del plugin — mantener en sintonia.
const FARO_TREE_LOGICO = [
  'documentos', 'documentos/plantillas/html',
  'gestion', 'gestion/brainstorming', 'gestion/decisions',
  'gestion/cambios/specs', 'gestion/cambios/changes/archive',
  'gestion/reporting/informes', 'gestion/reporting/presentaciones',
  'fuentes', 'flujos', 'notebooks', 'scripts',
  'borrador', 'borrador/data', 'borrador/scripts', 'borrador/tmp',
];
// Carpetas del arbol que faltan (o, con soloVacias, las que existen pero no tienen contenido: ahi va
// el .gitkeep para que git las versione — sin el, el equipo no las recibe al clonar).
// #293: el arbol se resuelve con el layout del repo — un repo sin migrar recibe sus carpetas en la raiz
// (crear faro/gestion en el le cambiaria el layout a medias); uno nuevo o migrado, bajo faro/.
const faroTree = (destino) => FARO_TREE_LOGICO.map((d) => rutaFaro(destino, d));
const FARO_TREE = FARO_TREE_LOGICO.map((d) => (d === 'scripts' ? d : `faro/${d}`));
function carpetasFaroQueFaltan(destino, { soloVacias = false } = {}) {
  return faroTree(destino).filter((d) => {
    const p = path.join(destino, d);
    const existe = fs.existsSync(p);
    if (!soloVacias) return !existe;
    if (!existe) return false;
    try { return fs.readdirSync(p).length === 0; } catch { return false; }
  });
}
// .gitignore: MERGE (no pisa el del stack) — añade solo las líneas FARO que falten (faro/borrador/, .env…).
function mergeGitignore(src, dst) {
  let tmpl = ''; try { tmpl = fs.readFileSync(src, 'utf8'); } catch { return; }
  let cur = ''; try { cur = fs.readFileSync(dst, 'utf8'); } catch {}
  if (!cur) { fs.writeFileSync(dst, tmpl); return; }
  // .claude/ ES la capa FARO (harness, agentes, comandos) y DEBE subirse. Si el proyecto la ignora (muy
  // común por costumbre), la DES-IGNORAMOS (comentamos la regla) para no dejar el harness fuera del repo.
  // Respetamos el ignore ESPECÍFICO de .claude/settings.local.json (overrides personales de cada usuario).
  const ignoraClaude = (l) => /^\/?\.claude(\/\*{0,2})?\/?$/.test(l) && !/settings\.local/.test(l);
  let cambiado = false;
  cur = cur.split(/\r?\n/).map((raw) => {
    const l = raw.trim();
    if (l && !l.startsWith('#') && !l.startsWith('!') && ignoraClaude(l)) { cambiado = true; return `# ${raw}   # FARO des-ignoró .claude/ (la capa del harness debe subirse)`; }
    return raw;
  }).join('\n');
  // Idempotente: 'seen' arranca con TODO lo que ya hay (incluye un bloque FARO de una adopción previa)
  // y crece con cada línea añadida, así no duplica ni frente al proyecto ni consigo misma (CRLF/LF: se
  // compara por línea trim, agnóstico al fin de línea). Los comentarios del template no se copian.
  const seen = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const add = [];
  for (const raw of tmpl.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || seen.has(l)) continue;
    seen.add(l); add.push(l);
  }
  if (add.length) { cur = cur.replace(/\s*$/, '') + '\n\n# --- FARO ---\n' + add.join('\n') + '\n'; cambiado = true; }
  if (cambiado) fs.writeFileSync(dst, /\n$/.test(cur) ? cur : cur + '\n');
}


// Compatibilidad: los flujos y tests importan de repo.mjs lo que ahora vive en plugin.mjs y meta.mjs.
export * from './plugin.mjs';
export * from './meta.mjs';
export {
  personalizarPlantilla,
  tieneCmd, cuentaSsh, cuentaSshGithub, parseSshLogin, editorBin, checkPrerrequisitos, asegurarGitIdentidad,
  configurarRemotoSeamless, estamparIdentidad,
  finalizarLocal, aplicarExigirPipeline, elegirDestino, overlayFaro, FARO_ROOTS, FARO_TREE, faroRoots, faroTree, carpetasFaroQueFaltan, mergeGitignore,
  cdSugerido, comandoDependencias, inventarioRamas, asegurarDevelopLocal, normalizarPrincipalLocal,
  diagnosticarEstructura, diagnosticarRamasLocal,
};
