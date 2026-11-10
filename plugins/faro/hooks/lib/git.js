// lib/git.js — capa git de solo lectura (estado, flow, roles, lineas de sesion) (extraido de harness.js).
// Factory con CTX compartido: harness.js es el despachador; cada dominio vive en lib/<dominio>.js.
'use strict';
const { execFileSync, spawnSync } = require('child_process');
module.exports = function (ctx) {
  const { fs, path, ROOT, ESTADO_FILE, DOC_PATHS, WORK_BRANCH_RE, PROTECTED_BRANCHES, BRANCH_TYPES, isProtected, isDone, NO_INSTANCIA, listFiles, fmtDate, parseEstado, labelSlugs } = ctx;


// git via execFileSync (array de argumentos, sin shell): inmune a inyeccion y a
// problemas de escaping con espacios/acentos en rutas.
// ULTIMO FALLO DE git(), para poder distinguir "aqui no hay git" de "git no contesto a tiempo".
// Antes todo error acababa en null y el llamante lo traducia a "repo sin git": mentira en dos de los
// tres casos, y ademas la mas cara, porque manda a buscar donde no es. El timeout subio de 5s a 15s:
// en una maquina con antivirus de endpoint arrancar un proceso cuesta ~500-600ms medidos, y con varios
// ganchos a la vez un git normal puede pasar de 5s sin que pase nada malo.
let _ultimoFallo = null;
const GIT_READ_TIMEOUT_MS = 15000;
function git(...args) {
  try {
    const r = execFileSync('git', args, { windowsHide: true, cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_READ_TIMEOUT_MS }).trim();
    _ultimoFallo = null;
    return r;
  } catch (e) {
    if (e && e.code === 'ENOENT') _ultimoFallo = { tipo: 'sin-git-instalado', detalle: 'el ejecutable git no esta en el PATH' };
    else if (e && (e.killed || e.signal || e.code === 'ETIMEDOUT')) _ultimoFallo = { tipo: 'timeout', detalle: `git no respondio en ${GIT_READ_TIMEOUT_MS / 1000}s (${args[0]})` };
    else _ultimoFallo = { tipo: 'error-git', detalle: `git ${args[0]} fallo` + (e && e.status != null ? ` (codigo ${e.status})` : '') };
    return null;
  }
}
// Por que la ultima lectura de git devolvio null. null = no hubo fallo (git contesto bien).
const ultimoFalloGit = () => _ultimoFallo;

// git de ESCRITURA (merge/commit/switch sobre repos grandes). El timeout de 5s de git() vale para
// LECTURAS, pero mata un 'git merge' de un repo real (caso reportado: 271 ficheros / +61k lineas)
// dejandolo A MEDIAS: index.lock huerfano, ficheros en estado AD y un 'merge --abort' que ya no
// puede limpiar. Ademas devuelve el CODIGO DE SALIDA, no solo texto: comparar HEAD antes/despues no
// distingue "conflicto real" (exit 1, estado recuperable) de "proceso muerto" (sin exit, estado roto).
const GIT_WRITE_TIMEOUT_MS = 600000; // 10 min: un merge grande no deberia tardar mas; si tarda, es un cuelgue real
function gitWrite(...args) {
  const r = spawnSync('git', args, { windowsHide: true, cwd: ROOT, encoding: 'utf8', timeout: GIT_WRITE_TIMEOUT_MS });
  return {
    // status null = el proceso NO termino por si mismo (timeout/kill) -> estado del repo INCIERTO.
    ok: r.status === 0,
    status: r.status,
    matado: r.status === null || r.signal != null || !!r.error,
    salida: `${r.stdout || ''}${r.stderr || ''}`.trim(),
  };
}

// index.lock huerfano: lo deja un git muerto a media escritura y bloquea CUALQUIER operacion
// posterior ("Another git process seems to be running"). Solo se retira si NO hay proceso git vivo
// (comprobacion barata: el lock existe y una lectura trivial de git funciona -> nadie lo esta usando).
function limpiarIndexLockHuerfano() {
  const lock = path.join(ROOT, '.git', 'index.lock');
  try {
    if (!fs.existsSync(lock)) return false;
    // Si git puede leer el indice, el lock es basura de un proceso muerto (git vivo lo mantendria ocupado).
    if (git('rev-parse', '--git-dir') === null) return false; // git no responde: NO tocar, puede haber proceso vivo
    fs.unlinkSync(lock);
    return true;
  } catch { return false; }
}

let _git;
function gitInfo() {
  if (_git !== undefined) return _git;
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch) return (_git = null);
  // Identidad de trabajo = usuario git (cada miembro del equipo tiene la suya):
  // es la que firma commits/merges y la que se usa en aprobada_por y owners (@usuario).
  const user = git('config', 'user.name') || null;
  // '-uall' por el mismo motivo que en docsSinCommitear(): sin el, una carpeta nueva se colapsa en
  // una linea y sus documentos no se ven. Cambia tambien 'dirty' (cuenta ficheros, no carpetas),
  // que es lo que el numero decia querer decir.
  const status = git('status', '--porcelain', '-uall') || '';
  const dirty = status.split('\n').filter(Boolean);
  const dirtyDocs = dirty
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, '').replace(/\\/g, '/'))
    .filter((f) => DOC_PATHS.test(f));
  return (_git = { branch, user, dirty: dirty.length, dirtyDocs });
}

