// lib/alcance.js — RESTRICCIONES DE ALCANCE (#150). El agente solo modifica el repo de la sesion y sus
// worktrees; en un repo ajeno la via es abrir un ISSUE, y la forja solo se toca en la organizacion
// del remoto de la sesion. Leer repos ajenos esta permitido.
//
// ES UNA RED CONTRA ACCIDENTES E INYECCIONES DE INSTRUCCIONES, NO UNA FRONTERA DE SEGURIDAD: analizar
// texto deja rendijas (un interprete como `node -e` o `python -c` escribe donde quiera). La frontera
// real son los permisos de Claude Code y el alcance del token. Por eso el criterio es FALLAR CERRADO:
//   · deny  = esta PROBADO que el destino es otro repo;
//   · ask   = hay indicio de otro destino que no se puede resolver con certeza a un repo propio
//             (el humano decide; nunca un allow silencioso);
//   · null  = propio, worktree propio, o fuera de cualquier repo.
// Todo error (excepcion, entrada que no es texto, git no disponible, ruta irresoluble, texto que no se
// parsea del todo) acaba en ask o deny; las entradas publicas estan envueltas en try/catch.
//
// SI cubre: pre-doc (Write/Edit/MultiEdit con ruta real), git hacia otro repo (-C, --git-dir,
// --work-tree, GIT_*, cd previos; hacia otro repo solo se aceptan status, log, diff, show, rev-parse,
// branch, ls-files, remote y describe sin opciones que escriban o ejecuten), las redirecciones simples
// > y >> a una ruta resoluble, el transporte gh (organizacion y escrituras) y asignar-tarea --repo.
// NO cubre: interpretes (node -e, python -c), herramientas sueltas (rm, cp, mv, find, tar, curl, sed -i…)
// con destino en otro repo, aliases de git, enlaces creados durante la propia orden ni forjas distintas
// de GitHub. LIMITES CONOCIDOS de lo que SI se mira: `xargs git …`, `find -exec git …` y `parallel git …`
// no se pueden resolver (el destino lo pone la entrada) y por eso piden confirmacion (ask) en cuanto
// aparece `git`; `cp`/`mv`/`tee`/`sed -i`/`dd of=` no se vigilan sobre la configuracion del repo (es libre, #238). Una
// invocacion con escape (`\git`) se analiza como `git`; `command git` y `env git` tambien.
//
// Diferenciales guard/shell cerrados tras revision: la palabra de la orden se lee con los escapes del shell
// (`g\it` es git), una variable/sustitucion como orden con argumentos de git pide confirmacion, los
// envoltorios con opciones con valor (sudo -u, nice -n, timeout -s…) se re-anclan en el git que sigue,
// `env -S`, `>& fichero`, sustituciones en heredocs sin comillas, lanzadores de PowerShell y las rutas
// destino que git escribe (push <ruta>, --output/-o/--prefix/--file/--directory, bundle create).
// Escapes: una barra invertida sin comillas se analiza con las DOS lecturas (separador de ruta de PowerShell/cmd y
// escape de bash) y gana la peor; `~usuario` no se resuelve (ask).
// SIGUE SIN CUBRIRSE (limite aceptado): lo que depende de variables sin resolver en redirecciones (`> $OUT`),
// llaves de shell (`{a,b}`), contenedores/ssh/watch/script, y interpretes (node -e, python -c), scripts (`bash x.sh`, source),
// aliases/funciones definidos fuera de la orden, `git config --global` y tee/cp/mv hacia otro repo.
//
// LISTA BLANCA faro/config.json (o .faro.json sin migrar, #293) > alcance: el fichero es LIBRE (#238) — ni pre-doc
// ni pre-bash piden confirmacion por editarlo o mencionarlo; lo fija test/restricciones-alcance.test.mjs. El control
// esta en la revision humana del PR que toque la configuracion, no en este hook.
//
// Modulo autonomo (sin ctx): lo cargan directo pre-doc, pre-bash, el transporte `gh` y asignar-tarea.
// Determinista, sin shell (execFile con windowsHide).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// org/repo: sin segmentos '.' ni '..' (no son nombres de repo y alimentan rutas de API como repos/org/..)
const RE_REPO = /^(?!\.{1,2}\/)(?!.*\/\.{1,2}$)[\w.-]+\/[\w.-]+$/;
const WIN = process.platform === 'win32';
const CI = WIN || process.platform === 'darwin';        // sistemas de ficheros que ignoran mayusculas

const clave = (p) => {
  const r = path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
  return CI ? r.toLowerCase() : r;
};
const dentroDe = (base, p) => { const b = clave(base), q = clave(p); return q === b || q.startsWith(b + '/'); };

function git(cwd, ...args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch { return null; }
}

// ───────────────────────── rutas ─────────────────────────

/**
 * Normaliza lo que el sistema de ficheros normalizaria: prefijos extendidos (\\?\ y \\.\), puntos y
 * espacios finales de Windows, barras. {abs, unc, incierto}: `incierto` = motivo si la ruta no se puede
 * resolver con certeza (C:foo relativa a la unidad, flujos alternos NTFS, NUL).
 */