// Solo los documentos sin commitear: UNA lectura de git en vez de las TRES de gitInfo()
// (rev-parse + config user.name + status). 'stop-check' corre al CERRAR CADA TURNO y no usa ni la
// rama ni el usuario, asi que pagaba dos lecturas por nada — la misma optimizacion que se hizo en
// 'pre-doc' con ramaActual(). Devuelve [] si no hay repo git, que es lo que espera quien llama.
function docsSinCommitear() {
  if (_git !== undefined) return _git ? _git.dirtyDocs : [];   // si ya se pago gitInfo(), se reusa
  // '-uall' es imprescindible: por defecto git COLAPSA una carpeta nueva entera en una sola linea
  // ('?? gestion/') en vez de listar sus ficheros. Con eso, un informe de cierre de fase recien
  // creado dentro de una carpeta nueva NO casaba con el filtro y no bloqueaba nada — el gate se
  // saltaba solo, en silencio, justo en el caso mas probable (primer informe del repo).
  const status = git('status', '--porcelain', '-uall');
  if (status === null || status === undefined) return [];
  return String(status).split('\n').filter(Boolean)
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, '').replace(/\\/g, '/'))
    .filter((f) => DOC_PATHS.test(f));
}

// Ultima modificacion de un archivo segun git (fecha + autor del ultimo commit que lo tocó) —
// para responder "quien y cuando cambio esto por ultimo" sin depender de un campo de frontmatter
// que se pueda desincronizar. Null si el archivo no esta versionado o no tiene historial.
function lastCommitOf(relPath) {
  const out = git('log', '-1', '--format=%ad|%an', '--date=short', '--', relPath);
  if (!out) return null;
  const [date, author] = out.split('|');
  return { date, author };
}

// SOLO la rama, con UNA llamada a git. gitInfo() hace tres (rev-parse + config user.name + status
// --porcelain) porque casi todos sus usos quieren ademas saber quien firma y si hay trabajo sin
// commitear. Pero el hook que corre en CADA Write/Edit solo necesita saber en que rama estas, para
// decidir si esa rama esta protegida — y pagaba las otras dos sin usarlas.
//
// Medido: 'git status --porcelain' ~156ms y 'git config' otro tanto, en una llamada que se repite
// decenas de veces por sesion de trabajo. Aqui no hay caché propia a proposito: si alguien ya pidio
// gitInfo() se reutiliza la suya, y si no, esta lectura es tan barata que cachearla no compensa.
function ramaActual() {
  if (_git !== undefined) return _git ? _git.branch : null;
  return git('rev-parse', '--abbrev-ref', 'HEAD');
}

// Salud del ciclo de vida de ramas (git-flow): existe develop, en que rama estamos,
// que features hay y cuales estan ya integradas en develop (candidatas a borrado).
let _flow;
// La cache es PRIVADA de este modulo: quien cambie el estado de las ramas (merge, push) tras la
// PRIMERA lectura necesita una via EXPLICITA para tirarla, o gitFlow() seguiria devolviendo el
// estado de ANTES del merge (mismo patron que invalidarEstado() en lib/estado.js).
function invalidarFlow() { _flow = undefined; }
// Una rama de trabajo esta integrada en 'develop' si su CONTENIDO ya esta alli, aunque ningun
// commit suyo sea ancestro de develop (caso real: GitHub "Squash and merge" crea un commit NUEVO
// en develop con hash distinto a TODOS los de la rama -> 'git branch --merged' la sigue viendo
// como sin integrar; y 'git cherry' tampoco sirve, compara patch a patch y falla con rebases/
// squash de MULTIPLES commits porque ningun commit parcial coincide con el diff acumulado).
// Se usa 'git merge-tree' (fusion de PRUEBA, no toca el working tree ni el indice): si el arbol
// resultante de fusionar la rama en develop es IDENTICO al arbol ACTUAL de develop, mergearla no
// cambiaria nada -> ya esta integrada. Robusto tambien si develop avanzo DESPUES del squash (con
// otros commits ajenos a la rama): el arbol de develop ya incluye ese avance y sigue coincidiendo.
// Un conflicto real (rama de verdad distinta) devuelve exit!=0 -> git() da null -> NO integrada.
function integradaPorContenido(rama, base) {
  const arbolBase = git('rev-parse', `${base}^{tree}`);
  if (!arbolBase) return false;
  const arbolFusion = git('merge-tree', base, rama);
  return arbolFusion !== null && arbolFusion === arbolBase;
}

function gitFlow() {
  if (_flow !== undefined) return _flow;
  const g = gitInfo();
  if (!g) return (_flow = null);
  // UNA SOLA LECTURA DE REFS. Antes se preguntaba rama por rama con rev-parse --verify (develop local,
  // develop remota, main local, main remota) MAS un for-each-ref para las features: hasta 5 procesos git
  // para algo que git contesta entero de una vez. Con antivirus de endpoint cada proceso cuesta ~500ms
  // medidos. Mismo resultado, validado contra la forma antigua; lo unico que cambia es el coste.
  const refsRaw = git('for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin') || '';
  const refs = new Set(refsRaw.split(/\r?\n/).map((r) => r.trim()).filter(Boolean));
  const existe = (r) => refs.has(r);
  const developLocal = existe('refs/heads/develop');
  const developRemote = existe('refs/remotes/origin/develop');
  const features = [...refs].filter((r) => r.startsWith('refs/heads/')).map((r) => r.slice(11)).filter((b) => WORK_BRANCH_RE.test(b));
  let merged = [];
  let unmerged = features;
  if (developLocal && features.length) {
    const mergedRaw = git('branch', '--merged', 'develop') || '';
    const mergedSet = new Set(mergedRaw.split('\n').map((l) => l.replace(/^[*+ ]+/, '').trim()));
    // Ancestro directo (merge normal) O contenido ya presente (squash/rebase merge).
    const integrada = (f) => mergedSet.has(f) || integradaPorContenido(f, 'develop');
    merged = features.filter(integrada);
    unmerged = features.filter((f) => !integrada(f));
  }
  // Pendiente de aprobacion: commits de develop que aun no estan en la rama principal (main/master).
  // Issue #2: 'main' puede no existir como rama LOCAL (repo clonado y trabajado solo desde develop/feature) —
  // sin esto, mainName salia null y "aprobar" respondia "nada que aprobar" aunque el remoto llevara commits
  // pendientes. Se busca primero en local; si no esta, se cae a origin/<main|master> (ref remota, sin checkout).
  let mainName = PROTECTED_BRANCHES.find((b) => existe(`refs/heads/${b}`)) || null;
  let mainLocal = mainName !== null;
  if (!mainName) {
    const remoteMain = PROTECTED_BRANCHES.find((b) => existe(`refs/remotes/origin/${b}`)) || null;
    if (remoteMain) mainName = remoteMain;
  }
  const mainRef = mainName ? (mainLocal ? mainName : `origin/${mainName}`) : null;
  const developRef = developLocal ? 'develop' : (developRemote ? 'origin/develop' : null);
  let aheadOfMain = 0;
  // -1 = NO se pudo comparar (rev-list fallo): jamas confundirlo con 0 (nada pendiente) — es la
  // direccion peligrosa del issue #2 (el usuario cree que aprobo/publico y no ocurrio nada).
  if (mainRef && developRef) { const c = git('rev-list', '--count', `${mainRef}..${developRef}`); aheadOfMain = (c === null || c === '') ? -1 : Number(c); }
  return (_flow = {
    branch: g.branch,
    develop: developLocal || developRemote,
    developLocal,
    developRemote,
    mainName,
    mainLocal,
    mainRef,
    developRef,
    aheadOfMain,
    onProtected: isProtected(g.branch),
    onFeature: WORK_BRANCH_RE.test(g.branch),
    features,
    merged,
    unmerged,
  });
}

// Fecha efectiva de un doc: ultimo commit (git log) o, si no esta trackeado/no hay git, mtime.
const _dates = new Map();
function docDate(f) {
  if (_dates.has(f.rel)) return _dates.get(f.rel);
  let d = f.mtime;
  if (gitInfo()) {
    const g = git('log', '-1', '--format=%cI', '--', f.rel);
    if (g) { const parsed = new Date(g); if (!Number.isNaN(parsed.getTime())) d = parsed; }
  }
  _dates.set(f.rel, d);
  return d;
}

// PRECARGA EN UNA SOLA LLAMADA. docDate() pedia la fecha de UNO en UNO: en el repo motor eran 8
// procesos git por arranque de sesion (traza GIT_TRACE), y en una maquina con antivirus de endpoint
// cada proceso cuesta ~500ms medidos. 'git log --name-only' sobre TODAS las rutas a la vez devuelve
// lo mismo: la PRIMERA aparicion de cada ruta es su ultimo commit. Validado fichero a fichero contra
// la forma antigua antes de sustituirla. Lo que la tanda no resuelva cae al camino de siempre.
function precargarFechas(files) {
  if (!gitInfo()) return;
  const faltan = (files || []).filter((f) => f && f.rel && !_dates.has(f.rel)).map((f) => f.rel);
  if (faltan.length < 2) return;   // con una sola ruta no hay nada que agrupar
  const out = git('log', '--format=@%cI', '--name-only', '--no-renames', '--', ...faltan);
  if (!out) return;
  const pendientes = new Set(faltan);
  let fecha = null;
  for (const linea of out.split(/\r?\n/)) {
    if (linea.startsWith('@')) { fecha = linea.slice(1); continue; }
    const rel = linea.trim();
    if (!rel || !fecha || !pendientes.has(rel)) continue;   // primera aparicion = ultimo commit
    const d = new Date(fecha);
    if (!Number.isNaN(d.getTime())) { _dates.set(rel, d); pendientes.delete(rel); }
  }
}

const latest = (files) => { precargarFechas(files); return files.reduce((a, b) => (!a || docDate(b) > docDate(a) ? b : a), null); };