function normalizarRuta(root, ruta) {
  let s = String(ruta);
  if (s.includes('\0')) return { abs: path.resolve(root), unc: false, incierto: 'la ruta contiene un caracter nulo' };
  let unc = false;
  if (WIN) {
    s = s.replace(/\//g, '\\');
    s = s.replace(/^\\\\[?.]\\UNC\\/i, '\\\\').replace(/^\\\\[?.]\\/, '');
    unc = /^\\\\[^\\]/.test(s);
    if (/^[A-Za-z]:(?![\\/])/.test(s)) return { abs: path.resolve(root), unc, incierto: 'ruta relativa a una unidad (C:foo)' };
    const trozos = s.split('\\');
    for (let k = 0; k < trozos.length; k++) {
      const t = trozos[k];
      if (k > 0 && t.includes(':')) return { abs: path.resolve(root), unc, incierto: 'ruta con flujo alterno NTFS' };
      if (t !== '.' && t !== '..') trozos[k] = t.replace(/[. ]+$/, '');   // Win32 ignora puntos y espacios finales
    }
    s = trozos.join('\\');
  }
  return { abs: path.resolve(root, s), unc, incierto: null };
}

/** Ruta real (enlaces simbolicos, junctions, nombres 8.3) del primer ancestro existente + el resto. */
function rutaReal(p) {
  let d = path.resolve(p);
  const resto = [];
  for (let i = 0; i < 80; i++) {
    try {
      const r = (fs.realpathSync.native || fs.realpathSync)(d);
      return resto.length ? path.join(r, ...resto.reverse()) : r;
    } catch { /* no existe: sube */ }
    const padre = path.dirname(d);
    if (padre === d) return path.resolve(p);
    resto.push(path.basename(d));
    d = padre;
  }
  return path.resolve(p);
}

const esRepoDesnudo = (d) => { try { return fs.existsSync(path.join(d, 'HEAD')) && fs.existsSync(path.join(d, 'objects')) && fs.existsSync(path.join(d, 'refs')); } catch { return false; } };

/** Raiz del repo git que contiene la ruta (sube hasta `.git`, fichero o carpeta, o un repo desnudo). Tolera rutas que aun no existen. null si no hay. */
function repoDeRuta(ruta, base) {
  let d = path.resolve(base || process.cwd(), String(ruta || ''));
  for (let i = 0; i < 80; i++) {
    try { if (fs.existsSync(path.join(d, '.git')) || esRepoDesnudo(d)) return d; } catch { /* sigue subiendo */ }
    const p = path.dirname(d);
    if (p === d) return null;
    d = p;
  }
  return null;
}

const _comun = new Map();
/** git-common-dir ABSOLUTO y resuelto del repo cuya raiz es `raiz` (null si git no responde). */
function comunDe(raiz) {
  const k = clave(raiz);
  if (_comun.has(k)) return _comun.get(k);
  let c = git(raiz, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!c) { const rel = git(raiz, 'rev-parse', '--git-common-dir'); c = rel ? path.resolve(raiz, rel) : null; }
  let r = null;
  if (c) { try { r = (fs.realpathSync.native || fs.realpathSync)(c); } catch { r = path.resolve(c); } }
  _comun.set(k, r);
  return r;
}

/** ¿`a` y `b` (rutas dentro de un repo) son el MISMO repositorio (mismo git-common-dir, worktrees incluidos)? */
function mismoRepo(a, b) {
  const ra = repoDeRuta(a), rb = repoDeRuta(b);
  if (!ra || !rb) return false;
  if (clave(ra) === clave(rb)) return true;
  const ca = comunDe(ra), cb = comunDe(rb);
  return !!ca && !!cb && clave(ca) === clave(cb);
}

/** {org, repo} del remoto `origin` del repo, o null (sin remoto, ruta local o forja desconocida). */
function slugDelRemoto(root) {
  const url = git(root, 'remote', 'get-url', 'origin');
  if (!url) return null;
  const f = require('./forge.js').detect(url);
  return f && f.owner && f.project ? { org: f.owner, repo: f.project, forge: f.forge } : null;
}
function organizacionDelRemoto(root) { const s = slugDelRemoto(root); return s ? s.org : null; }
function esOrganizacionPropia(root, org) {
  const propia = organizacionDelRemoto(root);
  return !!propia && !!org && propia.toLowerCase() === String(org).toLowerCase();
}

/** faro/config.json > alcance. repos_permitidos: solo entradas con forma org/repo. */
function leerAlcance(root) {
  try {
    const j = JSON.parse(fs.readFileSync(require('./config-repo.js').rutaAbs(root), 'utf8'));
    const a = j && typeof j.alcance === 'object' && j.alcance ? j.alcance : {};
    return { repos_permitidos: Array.isArray(a.repos_permitidos) ? a.repos_permitidos.filter((x) => typeof x === 'string' && RE_REPO.test(x)) : [] };
  } catch { return { repos_permitidos: [] }; }
}
function validarConfig(root, { schema } = {}) {
  let j;
  try { j = JSON.parse(fs.readFileSync(require('./config-repo.js').rutaAbs(root), 'utf8')); } catch { return []; }
  if (!j || j.alcance === undefined) return [];
  const claves = (schema && schema.enums && schema.enums.alcance && schema.enums.alcance.claves) || ['repos_permitidos'];
  const a = j.alcance;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return ['"alcance" debe ser un objeto: { "repos_permitidos": ["org/repo"] }.'];
  const w = [];
  for (const k of Object.keys(a)) if (!claves.includes(k)) w.push(`"alcance.${k}" no es una clave conocida (validas: ${claves.join(', ')}).`);
  if (a.repos_permitidos !== undefined) {
    if (!Array.isArray(a.repos_permitidos)) w.push('"alcance.repos_permitidos" debe ser una lista de "org/repo".');
    else for (const r of a.repos_permitidos) if (typeof r !== 'string' || !RE_REPO.test(r)) w.push(`"alcance.repos_permitidos": ${JSON.stringify(r)} no tiene forma org/repo.`);
  }
  return w;
}

// Config de Claude Code (memoria, ajustes): no es un repo de trabajo aunque el HOME cuelgue de uno.
function esConfigClaude(abs) {
  const dirs = [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.claude')].filter(Boolean);
  return dirs.some((d) => dentroDe(d, abs) || dentroDe(rutaReal(d), abs));
}

/**
 * Evalua una ruta frente al repo de la sesion. null = permitida (propia, worktree propio, fuera de
 * cualquier repo, config de Claude o repo hermano autorizado). Si no:
 *   {estado:'ajena', raiz, slug, nombre}   esta PROBADO que es de otro repo
 *   {estado:'incierta', motivo}            no se puede resolver con certeza (el llamador pide confirmacion)
 * Resuelve enlaces simbolicos, junctions y nombres 8.3 con la ruta real del primer ancestro existente.
 */
function evaluarRutaInterna(root, ruta, opts = {}) {
  if (!root || ruta === undefined || ruta === null || ruta === '') return null;
  const n = normalizarRuta(root, ruta);
  if (n.incierto) return { estado: 'incierta', motivo: n.incierto, nombre: String(ruta) };
  const realRoot = rutaReal(root);
  const real = rutaReal(n.abs);
  if (dentroDe(realRoot, real)) return null;
  if (esConfigClaude(real) || esConfigClaude(n.abs)) return null;
  const sesion = repoDeRuta(realRoot);
  if (!sesion) return null;                              // la sesion no es un repo git: nada que acotar
  const raiz = repoDeRuta(real);
  if (!raiz) return n.unc ? { estado: 'incierta', motivo: 'ruta de red (UNC) que no se puede comprobar', nombre: String(ruta) } : null;
  if (clave(raiz) === clave(sesion)) return null;
  const ca = comunDe(sesion), cb = comunDe(raiz);
  if (!ca || !cb) return { estado: 'incierta', motivo: 'no se pudo comprobar con git a que repo pertenece', nombre: path.basename(raiz) };
  if (clave(ca) === clave(cb)) return null;
  const s = slugDelRemoto(raiz);
  const permitidos = opts.permitidos || leerAlcance(root).repos_permitidos;
  if (s && permitidos.some((p) => p.toLowerCase() === `${s.org}/${s.repo}`.toLowerCase())) return null;
  return { estado: 'ajena', raiz, slug: s ? `${s.org}/${s.repo}` : null, nombre: path.basename(raiz) };
}
const incierta = (motivo, nombre) => ({ estado: 'incierta', motivo, nombre: String(nombre === undefined ? '' : nombre) });
/** Entrada publica: cualquier error o entrada que no es texto acaba en 'incierta' (el llamador pide confirmacion), nunca en null. */
function evaluarRuta(root, ruta, opts) {
  try {
    if (ruta === undefined || ruta === null || ruta === '') return null;
    if (typeof ruta !== 'string' || typeof root !== 'string' || !root) return incierta('la ruta no es texto', typeof ruta);
    return evaluarRutaInterna(root, ruta, opts || {});
  } catch (e) { return incierta(`error interno al resolver la ruta (${(e && e.message) || e})`, ruta); }
}
function evaluarGitDir(root, gd, opts) {
  try { return evaluarGitDirInterna(root, gd, opts || {}); } catch (e) { return incierta(`error interno al resolver el git-dir (${(e && e.message) || e})`, gd); }
}
function esRutaAjena(root, ruta, opts) { const r = evaluarRuta(root, ruta, opts); return !!r && r.estado === 'ajena'; }

/** Como evaluarRuta pero para `--git-dir`/GIT_COMMON_DIR (puede ser un repo desnudo): lo que no se pueda probar propio es incierto. */
function evaluarGitDirInterna(root, gd, opts = {}) {
  const n = normalizarRuta(root, gd);
  if (n.incierto) return { estado: 'incierta', motivo: n.incierto, nombre: String(gd) };
  const realRoot = rutaReal(root), real = rutaReal(n.abs);
  if (dentroDe(realRoot, real)) return null;
  const sesion = repoDeRuta(realRoot);
  if (!sesion) return null;
  const com = comunDe(sesion);
  if (com && dentroDe(com, real)) return null;          // .git/worktrees/<x> del propio repo
  if (path.basename(real).toLowerCase() === '.git' && fs.existsSync(path.dirname(real))) return evaluarRuta(root, path.dirname(real), opts);
  const r = repoDeRuta(real);
  if (r) return evaluarRuta(root, r, opts);
  return { estado: 'incierta', motivo: `no se puede comprobar a que repo pertenece ${path.basename(real)}`, nombre: path.basename(real) };
}

// ───────────────────────── analisis de una orden de shell ─────────────────────────

// Fin de una sustitucion $( ... ) o `...` que empieza en i (el '$' o la comilla inversa): {fin, interior}.
function sustitucion(s, i) {
  if (s[i] === '`') { const j = s.indexOf('`', i + 1); const fin = j < 0 ? s.length - 1 : j; return { fin, interior: s.slice(i + 1, fin), sinCerrar: j < 0 }; }
  let prof = 0;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '(') prof++;
    else if (s[j] === ')') { prof--; if (prof === 0) return { fin: j, interior: s.slice(i + 2, j) }; }
  }
  return { fin: s.length - 1, interior: s.slice(i + 2), sinCerrar: true };
}