function folderLine(dir) {
  const files = listFiles(dir);
  const last = latest(files);
  const lastTxt = last ? `ultimo: ${last.name} (${fmtDate(docDate(last))})` : 'vacio';
  return `- ${dir}: ${files.length} doc(s) · ${lastTxt}`;
}

// ¿Con quien habla el harness? Rol del usuario git, FLEXIBLE al gobierno del repo:
// 1) declarado en ESTADO.md ('maintainers:', coma-separado; el resto = developer);
// 2) si no hay lista, lee el rol REAL que 'harness.js role' dejo en CACHE (~/.faro.json > rol_cache,
//    clave host/ruta, fresco 24h). ANTES caia a los CLI 'gh'/'glab', que el propio motor prohibe y que
//    en un entorno GitLab-privado no estan: el rol quedaba siempre indeterminado. developer NO toca main.
let _rol;
function resolveRole(offlineOnly) {
  if (_rol !== undefined) return _rol;
  const g = gitInfo();
  if (!g) return (_rol = null);
  const ini = parseEstado();
  const maints = ((ini && (ini.fm.maintainers || ini.fm.aprobadores)) || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (maints.length) {
    const esM = maints.some((a) => a.toLowerCase() === (g.user || '').toLowerCase());
    return (_rol = { rol: esM ? 'maintainer' : 'developer', via: ESTADO_FILE, maints });
  }
  if (offlineOnly) return null; // sin cachear: puede resolverse despues
  const c = rolCacheado();
  if (c) return (_rol = { rol: c.rol, via: `${c.forja} (${c.detalle}, cache de harness.js role)`, maints: [] });
  return (_rol = null);
}
// Rol cacheado por 'harness.js role' (ambas forjas lo escriben con la misma clave host/ruta).
// Fresco 24h: el rol de una persona no cambia entre dos sesiones, y si cambia, 'role' lo refresca.
function rolCacheado() {
  try {
    const d = require('./forge.js').detect(git);
    if (!d.host || !d.path) return null;
    const cfg = require('./credenciales.js')().leerCfg();   // misma ruta y mismas reglas que todo el motor
    const e = cfg && cfg.rol_cache && cfg.rol_cache[`${d.host}/${d.path}`];
    if (!e || !e.rol || !e.ts || (Date.now() - e.ts) > 24 * 3600 * 1000) return null;
    return e;
  } catch { return null; }
}

function gitLines(compact, opts = {}) {
  // opts.indice (#127): el arranque como INDICE. Se queda lo que PROTEGE (rama, rol, plataforma,
  // proteccion) y sale lo que EXPLICA un procedimiento general (integrar, protocolo de ramas, listas
  // de features): eso va en 'harness.js estado'.
  const indice = !!opts.indice;
  const g = gitInfo();
  if (!g) {
    const f = ultimoFalloGit();
    if (f && f.tipo === 'timeout') return [`Git: NO PUDE LEER EL REPO — ${f.detalle}. NO significa que falte git: es lentitud (antivirus de endpoint, disco o red). Reintenta; si se repite, mide con: node -e "console.time('g');require('child_process').execFileSync('git',['status']);console.timeEnd('g')".`];
    if (f && f.tipo === 'sin-git-instalado') return ['Git: el ejecutable git NO esta en el PATH. Instalalo o anadelo al PATH; el repo puede estar perfectamente.'];
    if (f && f.tipo === 'error-git') return [`Git: ${f.detalle}. Revisa a mano con: git -C "${ROOT}" status.`];
    return ['Git: repo sin git (recomendado: git init + rama develop + commit por cambio documental).'];
  }
  const flow = gitFlow();
  const docsTxt = g.dirtyDocs.length ? ` (${g.dirtyDocs.length} documental/es)` : '';
  const lines = [`Git: rama '${g.branch}'${g.user ? ` · usuario: ${g.user}` : ''} · ${g.dirty} cambio(s) sin commitear${docsTxt}.`];
  // IDENTIDAD + ROL — se emite en el ARRANQUE, no en cada turno: el rol de una persona no cambia
  // entre el primer prompt de la sesion y el ultimo, asi que repetirlo es texto identico a coste
  // completo. Medido: este bloque + los tres siguientes eran el 94% de la inyeccion por prompt.
  const rr0 = !compact ? resolveRole(true) : null;
  if (compact) { /* el arranque ya lo dijo */ } else if (rr0) {
    lines.push(`Identidad: ${g.user || '(sin user.name)'} · Rol: ${rr0.rol.toUpperCase()} (${rr0.via}) — main/master/develop vetados a TODOS (tambien owner/admin): se TRABAJA en <tipo>/<slug> y todo entra por PR a develop.${rr0.rol === 'maintainer' ? ' Tu rol NO te exime del flujo: te habilita a CONSOLIDAR (/faro:consolidar -> develop) y APROBAR (/faro:publicar -> main).' : ' Tu solo lanzas /faro:pr; consolidar/aprobar los aplica un admin/owner/maintainer.'}`);
  } else if (indice) {
    lines.push(
      `Identidad: ${g.user || '(sin user.name — fija git config user.name)'} · Rol: SIN DETERMINAR — antes de CONSOLIDAR o PUBLICAR consulta el rol real: ` +
      'node .claude/hooks/harness.js role (si SIN_TOKEN -> node .claude/hooks/harness.js auth). main/master/develop vetados a escritura directa para TODOS; ' +
      '/faro:consolidar y /faro:publicar solo si puedeAprobar (admin/owner/maintainer); el resto lanza /faro:pr.',
    );
  } else {
    // Sin lista 'maintainers:' declarada: el rol REAL se resuelve por el TOKEN DEL HARNESS (no CLI gh).
    lines.push(
      `Identidad: ${g.user || '(sin user.name — fija git config user.name)'} · Rol: SIN DETERMINAR aun en contexto. ` +
      `ANTES de cualquier CONSOLIDACION o APROBACION (o si dudas de quien eres), CONSULTA el rol REAL: node .claude/hooks/harness.js role ` +
      `(usa el token del harness ~/.faro.json y devuelve org/repo/perm/puedeAprobar; si SIN_TOKEN -> node .claude/hooks/harness.js auth, codigo de 6 digitos). ` +
      `Regla: main/master/develop vetados a escritura directa para TODOS; /faro:consolidar y /faro:publicar solo si puedeAprobar (admin/owner/maintainer); el resto lanza /faro:pr.`,
    );
  }
  // PLATAFORMA: todo lo que sigue depende de QUE FORJA hay detras de origin. Antes se afirmaba
  // GitHub sin mirar, y en un repo de GitLab el agente recibia ordenes imposibles de cumplir.
  const _forge = require('./forge.js');
  const f = _forge.detect(git);
  const cap = _forge.capacidades(f.forge);

  // TAREAS ASIGNADAS: solo tiene sentido anunciarlo donde el harness sabe leerlas (hoy, GitHub).
  if (cap.tareas && !compact && indice) {
    lines.push('Tareas asignadas: las tuyas con `node .claude/hooks/harness.js mis-tareas`; asignar a alguien: `harness.js asignar-tarea "<titulo>" <login> --tipo <tipo>` ' +
      `(--tipo OBLIGATORIO: ${labelSlugs().join(' · ')}; si dudas, PREGUNTA con AskUserQuestion).`);
  } else if (cap.tareas && !compact) {
    lines.push('Tareas asignadas: si quieres saber que tienes pendiente asignado en esta repo, consulta `node .claude/hooks/harness.js mis-tareas` (issues de GitHub asignados a ti; --all incluye cerradas). Asignar trabajo a alguien del equipo = `harness.js asignar-tarea "<titulo>" <login> [<slug-change>] ["<cuerpo>"] --tipo <tipo>` (le llega email de GitHub). El `--tipo` es OBLIGATORIO: TODO issue lleva label. Tipos: ' + labelSlugs().join(' · ') + '. Si dudas entre dos, PREGUNTA con AskUserQuestion; no adivines. Prioridad/transversal aparte con `--extra urgente|riesgo|compliance|seguridad`. Un issue = una TAREA (no un bug).');
  }

  // REGLA DE PLATAFORMA — SIEMPRE inyectada (no solo con /faro:pr): un PR pedido en lenguaje llano
  // NO debe caer al CLI `gh` en GitHub, ni a una API inexistente en GitLab. La linea la sirve el
  // modulo de forja, que es quien sabe que esta soportado en cada una.
  // La regla de plataforma ya NO se repite por turno: en el turno la hace cumplir el GATE
  // determinista de PreToolUse (preBashPlataformaIssue), que cuesta CERO tokens y no se puede
  // ignorar. Aqui se conserva integra como CONTEXTO del arranque.
  if (!compact) lines.push(_forge.reglaPlataforma(f));

  if (NO_INSTANCIA) {
    lines.push(`MODO TEMPLATE: commit directo en '${g.branch}' permitido (el ciclo feature->develop->main aplica a las instancias).`);
    return lines;
  }
  if (!compact) {
  if (isProtected(g.branch)) {
    // En el TURNO no se repite: cmdPromptContext emite su propio "radar de rama" (una linea, el
    // aviso de seguridad) y esto es su desarrollo largo, que ya se dio al arrancar la sesion.
    lines.push(
      `PROTECCION '${g.branch}': es el ARCHIVO DE LO APROBADO (solo LECTURA/APROBACION), NO un sitio de trabajo — NADIE escribe aqui, tampoco tu (el harness lo BLOQUEA). Se llega SOLO por merge de un PR aprobado (= la aprobacion, la aplica el usuario/maintainer).`,
    );
    lines.push(
      `Si te piden GENERAR o ESCRIBIR algo estando en '${g.branch}' (informe, one-pager, documento, codigo): NO es un problema ni "va por encima" de develop, y NO se lo traslades al usuario como bloqueo — CAMBIATE TU a develop (git switch develop), generalo ahi, y llegara a '${g.branch}' con la proxima aprobacion. Es la mecanica normal, la resuelves tu.`,
    );
    lines.push(
      `Lo que SI se hace en '${g.branch}' (solo lectura): consultar estado y VALIDAR PRs pendientes. OFRECE analizarlos ('hay PRs hacia ${g.branch}, ¿los reviso?') con /faro:pr -> detecta los PRs con 'node .claude/hooks/harness.js pr ${g.branch}' (formateado; sin node -e) (si SIN_TOKEN, OFRECE conectar: node .claude/hooks/harness.js auth -> codigo de 6 digitos para el navegador), EXPLICA en llano, VALIDA (cobertura, riesgos, gaps frente a codigo/fuentes) y recomienda; el merge (=aprobacion) lo confirma un maintainer.`,
    );
    lines.push(
      flow && flow.develop
        ? 'Cambia ahora: git switch develop (integracion) · git switch -c feature/<tema> (trabajo aislado).'
        : 'Falta develop: crea el ciclo -> git switch -c develop (luego git push -u origin develop), despues git switch -c feature/<tema>.',
    );
  } else if (g.branch === 'develop') {
    lines.push(`Estas en develop (INTEGRACION): NO se edita a mano aqui (ni tu, ni owner/admin/maintainer). Para trabajar, abre una rama de cambio: node .claude/hooks/harness.js rama <tipo> "<tema>" (tipos: ${BRANCH_TYPES.filter((t) => t !== 'feature').join('/')}). El trabajo entra a develop por /faro:consolidar (rol) y develop->main por /faro:publicar (rol).`);
  } else if (WORK_BRANCH_RE.test(g.branch)) {
    // RAMA DE TRABAJO valida <tipo>/<slug>: aqui SI se trabaja. Al terminar -> enviar a develop con /faro:pr.
    lines.push(`Estas en '${g.branch}' (rama de trabajo): OK para editar/commitear aqui. Cuando el trabajo este listo, ENVIALO a develop abriendo el PR con /faro:pr (cualquiera puede lanzarlo). NO mergees a develop a mano: eso lo hace un rol con /faro:consolidar.`);
  } else if (!WORK_BRANCH_RE.test(g.branch)) {
    // Rama que NO encaja en el ciclo git-flow FARO (ni main/master, ni develop, ni <tipo>/*): avisa y reconduce.
    lines.push(
      `ATENCION rama '${g.branch}': NO sigue la convencion del flujo FARO. El trabajo aislado va en una rama de cambio ` +
      `<tipo>/<slug> (tipos: ${BRANCH_TYPES.filter((t) => t !== 'feature').join('/')}) y la integracion en develop — no trabajes suelto en una rama fuera del ciclo.`,
    );
    lines.push(
      flow && flow.develop
        ? `Reconducelo (confirma con el usuario): node .claude/hooks/harness.js rama <tipo> "<tema>" (crea <tipo>/<slug> desde develop) · git branch -m <tipo>/<slug> (renombra ESTA, conserva el trabajo) · o git switch develop.`
        : `Falta develop: crea el ciclo -> git switch -c develop (luego git push -u origin develop) y abre la rama de cambio con node .claude/hooks/harness.js rama <tipo> "<tema>".`,
    );
  }

  }   // fin del envoltorio !compact de la clasificacion de rama

  if (flow && !flow.develop && !compact) {
    lines.push("ATENCION git-flow: no existe la rama 'develop' (integracion), que el flujo feature->develop->main necesita. Crearla (con confirmacion del usuario): git switch -c develop && git push -u origin develop.");
  }
  // Integrar una rama de cambio: NUNCA a ciegas. Vale para TODOS (tambien owner/admin): todo entra por PR a develop.
  if (flow && flow.onFeature && !compact && !indice) {
    lines.push(
      `Integrar '${g.branch}' -> develop: NO a ciegas. 1) VALIDA (node .claude/hooks/harness.js validate + revisor-code/auditor). ` +
      `2) Entra por PR a develop (recomendado: /faro:pr / gestor-forja abre el PR con base=develop) o, sin revision formal, merge VALIDADO que ejecuta el USUARIO: git switch develop && git merge --no-ff ${g.branch} && git push. ` +
      `Aplica a TODOS, tambien owner/admin (el rol solo decide quien aprueba). Luego limpia: git branch -d ${g.branch}.`,
    );
  }
  if (flow && flow.merged && flow.merged.length && !compact && !indice) {
    lines.push(`Features ya integradas en develop (candidatas a borrado): ${flow.merged.map((f) => `git branch -d ${f}`).join(' · ')}.`);
  }
  if (flow && flow.aheadOfMain > 0) {
    lines.push(
      `PENDIENTE DE VALIDACION: develop ⇡${flow.aheadOfMain} commit(s) sobre ${flow.mainName}. ` +
      `¿Preparo la "peticion de validacion" (en llano; "(PR)" para el que sepa)? -> /faro:pr analiza los commits vs ${flow.mainName} CON CONTEXTO (que se ha hecho, agrupado por item legible) y redacta la peticion AMIGABLE para quien aprueba (no tecnico), dejandole elegir el alcance (todo o parte). ` +
      `El merge (=aprobacion/validacion) lo confirma un maintainer: git switch ${flow.mainName} && git merge --no-ff develop && git push.`,
    );
  }
  if (flow && flow.unmerged && flow.unmerged.length && !compact && !indice) {
    lines.push(`Features SIN integrar en develop: ${flow.unmerged.join(', ')} — integralas con merge parcial cuando esten listas.`);
  }

  if (!compact && !indice) {
    lines.push(
      'Protocolo de ramas: feature/<tema> (trabajo) -> develop (integracion) -> main/master (validacion/aprobacion). ' +
      'REGLAS del ciclo: Claude PUEDE commitear en develop/feature Y mergear feature->develop; ' +
      'las ramas principales (main/master) NUNCA se commitean directo (el harness lo bloquea) y su merge/push es la APROBACION -> ' +
      'Claude PREPARA el comando exacto y AVISA para que lo aplique el usuario. Commit por cambio documental · tag fase-<N> al cerrar fase.',
    );
  }
  return lines;
}

function tagLines() {
  const ini = parseEstado();
  if (!gitInfo() || !ini) return [];
  const missing = ini.fases.filter((f) => isDone(f.estado) && !git('tag', '--list', `fase-${f.num}`));
  return missing.length
    ? [`Tags pendientes de fase cerrada: ${missing.map((f) => `git tag fase-${f.num}`).join(' · ')} (crear en main validado).`]
    : [];
}


// publicarRamaSiHaceFalta: la forja NO puede abrir una peticion desde una rama que nunca ha visto.
// Antes, 'pr crear' llamaba a la API sin comprobarlo: fallaba SIEMPRE la primera vez y funcionaba
// tras un 'git push -u' a mano — se vivia como "error transitorio, reintento", pero lo que arreglaba
// no era repetir, era el push que se colaba en medio. Aqui se hace ese push como parte del flujo.
// Tambien empuja si la rama existe en el remoto pero se quedo atras: el PR debe ver el trabajo
// COMPLETO, no el de hace tres commits.
function publicarRamaSiHaceFalta(rama) {
  if (!rama) return { ok: false, msg: 'sin rama' };
  const remoto = git('remote', 'get-url', 'origin');
  if (!remoto) return { ok: false, msg: "no hay remoto 'origin' configurado: no se puede publicar la rama ni abrir la peticion." };
  // ¿Esta ya publicada Y al dia? Se compara el commit local con el del remoto ya conocido.
  const local = git('rev-parse', rama);
  const enRemoto = git('rev-parse', `origin/${rama}`);   // null si el remoto no la tiene
  if (enRemoto && local && enRemoto === local) return { ok: true, publicada: false };
  // lib/subir.js (#194): si el push normal falla por credenciales/red, reintenta con el token del harness.
  const r = require('./subir.js')([rama], { ROOT, upstream: true });
  if (!r.ok) return { ok: false, msg: `no pude publicar la rama '${rama}' en origin: ${r.msg}` };
  return { ok: true, publicada: true };
}

// ramaEsSoloGestion: ¿esta rama solo toca artefactos de GESTION (cierre de ciclo) o tambien trabajo?
// Se decide por lo que CAMBIA, no por el prefijo de la rama: un 'chore/' puede acabar tocando src/
// (y entonces es trabajo) y un 'docs/' puede ser solo un informe de cierre de fase (y entonces no).
// Gestion = el rastro del propio ciclo: gestion/, CHANGELOG.md, ESTADO.md y el fichero de version.
// Todo lo demas —codigo, hooks, tests, documentos controlados— es trabajo y necesita su tarea.
// Sin diff (rama sin cambios) NO se afirma que sea gestion: no hay evidencia, y eximir sin evidencia
// abriria justo el hueco que este gate cierra.
// MONOREPO (#131): el CHANGELOG.md de una app (apps/x/CHANGELOG.md) es gestion igual que el de la
// raiz. Su package.json, en cambio, es a la vez el fichero de VERSION y el de DEPENDENCIAS/scripts:
// un package.json ANIDADO solo cuenta como gestion si su diff no toca mas que la linea "version"
// (el bump de release de esa app); cambiar una dependencia o un script es trabajo y pide su tarea.
// El package.json de la RAIZ y los plugin.json mantienen su trato de siempre (fichero de version del
// repo/motor): endurecerlos cambiaria el comportamiento de los repos simples, fuera de alcance.
const RUTAS_GESTION = [
  /^gestion\//,
  /(^|\/)CHANGELOG\.md$/i,
  /^ESTADO\.md$/i,
  /^INICIATIVA\.md$/i,
  /^package\.json$/,
  /(^|\/)\.claude-plugin\/plugin\.json$/,
];
const PACKAGE_ANIDADO = /\/package\.json$/;
function soloCambiaVersion(base, fichero) {
  const d = git('diff', '--unified=0', `${base}...HEAD`, '--', fichero);
  if (d === null) return false;
  const lineas = d.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)\s/.test(l));
  return lineas.length > 0 && lineas.every((l) => /^[+-]\s*"version"\s*:\s*"[^"]*"\s*,?\s*$/.test(l));
}
function ramaEsSoloGestion(base = 'develop') {
  const salida = git('diff', '--name-only', `${base}...HEAD`);
  if (!salida) return false;                       // sin diff (o git fallo): no se exime
  const ficheros = salida.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!ficheros.length) return false;
  return ficheros.every((f) => RUTAS_GESTION.some((re) => re.test(f)) || (PACKAGE_ANIDADO.test(f) && soloCambiaVersion(base, f)));
}

  return { git, gitWrite, ultimoFalloGit, limpiarIndexLockHuerfano, gitInfo, ramaActual, lastCommitOf, gitFlow, invalidarFlow, docDate, latest, folderLine, resolveRole, gitLines, tagLines, publicarRamaSiHaceFalta, ramaEsSoloGestion, docsSinCommitear };
};