/**
 * Trocea una orden en segmentos y operadores respetando comillas, escapes, heredocs y sustituciones.
 * Cada palabra: {v, redir?, dup?}. Una sustitucion $(...) o `...` queda LITERAL dentro de su palabra (asi
 * un -C con ella es incierto) y ademas emite un item {t:'sub'} para analizar la orden de dentro. El
 * cuerpo de un heredoc se guarda en `words.cuerpos` (lo lee un shell que lo recibe por stdin).
 */
function trocear(cmd) {
  const s = String(cmd || '');
  const out = [];
  let words = [], w = null, q = null, incompleto = false;
  const pendientes = [];                                 // heredocs por consumir al llegar el salto de linea
  const pushW = () => { if (w !== null) { words.push({ v: w }); w = null; } };
  const pushSeg = () => { pushW(); if (words.length) { out.push({ t: 'seg', words }); words = []; } };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === '\\' && /["\\$`]/.test(s[i + 1] || '')) { w += s[i + 1]; i++; }
      else if (q === '"' && (c === '`' || (c === '$' && s[i + 1] === '('))) { const x = sustitucion(s, i); w += s.slice(i, x.fin + 1); out.push({ t: 'sub', cmd: x.interior }); if (x.sinCerrar) incompleto = true; i = x.fin; }
      else w += c;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {                // escape fuera de comillas (los \ de rutas Windows se conservan)
      const n = s[i + 1];
      if (n === '\n') { i++; continue; }
      if (n === '\r' && s[i + 2] === '\n') { i += 2; continue; }
      if (/[\s"'$`;&|<>()\\*?#~]/.test(n)) { w = (w === null ? '' : w) + n; i++; continue; }
    }
    if (c === '`' || (c === '$' && s[i + 1] === '(')) { const x = sustitucion(s, i); w = (w === null ? '' : w) + s.slice(i, x.fin + 1); out.push({ t: 'sub', cmd: x.interior }); if (x.sinCerrar) incompleto = true; i = x.fin; continue; }
    if (c === '"' || c === "'") { q = c; if (w === null) w = ''; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { pushW(); continue; }
    if (c === '\n') {
      pushSeg(); out.push({ t: 'op', v: ';' });
      for (const d of pendientes.splice(0)) {            // el cuerpo del heredoc: hasta su delimitador
        let j = i + 1;
        const cuerpo = [];
        while (j < s.length) {
          let fin = s.indexOf('\n', j); if (fin < 0) fin = s.length;
          const linea = s.slice(j, fin).replace(/\r$/, '');
          j = fin + 1;
          if ((d.tab ? linea.replace(/^\t+/, '') : linea) === d.v) break;
          cuerpo.push(linea);
        }
        (d.ref.cuerpos = d.ref.cuerpos || []).push(cuerpo.join('\n'));
        (d.ref.literales = d.ref.literales || []).push(d.literal);   // <<'EOF': el shell no expande el cuerpo
        i = Math.min(j - 1, s.length);
      }
      continue;
    }
    if (c === ';' || c === '(' || c === ')') { pushSeg(); out.push({ t: 'op', v: c }); continue; }
    if (c === '|' || c === '&') {
      if (c === '&' && (s[i - 1] === '>' || s[i + 1] === '>')) { w = (w === null ? '' : w) + c; continue; }   // 2>&1, &>
      pushSeg();
      let v = c; if (s[i + 1] === c) { v = c + c; i++; } else if (c === '|' && s[i + 1] === '&') { i++; }
      out.push({ t: 'op', v });
      continue;
    }
    if (c === '<' || c === '>') {
      if (c === '<' && s[i + 1] === '<' && s[i + 2] === '<') { pushW(); words.push({ v: '<<<', redir: '<<<' }); i += 2; continue; }   // here-string
      if (c === '<' && s[i + 1] === '<') {               // heredoc
        pushW(); i += 2; let tab = false; if (s[i] === '-') { tab = true; i++; }
        while (s[i] === ' ' || s[i] === '\t') i++;
        let d = '', dq = null, literal = false;
        for (; i < s.length; i++) {
          const ch = s[i];
          if (dq) { if (ch === dq) dq = null; else d += ch; continue; }
          if (ch === '"' || ch === "'") { dq = ch; literal = true; continue; }
          if (ch === '\\') { literal = true; continue; }
          if (/[\s;&|()<>]/.test(ch)) break;
          d += ch;
        }
        i--; pendientes.push({ v: d, tab, literal, ref: words });
        continue;
      }
      if (w !== null && (/^\d+$/.test(w) || w === '&')) w = null; else pushW();
      let op = c;
      if (c === '>' && (s[i + 1] === '>' || s[i + 1] === '|')) { op = c + s[i + 1]; i++; }
      let dup = false;
      if (s[i + 1] === '&') { dup = true; i++; }
      words.push({ v: op, redir: op, dup });
      continue;
    }
    w = (w === null ? '' : w) + c;
  }
  pushSeg();
  out.incompleto = incompleto || q !== null;
  return out;
}

// Lecturas de git que se aceptan SIN mirar el destino: lista MINIMA y cerrada, y solo con opciones que
// no escriben ni ejecutan nada. Cualquier otro verbo hacia otro repo es deny (si es de escritura
// conocida) o ask. Si dudas, ask.
const LECTURAS_SEGURAS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'branch', 'ls-files', 'remote', 'describe']);
// Opciones que escriben un fichero o ejecutan otro programa (o cambian de donde lee): ninguna se acepta.
const OPCION_PELIGROSA = /^(-o|-O|--output|--ext-diff|--textconv|--exec|--open-files-in-pager|--no-index|--upload-pack|--receive-pack|--git-dir|--work-tree|--config-env|--file|-c$|--exec-path|--format-patch|--pager|--paginate|--editor|--help|-h$)/;
const ESCRITURAS_GIT = new Set(['commit', 'push', 'add', 'rm', 'mv', 'checkout', 'switch', 'restore', 'reset', 'merge', 'rebase', 'pull', 'fetch', 'clean', 'cherry-pick', 'revert', 'am', 'apply', 'stash', 'tag', 'init', 'clone', 'config', 'gc', 'prune', 'update-ref', 'symbolic-ref', 'filter-branch', 'notes', 'bisect', 'submodule', 'worktree', 'branch', 'remote', 'format-patch', 'bundle', 'archive', 'hash-object', 'write-tree', 'commit-tree', 'read-tree', 'checkout-index', 'update-index', 'fast-import', 'replace', 'maintenance']);

/** ¿Es una lectura de git de la lista cerrada y SIN opciones que escriban o ejecuten? Todo lo demas, no. */
function esLecturaGit(verbo, resto) {
  const v = String(verbo || '').toLowerCase();
  if (!LECTURAS_SEGURAS.has(v)) return false;
  const args = Array.isArray(resto) ? resto.map(String) : [];
  if (args.some((a) => OPCION_PELIGROSA.test(a) || /[<>|]/.test(a))) return false;
  const pos = args.filter((a) => !a.startsWith('-'));
  const tiene = (...fl) => args.some((a) => fl.includes(a));
  if (v === 'branch') {                                   // solo listar
    if (tiene('-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy', '-u', '-f', '--force') || args.some((a) => /^--(set-upstream|unset-upstream|edit-description)/.test(a))) return false;
    return pos.length === 0 || tiene('--list', '-l', '--contains', '--merged', '--no-merged', '--points-at');
  }
  if (v === 'remote') return args.length === 0 || (args.length === 1 && (args[0] === '-v' || args[0] === '--verbose'));
  return true;
}

const deny = (r, ruta, tipo) => ({ nivel: 'deny', ruta, repo: r.slug || r.nombre, sinRemoto: !r.slug, tipo });
const ask = (ruta, motivo, tipo = 'incierto') => ({ nivel: 'ask', ruta, repo: 'desconocido', sinRemoto: true, tipo, motivo });
/** Resultado de evaluar una ruta -> golpe ({nivel}) o null. */
function golpe(r, ruta, tipo) {
  if (!r) return null;
  return r.estado === 'ajena' ? deny(r, ruta, tipo) : ask(ruta, r.motivo, tipo);
}

// Variables conocidas que SI se resuelven; cualquier otra ($X, %X%, $env:X, `, $() es incierta.
function expandir(v, base, root) {
  const home = os.homedir(), tmp = os.tmpdir();
  let r = String(v);
  if (r === '~' || /^~[\\/]/.test(r)) r = home + r.slice(1);
  r = r.replace(/^(?:\$\{?(?:HOME|USERPROFILE)\}?|%USERPROFILE%|\$env:(?:USERPROFILE|HOME))(?=$|[\\/])/i, () => home);
  r = r.replace(/^(?:\$\{?(?:TMPDIR|TEMP|TMP)\}?|%(?:TEMP|TMP)%|\$env:(?:TEMP|TMP))(?=$|[\\/])/i, () => tmp);
  r = r.replace(/^(?:\$\{?PWD\}?|\$pwd)(?=$|[\\/])/i, () => base || root);
  r = r.replace(/^(?:\$\{?CLAUDE_PROJECT_DIR\}?|\$env:CLAUDE_PROJECT_DIR)(?=$|[\\/])/, () => root);
  return r;
}
const sinResolver = (v) => /[$`%*?\[\]{}]|\$\(|^~[^\\/]/.test(v);   // ~usuario no se resuelve: es el home de OTRO usuario
const esNulo = (v) => /^(\/dev\/null|nul|\$null|\/dev\/(stdout|stderr|tty|fd\/\d+))$/i.test(v);
const posicionales = (a) => a.filter((x) => !x.startsWith('-'));
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd', 'iex', 'invoke-expression']);
const SALTAR = new Set(['{', '}', '!', 'if', 'then', 'do', 'else', 'elif', 'while', 'until', 'function']);
const ENVOLTORIOS = new Set(['sudo', 'doas', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'setsid', 'busybox', 'watch', 'unbuffer']);
/** Nombre del programa de una palabra de orden: sin ruta ni .exe y con los escapes del shell resueltos (`g\it` es `git`). */
function nombreCmd(w) {
  const b = path.basename(String(w)).toLowerCase().replace(/\.exe$/, '');
  if (b === 'git') return b;
  const sinEscape = path.basename(String(w).replace(/\\/g, '')).toLowerCase().replace(/\.exe$/, '');
  return sinEscape === 'git' ? 'git' : b;
}
const VERBOS_GIT =/^(commit|push|add|rm|reset|checkout|merge|rebase|tag|stash|apply|am|cherry-pick|revert|clean|mv|init|clone|fetch|pull|config|worktree|restore|switch|remote|branch)$/;
const OPC_GIT_GLOBAL = /^(-C|-c|--git-dir|--work-tree)$|^--(git-dir|work-tree|config-env)=/;
const VARS_GIT = /^GIT_(INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|CONFIG(_GLOBAL|_SYSTEM|_NOSYSTEM|_PARAMETERS|_COUNT|_KEY_\d+|_VALUE_\d+)?|EXEC_PATH|SSH(_COMMAND)?|ASKPASS|EXTERNAL_DIFF|PAGER|EDITOR|SEQUENCE_EDITOR)$/i;

function analizarGit(words, estado, root, env, opts) {
  const base = estado.cwd;
  const abs = (v, desde) => {                            // ruta absoluta o null si no es resoluble con certeza
    const e = expandir(v, base, root);
    if (e === '' || sinResolver(e)) return null;
    const d = desde === undefined ? base : desde;
    if (!path.isAbsolute(e) && d === null) return null;
    return path.resolve(d === null ? root : d, e);
  };
  const dirs = [];
  const vars = { ...estado.env, ...env };
  let gitDir = vars.GIT_DIR !== undefined ? vars.GIT_DIR : null;
  let workTree = vars.GIT_WORK_TREE !== undefined ? vars.GIT_WORK_TREE : null;
  let commonDir = vars.GIT_COMMON_DIR !== undefined ? vars.GIT_COMMON_DIR : null;
  let i = 0, preguntar = null, hayC = false, gitDirVeces = gitDir !== null ? 1 : 0;
  while (i < words.length) {
    const a = words[i];
    if (a === '-C') { dirs.push(words[i + 1] === undefined ? '' : words[i + 1]); i += 2; continue; }
    if (/^-C./.test(a)) { dirs.push(a.slice(2)); i++; continue; }
    if (a === '-c' || a === '--config-env' || a.startsWith('--config-env=')) {
      hayC = true;
      const conIgual = a.startsWith('--config-env=');   // --config-env=<clave>=<VAR>: el valor va pegado
      const kv = conIgual ? a.slice(13) : String(words[i + 1] === undefined ? '' : words[i + 1]);
      const k = kv.split('=')[0].toLowerCase();
      if (k === 'core.worktree') workTree = kv.slice(kv.indexOf('=') + 1);
      else if (/^(alias\.|core\.(sshcommand|fsmonitor|hookspath|pager|editor|askpass|gitproxy)|include\.|includeif\.|credential\.|filter\.|diff\..*\.(command|textconv)|gpg\.)/.test(k) || a === '--config-env' || conIgual) preguntar = `git -c ${k} puede ejecutar otro comando`;
      i += conIgual ? 1 : 2; continue;
    }
    if (a === '--namespace' || a === '--super-prefix') { i += 2; continue; }
    if (a.startsWith('--exec-path')) { hayC = true; if (a.includes('=')) preguntar = 'git --exec-path=… ejecuta subcomandos de otra carpeta'; i++; continue; }
    if (a.startsWith('--git-dir=')) { gitDir = a.slice(10); gitDirVeces++; i++; continue; }
    if (a === '--git-dir') { gitDir = words[i + 1] === undefined ? '' : words[i + 1]; gitDirVeces++; i += 2; continue; }
    if (a.startsWith('--work-tree=')) { workTree = a.slice(12); i++; continue; }
    if (a === '--work-tree') { workTree = words[i + 1] === undefined ? '' : words[i + 1]; i += 2; continue; }
    if (a.startsWith('-')) { i++; continue; }
    break;
  }
  const verbo = words[i];
  const resto = words.slice(i + 1);
  if (preguntar) return ask('git', preguntar, 'git-config');
  for (const k of Object.keys(vars)) if (VARS_GIT.test(k)) return ask(k, `${k} cambia a donde escribe o que ejecuta git`, 'git-env');
  if (!verbo) return null;
  // Lectura de la lista cerrada, sin opciones que escriban o ejecuten y sin -c/--exec-path ni --git-dir repetido:
  // es inocua contra cualquier repo, no hace falta saber cual es.
  if (!hayC && gitDirVeces <= 1 && esLecturaGit(verbo, resto)) return null;
  // Destinos de la accion. Si hay --git-dir/--work-tree/GIT_*, mandan ellos (y los -C explicitos); si no, el cwd.
  const objetivos = [];
  let incierto = null;
  const explicito = dirs.length > 0 || workTree !== null || gitDir !== null || commonDir !== null;
  let dir = base;
  for (const d of dirs) {
    const a = abs(d, dir);
    if (a === null) { incierto = d === '' ? '-C sin ruta' : `-C ${d}`; dir = null; continue; }
    dir = a;
  }
  if (dirs.length && dir !== null) objetivos.push({ ruta: dir, f: evaluarRuta });
  if (!explicito) {
    if (base === null) incierto = 'directorio de trabajo desconocido (cd con variable o popd)';
    else objetivos.push({ ruta: base, f: evaluarRuta });
  }
  if (workTree !== null) { const a = abs(workTree, base); if (a === null) incierto = `--work-tree ${workTree}`; else objetivos.push({ ruta: a, f: evaluarRuta }); }
  if (gitDir !== null) { const a = abs(gitDir, base); if (a === null) incierto = `--git-dir ${gitDir}`; else objetivos.push({ ruta: a, f: evaluarGitDir }); }
  if (commonDir !== null) { const a = abs(commonDir, base); if (a === null) incierto = `GIT_COMMON_DIR ${commonDir}`; else objetivos.push({ ruta: a, f: evaluarGitDir }); }
  // Verbos que crean cosas en una ruta dada: clone <url> <dest>, init <dir>, worktree add <ruta>.
  const pos = posicionales(resto);
  let dest = null;
  if (verbo === 'clone') dest = pos[1];
  else if (verbo === 'init') dest = pos[0];
  else if (verbo === 'worktree' && resto[0] === 'add') {
    const sin = []; for (let k = 1; k < resto.length; k++) { if (['-b', '-B', '--reason'].includes(resto[k])) { k++; continue; } if (!resto[k].startsWith('-')) sin.push(resto[k]); }
    dest = sin[0];
  }
  if (dest !== undefined && dest !== null) {
    const a = abs(dest, dir === undefined ? base : dir);
    if (a === null) incierto = incierto || `destino ${dest}`; else objetivos.push({ ruta: a, f: evaluarRuta });
  }
  // Rutas DESTINO que git escribe fuera del repo de trabajo: opciones --output/-o/--prefix/--file/--directory/--repo, `push <ruta>` y `bundle create <fichero>`.
  // (Leer de otro repo —fetch/pull/clone <ruta>— sigue permitido.) Solo las rutas que se resuelven con certeza.
  const rutasDestino = [];
  for (let j = 0; j < resto.length; j++) {
    const o = resto[j];
    const mo = /^--(?:output|output-directory|prefix|file|directory|repo)=(.+)$/.exec(o);
    if (mo) { rutasDestino.push(mo[1]); continue; }
    if (['-o', '--output', '--output-directory', '--prefix', '--file', '--directory', '--repo'].includes(o) || (o === '-f' && verbo === 'config')) { if (resto[j + 1] !== undefined) rutasDestino.push(resto[j + 1]); }
  }
  if (verbo === 'push' && pos[0] && /[\\/]/.test(pos[0]) && !/^[A-Za-z][\w+.-]*:\/\//.test(pos[0])) rutasDestino.push(pos[0]);
  if (verbo === 'bundle' && resto[0] === 'create' && pos[1]) rutasDestino.push(pos[1]);
  for (const r of rutasDestino) {
    const a = abs(r, dir === undefined ? base : dir);
    if (a !== null) objetivos.push({ ruta: a, f: evaluarRuta });
  }
  const escribe = ESCRITURAS_GIT.has(String(verbo).toLowerCase());
  let primerAsk = null;
  for (const o of objetivos) {
    const h = golpe(o.f(root, o.ruta, opts), o.ruta, 'git-escritura');
    if (h && h.nivel === 'deny') return escribe ? h : ask(o.ruta, `git ${verbo} hacia otro repo (${h.repo}): solo se aceptan status, log, diff, show, rev-parse, branch, ls-files, remote y describe sin opciones que escriban o ejecuten`, 'git-otro-repo');
    if (h && !primerAsk) primerAsk = h;
  }
  if (primerAsk) return primerAsk;
  if (incierto) return ask(incierto, `git ${verbo} con un destino que no se puede resolver (${incierto})`, 'git-ambiguo');
  return null;
}

function analizarSegmento(words, estado, root, opts) {
  let base = estado.cwd;
  const abs = (v) => {
    const e = expandir(v, base, root);
    if (e === '' || sinResolver(e)) return null;
    if (!path.isAbsolute(e) && base === null) return null;
    return path.resolve(base === null ? root : base, e);
  };
  // 1) Redirecciones simples `>`/`>>` a una ruta claramente resoluble (el resto no se analiza); `<<<` alimenta a un shell.
  const cmdWords = [], hereStrings = [];
  let primerAsk = null;
  for (let i = 0; i < words.length; i++) {
    const x = words[i];
    if (x.redir) {
      const t = words[i + 1];
      if (t && !t.redir) {
        i++;
        if (x.redir === '<<<') hereStrings.push(t.v);
        else if ((x.redir === '>' || x.redir === '>>' || x.redir === '>|') && t.v !== '' && !/^\d+$/.test(t.v) && t.v !== '-' && !esNulo(t.v)) {
          const a = abs(t.v);
          const h = a === null ? null : golpe(evaluarRuta(root, a, opts), t.v, 'redireccion');
          if (h && h.nivel === 'deny') return h;
          if (h && !primerAsk) primerAsk = h;
        }
      }
      continue;
    }
    cmdWords.push(x.v);
  }
  const resultado = (h) => (h && h.nivel === 'deny' ? h : primerAsk || h || null);
  // 2) Asignaciones de entorno, envoltorios y palabras de control.
  const env = {};
  let k = 0, cwdLocal = undefined;
  for (;;) {
    const a = cmdWords[k];
    if (a === undefined) break;
    const m = a.match(/^([A-Za-z_]\w*)=(.*)$/);
    if (m) { env[m[1]] = m[2]; if (/^GIT_/i.test(m[1])) estado.visto = true; k++; continue; }
    if (SALTAR.has(a)) { k++; continue; }
    const b = nombreCmd(a);
    if (b === 'env') {                                   // env [-C dir] [VAR=val]... cmd
      k++;
      while (cmdWords[k] !== undefined) {
        const e = cmdWords[k];
        const mm = e.match(/^([A-Za-z_]\w*)=(.*)$/);
        if (mm) { env[mm[1]] = mm[2]; if (/^GIT_/i.test(mm[1])) estado.visto = true; k++; continue; }
        if (e === '-C' || e === '--chdir') { cwdLocal = cmdWords[k + 1]; k += 2; continue; }
        if (e.startsWith('--chdir=')) { cwdLocal = e.slice(8); k++; continue; }
        if (e === '-S' || e === '--split-string' || e.startsWith('--split-string=')) {   // env -S "git -C x …": la cadena es una orden
          const txt = e.startsWith('--split-string=') ? e.slice(15) : cmdWords.slice(k + 1).join(' ');
          return resultado(analizarComando(txt, root, { ...opts, cwd: base, prof: (opts.prof || 0) + 1, env: { ...estado.env, ...env }, texto: txt }));
        }
        if (e === '-u') { k += 2; continue; }
        if (e.startsWith('-')) { k++; continue; }
        break;
      }
      continue;
    }
    // Un envoltorio con opciones CON valor (sudo -u root, nice -n 5, timeout -s KILL 5…) deja un valor donde esperariamos la orden:
    // se re-ancla en el primer git o shell que aparezca despues (mejor de mas que ocultar el git).
    const reancla = (desde) => { for (let j = desde; j < cmdWords.length; j++) { const n = nombreCmd(cmdWords[j]); if (n === 'git' || SHELLS.has(n)) return j; } return desde; };
    if (ENVOLTORIOS.has(b)) { k++; while (cmdWords[k] !== undefined && (cmdWords[k].startsWith('-') || /^\w+=/.test(cmdWords[k]))) k++; k = reancla(k); continue; }
    if (b === 'timeout') { k++; while (cmdWords[k] !== undefined && cmdWords[k].startsWith('-')) k++; k++; k = reancla(k); continue; }
    break;
  }
  if (cmdWords[k] === undefined) {
    for (const [n, v] of Object.entries(env)) estado.env[n] = v;   // `GIT_DIR=x` solo: vale para lo que siga
    return resultado(null);
  }
  const args = cmdWords.slice(k + 1);
  const c0 = nombreCmd(cmdWords[k]);
  if (cwdLocal !== undefined) { const a = abs(cwdLocal); base = a; }   // env -C dir …
  const pasaCwd = () => ({ ...estado, cwd: base });
  // 2b) La palabra de la orden es una variable o sustitucion ($GIT, $(echo git)…): puede ser git y no se sabe. Si los argumentos
  //     parecen de git (-C, --git-dir, un verbo que escribe), se confirma.
  if (/[$`]/.test(cmdWords[k]) && args.some((x) => OPC_GIT_GLOBAL.test(x) || VERBOS_GIT.test(x))) {
    return resultado(ask(cmdWords[k], 'la orden empieza por una variable o sustitucion y sus argumentos parecen de git: no se puede comprobar el destino', 'git-ambiguo'));
  }
  // 2c) Sustituciones $(…) y `…` dentro del cuerpo de un heredoc (sin comillas se EJECUTAN aunque el heredoc no vaya a un shell).
  //     Con el delimitador entre comillas o escapado (<<'EOF', <<"EOF", <<\EOF) el cuerpo es literal: no se analiza (#197).
  if (words.cuerpos && words.cuerpos.length && !SHELLS.has(c0) && c0 !== 'eval') {
    let hh = null;
    for (const [n, cuerpo] of words.cuerpos.entries()) {
      if ((words.literales || [])[n]) continue;
      for (let q = 0; q < cuerpo.length; q++) {
        if (cuerpo[q] !== '`' && !(cuerpo[q] === '$' && cuerpo[q + 1] === '(')) continue;
        if ((opts.prof || 0) >= 3) { hh = hh || ask('$(…)', 'sustitucion de ordenes demasiado anidada', 'shell'); break; }
        const sx = sustitucion(cuerpo, q);
        const r = analizarComando(sx.interior, root, { ...opts, cwd: base, prof: (opts.prof || 0) + 1, env: { ...estado.env, ...env }, texto: sx.interior });
        if (r) hh = hh || ask(r.ruta, r.motivo || `una sustitucion dentro de un heredoc toca otro repo (${r.repo})`, 'shell');
        q = sx.fin;
      }
    }
    if (hh) primerAsk = primerAsk || hh;
  }
  // 2d) Lanzadores indirectos de PowerShell/cmd con git o un shell entre sus argumentos.
  if (['start-process', 'saps', 'start', 'invoke-command', 'icm'].includes(c0) && args.some((x) => /\bgit\b/i.test(x) || SHELLS.has(nombreCmd(x)))) {
    return resultado(ask(c0, `${c0} lanza git o un shell con argumentos que no se pueden analizar`, 'git-indirecto'));
  }
  // 3) cd / pushd / Set-Location: solo cambia el directorio; leer en otro repo es legitimo.
  if (['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'].includes(c0)) {
    const t = args.includes('-') ? '-' : args.find((x) => !x.startsWith('-') && x.toLowerCase() !== '/d');
    if (t === undefined || t === '~') estado.cwd = os.homedir();
    else if (/^\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)$/.test(t)) estado.cwd = root;
    else if (t === '-') estado.cwd = null;
    else estado.cwd = abs(t);
    return resultado(null);
  }
  if (['popd', 'pop-location'].includes(c0)) { estado.cwd = null; return resultado(null); }
  // export GIT_DIR=… / declare -x / $env:GIT_DIR = …
  if (c0 === 'export' || c0 === 'declare' || c0 === 'typeset' || c0 === 'set' || c0 === 'setenv') {
    for (const a of args) { const m = a.match(/^([A-Za-z_]\w*)=(.*)$/); if (m) { estado.env[m[1]] = m[2]; if (/^GIT_/i.test(m[1])) estado.visto = true; } }
    return resultado(null);
  }
  const mEnvPs = cmdWords[k].match(/^\$env:(\w+)$/i);
  if (mEnvPs && args[0] === '=') { estado.env[mEnvPs[1]] = args[1] === undefined ? '' : args[1]; if (/^GIT_/i.test(mEnvPs[1])) estado.visto = true; return resultado(null); }
  if (c0 === 'set-item') {
    const e = args.find((x) => /^env:/i.test(x));
    if (e) { const n = e.slice(4); const vi = args.findIndex((x) => x.toLowerCase() === '-value'); estado.env[n] = vi >= 0 ? args[vi + 1] : args[args.indexOf(e) + 1]; if (/^GIT_/i.test(n)) estado.visto = true; return resultado(null); }
  }
  // 4) Shells anidados: `bash -c "git -C ../x commit"`, heredocs y here-strings que se les pasan, tuberias.
  if (SHELLS.has(c0) || c0 === 'eval') {
    if ((opts.prof || 0) >= 3) return resultado(ask(c0, 'shell anidado demasiado profundo', 'shell'));
    const sub = (txt) => analizarComando(txt, root, { ...opts, cwd: pasaCwd().cwd, prof: (opts.prof || 0) + 1, env: { ...estado.env, ...env } });
    let interno = null;
    if (c0 === 'eval' || c0 === 'iex' || c0 === 'invoke-expression') interno = args.join(' ');
    else { const j = args.findIndex((x) => /^(-c|-command|-lc|-ic|\/c|\/k)$/i.test(x) || /^-[a-z]*c$/.test(x)); if (j >= 0 && args[j + 1] !== undefined) interno = args.slice(j + 1).join(' '); }
    const textos = [];
    if (interno) textos.push(interno);
    for (const c of words.cuerpos || []) textos.push(c);
    for (const h of hereStrings) textos.push(h);
    let h = null;
    for (const t of textos) { const r = sub(t); if (r && r.nivel === 'deny') return r; if (r && !h) h = r; }
    if (!textos.length && estado.desdeTuberia && /\bgit\b|>/.test(opts.texto || '')) h = ask(c0, 'un shell que lee la orden de una tuberia: no se puede analizar', 'shell');
    return resultado(h);
  }
  // 4b) xargs/find/parallel con git.
  {
    if ((c0 === 'xargs' || c0 === 'find' || c0 === 'parallel') && args.some((x) => nombreCmd(x) === 'git' || SHELLS.has(nombreCmd(x)))) {
      return resultado(ask(c0, `${c0} ejecuta git o un shell con un destino que no se puede resolver`, 'git-indirecto'));
    }
  }
  // 5) git. (Las herramientas sueltas —rm, cp, find, tar, curl, sed -i…— NO se analizan: limite documentado.)
  if (c0 === 'git') return resultado(analizarGit(args, pasaCwd(), root, env, opts));
  return resultado(null);
}