// 'rama <tipo> "<tema>" --issue N' bautiza la rama '<tipo>/<N>-<slug>': el numero del issue viaja
// EN EL NOMBRE, asi que no hace falta guardar estado en ningun sitio para recuperarlo despues.
// Exige el '-' tras los digitos (o que sean todo el segmento) para no confundir un slug que empieza
// por numero — 'feat/2fa-login' no esta anclada al issue 2.
const issueDeRama = (rama) => {
  const m = String(rama || '').match(/^[^/]+\/(\d+)(?:-|$)/);
  return m ? m[1] : null;
};

// La forja solo cierra el issue al fusionar si el CUERPO lo dice: sin esta frase el PR entra, el
// trabajo se integra y el issue se queda abierto para siempre (paso de verdad, hubo que cerrar uno a
// mano). Idempotente: si ese cierre ya esta declarado, no lo repite. Y si el cuerpo dice 'Refs #N'
// (avanza la tarea, no la termina: #91), no se le impone un cierre que el autor no ha pedido.
const conCierreDeIssue = (cuerpo, rama) => {
  const n = issueDeRama(rama);
  if (!n) return cuerpo;
  if (require('./tarea.js').soloReferencia({ body: cuerpo }, n)) return cuerpo;
  const ya = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${n}\\b`, 'i');
  if (ya.test(cuerpo || '')) return cuerpo;
  return `${(cuerpo || '').trimEnd()}${cuerpo ? '\n\n' : ''}Closes #${n}`;
};

module.exports.issueDeRama = issueDeRama;
module.exports.conCierreDeIssue = conCierreDeIssue;

// DESFASE entre lo local y el remoto en las ramas de INTEGRACION (main/develop).
//
// Por que solo esas dos: son compartidas. Si tu copia de develop lleva doce commits de retraso,
// estas construyendo sobre una base que ya no existe y no te enteras hasta el merge. Tu rama de
// trabajo por DELANTE del remoto, en cambio, es lo normal — es trabajo tuyo sin subir todavia, y
// avisar de eso seria ruido en cada sesion.
//
// Tampoco se avisa de ir por DELANTE en main/develop: eso solo pasa tras publicar y antes de empujar
// (una ventana de segundos), y el propio 'publicar' ya lo sube. Lo que duele es ir por DETRAS.
//
// Logica PURA: recibe los conteos ya medidos y decide que decir. Sin esto, probar los casos raros
// (sin remoto, sin fetch, rama que no existe) exigiria montar repos con estados imposibles.
function desfaseIntegracion(estados) {
  const avisos = [];
  for (const e of estados || []) {
    if (!e || !e.rama) continue;
    // null = no se pudo comparar (sin rama remota, sin fetch). "No lo se" NO es "estas al dia":
    // callarlo aqui seria dar por bueno algo que nadie comprobo.
    if (e.detras === null || e.detras === undefined) {
      if (e.motivo) avisos.push(`no pude comparar '${e.rama}' con su remoto (${e.motivo}): no se si estas al dia.`);
      continue;
    }
    if (e.detras > 0) {
      avisos.push(`'${e.rama}' va ${e.detras} commit(s) POR DETRAS de origin/${e.rama}: ` +
        'estas trabajando sobre una base vieja. Traelo antes de seguir — harness.js sincronizar.');
    }
  }
  return avisos;
}
module.exports.desfaseIntegracion = desfaseIntegracion;