/**
 * Analiza una orden de shell (Bash o PowerShell). null = nada que objetar. Si no:
 *   {nivel:'deny', ruta, repo, sinRemoto, tipo}   esta PROBADO que escribe en un repo ajeno
 *   {nivel:'ask', ruta, motivo, tipo}             hay un destino que no se puede resolver con certeza
 * Cubre SOLO: git (-C, --git-dir, --work-tree, -c core.worktree, GIT_*, cd previos, shells anidados) y
 * las redirecciones simples `>`/`>>`. Cualquier error interno, entrada que no es texto o texto que no se
 * puede analizar del todo acaba en ask, nunca en null. Un deny gana a un ask.
 */
function analizarComando(cmd, root, opts = {}) {
  const r = analizarComandoUnaLectura(cmd, root, opts);
  // Una barra invertida sin comillas es un separador de ruta en PowerShell/cmd y un ESCAPE en bash (`..\ajeno` es
  // `..ajeno`, `aj\eno` es `ajeno`). El shell que ejecute es el que decide: se analizan las DOS lecturas y gana la peor.
  if (opts.lecturaPosix || opts.lecturaWin || typeof cmd !== 'string' || !cmd.includes('\\')) return r;
  const posix = cmd.replace(/(?<!:|<<-?[ \t]*)\\(?=[^\s"'\\])/g, '');   // <<\EOF conserva su escape: es un heredoc literal (#197)
  const lecturas = [r];
  if (posix !== cmd) lecturas.push(analizarComandoUnaLectura(posix, root, { ...opts, lecturaPosix: true }));
  // El MISMO veredicto en cualquier SO: en POSIX path.resolve no trata \ como separador, asi que la lectura de
  // PowerShell/cmd se hace explicita (\ → /). En Windows path.resolve ya lo hace y r ES esa lectura.
  if (!WIN) {
    const win = cmd.replace(/(?<!:)\\(?=[^\s"'\\])/g, '/');
    if (win !== cmd && win !== posix) lecturas.push(analizarComandoUnaLectura(win, root, { ...opts, lecturaWin: true }));
  }
  return lecturas.find((x) => x && x.nivel === 'deny') || lecturas.find((x) => x) || null;
}
function analizarComandoUnaLectura(cmd, root, opts = {}) {
  try {
    if (cmd === undefined || cmd === null || cmd === '') return null;
    if (typeof cmd !== 'string') return ask(String(typeof cmd), 'la orden no es texto: no se puede analizar', 'entrada');
    if (!root) return ask('', 'sin raiz de sesion para comprobar el destino', 'entrada');
    const texto = opts.texto === undefined ? cmd : opts.texto;
    if (cmd.length > 65536) return /\bgit\b|>/.test(cmd) ? ask('', 'orden demasiado larga para analizarla', 'entrada') : null;
    const o2 = { ...(opts || {}), texto };
    const estado = { cwd: opts.cwd === undefined ? root : opts.cwd, env: { ...(opts.env || {}) }, desdeTuberia: false };
    const pila = [];
    let primerAsk = null;
    const items = trocear(cmd);
    let previo = null;
    for (const it of items) {
      if (it.t === 'op') {
        if (it.v === '(') pila.push({ cwd: estado.cwd, env: { ...estado.env } });
        else if (it.v === ')') { if (pila.length) { const p = pila.pop(); estado.cwd = p.cwd; estado.env = p.env; } }
        previo = it.v;
        continue;
      }
      let b;
      if (it.t === 'sub') {                              // orden dentro de $(...) o `...`
        if ((opts.prof || 0) >= 3) b = ask('$(…)', 'sustitucion de ordenes demasiado anidada', 'shell');
        else b = analizarComando(it.cmd, root, { ...o2, cwd: estado.cwd, env: estado.env, prof: (opts.prof || 0) + 1, texto: it.cmd });
      } else {
        estado.desdeTuberia = previo === '|' || previo === '|&';
        b = analizarSegmento(it.words, estado, root, o2);
        previo = null;
      }
      if (b && b.nivel === 'deny') return b;
      if (b && !primerAsk) primerAsk = b;
    }
    if (primerAsk) return primerAsk;
    // Texto que el tokenizador no pudo cerrar (comillas o sustituciones sin terminar) y que toca git o escribe.
    if (items.incompleto && /\bgit\b|>/.test(texto)) return ask('', 'la orden tiene comillas o sustituciones sin cerrar: no se puede analizar', 'entrada');
    // Variables GIT_* mencionadas pero no capturadas por ninguna forma que sepamos leer.
    if (!estado.visto && /\bGIT_(DIR|WORK_TREE|COMMON_DIR)\b/i.test(texto) && /\bgit\b/i.test(texto)) return ask('GIT_*', 'variable GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR con una forma que no se puede analizar', 'git-env');
    return null;
  } catch (e) {
    return ask('', `error interno del analisis de alcance (${(e && e.message) || e})`, 'error');
  }
}

// ───────────────────────── transporte gh ─────────────────────────

const METODOS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SEG_LECTURA_LIBRE = new Set(['user', 'users', 'search', 'rate_limit', 'meta', 'emojis', 'licenses', 'gitignore', 'markdown', 'zen', 'octocat', 'versions', 'orgs', 'repos', 'graphql', 'gists', 'notifications', 'events', 'feeds', 'issues', 'codes_of_conduct', 'marketplace_listing', 'advisories', 'networks']);

/**
 * Decide si `harness.js gh <ruta> <metodo> [json]` esta dentro del alcance. null = permitido; si no, el
 * motivo. sesion = {org, repo} del remoto. Lecturas libres dentro de la organizacion; escrituras solo
 * en el repo de la sesion (o hermanos autorizados), salvo crear issues y comentar en ellos. Nombres de
 * org y repo se comparan en minusculas (GitHub no distingue) y sin el sufijo .git.
 */
function evaluarGhInterna(p, metodo, sesion, opts = {}) {
  let ruta = String(p === undefined || p === null ? '' : p).trim();
  const m = String(metodo || 'GET').toUpperCase();
  if (!METODOS.includes(m)) return `metodo '${metodo}' no reconocido`;
  const escribe = !['GET', 'HEAD'].includes(m);
  if (/[\u0000-\u001f\u007f\s]/.test(ruta)) return 'ruta de API con espacios o caracteres de control';
  if (/^\/\//.test(ruta)) return 'ruta de API no normalizada';
  if (/^[a-z][a-z0-9+.-]*:/i.test(ruta)) {               // URL absoluta: solo la API de la forja del remoto, por https y sin userinfo ni puerto
    let u, b;
    try { u = new URL(ruta); b = new URL(opts.apiBase || 'https://api.github.com/'); } catch { return 'URL absoluta invalida'; }
    if (!opts.apiBase) return 'una URL absoluta solo vale si es la de la API de la forja del remoto';
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.host.toLowerCase() !== b.host.toLowerCase()) return 'una URL absoluta solo vale si es la de la API de la forja del remoto (https, sin usuario ni puerto)';
    const pb = b.pathname.replace(/\/+$/, '');
    if (!u.pathname.startsWith(pb + '/')) return 'URL fuera de la API de la forja';
    ruta = u.pathname.slice(pb.length) + u.search;
  }
  ruta = ruta.split('#')[0].split('?')[0];
  if (/\\/.test(ruta) || /\/\/+/.test(ruta.replace(/^\/+/, ''))) return 'ruta de API no normalizada';
  const segs = [];
  for (const s of ruta.split('/').filter((x) => x !== '')) {
    let d; try { d = decodeURIComponent(s); } catch { return 'ruta de API con codificacion invalida'; }
    if (/%[0-9a-f]{2}/i.test(d)) return 'ruta de API con doble codificacion';
    if (d === '.' || d === '..' || /[\/\\?#\s\u0000-\u001f]/.test(d)) return 'ruta de API con segmentos de escape (. / .. / %2F / %3F / %23)';
    segs.push(d);
  }
  const primero = (segs[0] || '').toLowerCase();
  const sinSesion = 'sin remoto origin de GitHub no se puede saber cual es la organizacion de esta sesion';
  const otraOrg = (org) => `'${org}' no es la organizacion de esta sesion (${sesion && sesion.org}): el transporte gh solo opera en ella`;
  const norm = (x) => String(x).toLowerCase().replace(/\.git$/, '');
  if (primero === 'repos') {
    if (!segs[1] || !segs[2]) return escribe ? 'ruta repos/ sin org/repo' : null;
    if (!sesion) return sinSesion;
    if (norm(segs[1]) !== norm(sesion.org)) return otraOrg(segs[1]);
    const resto = segs.slice(3).map((x) => x.toLowerCase());
    if (escribe && ['transfer', 'forks'].includes(resto[0])) {
      const forkAOtraOrg = resto[0] === 'forks' && (() => { try { const o = JSON.parse(opts.cuerpo || '{}').organization; return o && norm(o) !== norm(sesion.org); } catch { return true; } })();
      if (resto[0] === 'transfer' || forkAOtraOrg) return `${m} ${resto[0]} sacaria el repo de la organizacion de la sesion`;
    }
    const propio = norm(segs[2]) === norm(sesion.repo) ||
      (opts.permitidos || []).some((x) => norm(x) === `${norm(segs[1])}/${norm(segs[2])}`);
    if (!escribe || propio) return null;
    const crear = m === 'POST' && resto.length === 1 && resto[0] === 'issues';
    const comentar = m === 'POST' && resto.length === 3 && resto[0] === 'issues' && /^\d+$/.test(resto[1]) && resto[2] === 'comments';
    if (crear || comentar) return null;
    return `${m} sobre ${segs[1]}/${segs[2]} no esta permitido: ese repo no es el de esta sesion (solo se puede abrir un issue o comentar en uno: POST repos/${segs[1]}/${segs[2]}/issues)`;
  }
  if (primero === 'orgs') {
    if (!segs[1]) return escribe ? 'ruta orgs/ sin organizacion' : null;
    if (!sesion) return sinSesion;
    return norm(segs[1]) === norm(sesion.org) ? null : otraOrg(segs[1]);
  }
  if (primero === 'graphql') {
    if (!escribe) return null;
    let j; try { j = JSON.parse(opts.cuerpo || ''); } catch { return 'el cuerpo de graphql no es un JSON legible: no se puede acotar'; }
    if (!j || typeof j.query !== 'string') return 'graphql sin "query" legible: no se puede acotar';
    const crudo = String(opts.cuerpo);
    if (/mutation|subscription/i.test(j.query) || /mutation|subscription/i.test(crudo) || /\\u00|\\x/i.test(crudo)) return 'una operacion de GraphQL que escribe (mutation, fragmentos o variables) no se puede acotar al repo de la sesion: usa la API REST (repos/<org>/<repo>/…)';
    return null;
  }
  if (!escribe) {
    // Lecturas por id numerico o de ambito no acotable (app, enterprises, installation…): no se pueden comprobar.
    if (SEG_LECTURA_LIBRE.has(primero)) return null;
    return `la ruta '${segs[0] || ''}/…' no se puede acotar a la organizacion de la sesion`;
  }
  return `escritura en '${segs[0] || ''}/…' fuera de repos/<org>/… y orgs/<org>/…: no se puede acotar a la organizacion de la sesion`;
}

/** Valida `--repo <org/repo>` de asignar-tarea. {ok, org, repo, esSesion} o {error}. */
function parsearRepoArgInterna(valor, root) {
  const v = String(valor === undefined || valor === null ? '' : valor).trim();
  if (!RE_REPO.test(v)) return { error: `--repo '${v}' no tiene la forma org/repo (letras, numeros, . _ -).` };
  const [org, repo] = v.split('/');
  const s = slugDelRemoto(root);
  if (!s) return { error: '--repo: no detecto el remoto origin de esta sesion, asi que no puedo comprobar que la organizacion sea la misma.' };
  if (s.org.toLowerCase() !== org.toLowerCase()) return { error: `--repo ${v}: '${org}' no es la organizacion de esta sesion (${s.org}). Solo se abren issues en repos de la misma organizacion; para otra, pidele al usuario que lo haga el mismo.` };
  return { ok: true, org, repo, esSesion: s.repo.toLowerCase() === repo.toLowerCase() };
}

/** Entrada publica del transporte: cualquier error o entrada rara se RECHAZA (devuelve el motivo), nunca se permite. */
function evaluarGh(p, metodo, sesion, opts) {
  try {
    if (typeof p !== 'string') return 'la ruta de la API no es texto';
    if (metodo !== undefined && metodo !== null && typeof metodo !== 'string') return 'el metodo no es texto';
    const o = opts || {};
    if (o.cuerpo !== undefined && o.cuerpo !== null && typeof o.cuerpo !== 'string') return 'el cuerpo no es texto';
    return evaluarGhInterna(p, metodo, sesion, o);
  } catch (e) { return `error interno del control de alcance (${(e && e.message) || e})`; }
}
/**
 * Sustituye los placeholders {org} y {repo} de una ruta de `harness.js gh` por los del remoto de la
 * sesion (los skills documentan asi las rutas). Va ANTES de evaluarGh: el control juzga la ruta ya
 * expandida, asi que el placeholder no da acceso a nada que la ruta literal no tuviera. Sin sesion, o
 * sin placeholders, devuelve la ruta tal cual (y evaluarGh sigue rechazandola si procede).
 */
function expandirPlaceholders(p, sesion) {
  if (typeof p !== 'string' || !sesion || !sesion.org || !sesion.repo) return p;
  return p.replace(/{org}/g, sesion.org).replace(/{repo}/g, sesion.repo);
}
/** Entrada publica de asignar-tarea --repo: cualquier error es un {error}. */
function parsearRepoArg(valor, root) {
  try { return parsearRepoArgInterna(valor, root); } catch (e) { return { error: `--repo: error interno al validar (${(e && e.message) || e})` }; }
}

module.exports = {
  RE_REPO, repoDeRuta, mismoRepo, esRutaAjena, evaluarRuta, organizacionDelRemoto, esOrganizacionPropia,
  slugDelRemoto, leerAlcance, validarConfig, analizarComando, esLecturaGit, trocear, evaluarGh, expandirPlaceholders, parsearRepoArg, normalizarRuta,
};