// FICHEROS SIN VERSIONAR (#117): las lineas '??' de 'git status --porcelain'. consolidar y publicar las
// commiteaban con 'add -A' y las subian sin que nadie lo decidiera (caso real: exports locales de n8n con
// configuracion propia acabaron en develop y en main). Un fichero que nadie ha decidido versionar NO
// entra solo: se para y se dice cuales son. Pura: recibe la salida de porcelain.
function ficherosSinVersionar(porcelain) {
  return String(porcelain || '').split(/\r?\n/)
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));
}
module.exports.ficherosSinVersionar = ficherosSinVersionar;

function avisoSinVersionar(lista, accion) {
  return [
    `\n${accion} PARADA: hay ${lista.length} fichero(s) SIN VERSIONAR en la copia local, y no los voy a meter en el repo sin que lo decidas:`,
    ...lista.slice(0, 15).map((f) => `  · ${f}`),
    ...(lista.length > 15 ? [`  · (+${lista.length - 15} mas)`] : []),
    '  Si deben ir al repo: commitealos en una rama de trabajo y entran por su PR.',
    '  Si son locales (exports, pruebas, configuracion propia): anadelos a .gitignore.',
    '  Luego reintenta.',
  ].join('\n');
}
module.exports.avisoSinVersionar = avisoSinVersionar;
