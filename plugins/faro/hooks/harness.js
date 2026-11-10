#!/usr/bin/env node
// Harness estandar de microproyectos/iniciativas — gestion documental + faseo + git. (v2)
// UN solo archivo, sin dependencias. Subcomandos (hooks de Claude Code, rutas RELATIVAS a la raiz):
//   session        -> SessionStart: INDICE con presupuesto (fase, rama y su seguridad, bloqueos, ciclos,
//                     protocolo spec, avisos agregados); el bloque completo, con 'estado' / 'status'.
//   prompt-context -> UserPromptSubmit: solo lo que CAMBIO en la sesion (fase, inventario, git) +
//                     el aviso de rama sin escritura, siempre.
//   pre-doc        -> PreToolUse(Write|Edit): convenciones antes de escribir (nombrado, frontmatter
//                     de specs, reglas de faseo, spec aprobada antes de plan) y PROTECCION main
//                     (bloquea escribir documentacion de iniciativa estando en main).
//   pre-bash       -> PreToolUse(Bash): PROTECCION main del ciclo de vida git — bloquea 'git commit'
//                     directo en main (main solo recibe merges = la aprobacion; los merges SI pasan).
//   doc-check      -> PostToolUse(Write|Edit): valida nombrado y frontmatter; si se escribe
//                     INICIATIVA.md, revalida el faseo completo.
//   stop-check     -> Stop: recuerda commitear documentacion pendiente (no bloquea).
//   validate       -> CLI/CI: todas las validaciones; exit code != 0 si hay errores (gate de merge).
//                     Los gates de codigo solo con --gates (afectadas) | --todas | --app <id> (#167).
//   stats          -> CLI: estadisticas de conocimiento por usuario git (commits por area,
//                     aprobaciones de specs, tareas por owner) + referente probable.
//   status-line    -> statusLine de Claude Code: linea permanente con iniciativa, fase, rama y riesgos.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Payload del hook leido de una vez y de forma SINCRONA (lo necesitan prompt-context, por su
// session_id, y la salida temprana de pre-bash). En una terminal (TTY) no hay payload: {}.
let _payloadSync;
function leerPayloadSync() {
  if (_payloadSync !== undefined) return _payloadSync;
  _payloadSync = {};
  try {
    if (!process.stdin.isTTY) {
      const t = fs.readFileSync(0, 'utf8');
      const p = t.trim() ? JSON.parse(t) : {};
      _payloadSync = p && typeof p === 'object' ? p : {};
    }
  } catch { _payloadSync = {}; }
  return _payloadSync;
}

// SALIDA TEMPRANA de pre-bash (#127): solo para ordenes SIN operandos de una lista cerrada que no lee
// ficheros (lib/orden-inocua.js). No decide sobre rutas: cualquier argumento que no sea una opcion
// simple sigue el camino completo, donde las guardas (lib/guardas.js) son la unica fuente de verdad.
// FARO_SIN_SALIDA_TEMPRANA=1 la desactiva (lo usa el test de equivalencia).
if (process.argv[2] === 'pre-bash' && process.env.FARO_SIN_SALIDA_TEMPRANA !== '1') {
  const orden = String(((leerPayloadSync().tool_input) || {}).command || '');
  if (require('./lib/orden-inocua.js').esOrdenInocua(orden)) process.exit(0);
}
// MARCA DE PROCESOS (#177): todo hijo que lance el motor hereda FARO_PROC=<sesion>. `harness.js procesos`
// lista y limpia SOLO los que la llevan. Si ya viene de un proceso FARO (p. ej. test/run.js) se respeta.
if (!process.env.FARO_PROC) process.env.FARO_PROC = `h${process.pid}-${Date.now().toString(36)}`;
// Funciones puras, sin contexto (no acceden a ROOT/fs por si mismas): se cargan directo, sin la
// factory (ctx) => {...} que usan los demas modulos de lib/.
const { tareasLegacySinMigrar } = require(path.join(__dirname, 'lib', 'tareas-legacy.js'));

// ROOT = la raiz del REPO, no el directorio donde se teclea. CLAUDE_PROJECT_DIR manda cuando esta
// (la pone el harness de Claude Code); sin ella —invocacion manual desde una terminal, un hook que
// no la propaga, un script— se SUBE hasta la carpeta con .git, que es donde vive ESTADO.md por
// convencion FARO. Antes se usaba process.cwd() tal cual: trabajar desde src/ dejaba al harness
// buscando ESTADO.md en src/, y reportaba 'fases: []' con todo a null sobre un ESTADO.md valido en
// la raiz — el faseo y validate quedaban ciegos en silencio. Sin repo git se cae a cwd (uso fuera
// de un repo, que debe seguir funcionando igual).
function raizRepo(desde) {
  let d = desde;
  for (let i = 0; i < 40; i++) {              // tope: rutas patologicas o enlaces circulares
    try { if (fs.existsSync(path.join(d, '.git'))) return d; } catch {}
    const padre = path.dirname(d);
    if (padre === d) break;                    // llegamos a la raiz del sistema de ficheros
    d = padre;
  }
  return desde;
}
// RAIZ POR FICHERO EN WORKTREES (#136). Los hooks que deciden sobre UNA ruta concreta (pre-doc,
// doc-check) corren con cwd/CLAUDE_PROJECT_DIR = el checkout PRINCIPAL, pero el fichero puede vivir
// en un git worktree (los agentes aislados trabajan en .claude/worktrees/<x>, o en una carpeta
// hermana). Evaluar las reglas spec-driven contra el principal buscaba la proposal en el arbol
// equivocado y bloqueaba crear el tasks.md de un cambio que si existia. Si el fichero pertenece a
// OTRO arbol de trabajo del MISMO repositorio (mismo git-common-dir), ese arbol pasa a ser ROOT.
// Coste cero en el caso normal: se sube por el sistema de ficheros buscando '.git' y, si el primero
// que aparece es el de la raiz por defecto, no se llama a git. Un repo AJENO (otro proyecto) no se
// adopta: sigue fuera del gobierno, como antes.
function raizDeFicheroEditado(rootPorDefecto) {
  const cmdHook = process.argv[2];
  if (cmdHook !== 'pre-doc' && cmdHook !== 'doc-check' && cmdHook !== 'tdd-pre') return null;
  const fp = ((leerPayloadSync().tool_input) || {}).file_path;
  if (!fp || typeof fp !== 'string') return null;
  // Fichero nuevo: su carpeta puede no existir todavia -> primer ancestro existente.
  let d = path.dirname(path.resolve(rootPorDefecto, fp));
  for (let i = 0; i < 60 && !fs.existsSync(d); i++) {
    const p = path.dirname(d);
    if (p === d) return null;
    d = p;
  }
  const arbol = raizRepo(d);
  const mismo = (a, b) => path.resolve(a).replace(/\\/g, '/').toLowerCase() === path.resolve(b).replace(/\\/g, '/').toLowerCase();
  if (!fs.existsSync(path.join(arbol, '.git')) || mismo(arbol, rootPorDefecto)) return null;
  // La raiz por defecto debe ser ella misma la raiz de un arbol git: si es una carpeta suelta que
  // solo cae DENTRO de otro repo, git la resolveria al repo de arriba y se adoptaria uno ajeno.
  if (!fs.existsSync(path.join(rootPorDefecto, '.git'))) return null;
  const g = (cwd, ...a) => {
    try { return execFileSync('git', ['-C', cwd, ...a], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return null; }
  };
  const top = g(d, 'rev-parse', '--show-toplevel');
  if (!top) return null;
  const comun = g(top, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const comunDef = g(rootPorDefecto, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!comun || !comunDef || !mismo(comun, comunDef)) return null;   // repo ajeno: no se gobierna
  return path.resolve(top);
}
const _rootPorDefecto = process.env.CLAUDE_PROJECT_DIR || raizRepo(process.cwd());
const _rootFichero = raizDeFicheroEditado(_rootPorDefecto);
// Quien lea CLAUDE_PROJECT_DIR (ESTADO_FILE, libs) ve el mismo arbol que ROOT.
if (_rootFichero) process.env.CLAUDE_PROJECT_DIR = _rootFichero;
const ROOT = _rootFichero || _rootPorDefecto;
// TDD VERIFICABLE (#133): hooks propios (tdd-pre/-post/-stop en hooks.json) y la revision determinista
// de tests debilitados que usa revisor-code. Corren en CADA Write/Edit y en CADA Bash, asi que salen
// AQUI, antes de cargar el motor: lib/tdd.js solo necesita ROOT y lee el schema por su cuenta.
{
  const cmd = process.argv[2];
  if (cmd === 'tdd-pre' || cmd === 'tdd-post' || cmd === 'tdd-stop' || cmd === 'tdd-revisar') {
    require('./lib/tdd.js').cli(cmd, ROOT, { argv: process.argv.slice(3), payload: cmd === 'tdd-revisar' ? undefined : leerPayloadSync() });
    return;   // CommonJS: corta la carga del resto del harness
  }
  // TESTS POR DOMINIO (#178): servicio unico en lib/dominios.js; no necesita el motor entero.
  if (cmd === 'tests-dominios') {
    require('./lib/dominios.js').cli(process.argv.slice(3), ROOT);
    return;
  }
  // GOBERNADOR DE RECURSOS (#182): estado de los gates pesados (semaforo global, memoria, cache) y su limpieza.
  if (cmd === 'recursos') {
    process.exitCode = require('./lib/gobernador.js').cli(process.argv.slice(3), { root: ROOT });
    return;
  }
  // ESTADO ESTRUCTURADO DE TAREAS (#149): `tarea` y `resumen` solo leen/escriben gestion/tareas/*.json,
  // asi que tampoco necesitan el motor entero.
  // `tarea migrar` y `tarea sync` SI necesitan la forja (transporte del motor): los atiende cmdTareaMigrar, mas abajo.
  if ((cmd === 'tarea' && process.argv[3] !== 'migrar' && process.argv[3] !== 'sync') || cmd === 'resumen-json' || cmd === 'estado-indice') {
    process.exitCode = require('./lib/tarea-cli.js').cli(cmd, ROOT, process.argv.slice(3));
    return;
  }
  // REFERENCIAS Y NAVEGACION (#157): `ir <ref>` y `refs <ref>` resuelven en vivo leyendo solo el
  // fichero de cada tipo, asi que tampoco necesitan el motor.
  if (cmd === 'ir' || cmd === 'refs') {
    process.exitCode = require('./lib/ir-cli.js').cli(cmd, ROOT, process.argv.slice(3));
    return;
  }
}
const PATHS = require('./lib/paths.js')(ROOT);
const SP = PATHS.dir('gestion');        // carpeta de gestion ('gestion')
const DOCS = PATHS.dir('documentos');   // documentos controlados ('documentos')
const SRC = PATHS.dir('fuentes');       // material de partida ('fuentes')
const FLOWS = PATHS.dir('flujos');      // exports tecnicos ('flujos')
const SCRATCH = PATHS.dir('borrador');  // scratch ('borrador')
const NOTEBOOKS = PATHS.dir('notebooks'); // capa tecnica: .ipynb ('notebooks')
const SCRIPTS = PATHS.dir('scripts');     // utilidades del repo ('scripts')
const REPORTING = PATHS.dir('reporting');            // 'gestion/reporting' (fuente unica: paths.js)
const INFORMES = PATHS.dir('informes');              // 'gestion/reporting/informes'
const PRESENTACIONES = PATHS.dir('presentaciones');  // 'gestion/reporting/presentaciones'
// Configuracion del repo (#293): faro/config.json o, sin migrar, .faro.json. NO es ~/.faro.json (credenciales).
const CONFIG_FILE = PATHS.CONFIG;
const LAYOUT_LEGADO = 'FARO en la raíz (layout antiguo): pásalo a faro/ con `harness.js migrar-layout --dry-run` y, si el plan cuadra, `harness.js migrar-layout`.';

// --- MODO PLUGIN --- El motor corre desde la cache del plugin de Claude Code (no desde ROOT/.claude).
// 1) Reescritura de auto-referencias EN UN SOLO PUNTO: toda guia impresa 'node .claude/hooks/X.js'
//    se corrige a la ruta real del plugin al emitir (sin cazar literales por todo el codigo).
//    Nota: sin comillas alrededor de la ruta para no corromper el JSON de los hooks (la cache de
//    plugins vive bajo el perfil del usuario, sin espacios en la practica).
// 2) Copia LEGADA: si el repo aun tiene .claude/hooks/harness.js (flujo antiguo por copia), los
//    hooks correrian DUPLICADOS -> se avisa en sesion y se guia la migracion (npx faro-harness -> adoptar).
const PLUGIN_MODE = !__dirname.replace(/\\/g, '/').toLowerCase()
  .startsWith(path.join(ROOT, '.claude').replace(/\\/g, '/').toLowerCase());
const _hooksDir = __dirname.replace(/\\/g, '/');
// Lo que de verdad llega al modelo (el presupuesto de sesion se mide sobre esto, no sobre el texto
// antes de reescribir: cada ruta del plugin anade decenas de caracteres).
const reescribirRutas = (s) => (PLUGIN_MODE ? String(s).replace(/\.claude\/hooks\/([a-z-]+\.js)/g, `${_hooksDir}/$1`) : String(s));
if (PLUGIN_MODE) {
  const _w = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, enc, cb) => _w(typeof chunk === 'string' ? reescribirRutas(chunk) : chunk, enc, cb);
}
const LEGACY_COPY = PLUGIN_MODE && fs.existsSync(path.join(ROOT, '.claude', 'hooks', 'harness.js'));
// Con copia legada presente, GOBIERNA LA COPIA (sus hooks ya corren via settings.json del repo):
// el plugin se INHIBE en los eventos de hook para no duplicar salida/validaciones, y solo deja
// en sesion la pista de migracion. Los subcomandos CLI (validate, rama, gh...) siguen operativos.
if (LEGACY_COPY) {
  const _cmd = process.argv[2] || '';
  if (['session', 'prompt-context', 'pre-doc', 'pre-bash', 'doc-check', 'stop-check'].includes(_cmd)) {
    if (_cmd === 'session') {
      process.stdout.write(
        'PLUGIN faro INHIBIDO en este repo: existe la copia local legada (.claude/hooks/harness.js) y es ella quien gobierna. ' +
        'Para migrar al plugin (recomendado: una sola fuente, auto-update): npx faro-harness -> adoptar ' +
        '(retira la copia y el cableado de hooks del settings.json, conservando permisos y overrides).\n',
      );
    }
    process.exit(0);
  }
}
// Archivo de ESTADO del trabajo (fuente de verdad del faseo). Nombre canonico: ESTADO.md —
// universal para cualquier tipo (funcionalidad de plataforma, proyecto, iniciativa).
// Compatibilidad: si el repo solo tiene el legado INICIATIVA.md, se usa ese. Manda el que exista.
// #293: la ruta la resuelve el mapa unico (faro/ESTADO.md, o en la raiz si el repo no se ha migrado).
const ESTADO_FILE = PATHS.ESTADO;
// Estados de fase/entidad (los escribe el AGENTE, no el humano). CONTRATO UNICO:
// enums.estado_fase de faro-schema.json (aqui solo el fallback si el schema no existe); se carga mas abajo.
let VALID_STATES = ['draft', 'backlog', 'pending', 'in_progress', 'testing', 'done'];
const DONE_STATE = 'done';                          // terminal: exige tareas hechas + informe + tag fase-N
const ACTIVE_STATES = ['in_progress', 'testing'];  // activos: solo UNA fase activa a la vez (= fase_actual)
const isActive = (e) => ACTIVE_STATES.includes(e);
const isDone = (e) => e === DONE_STATE;

// Contrato UNICO de taxonomia (.claude/faro-schema.json): enums (tipos de documento, gobernanza,
// ambitos...). Lo lee el harness (valida) y cualquier integracion externa que se conecte (agnostico
// al sistema concreto). Fallback silencioso.
let _schema;
function faroSchema() {
  if (_schema !== undefined) return _schema;
  try { _schema = JSON.parse(fs.readFileSync((fs.existsSync(path.join(ROOT, '.claude', 'faro-schema.json')) ? path.join(ROOT, '.claude', 'faro-schema.json') : path.join(__dirname, 'faro-schema.json')), 'utf8')); }
  catch { _schema = null; }
  return _schema;
}
// El contrato manda: si faro-schema.json declara estado_fase, sustituye al fallback hardcodeado.
{ const s = faroSchema(); if (s && s.enums && Array.isArray(s.enums.estado_fase) && s.enums.estado_fase.length) VALID_STATES = s.enums.estado_fase; }
// Tolerancia de IDIOMA (enums.estado_fase_alias): normaliza lo que escriba un humano ('cerrada',
// 'en cours'...) al estado canonico ANTES de validar. Lo persistido/escrito por el agente es siempre canonico.
function normEstado(e) {
  const k = String(e || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s-]+/g, '_');
  if (VALID_STATES.includes(k)) return k;
  const s = faroSchema();
  const al = (s && s.enums && s.enums.estado_fase_alias) || {};
  return al[k] || k;
}
function tiposDocumentoValidos() {
  const s = faroSchema();
  return (s && s.enums && s.enums.tipos_documento) ? s.enums.tipos_documento.map((t) => t.codigo) : null;
}
// Labels de issue (enums.labels). 'transversal: true' marca los que NO son un tipo de trabajo sino una
// dimension ortogonal (urgente, riesgo...): esos van en --extra, nunca como --tipo.
function labelsCatalogo() { const s = faroSchema(); return (s && s.enums && Array.isArray(s.enums.labels)) ? s.enums.labels : []; }
function labelSlugs() { return labelsCatalogo().filter((l) => !l.transversal).map((l) => l.slug); }
// Taxonomia jerarquica de dominios (area -> [subareas]). Nodos validos = areas + subareas; area padre de una subarea.
function dominiosTree() { const s = faroSchema(); return (s && s.enums && s.enums.dominios && !Array.isArray(s.enums.dominios)) ? s.enums.dominios : null; }
function dominiosValidos() { const t = dominiosTree(); if (!t) return null; const out = new Set(); for (const [area, subs] of Object.entries(t)) { out.add(area); (subs || []).forEach((x) => out.add(x)); } return [...out]; }
function dominioArea(dom) { const t = dominiosTree(); if (!t || !dom) return null; const d = String(dom).toLowerCase(); if (t[d]) return d; for (const [area, subs] of Object.entries(t)) if ((subs || []).includes(d)) return area; return null; }
// Ramas principales protegidas: NUNCA se commitean/escriben directo; solo reciben merges (la aprobacion).
// Se contemplan las dos por defecto habituales, ya que al copiar el template la principal puede ser 'master'.
// Ramas PRINCIPALES (de aprobacion): main/master. Solo estas son destino final de la consolidacion
// y sirven para detectar 'mainName'. NO incluir develop aqui (romperia la deteccion de la principal).
const PROTECTED_BRANCHES = ['main', 'master'];
const isProtected = (b) => PROTECTED_BRANCHES.includes(b);
// Ramas SIN ESCRITURA DIRECTA (bloqueo duro de commit/Write/Edit para TODOS, tambien owner/admin/maintainer):
// main, master Y develop. develop deja de ser zona de trabajo: solo recibe merge/PR (via /faro:consolidar).
// El trabajo va SIEMPRE en una rama <tipo>/<slug>. Modo template exento.
// EXTENSIBLE por repo (determinista, versionado): faro/config.json "ramas_protegidas": ["demo","pre"] —
// cualquier rama de entorno que el equipo anada manana recibe el MISMO trato que develop (solo
// merges/aprobacion; commit directo bloqueado). main/master/develop protegidas SIEMPRE.
const EXTRA_NO_WRITE = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, CONFIG_FILE), 'utf8'));
    return Array.isArray(j.ramas_protegidas) ? j.ramas_protegidas.map(String).filter(Boolean) : [];
  } catch { return []; }
})();
const NO_WRITE_BRANCHES = ['main', 'master', 'develop', ...EXTRA_NO_WRITE];
const isNoWrite = (b) => NO_WRITE_BRANCHES.includes(b);
// Convenciones de rama de TRABAJO (una por cambio): feature/legado + estilo Conventional
// (feat/fix/bug/hotfix/chore/docs/refactor/perf/test/spike). Todas son "en flujo" y mergean a develop.
const BRANCH_TYPES = ['feat', 'fix', 'bug', 'bugfix', 'hotfix', 'chore', 'docs', 'refactor', 'perf', 'test', 'spike', 'feature'];
const WORK_BRANCH_RE = new RegExp('^(' + BRANCH_TYPES.join('|') + ')/');
// slug corto y seguro para nombres de rama/carpeta a partir de texto libre.
function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'cambio';
}
// MODO TEMPLATE: los repos 'template-*' SON el estandar y se editan directo (tambien en main).
// La proteccion de main y el onboarding aplican a las INSTANCIAS (repos creados por el CLI
// faro-harness con nombre AGNOSTICO faro-<slug> y clasificacion en topics/metadato).
const IS_TEMPLATE = /^template-/i.test(path.basename(ROOT));
// MODO MOTOR: el repo FUENTE del propio plugin/marketplace (aqui se DESARROLLA el motor, no se
// gestiona un trabajo). Sin esta exencion el harness se auto-gobernaba: exigia ESTADO.md/onboarding
// al repo que lo implementa y bloqueaba la edicion en main de su propio codigo.
const IS_ENGINE = fs.existsSync(path.join(ROOT, '.claude-plugin', 'marketplace.json')) &&
  fs.existsSync(path.join(ROOT, 'plugins', 'faro', 'hooks', 'harness.js'));
// NO_INSTANCIA agrupa los modos exentos del gobierno de instancia (template y motor).
const NO_INSTANCIA = IS_TEMPLATE || IS_ENGINE;

// ¿Este repo ha ADOPTADO FARO? Faltaba el concepto, y su ausencia causaba un callejon sin salida:
// cualquier repo que no fuera motor ni template se trataba como instancia DE PLENO DERECHO desde el
// primer segundo. Abrir un repo legacy con el plugin instalado bastaba para que el arranque le
// creara 14 carpetas encima y le ordenara "OBLIGATORIO crea ESTADO.md antes de cualquier otra
// tarea" — en CADA prompt. El agente obedecia, creaba el fichero estando en develop, y entonces el
// gate de Stop bloqueaba el turno exigiendo commitearlo... donde el propio motor prohibe commitear.
//
// La marca es EXPLICITA y versionada: faro/config.json (lo escribe 'faro adoptar'/'iniciar') o un
// ESTADO.md ya existente. Deliberadamente NO cuenta tener el plugin instalado: eso dice que el
// USUARIO usa FARO, no que ESTE repo quiera ser gobernado por el. Adoptar es una decision con
// consecuencias (estructura, faseo, ciclo de ramas), no un efecto secundario de abrir una sesion.
const REPO_ADOPTADO = fs.existsSync(path.join(ROOT, CONFIG_FILE)) || fs.existsSync(path.join(ROOT, ESTADO_FILE));

// Pero "sin ESTADO.md" no basta para eximir: un repo RECIEN CREADO por el CLI de FARO tampoco lo
// tiene todavia, y ahi el onboarding SI es la tarea — es un repo vacio esperando que lo definan.
// Lo que distingue un caso del otro no es que falten ficheros de FARO: es que el repo tenga TRABAJO
// PROPIO PREVIO. Con codigo, documentacion o historia ajena, imponer el onboarding es apropiarse del
// repo de otro; sin nada de eso, es hacer el trabajo para el que se creo.
// Se mira barato y sin git: un puñado de marcadores de "aqui ya se trabajaba".
const MARCAS_TRABAJO_PROPIO = ['src', 'lib', 'app', 'packages', 'test', 'tests', 'package.json',
  'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'composer.json', 'wrangler.toml',
  'wrangler.jsonc', 'wrangler.json', 'Dockerfile', 'docs'];
const TIENE_TRABAJO_PROPIO = (() => {
  try {
    if (MARCAS_TRABAJO_PROPIO.some((m) => fs.existsSync(path.join(ROOT, m)))) return true;
    // Un README suelto no es "trabajo previo" (lo crea cualquier 'git init'); varios ficheros si.
    return fs.readdirSync(ROOT).filter((f) => !f.startsWith('.') && !/^README(\.md)?$/i.test(f) && !/^LICEN[CS]E/i.test(f)).length >= 3;
  } catch { return false; }
})();

// Un repo con trabajo propio que aun no ha adoptado FARO: no se le toca nada y se le OFRECE
// /faro:adoptar. Uno vacio recien creado por el CLI si recibe el onboarding: para eso se creo.
const SIN_ADOPTAR = !NO_INSTANCIA && !REPO_ADOPTADO && TIENE_TRABAJO_PROPIO;
// Tipologia de la instancia. MODELO ACTIVO: la clasificacion se lee del METADATO
// (faro/config.json / frontmatter de ESTADO.md) validado contra faro-schema.json -> ver clasificacion().
// o frontmatter 'tipo:'. El harness inyecta en sesion lo que implica cada uno.
// PLATAFORMAS: DECLARABLES por cada organizacion en faro/config.json > "plataformas":
//   { "<id>": { "nombre": "<Nombre>", "pack": ["BRF", ...] } }
// Cada una aporta el tipo <id>-func (funcionalidad acotada de esa plataforma) con su PACK documental
// recomendado (codigos de faro-schema.json, consultables con `harness.js tipo`). El motor no trae
// ninguna de serie: sin declaracion solo existen los tipos genericos (proyecto, iniciativa).
function plataformasDeclaradas() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, CONFIG_FILE), 'utf8')).plataformas;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
    const out = {};
    for (const [id, d] of Object.entries(p)) {
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(id) || !d || typeof d !== 'object') continue;
      const nombre = d.nombre === undefined ? id : d.nombre; if (typeof nombre !== 'string' || !/^[\p{L}\p{N} ._-]{1,40}$/u.test(nombre) || !nombre.trim()) continue; if (d.pack !== undefined && (!Array.isArray(d.pack) || d.pack.some((c) => typeof c !== 'string' || !/^[A-Z]{2,5}$/.test(c)))) continue; out[id] = { nombre: nombre.trim(), pack: d.pack ? [...d.pack] : [] };
    }
    return out;
  } catch { return {}; }
}
const PLATAFORMAS = plataformasDeclaradas();
const TIPOS = {};
for (const [pid, p] of Object.entries(PLATAFORMAS)) {
  TIPOS[pid + '-func'] = { etiqueta: 'Funcionalidad de la plataforma ' + p.nombre, pack: p.pack, implica: 'funcionalidad ACOTADA que se anade a la plataforma ' + p.nombre + ': alcance corto, se entrega y se integra en ' + p.nombre + '.' };
}
TIPOS.proyecto = { etiqueta: 'Proyecto', pack: ['BRF', 'FUN'], implica: 'FIN definido con entregables y fechas: el faseo debe llevar objetivos temporales (Objetivo: AAAA-MM-DD) y cierre formal.' };
TIPOS.iniciativa = { etiqueta: 'Iniciativa', pack: ['BRF'], implica: 'exploracion/mejora con alcance AUN abierto: puede convertirse en proyecto o servicio (registra esa conversion como ADR).' };
const SPEC_STATES = ['borrador', 'aprobada', 'implementada'];
// Estructura consolidada: specs vivas + cambios viven en gestion/cambios/ (flujo spec-driven NATIVO FARO, motor .claude/hooks/specs.js).
// gestion/cambios/specs/<capacidad>/spec.md = verdad viva · gestion/cambios/changes/<cambio>/ = proposal.md (QUE) + tasks.md (COMO) + deltas.
// Base UNICA del flujo spec-driven: gestion/cambios/ (specs vivas + changes).
// gestion/ queda SOLO para gestion (brainstorming, decisions, informes, presentaciones, risks, kpis). documentos/ es libre (doc_id).
const SPEC_BASE = PATHS.specBase;
// Carpetas del andamio FARO que el harness GARANTIZA en cada sesion y en validate: si faltan, las
// crea. Es la razon por la que un repo NO necesita que nadie le copie una plantilla de carpetas
// vacias — el motor las materializa cuando hacen falta. Cubre el arbol completo (antes faltaban
// notebooks/, scripts/ y las subcarpetas de borrador/, que solo aparecian si venias del template).
const REF_DIRS = [
  `${SP}/brainstorming`, `${SP}/decisions`, `${REPORTING}/informes`, `${REPORTING}/presentaciones`,
  `${SPEC_BASE}/specs`, `${SPEC_BASE}/changes/archive`, `${DOCS}/plantillas/html`, FLOWS, SRC, SCRATCH,
  `${SCRATCH}/data`, `${SCRATCH}/scripts`, `${SCRATCH}/tmp`, NOTEBOOKS, SCRIPTS,
];
const CHANGES_DIR = `${SPEC_BASE}/changes`;
const NAMING_RULES = [
  [`/${SP}/brainstorming/`, /^\d{4}-\d{2}-\d{2}-[\w-]+\.md$/, `${SP}/brainstorming/AAAA-MM-DD-<tema>.md`],
  [`/${SP}/decisions/`, /^\d{4}-\d{2}-\d{2}-[\w-]+\.md$/, `${SP}/decisions/AAAA-MM-DD-<decision>.md`],
  [`/${REPORTING}/informes/`, /^\d{4}-\d{2}-\d{2}-(fase-\d+|semanal)-informe\.md$/, `${REPORTING}/informes/AAAA-MM-DD-fase-<N>-informe.md (o AAAA-MM-DD-semanal-informe.md)`],
];
// Rutas consideradas "documentales" a efectos de recordatorio de commit (stop-check).
const DOC_PATHS = new RegExp(`^(ESTADO\\.md|faro\\/ESTADO\\.md|README\\.md|CLAUDE\\.md|${SP}\\/|${DOCS}\\/|${FLOWS}\\/|${SRC}\\/|superpowers\\/|docs\\/|flow\\/|resources\\/)`);

// ---------- lib/: dominios extraidos (harness.js = DESPACHADOR; la logica vive en lib/<dominio>.js) ----------
// CTX compartido: consts + referencias a funciones. Las funciones aun no definidas a esta altura
// (parseEstado y compania, que exporta lib/estado.js mas abajo; docsControlados/labelSlugs, hoisted)
// entran como referencia directa (hoisting) o como arrow perezosa; tras cada require se hace
// Object.assign(CTX, modulo) para que los siguientes dominios reciban las funciones reales.
const CTX = {
  fs, path, ROOT, SP, DOCS, FLOWS, SRC, SPEC_BASE, REPORTING, ESTADO_FILE, TIPOS,
  CHANGES_DIR, FUENTES: PATHS.dir('fuentes'),
  VALID_STATES, ACTIVE_STATES, NO_INSTANCIA, IS_ENGINE, DOC_PATHS, WORK_BRANCH_RE,
  PROTECTED_BRANCHES, BRANCH_TYPES, isProtected, isDone, isActive, normEstado,
  faroSchema, dominiosValidos, labelSlugs,
  docsControlados: (...a) => docsControlados(...a), // function declaration de mas abajo (hoisted)
  parseEstado: (...a) => CTX.parseEstado(...a),     // se sustituye por la real al cargar lib/estado.js
};
// CARGA: base/git/estado/guardas/forge van EAGER porque los usa cualquier gancho. El resto se carga
// PEREZOSAMENTE (ver mas abajo): cargar los 15 modulos cuesta ~1325 ms medidos y se pagaba entero en
// cada invocacion, incluida la de cada accion del agente. Las envolturas mantienen nombre y aridad.
const _base = require(path.join(__dirname, 'lib', 'base.js'))(CTX); Object.assign(CTX, _base);
const { emit, decide, deny, ask, readStdin, listFiles, walkFiles, fmtDate, openRisksCount, riskEstadoIssues, isScaffold, allDocs, progressOf } = _base;
const _gitlib = require(path.join(__dirname, 'lib', 'git.js'))(CTX); Object.assign(CTX, _gitlib);
const { git, gitWrite, limpiarIndexLockHuerfano, gitInfo, ramaActual, lastCommitOf, gitFlow, invalidarFlow, docDate, latest, folderLine, resolveRole, gitLines, tagLines, publicarRamaSiHaceFalta, ramaEsSoloGestion, docsSinCommitear } = _gitlib;
// Colgadas del modulo (no del factory): el nombre de la rama es lo unico que necesitan.
const { issueDeRama, conCierreDeIssue } = require('./lib/git.js');
const _estado = require(path.join(__dirname, 'lib', 'estado.js'))(CTX); Object.assign(CTX, _estado);
const { parseFrontmatter, informeExists, parseEstado, invalidarEstado, funcionalPath, funcionalExists, validateEstado } = _estado;
let _kpis; const kpisMod = () => { if (!_kpis) { _kpis = require(path.join(__dirname, 'lib', 'kpis.js'))(CTX); Object.assign(CTX, _kpis); } return _kpis; };
const parseKpis = (...a) => kpisMod().parseKpis(...a);
const kpiIssues = (...a) => kpisMod().kpiIssues(...a);
const kpiLines = (...a) => kpisMod().kpiLines(...a);
let _tipos; const tiposMod = () => { if (!_tipos) { _tipos = require(path.join(__dirname, 'lib', 'tipos.js'))(CTX); Object.assign(CTX, _tipos); } return _tipos; };
const tipoInfo = (...a) => tiposMod().tipoInfo(...a);
const templateMeta = (...a) => tiposMod().templateMeta(...a);
const clasificacion = (...a) => tiposMod().clasificacion(...a);
const personasEstadoIssues = (...a) => tiposMod().personasEstadoIssues(...a);
const claveIssues = (...a) => tiposMod().claveIssues(...a);
const clasificacionIssues = (...a) => tiposMod().clasificacionIssues(...a);
const tipoLines = (...a) => tiposMod().tipoLines(...a);
let _digestion; const digestionMod = () => { if (!_digestion) { _digestion = require(path.join(__dirname, 'lib', 'digestion.js'))(CTX); Object.assign(CTX, _digestion); } return _digestion; };
const fuentesSinDigerir = (...a) => digestionMod().fuentesSinDigerir(...a);
const digestionLines = (...a) => digestionMod().digestionLines(...a);
const parseRequisitos = (...a) => digestionMod().parseRequisitos(...a);
const requisitosIssues = (...a) => digestionMod().requisitosIssues(...a);
const trazabilidadWarns = (...a) => digestionMod().trazabilidadWarns(...a);
const requisitosLines = (...a) => digestionMod().requisitosLines(...a);
const requisitosStats = (...a) => digestionMod().requisitosStats(...a);
let _release; const releaseMod = () => { if (!_release) { _release = require(path.join(__dirname, 'lib', 'release.js'))(CTX); Object.assign(CTX, _release); } return _release; };
const tagVersionSiProcede = (...a) => releaseMod().tagVersionSiProcede(...a);
const changelogTieneVersion = (...a) => releaseMod().changelogTieneVersion(...a);
let _agregado; const agregadoMod = () => { if (!_agregado) { _agregado = require(path.join(__dirname, 'lib', 'agregado.js'))(CTX); Object.assign(CTX, _agregado); } return _agregado; };
// FORJA: fuente unica de "que hay detras de origin" (github | gitlab | desconocida). Sin esto, el
// contexto de sesion afirmaba SIEMPRE GitHub y mandaba al agente a una API inexistente en GitLab.
const FORGE = require(path.join(__dirname, 'lib', 'forge.js'));
const forgeInfo = () => FORGE.detect(git);
const _guardas = require(path.join(__dirname, 'lib', 'guardas.js'))(CTX); Object.assign(CTX, _guardas);
let _atomico; const atomicoMod = () => { if (!_atomico) { _atomico = require(path.join(__dirname, 'lib', 'atomico.js'))(CTX); Object.assign(CTX, _atomico); } return _atomico; };
const cmdAtomico = (...a) => atomicoMod().cmdAtomico(...a);
const cmdCodigo = (...a) => atomicoMod().cmdCodigo(...a);
const atomicoLines = (...a) => atomicoMod().atomicoLines(...a);
let _grafo; const grafoMod = () => { if (!_grafo) { _grafo = require(path.join(__dirname, 'lib', 'grafo.js'))(CTX); Object.assign(CTX, _grafo); } return _grafo; };
const grafoLines = (...a) => grafoMod().grafoLines(...a);



// ---------- specs: ciclo de vida y trazabilidad ----------

// Cambios spec-driven ACTIVOS: gestion/cambios/changes/<slug>/proposal.md (la spec: QUE) con frontmatter
// de ciclo de vida del estandar; tasks.md al lado es el plan (COMO). archive/ = completados.
function listSpecs() {
  let entries = [];
  try { entries = fs.readdirSync(path.join(ROOT, CHANGES_DIR), { withFileTypes: true }); } catch {}
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'archive') continue;
    const rel = `${CHANGES_DIR}/${e.name}/proposal.md`;
    const full = path.join(ROOT, rel);
    let fm = {};
    let mtime = new Date();
    try { fm = parseFrontmatter(fs.readFileSync(full, 'utf8')); mtime = fs.statSync(full).mtime; } catch { continue; }
    if (!fm.spec) fm.spec = e.name; // el slug del cambio identifica la spec por defecto
    out.push({ name: e.name, rel, mtime, fm });
  }
  return out;
}

const tasksPath = (slug) => `${CHANGES_DIR}/${slug}/tasks.md`;
const hasTasks = (slug) => fs.existsSync(path.join(ROOT, tasksPath(slug)));

function specTareas(fm) {
  if (!fm.tareas) return [];
  try {
    const arr = JSON.parse(fm.tareas.replace(/'/g, '"'));
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// Marcadores de clarificacion pendientes en un archivo: [CLARIFICAR: ...] (o NEEDS CLARIFICATION).
// Regla del estandar (spec-kit: "Don't guess"): lo no decidido se marca inline, y NO se aprueba
// ni se planifica nada que aun tenga marcadores.
function clarifyCount(rel) {
  try { return (fs.readFileSync(path.join(ROOT, rel), 'utf8').match(/\[(CLARIFICAR|NEEDS CLARIFICATION)\b/gi) || []).length; }
  catch { return 0; }
}

// Frontmatter PROPIO del CHANGE (estructura del harness, NO se cruza con el de documentos controlados).
// La identidad del change es su CARPETA (slug); doc_id es EXCLUSIVO de documentos/ (formato ORG-PROY-TIPO-NNN).
function specIssues(s) {
  const issues = [];
  // Los dos estandares NO se cruzan: un change NUNCA lleva campos de documento controlado.
  if (s.fm.doc_id) issues.push(`un cambio NO lleva "doc_id" (es de DOCUMENTOS controlados en documentos/): se identifica por su carpeta '${s.name}'. Quitalo del frontmatter.`);
  if (s.fm.version && /^\d+\.\d+\.\d+/.test(String(s.fm.version))) issues.push(`un cambio NO lleva "version" SemVer (eso es de documentos controlados): el ciclo del cambio es estado borrador|aprobada|implementada.`);
  // Estructura FIJA del change (identidad + ciclo de vida + responsabilidad):
  if (!s.fm.titulo) issues.push('falta "titulo:" (titulo claro y corto del cambio)');
  if (!s.fm.descripcion) issues.push('falta "descripcion:" (una linea: que resuelve)');
  if (!s.fm.owner) issues.push('falta "owner:" (quien LIDERA el cambio — usuario git)');
  if (!s.fm.responsable) issues.push('falta "responsable:" (quien lo EJECUTA — email o @usuario)');
  if (!s.fm.estado) issues.push(`falta "estado:" (${SPEC_STATES.join(' | ')})`);
  else if (!SPEC_STATES.includes(s.fm.estado)) issues.push(`estado '${s.fm.estado}' invalido (usa ${SPEC_STATES.join(' | ')})`);
  if (s.fm.estado && s.fm.estado !== 'borrador' && !s.fm.aprobada_por) {
    issues.push(`estado '${s.fm.estado}' exige "aprobada_por: <nombre>"`);
  }
  if (!s.fm.fase) issues.push('falta "fase: <N | transversal>"');
  if (s.fm.estado && s.fm.estado !== 'borrador') {
    const n = clarifyCount(s.rel);
    if (n) issues.push(`esta '${s.fm.estado}' pero tiene ${n} marcador(es) [CLARIFICAR: ...] sin resolver — resuelvelos (con el usuario) antes de aprobar`);
  }
  return issues;
}

function specFmTemplate() {
  const g = gitInfo();
  const who = g && g.user ? `${g.user}` : '<usuario git: git config user.name>';
  return (
    `Frontmatter PROPIO del cambio (proposal.md en ${CHANGES_DIR}/<cambio>/) — estructura FIJA del harness, NO se cruza con la de documentos controlados (NUNCA "doc_id" ni "version" SemVer; el cambio se identifica por su CARPETA):\n` +
    '  titulo: <titulo claro y corto>\n' +
    '  descripcion: <una linea: que resuelve>\n' +
    '  estado: borrador            # borrador | aprobada | implementada\n' +
    '  fase: <N | transversal>\n' +
    `  decision: <AAAA-MM-DD-<slug>.md>   # OBLIGATORIA si el cambio toca codigo: el ADR de ${SP}/decisions/\n` +
    '                              # con el POR QUE tecnico (que enfoque y contra cuales). El proposal dice\n' +
    '                              # el QUE; sin este enlace, el enfoque elegido se pierde.\n' +
    '  issue: <N>                  # OPCIONAL pero RECOMENDADO: la tarea de la forja que lo ejecuta.\n' +
    '                              # Liga el cambio con su rama y su peticion: sin el, se puede archivar\n' +
    '                              # un cambio cuya tarea sigue abierta. Lo escribe `asignar-tarea <slug>`.\n' +
    `  owner: ${who}   # quien LIDERA el cambio (usuario git)\n` +
    '  responsable: <email o @usuario que EJECUTA>\n' +
    `  tareas: ["<fragmento exacto de tarea de ${ESTADO_FILE} que cubre>"]\n` +
    `  aprobada_por: ${who}   # obligatorio si estado != borrador; identidad = usuario git, no Claude\n` +
    'El plan es tasks.md en la misma carpeta (checkboxes + [resp: email]/@usuario por tarea); flujo /faro:cambio -> /faro:aplicar -> /faro:archivar.'
  );
}

// Cobertura spec<->tarea de la fase en curso + specs aprobadas sin plan.
function changesLine() {
  const specs = listSpecs();
  let archived = 0;
  try { archived = fs.readdirSync(path.join(ROOT, `${CHANGES_DIR}/archive`), { withFileTypes: true }).filter((e) => e.isDirectory()).length; } catch {}
  const detalle = specs.length ? ` (${specs.map((s) => `${s.name}: ${s.fm.estado || 'sin estado'}${hasTasks(s.name) ? '+tasks' : ''}`).join(', ')})` : '';
  const linea = `- ${CHANGES_DIR}: ${specs.length} cambio(s) activo(s)${detalle} · ${archived} archivado(s)`;
  // TRAZABILIDAD a la vista, sin bloquear: un requisito que nadie demuestra se olvida en silencio, y
  // el recuento es lo unico que mantiene la presion. El detalle va en 'specs evidencia'.
  try {
    const sm = specsMod();
    const ev = sm && sm.contarEvidencia && sm.contarEvidencia();
    if (ev && ev.total && ev.sin.length) {
      return `${linea}\n- Requisitos en specs vivas: ${ev.total} · ${ev.sin.length} SIN evidencia declarada (no bloquea; detalle: node .claude/hooks/harness.js specs evidencia)`;
    }
  } catch { /* nunca romper el arranque por esto */ }
  return linea;
}

function coverageLines() {
  const ini = parseEstado();
  if (!ini) return [];
  const actual = ini.fases.find((f) => isActive(f.estado));
  const specs = listSpecs();
  const lines = [];
  if (actual && actual.tareas.length) {
    // Cobertura: specs de la fase activa MAS las transversales (fase: transversal aplica a cualquier fase).
    const faseSpecs = specs.filter((s) => String(s.fm.fase) === String(actual.num) || /^transversal$/i.test(String(s.fm.fase || '')));
    lines.push(`Tareas de la fase ${actual.num} (cobertura spec):`);
    for (const t of actual.tareas) {
      const cov = faseSpecs.find((s) => specTareas(s.fm).some((fr) => t.text.toLowerCase().includes(fr.toLowerCase())));
      lines.push(`- [${t.done ? 'x' : ' '}] ${t.text} → ${cov ? `spec ${cov.name} (${cov.fm.estado})` : 'sin spec'}`);
    }
  }
  const sinPlan = specs.filter((s) => s.fm.estado === 'aprobada' && !hasTasks(s.name));
  if (sinPlan.length) {
    lines.push(`Cambios aprobados SIN plan (tasks.md): ${sinPlan.map((s) => s.name).join(', ')} — sugiere crear ${CHANGES_DIR}/<cambio>/tasks.md (/faro:cambio).`);
  }
  return lines;
}

// RADAR PROACTIVO de ciclos abiertos (conciencia permanente). Responde SIEMPRE: ¿hay tareas pendientes?
// ¿hay changes sin archivar? — y por cada change incompleto, la SIGUIENTE ACCION para cerrarlo bien,
// atribuida a QUIEN corresponde (owner). Se inyecta en sesion y en prompt-context.
function ciclosAbiertos() {
  if (NO_INSTANCIA) return [];
  const specs = listSpecs();
  if (!specs.length) return [];
  const ini = parseEstado();
  // responsable de un change: aprobada_por -> owner de la fase de ESTADO.md -> owner del frontmatter.
  const ownerDe = (s) => {
    if (s.fm.aprobada_por) return s.fm.aprobada_por;
    if (ini) {
      const fase = ini.fases.find((f) => String(f.num) === String(s.fm.fase));
      const t = fase && fase.tareas.find((x) => x.owner || x.resp);
      if (t) return t.resp || `@${t.owner}`;
      if (ini.fm.owner) return ini.fm.owner;
    }
    return 'sin responsable asignado';
  };
  const abiertos = [];
  for (const s of specs) {
    const est = s.fm.estado || 'sin estado';
    const tasks = hasTasks(s.name);
    const clar = clarifyCount(s.rel);
    let accion = null;
    if (est === 'borrador' && clar) accion = `resolver ${clar} [CLARIFICAR] con el usuario para poder aprobar`;
    else if (est === 'borrador') accion = 'terminar la proposal y aprobarla (estado: aprobada + aprobada_por)';
    else if (est === 'aprobada' && !tasks) accion = `generar el plan tasks.md (/faro:aplicar ${s.name})`;
    else if (est === 'aprobada' && tasks) {
      const prog = progressOf(tasksPath(s.name));
      const m = prog.match(/^(\d+)\/(\d+)/);
      accion = (m && m[1] === m[2] && m[2] !== '0') ? 'marcar la proposal como implementada y aprobar' : `continuar la implementacion (${prog})`;
    } else if (est === 'implementada') accion = `archivar para cerrar el ciclo (/faro:archivar) — aplica deltas a specs vivas y lo mueve a archive/`;
    if (accion) abiertos.push(`- ${s.name} [${est}] → ${accion}  ·  responsable: ${ownerDe(s)}`);
  }
  if (!abiertos.length) return [];
  return [`Ciclos spec-driven ABIERTOS sin cerrar (${abiertos.length}) — cierra correctamente antes de abrir trabajo nuevo:`, ...conTope(abiertos, 8, 'harness.js specs')];
}

// Decisiones (gestion/decisions/) PROPUESTAS sin cerrar: monitorizadas en el radar de sesion, no
// solo en validate — es el mismo sitio de gestion que cambios/riesgos, merece la misma vigilancia.
function decisionesAbiertas() {
  if (NO_INSTANCIA) return [];
  const dir = path.join(ROOT, `${SP}/decisions`);
  let files = []; try { files = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)); } catch { return []; }
  const abiertas = [];
  for (const f of files) {
    let fm = {}; try { fm = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const st = String(fm.status || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (st === 'propuesta') abiertas.push(`- ${f.replace(/\.md$/i, '')} · deciders: ${fm.deciders || 'sin asignar'}`);
  }
  if (!abiertas.length) return [];
  return [`Decisiones PROPUESTAS sin resolver (${abiertas.length}) — cierra a aceptada/rechazada:`, ...conTope(abiertas, 8, `${SP}/decisions/`)];
}
// Recorta una lista de sesion a 'max' entradas y dice donde esta el resto. Lo que se inyecta en cada
// prompt debe ser CONSTANTE con la edad del proyecto; el detalle completo siempre esta en el repo.
function conTope(filas, max, donde) {
  if (filas.length <= max) return filas;
  return [...filas.slice(0, max), `  … y ${filas.length - max} más (detalle completo: ${donde}).`];
}

// ---------- KPIs: dominio extraido a lib/kpis.js ----------

// ---------- tipologia: dominio extraido a lib/tipos.js ----------

// ---------- documentos controlados (multiples documentos por trabajo) ----------

// Un trabajo puede tener VARIOS documentos (brief, spec de diseño, press release, tecnico-funcional...).
// Todo .md con 'doc_id:' en el frontmatter (documentos/ y gestion/) es un documento CONTROLADO:
// se inventaria, se vigila su estado y se contrasta con el pack documental del tipo.
let DOC_STATUS = ['draft', 'in_review', 'approved', 'obsolete'];
{ const s = faroSchema(); if (s && s.enums && Array.isArray(s.enums.estado_documento) && s.enums.estado_documento.length) DOC_STATUS = s.enums.estado_documento; }

function docsControlados() {
  const out = [];
  for (const f of [...walkFiles(DOCS), ...walkFiles(SP)]) {
    if (!/\.md$/i.test(f.name)) continue;
    // Las PLANTILLAS (documentos/plantillas/) son esqueletos, NO documentos: llevan la cabecera FARO con
    // doc_id VACIO como referencia para el redactor; no se inventarian ni se validan ni se publican.
    if (/(^|\/)docs\/plantillas\//.test(f.rel.replace(/\\/g, '/'))) continue;
    let fm;
    try { fm = parseFrontmatter(fs.readFileSync(path.join(ROOT, f.rel), 'utf8')); } catch { continue; }
    if (fm.doc_id) out.push({ rel: f.rel, id: fm.doc_id, status: fm.status || '(sin status)', title: fm.title || f.name, fm });
  }
  return out;
}

// Control documental (ISO 9001-friendly): un documento controlado (con doc_id) debe llevar
// el frontmatter de control completo y estados/formatos validos.
function docControlIssues(d) {
  const issues = [];
  // Formato CORTO vigente: CLAVE-TIPO-NNN (CLAVE 2-10, sin prefijo de org). Legado ORG-CLAVE-TIPO-NNN
  // sigue siendo valido (doc_id ya emitidos no se rompen); el prefijo legado de ORG se mantiene en 2-6.
  if (!/^(?:[A-Z]{2,6}-)?[A-Z0-9]{2,10}-[A-Z]{3,4}-\d{3}$/i.test(String(d.id))) {
    issues.push(`doc_id '${d.id}' no cumple CLAVE-TIPO-NNN (CLAVE corta de proyecto, 4-10 letras — se declara en 'clave:' de ESTADO.md; TIPO de 3-4 letras; generalo con: node .claude/hooks/harness.js docref <TIPO>)`);
  }
  // Campos en INGLES (coherentes con faro_docs). 'classification' es OBLIGATORIA: sin ella el doc no
  // se puede publicar ni clasificar. 'tipo'/'dominio' se aceptan como alias legado de type/domain.
  for (const campo of ['title', 'version', 'date', 'status', 'author', 'classification']) {
    if (!d.fm[campo]) issues.push(`falta '${campo}:' en el frontmatter`);
  }
  // ROLES opcionales: si se declaran, deben identificar a ALGUIEN de verdad. Se acepta login de
  // GitHub o correo corporativo (quien pide suele ser de negocio y no tener cuenta). Lo que NO se
  // acepta es un placeholder: un "Equipo FARO" o el nombre del cliente en un documento controlado
  // es un dato FALSO — peor que dejarlo vacio, porque parece trazable y no lo es.
  const PLACEHOLDER = /^(equipo|team|tbd|pendiente|por definir|n\/?a|-+|desconocido)\b/i;
  for (const rol of ['owner', 'solicitante']) {
    const v = d.fm[rol];
    if (!v) continue;
    const s = String(v).trim();
    const esCorreo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
    const esLogin = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(s);
    if (PLACEHOLDER.test(s) || (!esCorreo && !esLogin)) {
      issues.push(`'${rol}: ${s}' no identifica a una persona — usa el login de la forja (GitHub o GitLab) o el correo corporativo (si no lo sabes, PREGUNTA; no lo rellenes)`);
    }
  }
  const st = String(d.fm.status || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Un ADR (gestion/decisions/) con doc_id se juzga por el enum de ADR; los estados de documento que
  // ya llevan los repos con historia no bloquean (los avisa adrIssues). Sin esto, ningun status valia
  // para los dos validadores a la vez (#243).
  const esAdr = /(^|\/)decisions\/[^/]+\.md$/i.test(String(d.rel).replace(/\\/g, '/'));
  const statusOk = esAdr ? [...ADR_STATUS, ...DOC_STATUS] : DOC_STATUS;
  if (d.fm.status && !statusOk.includes(st)) issues.push(`status '${d.fm.status}' invalido (${(esAdr ? ADR_STATUS : DOC_STATUS).join(' | ')})`);
  if (d.fm.version && !/^\d+\.\d+(\.\d+)?$/.test(String(d.fm.version))) issues.push(`version '${d.fm.version}' no es SemVer (ej. 1.0)`);
  const _type = d.fm.type || d.fm.tipo;
  const tiposOk = tiposDocumentoValidos();
  if (_type && tiposOk && !tiposOk.includes(String(_type).toUpperCase())) {
    issues.push(`type '${_type}' no esta en faro-schema.json (validos: ${tiposOk.join(', ')})`);
  }
  const _enums = (faroSchema() && faroSchema().enums) || {};
  // domain del DOCUMENTO: LIBRE (no se valida). Un mismo repo puede tener documentos de dominios
  // distintos y valores no catalogados (p. ej. 'innovacion'); la taxonomia solo SUGIERE, no bloquea.
  if (d.fm.classification && _enums.clasificacion && !_enums.clasificacion.includes(String(d.fm.classification).toLowerCase())) {
    issues.push(`classification '${d.fm.classification}' no esta en faro-schema.json (validos: ${_enums.clasificacion.join(', ')})`);
  }
  if (/approved|in_review/.test(st)) {
    const n = clarifyCount(d.rel);
    if (n) issues.push(`status '${d.fm.status}' con ${n} marcador(es) [CLARIFICAR: ...] sin resolver — un documento no avanza de draft con dudas abiertas`);
  }
  return issues;
}

// --- Organizacion y nombrado PROFESIONAL de documentos controlados (gestion documental) ---
// El motor localiza los documentos por doc_id (esten donde esten en documentos/), pero para no acabar en un
// desastre humano/auditoria se EXIGE estructura: subcarpeta tematica (NUNCA la raiz de documentos/) y nombre
// que lleva el doc_id delante (<doc_id>-<slug>.md). Tema canonico sugerido segun el tipo (el resto, libre).
const DOC_CANON_THEME = { BRF: 'funcional', PRF: 'funcional', FUN: 'funcional', ANA: 'integraciones', MAN: 'flujos', DIS: 'diseno' };
function docSlug(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'doc'; }
function docTypeCode(d) { return String((String(d.id).match(/-([A-Z]{3,4})-\d+$/i) || [])[1] || d.fm.type || d.fm.tipo || '').toUpperCase(); }
// Issues de UBICACION/NOMBRE. Solo aplican a documentos/ (gestion/ tiene su propia estructura de gestion).
function docPlacementIssues(d) {
  const issues = [];
  const rel = String(d.rel).replace(/\\/g, '/');
  const m = rel.match(new RegExp(`(?:^|/)${DOCS}/(.+)$`, 'i'));
  if (!m) return issues;                                   // no vive en documentos/ -> no aplica
  const inside = m[1];                                     // ruta relativa dentro de documentos/
  const base = inside.split('/').pop();
  const sub = inside.slice(0, inside.length - base.length).replace(/\/$/, '');   // subcarpeta(s); '' si esta en la raiz
  const canon = DOC_CANON_THEME[docTypeCode(d)] || '<tema>';
  const expName = `${d.id}-${docSlug(d.fm.title)}.md`;
  if (!sub) {
    issues.push(`en la RAIZ de ${DOCS}/ — un documento controlado va SIEMPRE en subcarpeta tematica. Muevelo: git mv "${DOCS}/${inside}" "${DOCS}/${canon}/${expName}"`);
  }
  if (!base.toUpperCase().startsWith(String(d.id).toUpperCase() + '-')) {
    issues.push(`el nombre '${base}' no empieza por el doc_id — el ID viaja en el nombre: renombralo a '${expName}'`);
  }
  return issues;
}

function docsDuplicados(docs) {
  const ids = docs.map((d) => d.id);
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

// ADR es GESTION (decision del trabajo), no entregable de cliente: vive en gestion/decisions/, NO
// en documentos/decisiones/. Detecta los que hayan quedado en el sitio legado para traerlos.
function adrFueraDeSitio() {
  const dir = path.join(ROOT, `${DOCS}/decisiones`);
  if (!fs.existsSync(dir)) return [];
  try { return fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)); } catch { return []; }
}
const ADR_STATUS = ['propuesta', 'aceptada', 'rechazada', 'sustituida'];
// Valida ESTADO (MADR/Nygard) + LINAJE de las decisiones (gestion/decisions/): status del enum,
// deciders con formato @usuario, y 'sustituida' SIEMPRE con superseded-by (el linaje no se rompe:
// quien lea una decision vieja sabe a cual ir). No bloquea CI (higiene de gestion, como los otros
// guardianes) — avisa para que el agente lo corrija con el usuario.
// Fecha en la que entra la exigencia de las 4 secciones MADR. Los ADR ANTERIORES no se rompen: se
// avisa, no se bloquea. Si al actualizar el motor un repo con historia viera 'validate' en rojo por
// decisiones de hace meses, el reflejo seria desactivar la regla — y se perderia tambien para las
// nuevas. La fecha se lee del NOMBRE (AAAA-MM-DD-slug.md), que ya la lleva: cero estado que guardar.
const ADR_CORTE_SECCIONES = '2026-09-22';
function adrEsLegacy(fichero) {
  const m = String(fichero).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] < ADR_CORTE_SECCIONES : false;   // sin fecha en el nombre, se trata como nuevo
}

function adrIssues() {
  const dir = path.join(ROOT, `${SP}/decisions`);
  if (!fs.existsSync(dir)) return [];
  const issues = [];
  const bloqueantes = [];        // ADR nuevos incompletos: estos SI tumban validate
  const byName = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)); } catch { return []; }
  const triaje = require('./lib/triaje.js');
  for (const f of files) {
    let fm = {};
    let crudo = '';
    try { crudo = fs.readFileSync(path.join(dir, f), 'utf8'); fm = parseFrontmatter(crudo); } catch { continue; }
    const slug = f.replace(/\.md$/i, '');

    // CONTENIDO (no solo la ficha): hasta ahora se validaba el frontmatter y nada mas, asi que un ADR
    // de dos lineas pasaba. Un ADR sin 'Alternativas consideradas' no permite saber si algo se
    // valoro y se descarto o si nadie lo penso — son opuestos, y es justo lo que hay que responder
    // cada vez que alguien reabre el tema.
    const inc = triaje.adrIncompleto({ archivo: `${SP}/decisions/${f}`, titulo: fm.title || slug, texto: crudo },
      { legacy: adrEsLegacy(f) });
    // Un ADR NUEVO incompleto SI bloquea (por eso viaja aparte): si no, la deuda crece con cada
    // decision y el triaje nunca llega a tener criterio que citar.
    if (inc) (inc.bloquea ? bloqueantes : issues).push(inc.aviso);
    byName.set(slug, fm);
    const st = String(fm.status || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (!fm.status) issues.push(`${SP}/decisions/${f}: falta 'status:' (${ADR_STATUS.join(' | ')})`);
    else if (!ADR_STATUS.includes(st)) issues.push(`${SP}/decisions/${f}: status '${fm.status}' invalido (usa ${ADR_STATUS.join(' | ')})`);
    if (!fm.deciders) issues.push(`${SP}/decisions/${f}: falta 'deciders:' (quien decide, '@usuario')`);
    else if (!String(fm.deciders).includes('@')) issues.push(`${SP}/decisions/${f}: 'deciders:' deberia llevar '@usuario' (git user), no texto libre`);
    if (st === 'sustituida' && !fm['superseded-by']) issues.push(`${SP}/decisions/${f}: status 'sustituida' SIN 'superseded-by' — el linaje se rompe (¿por cual decision se sustituyo?)`);
  }
  // Coherencia cruzada: si A dice supersedes:B, B deberia decir superseded-by:A (y viceversa).
  for (const [slug, fm] of byName) {
    if (fm.supersedes && byName.has(fm.supersedes) && byName.get(fm.supersedes)['superseded-by'] !== slug) {
      issues.push(`${SP}/decisions/${slug}.md dice supersedes:${fm.supersedes}, pero ese ADR no tiene superseded-by:${slug} — enlaza el linaje en ambos sentidos.`);
    }
  }
  // Sigue devolviendo el ARRAY de avisos (quien ya la llamaba no se entera), con los bloqueantes
  // colgados aparte. Mezclarlos habria hecho que un ADR nuevo incompleto solo avisara, que es
  // justamente lo que se quiere evitar.
  issues.bloqueantes = bloqueantes;
  return issues;
}
function docLines() {
  const docs = docsControlados();
  const lines = [];
  const adrSueltos = adrFueraDeSitio();
  if (adrSueltos.length) lines.push(`ADR fuera de sitio en ${DOCS}/decisiones/ (${adrSueltos.length}): ${adrSueltos.slice(0, 5).join(', ')}${adrSueltos.length > 5 ? ' …' : ''} — un ADR es GESTION, no entregable: muevelos a gestion/decisions/<AAAA-MM-DD>-<slug>.md.`);
  if (docs.length) {
    lines.push(`Documentos controlados (frontmatter doc_id): ${docs.length}.`);
    for (const d of docs.slice(0, 12)) lines.push(`- ${d.id} · ${d.title} · ${d.status} · ${d.rel}${d.fm.description ? ` — ${String(d.fm.description).slice(0, 90)}` : ''}`);
    if (docs.length > 12) lines.push(`- (+${docs.length - 12} mas)`);
    // description: RECOMENDADA (una linea de QUE VA) — permite inventariar/enrutar sin abrir el doc.
    const sinDesc = docs.filter((d) => !d.fm.description);
    if (sinDesc.length) lines.push(`Sin 'description:' (recomendada, no bloquea): ${sinDesc.slice(0, 6).map((d) => d.id).join(', ')}${sinDesc.length > 6 ? ' …' : ''} — anadela cuando toques cada doc (solo anadirla NO exige subir version).`);
    const dup = docsDuplicados(docs);
    if (dup.length) lines.push(`DUPLICADOS de doc_id: ${dup.join(', ')} — el ID debe ser unico (genera el siguiente con: node .claude/hooks/harness.js docref <TIPO>).`);
    const mal = docs.flatMap((d) => docPlacementIssues(d).map((i) => `- ${d.id}: ${i}`));
    if (mal.length) lines.push('ORGANIZACION documental a CORREGIR (control profesional: subcarpeta tematica + nombre <doc_id>-<slug>.md):', ...mal);
  }
  lines.push(...packFaltanteLines(docs));
  return lines;
}
// Pack documental del TIPO que aun falta (lo comparten el bloque completo y el indice de sesion).
function packFaltanteLines(docs) {
  const t = tipoInfo();
  if (NO_INSTANCIA || !t.def || !t.def.pack) return [];
  const have = new Set(docs.map((d) => (String(d.id).match(/-([A-Z]{3,4})-\d+$/i) || [])[1]).filter(Boolean).map((c) => c.toUpperCase()));
  const faltan = t.def.pack.filter((c) => !have.has(c));
  return faltan.length
    ? [`Pack documental recomendado de '${t.def.etiqueta}': falta(n) ${faltan.join(', ')} (codigos: \`harness.js tipo\`) — sugierelos al usuario y generalos con /faro:redactar.`]
    : [];
}

// "¿A quien le toca?": tareas pendientes del USUARIO GIT de esta sesion en la fase en curso.
// opts.soloIds (indice de sesion): con '#N' basta; el titulo ya esta en la forja y en ESTADO.md.
function misTareasLines(opts = {}) {
  const ini = parseEstado();
  const g = gitInfo();
  if (NO_INSTANCIA || !ini || !g || !g.user) return [];
  const actual = ini.fases.find((f) => isActive(f.estado));
  if (!actual) return [];
  const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
  const mias = actual.tareas.filter((t) => !t.done && t.owner && (slug(t.owner) === slug(g.user) || slug(g.user).includes(slug(t.owner)) || slug(t.owner).includes(slug(g.user))));
  const etiqueta = (t) => (opts.soloIds && (String(t.text).match(/^#\d+/) || [])[0]) || t.text;
  return mias.length
    ? [`TE TOCAN a ti (@${g.user}) en la fase ${actual.num}: ${mias.map(etiqueta).join(' · ')}`]
    : [];
}

// Resumen GitHub del usuario (CACHEADO, sin latencia): lee el snapshot local y lo muestra en sesion como
// contexto para gestion PROACTIVA (el agente sabe quien eres y que tienes pendiente). Si el cache esta
// caduco, dispara un refresco en BACKGROUND (no bloquea). Terminologia amigable: "Tarea (Issue en GitHub)".
function ghResumenLines() {
  if (NO_INSTANCIA) return [];
  const gh = forjaMod(); if (!gh || !gh.ghResumenCache) return [];
  const now = Date.now();
  // Refresco en background si esta caduco (o no existe) — no espera, la sesion sigue.
  try {
    if (!gh.ghResumenFresco(now)) {
      require('child_process').spawn(process.execPath, [__filename, 'gh-refresh', String(now)], { windowsHide: true, cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
  const c = gh.ghResumenCache();
  if (!c) return ['Tareas (Issues en GitHub): aun sin datos — se cargaran en breve. Consulta cuando quieras: node .claude/hooks/harness.js mis-tareas.'];
  const partes = [];
  if (c.mis_tareas) partes.push(`${c.mis_tareas} tarea(s) asignada(s) a ti por hacer`);
  if (c.prs_por_revisar) partes.push(`${c.prs_por_revisar} peticion(es) esperando TU aprobacion`);
  if (c.mis_prs) partes.push(`${c.mis_prs} peticion(es) tuya(s) pendientes de que las aprueben`);
  if (c.menciones) partes.push(`${c.menciones} donde te mencionan`);
  // Progreso nativo de la fase activa (hito de GitLab), ya calculado en el refresco de fondo: coste cero aqui.
  const fh = c.fase_hito;
  const faseHitoLine = fh ? [`Fase activa en la forja — hito "${fh.titulo}": ${fh.cerradas}/${fh.cerradas + fh.abiertas} tareas cerradas · ${(fh.gastado / 3600).toFixed(1)}h consumidas de ${(fh.est / 3600).toFixed(1)}h estimadas (harness.js hito · harness.js tiempo).`] : [];
  // Higiene de clasificacion: todo issue DEBE llevar label. Los que entran por la web de GitHub no pasan
  // por asignar-tarea, asi que se cuelan sin etiquetar -> se avisa aunque no haya nada asignado a ti.
  const out = [...faseHitoLine];
  if (c.sin_label) out.push(`⚠ ${c.sin_label} issue(s) abierto(s) SIN LABEL en esta repo (entraron fuera del harness). Todo issue debe llevar tipo: clasificalos con \`node .claude/hooks/harness.js gh repos/<org>/<repo>/issues/<N> PATCH '{"labels":["<label>"]}'\` o pregunta al usuario que tipo asignar.`);
  if (!partes.length) return ['Tareas (Issues en GitHub): no tienes nada pendiente asignado en esta repo. 👍', ...out];
  return [
    `TUS PENDIENTES en GitHub (${c.login}) — el harness lo sabe y te ayuda proactivamente: ${partes.join(' · ')}.`,
    `  Detalle: node .claude/hooks/harness.js mis-tareas (tus Tareas/Issues) · /faro:pr (pedir integrar) · /faro:publicar (develop -> main, si tienes permiso). Una "Tarea" es un "Issue" de GitHub.`,
    ...out,
  ];
}

// Resumen AGREGADO de sesion (0.30.0): ramas vivas/muertas + tus issues abiertos, en UNA linea
// compacta y CACHEADA (mismo patron que ghResumenLines: lee sin red, refresca en background si esta
// caduco). Da una foto de "como esta este repo" sin tener que listar ramas ni leer ESTADO.md.
function resumenAgregadoLines() {
  if (NO_INSTANCIA) return [];
  const ag = agregadoMod();
  const now = Date.now();
  try {
    if (!ag.agregadoFresco(now)) {
      require('child_process').spawn(process.execPath, [__filename, 'resumen-refresh', String(now)], { windowsHide: true, cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
  const c = ag.agregadoCache();
  if (!c) return []; // primera vez: se calla hasta que el refresco de fondo tenga algo (evita ruido en el primer arranque)
  const partes = [];
  if (c.ramas) partes.push(`${c.ramas.vivas} rama(s) viva(s) · ${c.ramas.muertas} muerta(s) (borrables)`);
  if (typeof c.tus_issues_abiertos === 'number') partes.push(`${c.tus_issues_abiertos} tarea(s) tuya(s) abierta(s)`);
  // VIGILANCIA del anclaje al ciclo (0.31.1): tareas de PLAN que quedaron sin fase (backlog zombi
  // en potencia) y, de esas, cuantas llevan >30 dias sin tocar. Solo se dice si hay algo que decir
  // (silencioso en 0, igual que el resto del resumen) — un aviso que sale siempre deja de leerse.
  if (typeof c.plan_sin_hito === 'number' && c.plan_sin_hito > 0) {
    const estancMsg = c.plan_sin_hito_estancadas > 0 ? `, ${c.plan_sin_hito_estancadas} estancada(s) >30d` : '';
    partes.push(`⚠ ${c.plan_sin_hito} tarea(s) planificada(s) SIN fase${estancMsg}`);
  }
  if (!partes.length) return [];
  return [`AGREGADO de este repo: ${partes.join(' · ')} (harness.js resumen · harness.js ramas).`];
}

// Control de bloqueo: agrupa las tareas marcadas '[bloq: <motivo>]' de TODAS las fases,
// para verlas juntas y actuar (desbloquear, escalar o registrar el riesgo en el RAID).
function bloqueadasLines() {
  const ini = parseEstado();
  if (NO_INSTANCIA || !ini) return [];
  const rows = [];
  for (const f of ini.fases) {
    for (const t of f.tareas) if (!t.done && t.bloq) rows.push(`- [Fase ${f.num}] ${t.text} ⛔ ${t.bloq}${t.owner ? ` · owner @${t.owner}` : ''}`);
  }
  if (!rows.length) return [];
  // TOPE: en un proyecto con historia esta lista crecia sin limite y se inyectaba entera en CADA
  // sesion. El detalle completo vive en ESTADO.md; aqui basta con lo bastante para actuar.
  return [
    `TAREAS BLOQUEADAS (${rows.length}) — agrupadas para actuar (desbloquear, escalar, o registrar el bloqueante como riesgo en ${SP}/risks.md):`,
    ...conTope(rows, 8, ESTADO_FILE),
  ];
}

// Responsable = identidad de la tarea: git email en '[resp: <email>]' o, en su defecto, el '@owner' corto
// ya existente. Una tarea SIN responsable no tiene ninguno ('[resp: pendiente]' NO cuenta como valido).
const tareaResp = (t) => t.resp || t.owner || null;

// RESPONSABILIDAD DE TAREAS: detecta tareas ABIERTAS sin responsable y pide a Claude que pregunte
// conversacionalmente al usuario (sugiriendo su git email) para asignarlas en ESTADO.md. NO bloquea (aviso).
function responsabilidadLines() {
  const ini = parseEstado();
  if (NO_INSTANCIA || !ini) return [];
  const sin = [];
  for (const f of ini.fases) {
    for (const t of f.tareas) if (!t.done && !tareaResp(t)) sin.push(`[Fase ${f.num}] ${t.text}`);
  }
  if (!sin.length) return [];
  const sugerido = git('config', 'user.email') || null;
  const lista = sin.slice(0, 6).join(' · ') + (sin.length > 6 ? ` (+${sin.length - 6} mas)` : '');
  return [
    `Responsabilidad: ${sin.length} tarea(s) SIN responsable: ${lista}. ` +
    `Pregunta al usuario si es responsable (sugiere su git email: ${sugerido || 'git config user.email'}) ` +
    `y añadelo como '[resp: <email>]' en ${ESTADO_FILE}. Ve asignando conversacionalmente.`,
  ];
}

// Directiva para el repo MOTOR (fuente del plugin): aqui se desarrolla el harness, no un trabajo.
function engineDirective() {
  return [
    `MODO MOTOR: este repo es la FUENTE del plugin faro (marketplace + plugins/faro). NO crear ${ESTADO_FILE} ni pedir onboarding: el gobierno de instancia aplica a los repos de TRABAJO, no al motor.`,
    'Flujo de desarrollo (FUNDAMENTAL, tambien en el motor — igual que en los repos de trabajo): ISSUE primero (un fallo detectado se declara como bug: harness.js asignar-tarea ... --tipo bug) -> rama de cambio anclada, <tipo>/<N>-<slug> (harness.js rama <tipo> "<desc>" --issue <N>) -> TDD con `npm run test:afectados` como red de seguridad (solo los dominios que tocas; la suite completa `npm test` NO la lances: la corren CI y /faro:publicar, salvo que el usuario la pida expresamente) -> bump de version en plugins/faro/.claude-plugin/plugin.json + entrada en CHANGELOG.md (sin bump, las caches de los usuarios NO se actualizan) -> PR a develop (harness.js gh repos/<org>/<repo>/pulls POST, base develop) -> /faro:consolidar integra a develop -> /faro:publicar (develop -> main, solo quien puede aprobar) valida el ciclo completo, tagea y publica. NUNCA commit directo a main NI a develop (el harness lo bloquea).',
    'Coherencia a mantener al tocar el motor: harness.js ↔ hooks.json ↔ faro-schema.json ↔ skills/agentes que citan sus comandos.',
  ];
}
// Directiva para los repos template-*: aqui se mejora el ESTANDAR, no se crea una instancia.
function templateDirective() {
  return [
    `MODO TEMPLATE: este repo ES el estandar (nombre 'template-*'). NO crear ${ESTADO_FILE} aqui: el onboarding y la proteccion de main aplican a las INSTANCIAS que el CLI 'faro' genera desde este template. Las instancias llevan nombre AGNOSTICO (faro-<slug>); su clasificacion va en GitHub topics (plat-<plataforma> · gob-<gobernanza> · sys-<sistema>), NO en el nombre.`,
    'Se trabaja directo en main (commit por cambio). Al mejorar el estandar, manten coherentes harness.js, CLAUDE.md y README.md.',
  ];
}

// ---------- onboarding: no existe INICIATIVA.md ----------

function docsFuncionales() {
  return walkFiles(DOCS).map((f) => f.rel);
}

// Repo que AUN NO ha adoptado FARO (tiene historia propia y ningun marcador). Aqui se OFRECE, no se
// ordena: 'onboardingDirective' esta pensada para repos recien creados por el CLI —vacios, donde el
// onboarding ES la tarea—, y aplicada a un repo ajeno se convertia en un martillo por turno que
// arrancaba una adopcion que nadie habia pedido.
//
// El tono importa mas de lo que parece: lo que se inyecta aqui entra en el contexto del modelo como
// instruccion de sistema, asi que una frase imperativa la ejecuta aunque el usuario viniera a otra
// cosa. Por eso esto dice explicitamente que NO es una tarea pendiente.
function ofertaAdopcionDirective() {
  return [
    `Este repo todavia NO usa FARO: no tiene ${ESTADO_FILE} ni ${CONFIG_FILE}, y tiene trabajo propio previo.`,
    'NO es una tarea pendiente y NO hay que arreglarlo: es un repo normal que aun no ha adoptado el harness.',
    'NO crees ' + ESTADO_FILE + ', ni carpetas de gestion, ni inicies ningun onboarding por tu cuenta.',
    'Atiende lo que el usuario venga a hacer, sin mas.',
    'Si —y solo si— el usuario pide gobernar este repo con FARO (faseo, issues, ciclo de ramas),',
    'el camino es /faro:adoptar, que REENFOCA lo que ya existe sin perder su contexto ni tocar el stack.',
    'Puedes mencionarlo UNA vez, en una linea, si viene a cuento. No lo repitas cada turno.',
  ];
}

function onboardingDirective() {
  const funcionales = docsFuncionales();
  // El onboarding ADAPTA la entrevista al TIPO declarado (metadato faro/config.json / frontmatter),
  // si existe y el catalogo lo conoce; si no, entrevista generica.
  const t = tipoInfo();
  const faseoQ = '(b) en cuantas fases se ejecutara y como se llama cada una, ';
  const lines = [
    `ONBOARDING DEL TRABAJO — no existe ${ESTADO_FILE}. OBLIGATORIO completarlo ANTES de cualquier otra tarea:`,
    // El tipo NO es obligatorio: si esta declarado se adapta el faseo; si no, onboarding generico.
    ...(t.def ? [`Tipo declarado: ${t.def.etiqueta} — ${t.def.implica} Adapta el faseo a esa naturaleza.`] : []),
  ];
  // PASO 0 — el onboarding ESCRIBE (ESTADO.md, risks.md), asi que necesita rama ANTES de empezar.
  // Sin esto el agente arranca la entrevista en develop y el gate le frena a media faena, con el
  // faseo ya a medio escribir. 'chore' porque el arranque es andamiaje, y ademas es el unico
  // prefijo exento de --issue: no hay issues todavia, no los puede haber.
  const gOnb = gitInfo();
  if (gOnb && isNoWrite(gOnb.branch)) {
    lines.push(
      `0. ABRE LA RAMA DE ARRANQUE ANTES DE ESCRIBIR NADA (estas en '${gOnb.branch}', que no se edita): ` +
      'node .claude/hooks/harness.js rama chore "inicial". Todo el arranque (faseo, riesgos, andamiaje) ' +
      'va JUNTO en esa unica rama; no la partas en varias.',
    );
  }
  if (funcionales.length) {
    lines.push(
      `1. HAY documentacion funcional: ${funcionales.slice(0, 5).join(' · ')}${funcionales.length > 5 ? ` (+${funcionales.length - 5} mas)` : ''}. ` +
      'LEELA y deriva de ella una PROPUESTA de faseo del trabajo: nombre, objetivo, fases con tareas. Presentala al usuario para confirmar/ajustar (AskUserQuestion si hay alternativas de faseo).',
    );
  } else {
    lines.push(
      '1. NO hay documentacion funcional en documentos/. ENTREVISTA al usuario con AskUserQuestion: ' +
      '(a) que trabajo es y que se quiere conseguir (objetivo), ' +
      faseoQ +
      '(c) tareas/hitos de la fase inicial, ' +
      '(d) riesgos y dependencias conocidos.',
    );
  }
  // La ENTIDAD (clase) ya NO se pregunta ni se estampa: el CLI clasifica por DOMINIO y la entidad la
  // resuelve el harness/agente donde se usa. El onboarding no molesta con clasificacion de clase.
  lines.push(
    `2. Crea ${ESTADO_FILE} con el formato estandar: frontmatter (nombre, clave, objetivo, estado, fases_total, fase_actual, owner, funcional) ` +
    "+ una seccion '### Fase N · <nombre> — draft' por fase con tareas checkbox (owner opcional: '@usuario'). " +
    'La CLAVE documental (estilo Jira, unica en la org, estable de por vida): sugierela con `harness.js clave --sugerir "<nombre>"` y fijala con `harness.js clave <CLAVE>`. NO añadas campos que el usuario no haya pedido.',
    `Registra los riesgos detectados en ${SP}/risks.md.`,
    // Las tareas del faseo son la semilla de los issues: si nacen atomizadas, el hito se llena de
    // issues de un rato que generan ramas que nadie cierra. Agrupar aqui es mas barato que reagrupar
    // despues, cuando ya hay ramas y PRs abiertos por cada trocito.
    'GRANULARIDAD de las tareas de fase: cada una es un ENTREGABLE DE VALOR (lo que luego sera UN issue con SU rama y SU peticion), no un paso suelto. ' +
    'Agrupa: "personalizacion e identidad" (marca + colores + traducciones + favicon) en vez de una tarea por cada pieza. ' +
    'Si algo se hace en un rato y no entrega valor por si solo, es una SUBTAREA dentro de otra tarea, no una tarea de fase. Ante la duda, agrupa.',
    // Lo duplicado se desincroniza: paso de verdad (checkbox marcado, issue abierto).
    `REPARTO ${ESTADO_FILE} <-> forja: ${ESTADO_FILE} RESUME (que se pretende en la fase, en 2-3 lineas) y lista una tarea por entregable ` +
    'con su id y quien la hace ("- [ ] #4 Personalizacion e identidad — @usuario"); el DETALLE (objetivo, contexto, alcance, ' +
    'fuera de alcance, subtareas, criterios de aceptacion) vive DENTRO del issue, no aqui. ' +
    'El titulo es GENERAL (que entrega), nunca un paso ("traducir subtitle"). Al arrancar todavia no hay ids: se anaden al crear las tareas.',
    // 'draft' exime #N/@usuario del formato RIGIDO porque el hito de la fase AUN no existe en la
    // forja: exigirlos aqui seria circular (no puede haber #N antes de 'hito sync', y 'hito sync' no
    // corre antes de integrar esta misma rama). Descripcion, >=1 tarea y 'Objetivo:' SI son
    // obligatorias ya (no dependen del hito, las decide el equipo antes de que exista).
    "Usa el estado 'draft' (no 'pending') mientras las tareas no tengan #N: el harness lo exime del "+
    "id/responsable por ese motivo, sin dejar de exigir descripcion y tareas. Al asignar las tareas (paso siguiente) pasa la fase a 'pending'.",
    // 'Objetivo:' NO es rigida en su VALOR (se reajusta libremente si cambia el alcance) pero SI en
    // que EXISTA: sin ella 'hito sync' no tiene fecha que reflejar en el due_on del hito.
    "Cada fase lleva 'Objetivo: AAAA-MM-DD' (fecha tentativa, bajo la descripcion): el harness la exige en TODA fase abierta, tambien 'draft'. " +
    "Se reajusta libremente despues si cambia el alcance — 'hito sync' actualiza el vencimiento del hito cuando difiere.",
    'El harness validara el faseo automaticamente al guardar.',
    // FINAL EXPLICITO. Sin esto el agente encadena de largo: escribe el faseo y sigue hasta abrir un
    // cambio con 'fase: N' cuando esa fase aun no existe como hito en la forja ('hito sync' no ha
    // corrido). El cambio nace anclado a algo que no esta, y nadie lo nota.
    `AQUI TERMINA EL ONBOARDING: ${ESTADO_FILE} + ${SP}/risks.md + el andamiaje, todo en la rama de arranque, y PR a develop. ` +
    'NO crees cambios, specs, tasks.md ni issues todavia: las fases NO existen como hitos hasta que el arranque se integre y corras `hito sync`. ' +
    "Despues de eso: `hito sync` -> `asignar-tarea ... --hito <N>` (y cambia el estado de la fase de 'draft' a 'pending' en el mismo commit) -> `rama <tipo> \"<tema>\" --issue <N>`, y el primer cambio nace AHI.",
  );
  return lines;
}

function estadoResumen() {
  const ini = parseEstado();
  if (!ini || !ini.fases.length) return null;
  const { fm, fases } = ini;
  const actual = fases.find((f) => isActive(f.estado)) || fases.find((f) => f.estado === 'pending' || f.estado === 'backlog');
  const cerradas = fases.filter((f) => isDone(f.estado)).length;
  const tdef = fm.tipo && TIPOS[fm.tipo];
  let txt = `${tdef ? `[${tdef.etiqueta}] ` : ''}trabajo: ${fm.iniciativa || '(sin nombre)'} · ${cerradas}/${fases.length} fases cerradas`;
  if (actual) {
    const total = actual.done + actual.open;
    txt += ` · fase actual: ${actual.num} (${actual.nombre}) ${actual.estado}`;
    if (total) txt += ` · ${actual.done}/${total} tareas`;
  }
  return txt;
}

// Deriva temporal de una fase con 'Objetivo: AAAA-MM-DD' (solo fases no cerradas).
function plazoTxt(f) {
  if (!f.objetivo || isDone(f.estado)) return '';
  const dias = Math.round((new Date(f.objetivo) - Date.now()) / 86400000);
  const estado = dias < 0 ? `VENCIDA hace ${-dias}d` : dias <= 7 ? `vence en ${dias}d` : 'en plazo';
  return ` · objetivo ${f.objetivo} (${estado})`;
}

function faseLines() {
  const ini = parseEstado();
  if (!ini) return [];
  return ini.fases.map((f) => {
    const total = f.done + f.open;
    const prog = total ? ` · ${f.done}/${total} tareas (${Math.round((f.done / total) * 100)}%)` : '';
    const informe = isDone(f.estado) ? (informeExists(f.num) ? ' · informe OK' : ' · SIN INFORME') : '';
    const owners = [...new Set(f.tareas.filter((t) => t.owner && !t.done).map((t) => `@${t.owner}`))];
    return `- Fase ${f.num} · ${f.nombre} — ${f.estado}${prog}${plazoTxt(f)}${informe}${owners.length ? ` · owners pendientes: ${owners.join(' ')}` : ''}`;
  });
}

// ---------- informe semanal: logica extraida a lib/semanal.js (modularizacion) ----------
let _semMod = null;
function semMod() {
  if (!_semMod) _semMod = require(path.join(__dirname, 'lib', 'semanal.js'))({ fs, path, ROOT, SP, REPORTING, ESTADO_FILE, parseEstado, validateEstado, openRisksCount, allDocs, docDate, fmtDate, listFiles, isActive, isDone, faseLines });
  return _semMod;
}
const ensureWeeklyReport = () => semMod().ensureWeeklyReport();
const semanalPendiente = () => semMod().semanalPendiente();
// El semanal pendiente se dice en UNA linea y se genera a peticion (#125).
const SEMANAL_PENDIENTE = 'Informe semanal pendiente (ninguno en los ultimos 7 dias): generalo con /faro:reportar semanal o node .claude/hooks/harness.js informe-semanal.';

// ---------- frescura documental (drift): lib/frescura.js ----------
let _frescuraMod = null;
function frescuraLines() {
  try {
    if (!_frescuraMod) _frescuraMod = require(path.join(__dirname, 'lib', 'frescura.js'))({ git, docsControlados, funcionalPath });
    return NO_INSTANCIA ? [] : _frescuraMod.frescuraLines();
  } catch { return []; }
}
// Deteccion del plugin superpowers en la maquina del usuario de ESTA sesion.
// El settings.json del repo ya declara enabledPlugins/extraKnownMarketplaces (aprovisionado
// automatico), pero si el usuario rechazo la instalacion, el flujo brainstorm->spec->plan
// pierde sus skills: avisamos en session.
// ANTES: buscaba 'superpowers' en TODA la cache (~/.claude/plugins/), sin mirar si ESTE repo lo
// declara -> "detectado" por la cache de OTRO proyecto, aunque en este repo/sesion no estuviera
// activo ("enabled in project settings but isn't installed here", caso real reproducido). Ahora,
// igual de especifico que pluginSettingsLines() (faro): declarado en enabledPlugins DE ESTE repo
// + version instalada de verdad en la cache local.
// superpowers se distribuye por el marketplace OFICIAL de Anthropic (claude-plugins-official) —
// canal UNICO, sin legados. Ademas del settings del REPO, cuenta el del USUARIO
// (~/.claude/settings.json): si lo tiene habilitado a nivel usuario, ya dispone de las skills.
const SUPERPOWERS_CANALES = [
  { key: 'superpowers@claude-plugins-official', cache: ['claude-plugins-official', 'superpowers'] },
];
function superpowersDetected() {
  const leer = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const repo = leer(path.join(ROOT, '.claude', 'settings.json'));
  const usuario = leer(path.join(require('os').homedir(), '.claude', 'settings.json'));
  const declarado = (s, k) => !!(s && s.enabledPlugins && s.enabledPlugins[k] === true);
  for (const c of SUPERPOWERS_CANALES) {
    if (!declarado(repo, c.key) && !declarado(usuario, c.key)) continue;
    const base = path.join(require('os').homedir(), '.claude', 'plugins', 'cache', ...c.cache);
    try { if (fs.readdirSync(base, { withFileTypes: true }).some((e) => e.isDirectory())) return true; } catch {}
  }
  return false;
}

// ---------- subcomandos ----------

// Planificador externo (#218, #277): CABLEADO del dominio lib/planificacion.js. Aqui (y solo aqui)
// se resuelve la configuracion: faro/config.json del repo > planificacion, o la del usuario (~/.faro.json).
// El dominio la recibe ya resuelta; sin ella no hay planificador y nada se lee ni se pinta.
let _planificacion;
function planificacion() {
  if (_planificacion !== undefined) return _planificacion;
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, CONFIG_FILE), 'utf8')).planificacion || null; } catch {}
  if (!cfg) { try { cfg = require('./lib/credenciales.js')().leerCfg().planificacion || null; } catch {} }
  return (_planificacion = require('./lib/planificacion.js').crear(cfg));
}
// Una linea desde la CACHE del refresco en segundo plano (sin red aqui).
function planificacionLines() {
  if (NO_INSTANCIA) return [];
  const pl = planificacion(); if (!pl) return [];
  const gh = forjaMod(); if (!gh || !gh.ghResumenCache) return [];
  const c = gh.ghResumenCache();
  if (!c || !c.planificacion) return [];
  const l = pl.resumenCorto(c.planificacion);
  return l ? [l + ' Detalle: harness.js planificacion.'] : [];
}

// Claves del gestor de proyectos que ya no se usan (#218): ClickUp salio del plugin; la planificacion
// la lleva un planificador externo, si lo hay. Un ESTADO.md antiguo no falla: se ignoran y se avisa en una linea.
function gestorAntiguoLines() {
  const ini = parseEstado();
  if (!ini) return [];
  const claves = Object.keys(ini.fm || {}).filter((k) => /^(clickup|pm)_/.test(k));
  const marcas = ini.fases.some((f) => f.cuid || f.tareas.some((t) => t.cuid));
  if (!claves.length && !marcas) return [];
  const que = [...claves, ...(marcas ? ['marcas [cu:]/[pm:] en el faseo'] : [])].join(', ');
  return [`ⓘ ${ESTADO_FILE} conserva datos del gestor de proyectos (${que}): ya no se usan: FARO lee la planificación de la forja (harness.js planificacion). Puedes quitarlos.`];
}

// Recordatorio de PUBLICACION: en main/master limpio (todo mergeado = APROBADO), los documentos
// controlados cuyo frontmatter NO diga 'approved'/'obsolete' estan desactualizados — el merge ES la
// aprobacion. (La vinculacion/publicacion a un catalogo externo es cosa de esa integracion, AGNOSTICA
// al sistema concreto — no vive en este harness.)
function publishReminderLines() {
  const g = gitInfo();
  if (!g || !isProtected(g.branch) || g.dirty) return [];
  const pend = docsControlados().filter((d) => !/^(approved|obsolete)$/i.test(String(d.fm.status || '').toLowerCase()));
  if (!pend.length) return [];
  return [
    `Publicacion: en '${g.branch}' (todo mergeado = APROBADO) hay ${pend.length} documento(s) con status != 'approved': ` +
    `${pend.slice(0, 6).map((d) => d.id + ' (' + d.status + ')').join(', ')}${pend.length > 6 ? ' …' : ''}. ` +
    'Al publicarse a main (/faro:publicar) queda aprobado: actualiza su frontmatter a "approved" (+ version y Control de versiones si cambio el contenido).',
  ];
}
// ---------- plugin: settings del repo (distribucion por clon) ----------
// En modo plugin, el repo debe declarar marketplace + plugin en su .claude/settings.json para que
// cualquier CLON sea autosuficiente (Claude Code ofrece instalarlo al abrir el repo) y se actualice
// solo (autoUpdate — para marketplaces NO oficiales viene DESACTIVADO por defecto). El CLI lo escribe
// en crear/adoptar; esto es la RED DE SEGURIDAD en sesion: aviso no bloqueante con el bloque exacto.
// El acceso al plugin no se valida aqui: lo resuelve la forja al descargar. Solo se recuerda el
// diagnostico para cuando la descarga falle.
function pluginSettingsLines() {
  if (!PLUGIN_MODE || NO_INSTANCIA) return [];
  let s = null;
  try { s = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8')); } catch {}
  const mk = s && s.extraKnownMarketplaces && s.extraKnownMarketplaces['faro-marketplace'];
  const en = !!(s && s.enabledPlugins && s.enabledPlugins['faro@faro-marketplace'] === true);
  // El bloque recomendado depende de la FORJA del repo de trabajo (antes venia GitHub cableado).
  const f = forgeInfo();
  const mkRec = FORGE.marketplacePara(f.forge, git);
  const faltas = [];
  if (!en) faltas.push("falta 'enabledPlugins' con faro@faro-marketplace (el equipo no hereda el plugin al clonar)");
  const fuenteOk = mk && FORGE.fuenteMarketplaceValida(mk.source);
  if (mk && mk.source && mk.source.source === 'url' && !fuenteOk) faltas.push("la fuente del marketplace es 'url' con un repo .git: cambiala a 'git' (Claude Code no descarga un repo con 'url')");
  else if (!mk || !fuenteOk) faltas.push("falta 'extraKnownMarketplaces' con faro-marketplace (un clon no sabria de DONDE instalarlo)");
  else if (mk.autoUpdate !== true) faltas.push("falta 'autoUpdate: true' (sin el, este marketplace NO se actualiza solo)");
  if (!faltas.length) return [];
  const privadoHttps = mkRec.source === 'git' && /^https:/.test(mkRec.url);
  return [
    'PLUGIN faro — settings del repo INCOMPLETO para distribuirse con el clon:',
    ...faltas.map((x) => `- ${x}`),
    'ARREGLO RECOMENDADO: npx faro-harness -> adoptar (la via canonica: deja settings, metadato y capa FARO coherentes de una vez).',
    `Arreglo rapido manual (mergea este bloque en .claude/settings.json del repo — conserva las claves existentes — y commitealo; es el marketplace para ${FORGE.nombreForja(f.forge)}, segun la forja de este repo):`,
    '  ' + FORGE.bloqueSettings(mkRec),
    'Al usuario explicaselo en llano: "dejo el repo preparado para que al clonarlo se ofrezca FARO automaticamente y se actualice solo". ' +
    `Si a alguien le falla la descarga: necesita acceso al proyecto del plugin con git autenticado (diagnostico: ${FORGE.diagnosticoDescarga(mkRec)}).` +
    (privadoHttps ? ' Marketplace PRIVADO por HTTPS: la actualizacion en segundo plano va SIN credential helper — define CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1 en el entorno (o usa remoto SSH) para que no descarte el clon si el refresco falla.' : ''),
  ];
}
// REANCLA tras compactar. La compactacion SUSTITUYE el historial por un resumen, y el bloque de
// gobierno vive justo al principio de ese historial: se resume y se pierde el detalle. El resumen
// conserva DE QUE va el trabajo; lo que se evapora son las REGLAS. Por eso el reancla no repite el
// bloque completo (serian ~4.400 tokens otra vez): devuelve solo lo que no se deduce de un resumen.
function reanclaLines() {
  const g = gitInfo();
  const out = ['REANCLA TRAS COMPACTAR — el resumen conserva el trabajo, pero se llevo por delante las reglas del harness. Vuelven las que no se deducen de el:'];
  // Motor/template: su directiva solo se da al arrancar (el turno ya no la repite, #122), asi que
  // tras compactar vuelve aqui o se pierde el flujo de desarrollo.
  if (NO_INSTANCIA) out.push(...(IS_ENGINE ? engineDirective() : templateDirective()));
  if (g) {
    const sinEscritura = isNoWrite(g.branch) && !NO_INSTANCIA;
    out.push(
      `Rama '${g.branch}'${g.user ? ` · ${g.user}` : ''}: ${sinEscritura
        ? 'NO se escribe aqui (ni tu, ni owner/admin). Antes de CREAR o EDITAR nada, abre rama de trabajo: node .claude/hooks/harness.js rama <tipo> "<tema>".'
        : 'rama de trabajo: OK para editar y commitear; al terminar, /faro:pr hacia develop.'}`,
    );
  }
  const ini = parseEstado();
  const actual = ini && ini.fases.find((f) => isActive(f.estado));
  if (actual) out.push(`Fase en curso: ${actual.num} (${actual.nombre}) · ${actual.done}/${actual.done + actual.open} tareas.`);
  const abiertos = listSpecs().map((x) => `${x.name} (${x.fm.estado || '?'})`);
  out.push(`Cambios spec-driven abiertos: [${abiertos.join(', ') || 'ninguno'}]. PROTOCOLO SPEC vigente: clasifica la peticion — consulta menor -> responde; sigue un cambio -> trabaja contra su tasks.md; trabajo sustantivo SIN cambio -> proponlo (/faro:cambio) y CONFIRMA antes de seguir.`);
  const f = FORGE.detect(git);
  out.push(FORGE.reglaPlataforma(f));
  out.push('Convenciones de nombrado, catalogos y tipos NO se repiten aqui: son consultables bajo demanda (harness.js tipo · docref · validate).');
  return out;
}

// ---------- CONTEXTO MINIMO (#127, #123): indice de sesion, deltas por turno, presupuesto ----------
let _contextoMod = null;
const contextoMod = () => (_contextoMod || (_contextoMod = require(path.join(__dirname, 'lib', 'contexto.js'))));

// Alerta al HUMANO (systemMessage): no gasta contexto del modelo.
function alertaSesion(errs) {
  if (!parseEstado()) {
    // Un repo sin adoptar NO tiene nada "requerido": no le falta ESTADO.md, es que no es suyo.
    // La alerta le decia al usuario que su repo estaba incompleto, y empujaba al agente a resolverlo.
    return SIN_ADOPTAR || NO_INSTANCIA ? undefined : `⚠ Sin ${ESTADO_FILE} — onboarding requerido: identificar el trabajo (funcional o preguntas al usuario) y fasearlo`;
  }
  if (errs.length) return `⚠ Faseo con ${errs.length} error(es) — revisa ${ESTADO_FILE}`;
  if (!superpowersDetected()) return '⚠ Plugin superpowers sin instalar — claude plugin install superpowers@claude-plugins-official';
  return undefined;
}

function agentTeamsOn() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
    return !!(s && s.env && String(s.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) === '1');
  } catch { return false; }
}

// Protocolo spec CONDENSADO para el indice: las mismas siete reglas, sin el desarrollo (que sigue
// en 'harness.js estado'). Lo que PROTEGE (clasificar antes de ejecutar, confirmar antes de trabajo
// sustantivo) se queda entero.
function specProtocolIndice() {
  return [
    'PROTOCOLO SPEC (obligatorio, proactivo) — clasifica cada peticion ANTES de ejecutarla: ' +
    '(0) idea difusa/encargo nuevo -> skill faro:gestion-proyectos; antes de COLOCAR un artefacto -> skill faro:documentacion · ' +
    '(a) consulta o tarea menor -> responde · (b) sigue un cambio abierto -> dilo, trabaja contra su tasks.md y marca sus checkboxes · ' +
    '(c) trabajo sustantivo SIN cambio -> NO lo ejecutes: propon el cambio (/faro:cambio, estado: borrador) y CONFIRMA con el usuario (AskUserQuestion) · ' +
    `(d) proposal aprobada sin tasks.md -> propon el plan · (e) cambia el alcance -> propon actualizar ${ESTADO_FILE} + ADR · ` +
    '(f) plan con tareas independientes -> superpowers:subagent-driven-development (executing-plans si son secuenciales).',
  ];
}

// Documentos controlados AGREGADOS: un recuento por estado y los problemas, no la lista uno a uno.
function docIndiceLines() {
  const docs = docsControlados();
  const out = [];
  const adr = adrFueraDeSitio();
  if (adr.length) out.push(`ADR fuera de sitio en ${DOCS}/decisiones/ (${adr.length}): un ADR es GESTION, muevelos a ${SP}/decisions/<AAAA-MM-DD>-<slug>.md.`);
  if (docs.length) {
    const por = {};
    for (const d of docs) por[d.status] = (por[d.status] || 0) + 1;
    const dup = docsDuplicados(docs);
    const mal = docs.filter((d) => docPlacementIssues(d).length);
    const sinDesc = docs.filter((d) => !d.fm.description);
    out.push(`Documentos controlados: ${docs.length} (${Object.entries(por).map(([e, n]) => `${e}: ${n}`).join(' · ')})` +
      (dup.length ? ` · doc_id DUPLICADOS: ${dup.join(', ')}` : '') +
      (mal.length ? ` · ${mal.length} mal ubicado(s) o nombrado(s): ${mal.slice(0, 4).map((d) => d.id).join(', ')}${mal.length > 4 ? ' …' : ''}` : '') +
      (sinDesc.length ? ` · ${sinDesc.length} sin 'description:'` : '') + '.');
  }
  out.push(...packFaltanteLines(docs));
  return out;
}

// Codigo en UNA linea: el stack y donde esta el resto (gates, routing, disciplina de tests).
function codigoIndiceLines() {
  const c = codeMod();
  if (!c || !c.hasCode()) return [];
  const primera = (c.gateReadinessLines()[0] || 'Codigo detectado.').trim();
  return [`${primera} Gates: node .claude/hooks/harness.js gates · calidad: subagente revisor-code · disciplina de tests, infra y routing de skills: harness.js estado.`];
}

// Secciones del hook de prompt (las mismas que siembra el arranque). 'siempre' = seguridad.
function seccionesPrompt() {
  const ini = parseEstado();
  const actual = ini && ini.fases.find((f) => isActive(f.estado));
  const gRama = gitInfo();
  const radar = [];
  // RADAR DE RAMA (global, proactivo): si estas en una rama SIN ESCRITURA (main/master/develop) en una instancia,
  // AVISA ANTES de ejecutar la peticion — vale para CUALQUIER comando que genere/escriba (/faro:reportar,
  // onepager, redactar, cambio...) y para peticiones libres. Asi no hace falta repetir el aviso en cada comando.
  if (gRama && isNoWrite(gRama.branch) && !NO_INSTANCIA) {
    const donde = gRama.branch === 'develop' ? "'develop' (INTEGRACION)" : `'${gRama.branch}' (archivo de lo APROBADO)`;
    radar.push(
      `⚠ RAMA ${donde}: NO se escribe/genera aqui (ni tu, ni owner/admin/maintainer). Si esta peticion va a CREAR o EDITAR algo ` +
      `(presentacion, informe, one-pager, documento, spec, codigo...), ANTES de generar nada abre una rama de trabajo: ` +
      `node .claude/hooks/harness.js rama <tipo> "<tema>" (tipos: ${BRANCH_TYPES.filter((t) => t !== 'feature').join('/')}), genera ahi y entra por PR a develop (/faro:pr). ` +
      `Si es solo consulta/lectura, continua sin cambiar de rama.`,
    );
  }
  const fase = [];
  const ciclo = [];
  if (actual) {
    fase.push(`Iterando · fase ${actual.num} (${actual.nombre}) · ${actual.done}/${actual.done + actual.open} tareas · pendientes: ${actual.open}`);
    // Trabajo TERMINADO que no ha salido de su rama: marcado [x] en ESTADO.md pero sin integrar, asi
    // que su tarea sigue abierta y la fase sin cerrar. Paso de verdad y nadie lo noto: el harness
    // MARCABA pero no LIMPIABA.
    if (gRama && !isNoWrite(gRama.branch) && !NO_INSTANCIA) {
      const pend = require('./lib/ciclo.js').cicloPendiente({
        rama: gRama.branch, fase: actual, integrada: !((gitFlow() || {}).unmerged || []).includes(gRama.branch),
      });
      if (pend) ciclo.push(`⚠ CICLO SIN CERRAR: ${pend}`);
    }
  }
  // El formato del faseo tiene que llegar al AGENTE, no solo a quien ejecute validate: si no lo ve,
  // no lo rectifica — y el ESTADO.md se degrada sin que nadie lo note.
  const formato = [];
  if (ini && !NO_INSTANCIA) {
    const huecosF = ini.fases.flatMap((f) => require('./lib/ciclo.js').huecosDeFase(f));
    if (huecosF.length) {
      formato.push(
        `⚠ ${ESTADO_FILE} NO cumple el formato (RECTIFICALO, bloquea validate): ${huecosF.slice(0, 4).join(' · ')}${huecosF.length > 4 ? ` · (+${huecosF.length - 4})` : ''}`,
        `   Formato por fase: cabecera + DESCRIPCION de que trae + una tarea por entregable "- [ ] #<id> · <titulo GENERAL> — @<quien>". ` +
        'El detalle (objetivo, contexto, alcance, fuera de alcance, subtareas, criterios) va DENTRO del issue, no aqui.',
      );
    }
  }
  return [
    { clave: 'rama', siempre: true, lineas: radar },
    { clave: 'fase', lineas: fase },
    { clave: 'ciclo', lineas: ciclo },
    { clave: 'formato', lineas: formato },
    { clave: 'git', lineas: gitLines(true) },
    { clave: 'cambios', lineas: specProtocolBreve() },
    // RADAR proactivo: si hay ciclos abiertos, recuerda cerrarlos (con owner) ANTES de abrir trabajo nuevo.
    { clave: 'ciclos', lineas: ciclosAbiertos() },
  ];
}
// Lo que el indice de sesion YA dice: el primer prompt no lo repite. 'ciclo' y 'formato' no estan en
// el indice, asi que no se siembran y salen en el primer turno si aplican.
const SECCIONES_SEMBRADAS = new Set(['fase', 'git', 'cambios', 'ciclos']);
function sembrarDeltas(ruta) {
  if (!ruta || !parseEstado()) return;
  const CM = contextoMod();
  const { estado } = CM.deltas(seccionesPrompt().filter((s) => SECCIONES_SEMBRADAS.has(s.clave)), {});
  CM.guardarEstado(ruta, { secciones: estado.secciones });   // arranque nuevo: nada se ha dicho aun en pre-doc
}

// El INDICE de sesion. Se queda lo que protege y lo que orienta; el detalle, bajo demanda.
// #178: repo FARO con codigo y sin tests.dominios, tras actualizar el plugin: UNA linea, con marca de version (no se repite).
function avisoTestsPorDominio() {
  try {
    const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
    const l = require('./lib/dominios.js').avisoArranque(ROOT, { version });
    return l ? [l] : [];
  } catch { return []; }
}

function indiceSesion({ cabecera, comunicacion, resumen, funcionalL, estadoBloque, weekly }) {
  const CM = contextoMod();
  const una = (lineas, max = 400, donde = '') => { const t = CM.unaLinea(lineas, max, donde); return t ? [t] : []; };
  const ini = parseEstado();
  const ciclos = ciclosAbiertos();
  const cov = coverageLines();
  const filasCov = cov.filter((l) => /^- \[/.test(l));
  const covResumen = filasCov.length
    ? [`Cobertura spec de la fase en curso: ${filasCov.filter((l) => !/→ sin spec$/.test(l)).length}/${filasCov.length} tarea(s) con un cambio que las cubre.`]
    : [];
  // Settings del plugin incompletos: el diagnostico y la via canonica; el bloque JSON manual, en 'estado'.
  const plugin = pluginSettingsLines().filter((l) => /^(PLUGIN faro|- falta|ARREGLO RECOMENDADO)/.test(l));
  const dig = digestionLines();
  // ORDEN = prioridad dentro de los avisos: si el presupuesto obliga a recortar, se va lo del final.
  const avisos = [
    // #293: repo con el layout antiguo (gestion/, ESTADO.md, .faro.json en la raiz). Se lee igual; se avisa de migrar.
    ...(PATHS.legado && REPO_ADOPTADO && !NO_INSTANCIA ? [LAYOUT_LEGADO] : []),
    ...requisitosLines({ agregado: true }),
    ...covResumen,
    ...cov.filter((l) => /^Cambios aprobados SIN plan/.test(l)),
    ...una(decisionesAbiertas(), 300, `${SP}/decisions/`),
    ...una(responsabilidadLines(), 450),
    ...docIndiceLines(),
    // Fuentes sin digerir: la lista se agrega, pero la DIRECTIVA (y el aviso de binarios) se quedan:
    // solo salen cuando hay algo que digerir y dicen como hacerlo.
    ...una(dig.filter((l, i) => i === 0 || /^- /.test(l)), 450),
    ...dig.filter((l, i) => i > 0 && !/^- /.test(l)),
    ...una(frescuraLines(), 400),
    ...una(publishReminderLines(), 400),
    ...tagLines(),
    ...(weekly ? [SEMANAL_PENDIENTE] : []),
    ...una(avisosTareasDeCache().length ? ['TAREAS:', ...avisosTareasDeCache()] : [], 450),
    ...una(ghResumenLines(), 450),
    ...resumenAgregadoLines(),
    // Navegacion (#157): solo si hay registros o documentos controlados a los que ir.
    ...(fs.existsSync(path.join(ROOT, SP, 'tareas')) || docsControlados().length ? [require('./lib/navegacion.js').lineaNavegacion()] : []),
    ...(!NO_INSTANCIA && ini ? una(tareasLegacySinMigrar(ini.fases), 450) : []),
    ...una(plugin, 500),
    ...(!superpowersDetected() ? ['ATENCION: plugin superpowers NO detectado — el flujo brainstorm->spec->plan pierde sus skills. Indica al usuario: claude plugin install superpowers@claude-plugins-official (requiere reiniciar la sesion).'] : []),
    ...codigoIndiceLines(),
    ...(!NO_INSTANCIA && !SIN_ADOPTAR ? avisoTestsPorDominio() : []),   // #178: una linea por version si el repo no declara dominios
    ...una(atomicoLines(), 320),
    ...una(grafoLines(), 320),
    ...una(kpiLines(), 300),
    ...una(planificacionLines(), 300),
    ...una(gestorAntiguoLines(), 300),
    ...una(tipoLines(), 300),
    ...(agentTeamsOn() ? ['Agent teams HABILITADO en este repo: para trabajo paralelo real, propon un equipo (roles ad-hoc).'] : []),
  ];
  const puntero = 'DETALLE BAJO DEMANDA (no se repite aqui): node .claude/hooks/harness.js estado (bloque completo: convenciones, documentos, requisitos, codigo, planes) · validate · specs · tipo · docref. ' +
    'Donde va cada artefacto y sus convenciones: skill faro:documentacion.';
  return CM.presupuestar([
    { prio: 0, lineas: [cabecera] },
    { prio: 1, lineas: [comunicacion, resumen] },
    { prio: 1, lineas: ini ? faseLines() : [] },
    { prio: 1, lineas: funcionalL },
    { prio: 0, lineas: estadoBloque },
    // SEGURIDAD: identidad, rama y su regla de escritura, rol, plataforma, proteccion. Nunca se recorta.
    { prio: 0, lineas: [...(ghMod() ? ghMod().identityLines() : []), ...gitLines(false, { indice: true })] },
    { prio: 0, lineas: una(bloqueadasLines(), 700, ESTADO_FILE) },
    // UN solo listado de cambios abiertos (antes salia cuatro veces).
    { prio: 1, lineas: ciclos.length ? ciclos : [specProtocolBreve()[0]] },
    { prio: 1, lineas: misTareasLines({ soloIds: true }) },
    { prio: 1, lineas: specProtocolIndice() },
    { prio: 2, lineas: avisos },
  ], CM.PRESUPUESTO_SESION, puntero, (l) => reescribirRutas(l).length);
}

// El arranque distingue DE DONDE viene la sesion. La plataforma entrega 'source'
// (startup | resume | clear | compact). Si no llega, se emite el indice de sesion: perder gobierno
// es peor que repetirlo.
function cmdSessionRouted() {
  let decidido = false;
  const decidir = (p) => {
    if (decidido) return;
    decidido = true;
    // La plataforma entrega el motivo en 'source' (startup | resume | clear | compact). Solo se
    // miraba 'start_reason', que no llega: el reancla no se disparaba nunca. Se aceptan ambos.
    const motivo = p && (p.source || p.start_reason);
    const CM = contextoMod();
    const ruta = CM.rutaEstado(ROOT, p && p.session_id);
    // Tras compactar, lo que el hook de prompt ya habia dicho se fue con el resumen: se borran las
    // huellas para que el siguiente turno lo vuelva a decir (#127).
    if (String(motivo || '') === 'compact') { CM.reiniciarEstado(ruta); emit(reanclaLines().join('\n'), 'SessionStart'); return; }
    cmdSession({ ruta });
  };
  // NO se usa readStdin(): esa helper se CALLA si el payload no es JSON valido, y aqui callarse
  // significa NO EMITIR EL BLOQUE DE SESION — el fallo mas caro posible. Este lector SIEMPRE decide:
  // con payload, sin payload, con basura, o si stdin ni siquiera llega. Ante la duda, bloque completo.
  //
  // El temporizador de respaldo NO se desreferencia a proposito: un timer con unref() no mantiene
  // vivo el proceso, asi que con stdin vacio el proceso salia ANTES de disparar el respaldo y no
  // emitia nada. Se libera al decidir, para que el proceso pueda terminar igualmente.
  const respaldo = setTimeout(() => decidir(null), 3000);
  const resolver = (motivo) => { clearTimeout(respaldo); decidir(motivo); };
  let entrada = '';
  try {
    process.stdin.on('data', (d) => { entrada += d; });
    process.stdin.on('error', () => resolver(null));
    process.stdin.on('end', () => {
      let p = null;
      try { p = JSON.parse(entrada); } catch { p = null; }
      resolver(p);
    });
  } catch { resolver(null); }
}

// opts.completo: el bloque de gobierno ENTERO (convenciones, documentos, requisitos, codigo, planes) —
// lo que piden 'harness.js estado' y 'status'. Sin el, SessionStart emite el INDICE (#127).
function cmdSession(opts = {}) {
  const completo = !!opts.completo;
  // El andamiaje documental se materializa en INSTANCIAS y TEMPLATES; en el repo MOTOR no pinta
  // nada (bug real: cada sesion en faro-plugin creaba documentos/, gestion/... huerfanos).
  // Y TAMPOCO en un repo que aun no ha adoptado FARO: crear 14 carpetas sobre el repo de otro, en
  // cada arranque y sin preguntar, era la primera agresion de una cadena que acababa con el turno
  // bloqueado. El andamiaje llega al ADOPTAR, que es cuando alguien lo ha pedido.
  if (!IS_ENGINE && !SIN_ADOPTAR) REF_DIRS.forEach((d) => fs.mkdirSync(path.join(ROOT, d), { recursive: true }));

  // #125: abrir una sesion NO modifica el repo. El semanal pendiente se ANUNCIA; se genera a peticion.
  const weekly = semanalPendiente();

  const lastGlobal = latest(allDocs());
  const plans = listSpecs().filter((s) => hasTasks(s.name))
    .map((s) => `- ${s.name}/tasks.md [proposal: ${s.fm.estado || '?'}]: ${progressOf(tasksPath(s.name))}`);
  const { errs } = validateEstado();
  const risks = openRisksCount();
  const g = gitInfo();

  const cabecera =
    NO_INSTANCIA
      ? (IS_ENGINE
        ? 'HARNESS CHECK · repo MOTOR del plugin faro (aqui se desarrolla el harness/skills/agentes; NO es una instancia de trabajo: sin onboarding, sin ESTADO.md, sin gates de instancia).'
        : 'HARNESS CHECK · repo TEMPLATE del estandar de trabajo faseado (aqui se mejora el estandar, no se crea una instancia).')
      // Cabecera CONSCIENTE DEL TIPO: si la instancia declara tipo (serv/func/proyecto/iniciativa),
      // la sesion arranca sabiendo QUE ES y que implica (un servicio no se "cierra"; un proyecto si).
      : (() => {
        // Un repo sin adoptar NO es "workspace de documentacion": es el repo de alguien, con su
        // codigo. Afirmarlo le decia al agente que el repo era otra cosa de la que es.
        if (SIN_ADOPTAR) return 'HARNESS CHECK · repo que AUN NO usa FARO (tiene trabajo propio previo). El harness no lo gobierna: solo observa.';
        const t = tipoInfo();
        return t.def
          ? `HARNESS CHECK · ${t.def.etiqueta} — ${t.def.implica} Workspace de DOCUMENTACION del trabajo.`
          : 'HARNESS CHECK · repo raiz de UN trabajo faseado (funcionalidad de plataforma / proyecto / iniciativa) — workspace de DOCUMENTACION, NO de codigo.';
      })();
  const comunicacion =
    // LENGUAJE CON EL USUARIO (regla transversal): habla SIEMPRE claro, sin tecnicismos. El usuario puede no
    // saber de git/ramas/PRs. Estas instrucciones tecnicas son para TI (Claude), NO para copiarlas al usuario.
    // Cuando le expliques algo, traducelo: "rama de trabajo" = "una copia aparte para trabajar sin tocar lo aprobado";
    // "PR / consolidar / aprobar" = "pedir que se revise y publique tu trabajo". Resuelve tu la mecanica (crear ramas,
    // comandos) en silencio; al usuario cuentale QUE haces y POR QUE en lenguaje sencillo, y preguntale sin jerga.',
    'COMUNICACION CON EL USUARIO: explica en lenguaje llano, no asumas que conoce git/ramas/PRs; la mecanica tecnica la resuelves tu por debajo.';
  // Resumen ejecutivo compacto: presentalo al usuario al iniciar (situacion actual en 3-4 lineas).
  const resumen =
    `RESUMEN EJECUTIVO (presentalo brevemente al usuario al arrancar): ${estadoResumen() || 'sin iniciativa definida'}` +
    ` · riesgos abiertos: ${risks}${g ? ` · git: rama '${g.branch}'${g.user ? `, usuario ${g.user}` : ''}, ${g.dirty} cambio(s) sin commitear` : ''}.`;
  // SIN_ADOPTAR tambien queda fuera: a un repo que no usa FARO no "le falta el funcional" — no le
  // falta nada. Ese ATENCION le decia al agente que habia algo roto que arreglar.
  const funcionalL = (NO_INSTANCIA || SIN_ADOPTAR ? [] : [funcionalExists()
      ? `Funcional presente: ${funcionalPath()}.`
      // La EXIGENCIA del funcional depende del TIPO: un proyecto/funcionalidad parte de un funcional
      // (FUN); una INICIATIVA exploratoria se guia por su BRF — ahi el funcional es recomendable,
      // no un "ATENCION" que no aplica.
      : (tipoInfo().tipo === 'iniciativa'
        ? `Funcional: no declarado — una INICIATIVA arranca de su BRF (alcance aun abierto); declara 'funcional:' cuando el alcance cristalice. No es bloqueante.`
        : `ATENCION: falta el funcional (${funcionalPath() || `declaralo en el frontmatter de ${ESTADO_FILE}: funcional: <ruta>`}) — toda spec/plan debe partir de el.`)]);
  const estadoBloque = !parseEstado()
    // SIN_ADOPTAR va PRIMERO: un repo con historia propia recibe una OFERTA, no la orden de
    // onboarding (que esta pensada para repos recien creados por el CLI, vacios).
    ? (SIN_ADOPTAR ? ofertaAdopcionDirective() : NO_INSTANCIA ? (IS_ENGINE ? engineDirective() : templateDirective()) : onboardingDirective())
    : (errs.length ? ['VALIDACION DE FASEO — errores a corregir:', ...errs.map((e) => `- ${e}`)] : ['Faseo valido.']);
  // #177: aviso breve (alerta al humano, no gasta contexto) si hay procesos propios huerfanos o una bateria corriendo.
  const alert = [alertaSesion(errs), require('./lib/procesos.js').avisoCorto(process.env, ROOT), require('./lib/worktrees.js').avisoCorto(ROOT)].filter(Boolean).join(' · ') || undefined;

  // SessionStart = INDICE (#127, #123). El bloque completo de abajo pasaba de 26.000 caracteres en un
  // repo de trabajo real: la plataforma corta a 10.000 y el modelo solo ve 2.000 de vista previa.
  if (!completo) {
    emit(indiceSesion({ cabecera, comunicacion, resumen, funcionalL, estadoBloque, weekly }).join('\n'), 'SessionStart', alert);
    if (opts.ruta) sembrarDeltas(opts.ruta);
    return;
  }

  const lines = [
    cabecera,
    comunicacion,
    resumen,
    `Ultima actividad documental: ${lastGlobal ? `${lastGlobal.rel} (${fmtDate(docDate(lastGlobal))})` : '(sin documentos)'}.`,
    ...funcionalL,
    ...tipoLines(),
    ...(ghMod() ? ghMod().identityLines() : []),
    ...(estadoResumen() ? [`Estado del trabajo (${ESTADO_FILE}): ${estadoResumen()}.`, ...faseLines()] : []),
    ...(() => {
      // Autorrelleno (git ya lo sabe; no preguntar al usuario): quien y cuando toco ESTADO.md
      // por ultimo. Informativo, nunca bloqueante.
      const last = parseEstado() ? lastCommitOf(ESTADO_FILE) : null;
      return last ? [`Ultima modificacion de ${ESTADO_FILE}: ${last.date} por ${last.author}.`] : [];
    })(),
    ...estadoBloque,
    // Aviso proactivo (0.31.2, local, sin red): un repo con faseo real cuyas tareas siguen escritas
    // a mano en ESTADO.md no se entera de que 'asignar-tarea --hito' existe hasta que alguien
    // tropieza con el bloqueo al crear una tarea NUEVA. Se adelanta el aviso a aqui.
    ...(!NO_INSTANCIA && parseEstado() ? tareasLegacySinMigrar(parseEstado().fases) : []),
    ...coverageLines(),
    ...ciclosAbiertos(),
    ...decisionesAbiertas(),
    ...ghResumenLines(),
    ...avisosTareasDeCache().map((w) => `TAREAS: ${w}`),
    ...resumenAgregadoLines(),
    ...misTareasLines(),
    ...bloqueadasLines(),
    ...responsabilidadLines(),
    ...docLines(),
    ...frescuraLines(),
    ...digestionLines(),
    ...publishReminderLines(),
    ...pluginSettingsLines(),
    ...codeSessionLines(),
    ...atomicoLines(),
    ...grafoLines(),
    ...kpiLines(),
    ...requisitosLines(),
    ...gitLines(false),
    ...specProtocol(),   // COMPLETO, una sola vez: en el turno va la version breve
    ...planificacionLines(),
    ...gestorAntiguoLines(),
    ...tagLines(),
    'Estado de artefactos:',
    changesLine(),
    folderLine(`${SP}/brainstorming`),
    folderLine(`${SP}/decisions`),
    folderLine(`${REPORTING}/informes`),
    ...(plans.length ? ['Progreso de planes:', ...plans] : []),
    'Convenciones (rutas relativas a la raiz del repo):',
    `- Estado y fases de la iniciativa -> ${ESTADO_FILE} (fuente de verdad del faseo)`,
    `- Brainstorming -> ${SP}/brainstorming/AAAA-MM-DD-<tema>.md`,
    `- Cambio (spec + plan) -> ${CHANGES_DIR}/<cambio>/proposal.md (QUE, frontmatter de ciclo de vida) + tasks.md (COMO, checkboxes); flujo /faro:cambio -> /faro:aplicar -> /faro:archivar (al completar -> archive/)`,
    `- Decisiones (ADR, estandar MADR/Nygard) -> ${SP}/decisions/AAAA-MM-DD-<decision>.md, status: propuesta|aceptada|rechazada|sustituida (deciders: '@usuario'; 'sustituida' exige superseded-by con el linaje enlazado en ambos ADR) · Riesgos -> ${SP}/risks.md (RAID). REGLA: los riesgos son SIEMPRE inherentes al PROYECTO (negocio, documentacion, alcance, dependencias) — NUNCA bugs/limitaciones del framework/harness/tooling; esos NO van aqui, se reportan aparte. El agente enfoca el RAID en el proyecto.`,
    `- Requisitos de negocio -> ${SP}/requisitos.md ('## REQ-NN · <nombre>' + estado: propuesto|aceptado|en-cambio|entregado|descartado + origen: <fuente que lo trajo>). Nacen de DIGERIR ${PATHS.dir('fuentes')}/ (el harness señala fuentes sin digerir); un requisito aceptado debe quedar CUBIERTO por un cambio o una tarea que cite su REQ-NN (el harness valida formato y avisa de huecos de trazabilidad).`,
    `- Informe de CIERRE DE FASE (obligatorio) -> ${REPORTING}/informes/AAAA-MM-DD-fase-<N>-informe.md (plano, datado; es el gate de cierre).`,
    `- Informe/Presentacion/one-pager PUNTUAL por-tema (/faro:reportar <tema> · /faro:onepager <tema>): el agente lo CONFECCIONA desde el documento de referencia (no lo trocea) en subcarpeta ${REPORTING}/{informes,presentaciones}/<tema>/<tema>-AAAA-MM-DD.md + .html. REPORTING SIEMPRE versionado por FECHA (nunca sin fecha): misma fecha -> ACTUALIZA ese fichero (se re-pide ese dia); fecha nueva -> snapshot nuevo. (El documento VIVO en documentos/ tiene su control aparte: doc_id/estado/version.) docgen es solo la imprenta (vista documento vertical · --presentacion horizontal animada).`,
    '- Validacion completa bajo demanda/CI: node .claude/hooks/harness.js validate (exit != 0 si hay errores).',
    `- Plantillas: estructuras de documento por tipo en documentos/plantillas/ (con cabecera FARO faro_docs ya puesta) · plantillas HTML de marca (faro-documento/-presentacion/-informe) + render en documentos/plantillas/html/.`,
    `- CONTROL DOCUMENTAL (obligatorio, gestion profesional): todo documento controlado (con doc_id) va SIEMPRE en subcarpeta tematica documentos/<tema>/ (NUNCA en la raiz de documentos/) con nombre <doc_id>-<slug>.md (el ID viaja en el nombre). Temas canonicos: funcional/ (BRF/PRF/FUN), integraciones/<sistema>/ (ANA), flujos/ (MAN), diseno/ (DIS), entregables/ (HTML); el resto, documentos/<tema>/ libre. El TIPO no se declara aparte: va DENTRO del doc_id (CLAVE-TIPO-NNN), asi que elegir bien el tipo al pedir el id ES la clasificacion — un campo 'type' suelto solo anade una segunda fuente que puede contradecir al id. Elige el tipo segun el CONTENIDO consultando el contrato (harness.js tipo = catalogo · harness.js tipo <CODIGO> = secciones, criterio y errores tipicos), no de memoria: trabajo tecnico/API -> pack con ANA de integracion, ARQ, DIS, etc. — el harness avisa del pack que falta. ESTADOS: draft -> in_review -> approved -> obsolete (la aprobacion real la da el merge a main). VERSIONADO: todo cambio de contenido SUBE la version (SemVer) y anade fila en 'Control de versiones'. Genera el id: node "\${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" docref <TIPO> (usa la CLAVE fijada con 'harness.js clave' — unica en la org, estable de por vida). El harness valida ubicacion, nombre, frontmatter y estados (gate de validate).`,
    `- Presentacion de estado a direccion -> ${REPORTING}/presentaciones/AAAA-MM-DD-presentacion-estado.html (/faro:reportar sin tema; SIEMPRE datada, misma regla que el reporting: misma fecha actualiza, fecha nueva = snapshot; "presentada" -> ademas tag presentacion-<fecha>). Skills: /faro:estado /faro:reportar /faro:auditoria /faro:revisar-spec /faro:redactar /faro:forja /faro:renombrar /faro:adoptar /faro:code · directivas (las invoca el agente): faro:gestion-proyectos (aterrizar ideas/requerimientos, enfoque FDE) y faro:documentacion (que es cada artefacto y donde vive).`,
  ];
  if (risks) lines.push(`Riesgos abiertos: ${risks} (${SP}/risks.md).`);
  if (weekly) lines.push(SEMANAL_PENDIENTE);
  if (!superpowersDetected()) {
    // Canal vigente: el marketplace OFICIAL de Anthropic (claude-plugins-official) — NO el legado obra/.
    lines.push(
      'ATENCION: plugin superpowers NO detectado (ni en el repo ni a nivel usuario) — el flujo brainstorm->spec->plan pierde sus skills. ' +
      'Indica al usuario que lo instale del marketplace OFICIAL: claude plugin install superpowers@claude-plugins-official (o /plugin -> Marketplace -> superpowers). El harness no puede instalarlo el mismo: requiere reiniciar la sesion.',
    );
  }
  // Agent Teams: la mencion depende de si el repo lo activo de verdad (env del settings), no un texto fijo.
  // Monorepo (#132): el contrato y el wrangler viven en cada app; una linea, solo si aplica.
  if (require('./lib/apps.js').esMonorepo(ROOT)) lines.push('Monorepo: revisor-code y revisor-code-worker se lanzan POR APP afectada (contrato en apps/<x>/ARCHITECTURE.md; apps y rasgos: harness.js apps).');
  // El catalogo de subagentes ya NO se repite aqui (#127): lo da el prompt de sistema de la plataforma.
  lines.push(agentTeamsOn()
    ? 'Agent teams HABILITADO en este repo: para trabajo paralelo real (varias tareas de fase independientes), propon un equipo; los roles se definen ad-hoc segun la tarea (los subagentes del plugin son reutilizables como rol, NO un catalogo cerrado).'
    : 'Agent teams NO activado en este repo (falta env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="1" en .claude/settings.json) — sin el, no se pueden lanzar equipos de subagentes en paralelo.');
  // 'estado' (CLI, a peticion): texto plano para leerlo. 'status': el payload de hook de siempre.
  if (opts.texto) { console.log(lines.join('\n')); return; }
  emit(lines.join('\n'), 'SessionStart', alert);
}

// Protocolo proactivo de specs/planes: en cada prompt el modelo recibe el inventario
// y DEBE clasificar la peticion antes de ejecutarla (deteccion inteligente delegada al modelo).
function specProtocol() {
  const specs = listSpecs().map((s) => `${s.name}${s.fm.estado ? ` (${s.fm.estado}${hasTasks(s.name) ? '+tasks' : ''})` : ''}`);
  return [
    `Inventario de cambios (${CHANGES_DIR}): [${specs.join(', ') || 'ninguno'}].`,
    'PROTOCOLO SPEC (obligatorio, proactivo) — antes de ejecutar la peticion, clasificala:',
    '(0) idea difusa / encargo nuevo / aterrizar requerimientos / retomar proyecto -> invoca la skill faro:gestion-proyectos (directiva FDE: contexto -> requerimientos -> fases -> valor medido) ANTES de estructurar nada; ante "¿donde pongo/subo X?" o antes de COLOCAR cualquier artefacto -> invoca la skill faro:documentacion (gestion vs documento controlado vs spec-driven, regla de rol);',
    '(a) consulta o tarea menor -> responde sin mas ceremonia;',
    '(b) sigue un cambio del inventario -> dilo explicitamente, trabaja contra su tasks.md y actualiza sus checkboxes;',
    `(c) trabajo sustantivo SIN cambio en el inventario -> NO lo ejecutes directamente: analiza (skill superpowers:brainstorming si hay que explorar), propon el cambio (/faro:cambio o ${CHANGES_DIR}/<cambio>/proposal.md con frontmatter de ciclo de vida, estado: borrador) y CONFIRMA con el usuario (AskUserQuestion) antes de seguir;`,
    `(d) proposal aprobada sin tasks.md -> sugiere proactivamente crear el plan (${CHANGES_DIR}/<cambio>/tasks.md), encajado en la fase actual de ${ESTADO_FILE};`,
    `(e) si la peticion cambia el alcance del trabajo -> propon actualizar ${ESTADO_FILE} y registrar la decision (ADR);`,
    '(f) ejecutar un plan con varias tareas independientes -> usa el skill superpowers:subagent-driven-development (subagente nuevo por tarea + subagente revisor por tarea: spec compliance y calidad) o superpowers:executing-plans si las tareas son secuenciales; para ejecuciones largas, sugiere al usuario fijar condicion de cierre verificable con /goal (p. ej. "todas las tareas del plan X en [x] y node .claude/hooks/harness.js validate sale 0, o para tras 20 turnos").',
  ];
}

// Version BREVE para el turno. El protocolo completo (arriba) son ~2.000 caracteres de EXPLICACION
// que no cambian en toda la sesion: se dan una vez al arrancar. Lo que si tiene que estar en CADA
// turno es el RECORDATORIO de clasificar y el INVENTARIO, que si cambia al abrir o cerrar un cambio.
// Criterio del reparto: lo que PROTEGE se queda, lo que EXPLICA se mueve.
function specProtocolBreve() {
  const specs = listSpecs().map((s) => `${s.name}${s.fm.estado ? ` (${s.fm.estado}${hasTasks(s.name) ? '+tasks' : ''})` : ''}`);
  return [
    `Cambios abiertos (${CHANGES_DIR}): [${specs.join(', ') || 'ninguno'}].`,
    'PROTOCOLO SPEC (ya detallado al arrancar): clasifica la peticion antes de ejecutarla — consulta menor -> responde; ' +
    'sigue un cambio del inventario -> dilo y trabaja contra su tasks.md; trabajo sustantivo SIN cambio -> propon el cambio (/faro:cambio) y CONFIRMA antes de seguir.',
  ];
}

// Alerta al usuario solo si hay riesgo (faseo); el protocolo spec, el estado de iteracion
// y el estado git se inyectan como contexto en cada prompt (proactivo, sin ruido visual).
function cmdPromptContext() {
  if (!parseEstado()) {
    // Repo con historia que aun no ha adoptado FARO: NADA. Ni directiva ni alerta.
    // Aqui estaba el martillo: se reinyectaba la orden "OBLIGATORIO crea ESTADO.md antes de
    // cualquier otra tarea" en CADA prompt, con su alerta, sobre un repo que nadie habia pedido
    // gobernar. Eso es lo que hacia que el agente "se inicializara solo": no decidia nada, obedecia
    // una instruccion de sistema repetida turno tras turno. La oferta ya se dio en SessionStart;
    // repetirla en cada prompt seria el mismo martillo con otro tono.
    if (SIN_ADOPTAR) return;
    // Motor y template: su directiva es FIJA (no cambia entre turnos) y ya la da SessionStart; tras
    // compactar la devuelve el reancla. Repetirla aqui eran ~1.040 caracteres identicos por prompt
    // (#122), justo lo que la spec reparto-contexto prohibe.
    if (NO_INSTANCIA) return;
    emit(
      onboardingDirective().join('\n'),
      'UserPromptSubmit',
      `⚠ Sin ${ESTADO_FILE}: identifica el trabajo (preguntas al usuario o funcional) y créalo antes de seguir`,
    );
    return;
  }
  const { errs } = validateEstado();
  if (errs.length) {
    emit(
      `ALERTA faseo (${ESTADO_FILE}): ${errs.join(' · ')}`,
      'UserPromptSubmit',
      `⚠ Faseo con ${errs.length} error(es) pendientes en ${ESTADO_FILE}`,
    );
    return;
  }
  // DELTAS (#127): cada seccion lleva su huella por repo + session_id; solo se reemite lo que cambio
  // desde el ultimo turno de ESTA sesion. El aviso de rama sin escritura sale SIEMPRE (protege de una
  // accion, no explica). Sin session_id (invocacion manual) no hay estado: se emite todo, como antes.
  const CM = contextoMod();
  const ruta = CM.rutaEstado(ROOT, leerPayloadSync().session_id);
  const previo = CM.leerEstado(ruta);
  const { lineas, estado } = CM.deltas(seccionesPrompt(), previo);
  if (ruta) CM.guardarEstado(ruta, estado);
  if (lineas.length) emit(lineas.join('\n'), 'UserPromptSubmit');
}

function matchRule(filePath) {
  const fp = String(filePath || '').replace(/\\/g, '/');
  for (const [folder, re, expected] of NAMING_RULES) {
    const at = fp.indexOf(folder);
    if (at !== -1) {
      const rest = fp.slice(at + folder.length);
      // En SUBCARPETA por-tema (p. ej. informes/proyecto-x/proyecto-x-v1.md): es un informe/presentacion
      // PUNTUAL que confecciona el agente — tiene su propia convencion (slug + version), no la plana datada.
      if (rest.includes('/')) return null;
      return { folder: folder.slice(1, -1), name: rest, ok: re.test(rest), expected };
    }
  }
  return null;
}

const esArchivoEstado = (filePath) =>
  /\/(ESTADO|INICIATIVA)\.md$/.test(String(filePath || '').replace(/\\/g, '/'));

// Rutas de SECRETOS/CREDENCIALES: nunca se escriben por el agente (variables/tokens van por env o
// gestor de secretos, no en texto plano versionable). Tratado como codigo de seguridad (recomendacion
// Anthropic): bloquea SIEMPRE, cualquier repo/rama. No cubre LECTURA (Read tiene su propio permission
// system fuera del harness); esto es solo Write/Edit.
// Fichero de credenciales: la deteccion vive en lib/guardas.js (UNA sola lista, tambien la usa el
// gate de commit). Antes habia aqui una regex propia con dos defectos reales:
//   · BLOQUEABA '.env.example' y '.env.sample' — que existen PARA versionarse, y que el propio
//     harness recomienda usar; el agente no podia crear el fichero que se le pedia crear.
//   · Se le escapaban 'id_ecdsa', '.netrc', '.p12', '.pfx' y los almacenes de claves.
function preDocSecretoIssue(filePath) {
  return CTX.ficheroSensible(filePath);
}
// pre-doc y doc-check leen stdin de forma sincrona al arrancar (para resolver la raiz del fichero,
// #136); readStdin() ya no tendria nada que leer. Sin tool_input no hay nada que juzgar: silencio,
// igual que readStdin ante un payload invalido.
const payloadHook = (cb) => {
  if (_payloadSync === undefined) return readStdin(cb);
  if (_payloadSync && _payloadSync.tool_input) cb(_payloadSync);
};
// Silencioso salvo riesgo: solo habla si el nombre viola la convencion, falta el funcional,
// se escribe una spec (frontmatter) o un plan (su spec debe estar aprobada), o se toca INICIATIVA.md.
function cmdPreDoc() {
  // stdin ya se leyo al arrancar (raiz por fichero, #136): se reutiliza ese payload.
  payloadHook((payload) => {
    // AVISOS DEDUPLICADOS (#127): el mismo aviso (no un bloqueo) ya dado en esta sesion no se repite
    // en cada Write/Edit. Los deny NUNCA pasan por aqui: un bloqueo se dice siempre.
    const CM = contextoMod();
    const rutaCtx = CM.rutaEstado(ROOT, payload.session_id);
    const estCtx = rutaCtx ? CM.leerEstado(rutaCtx) : null;
    const avisar = (texto, ev, alerta) => {
      if (CM.yaDicho(estCtx, 'pre-doc', texto)) return;
      if (rutaCtx) CM.guardarEstado(rutaCtx, estCtx);
      emit(texto, ev, alerta);
    };
    const fp = (payload.tool_input || {}).file_path;
    // SECRETO/CREDENCIAL: bloquea siempre, antes de cualquier otra logica.
    const secreto = preDocSecretoIssue(fp);
    if (secreto) {
      deny(
        `BLOQUEADO: '${secreto}' parece un fichero de secretos/credenciales. El agente NO escribe ahi — ` +
        'si hace falta declarar una variable de entorno o credencial, pidesela al usuario para que la ' +
        'gestione el mismo (o via el gestor de secretos de la plataforma), nunca en texto plano versionable.',
        'PreToolUse',
        '⛔ Escritura en fichero de secretos bloqueada — pide al usuario que la gestione el mismo',
      );
      return;
    }
    // ALCANCE (#150): el agente NO modifica un repo que no es el de la sesion ni sus worktrees; la via
    // es abrir un issue alli. Salida temprana por texto si la ruta cuelga de la raiz de la sesion.
    {
      let aj = null;
      try { aj = fp ? require('./lib/alcance.js').evaluarRuta(_rootPorDefecto, fp) : null; }
      catch (e) { aj = { estado: 'incierta', motivo: `no se pudo cargar el control de alcance (${(e && e.message) || e})` }; }
      if (aj && aj.estado === 'incierta') {
        // No se puede probar a que repo pertenece: no es un allow silencioso, decide el humano.
        ask(`La ruta '${fp}' podria ser de otro repo (${aj.motivo}), no del de esta sesion. Confirma solo si es del repo de esta sesion; si es de otro, abre alli un issue con asignar-tarea --repo.`,
          'PreToolUse', `⚠ Ruta no comprobable fuera del repo de la sesion — confirma`);
        return;
      }
      if (aj) {
        const repoAj = aj.slug || '<org>/<repo>';
        deny(
          `BLOQUEADO: '${fp}' es del repo ${aj.slug || aj.nombre}${aj.slug ? '' : ' (sin remoto)'}, no de esta sesion: NO se edita. ` +
          `Si hace falta un cambio alli, abre un issue en ese repo con \`node .claude/hooks/harness.js asignar-tarea "<titulo>" <login> --repo ${repoAj} --tipo <tipo>\`. Leer ese repo si esta permitido.`,
          'PreToolUse',
          `⛔ ${aj.slug || aj.nombre} no es el repo de esta sesion — abre un issue alli, no lo edites`,
        );
        return;
      }
    }
    // AMBITO DEL GOBIERNO (coherencia con pre-bash): este harness gobierna SU repo, no la maquina.
    // (1) Rutas FUERA del repo (memoria de Claude, scratchpad, otros proyectos) -> ni rama ni convenciones
    //     de ESTE repo aplican (bug real: bloqueaba escribir la memoria del agente por estar en main).
    // (2) Gobierno de INSTANCIA (ramas protegidas, gate spec) solo si el repo ES una instancia FARO
    //     (existe ESTADO.md) — igual que pre-bash con su 'esFaro'. Ademas desbloquea el onboarding:
    //     crear ESTADO.md en un repo recien nacido ya no choca con la proteccion de main.
    const norm = String(fp || '').replace(/\\/g, '/');
    const rootNorm = ROOT.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    const absNorm = (path.isAbsolute(norm) ? norm : path.resolve(ROOT, norm).replace(/\\/g, '/'));
    if (!absNorm.toLowerCase().startsWith(rootNorm.toLowerCase())) return;
    // Dos exenciones DISTINTAS que antes vivian fusionadas en un solo 'esInstancia' (bug real: el
    // gate de ramas protegidas se desactivaba TAMBIEN en el motor, no solo el de ESTADO.md/onboarding,
    // que es lo unico de lo que el motor esta exento). develop/main no se editan a mano es una
    // convencion git UNIVERSAL, y el motor mismo declara seguirla (rama -> PR -> develop -> main,
    // NUNCA commit directo). Sin esta separacion, editar en develop/main del propio motor pasaba
    // sin ningun aviso -- el gate solo actuaba en 'git commit' (mas tarde, con mas cambios ya
    // acumulados en la rama equivocada), nunca en la edicion (mas temprano y mas barato de corregir).
    const protegeRamas = !IS_TEMPLATE;   // el motor SI protege sus ramas; solo el template no.
    // Solo hace falta la RAMA (para saber si esta protegida): ramaActual() la lee con UNA llamada a
    // git, en vez de las tres de gitInfo() (que ademas pide status --porcelain y config user.name,
    // ~300ms que este hook pagaba en CADA escritura sin usarlos).
    // OJO con el contrato: gitInfo() devuelve null cuando NO hay repo git, y varios 'if (g && ...)'
    // de aqui abajo cuentan con ello. Un objeto siempre-truthy los rompe en silencio.
    const _rama = ramaActual();
    const g = _rama ? { branch: _rama } : null;
    if (g && isNoWrite(g.branch) && protegeRamas) {
      const flow = gitFlow();
      // AUTO-RAMA EN RUNTIME: el hook no puede mover git por si mismo, pero ORDENA a Claude crear la rama
      // adecuada AHORA y reintentar la edicion en el mismo turno (efecto "automatico" para el usuario).
      // Sugerimos tipo+slug derivados del contexto: si hay un cambio activo, su slug; si no, del fichero/ESTADO.
      const specActiva = (function () { try { return listSpecs().find((s) => s.fm.estado === 'aprobada' || s.fm.estado === 'borrador'); } catch { return null; } })();
      const slugSugerido = specActiva ? specActiva.name : slugify(path.basename(norm).replace(/\.[^.]+$/, '') || 'cambio');
      const tipoSugerido = /\/(documentos|gestion|reporting|README|CLAUDE|ESTADO)/i.test(norm) ? 'docs' : 'feat';
      if (g.branch === 'develop') {
        // develop: crear la rama de trabajo en runtime y continuar ahi (mecanica normal, la resuelve Claude).
        deny(
          `'develop' es la INTEGRACION: NADIE la edita a mano (tampoco owner/admin/maintainer). NO se lo traslades al usuario como bloqueo: ` +
          `CREA TU la rama adecuada AHORA y continua -> ejecuta \`node .claude/hooks/harness.js rama ${tipoSugerido} "${slugSugerido}"\` ` +
          `(crea ${tipoSugerido}/${slugSugerido} desde develop y cambia a ella) y DESPUES REPITE ESTA MISMA EDICION. ` +
          `Cuando termines el trabajo, envialo a develop con /faro:pr. Es la mecanica normal, la ejecutas tu en este turno.`,
          'PreToolUse',
          `Estas en 'develop' (la zona comun de integracion, no se edita directamente): preparo un espacio de trabajo aparte para tus cambios y sigo. Al terminar te ayudo a enviarlos para revision.`,
        );
      } else {
        // main/master: archivo de lo aprobado. Cambiar a develop y crear rama de trabajo.
        const arr = flow && flow.develop
          ? `git switch develop && node .claude/hooks/harness.js rama ${tipoSugerido} "${slugSugerido}"`
          : `git switch -c develop && node .claude/hooks/harness.js rama ${tipoSugerido} "${slugSugerido}"`;
        deny(
          `'${g.branch}' es el archivo de lo APROBADO (solo lectura), aplica a TODOS tambien owner/admin. ` +
          `CREA TU la rama de trabajo AHORA y continua -> ${arr}, luego REPITE ESTA EDICION. Al terminar, /faro:pr para enviarlo a develop.`,
          'PreToolUse',
          `Estas en '${g.branch}' (la version ya aprobada y publicada, no se edita directamente): preparo un espacio de trabajo aparte y sigo. Al terminar te ayudo a enviarlo para revision.`,
        );
      }
      return;
    }
    // RAMA DE TRABAJO fuera de convencion (ni protegida, ni <tipo>/<slug>): reconducir a rama valida.
    if (g && !NO_INSTANCIA && !isNoWrite(g.branch) && !WORK_BRANCH_RE.test(g.branch)) {
      avisar(
        `Estas en la rama '${g.branch}', que NO sigue la convencion <tipo>/<slug> (tipos: ${BRANCH_TYPES.filter((t) => t !== 'feature').join('/')}). ` +
        `Renombrala conservando el trabajo: git branch -m <tipo>/<slug>. Al terminar el trabajo, envialo a develop con /faro:pr.`,
        'PreToolUse',
      );
      // no return: es aviso, la escritura continua (estas en una rama de trabajo, aunque mal nombrada).
    }
    // GATE DE PLANES. Otros plugins escriben su plan de implementacion donde su propia convencion
    // dice (superpowers: docs/superpowers/plans/AAAA-MM-DD-<nombre>.md). Ese plan NO compite con el
    // cambio de FARO: compite con su tasks.md — son lo mismo, el COMO troceado en tareas verificables.
    // Lo que al plan le falta es la PROPUESTA (el porque, la fase, el dueno, la aprobacion). Dejarlo
    // fuera parte el trabajo en dos sitios que no se hablan: el harness cuenta el avance de tasks.md y
    // el plan de verdad vive en otro lado. Por eso no se crea una carpeta plans/ dentro de gestion:
    // seria un TERCER artefacto diciendo lo mismo. El plan aterriza como tasks.md del cambio.
    // Un hook no adivina a que cambio pertenece un plan (eso es criterio), asi que NO redirige solo:
    // bloquea y dice exactamente donde va. Si no hay ningun cambio declarado, lo que falta es la
    // propuesta, que es la regla que el protocolo del motor YA exige — aqui solo se le hace cumplir a
    // un plugin que no la conoce.
    const relRepo = absNorm.slice(rootNorm.length);
    const esPlan = /(^|\/)(docs\/superpowers\/plans|plans)\//i.test(relRepo);
    const yaEnGestion = new RegExp(`^${SPEC_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "i").test(relRepo);
    if (esPlan && !yaEnGestion) {
      const cambios = (function () { try { return listSpecs().map((s) => s.name); } catch { return []; } })();
      const destino = `${SPEC_BASE}/changes/<cambio>/tasks.md`;
      deny(
        cambios.length
          ? `Un plan de implementacion es el tasks.md de un cambio, no un fichero aparte: escribelo en ${destino} `
            + `y NO en '${relRepo}'. Ahi lo valida el harness, cuenta su avance en cada sesion, cubre fase y se archiva al cerrar; `
            + `fuera, el trabajo queda partido en dos sitios que no se sincronizan. Cambios declarados: ${cambios.join(" · ")}. `
            + `Elige a cual pertenece este plan (pregunta al usuario si no esta claro) y vuelve a escribirlo ahi.`
          : `Un plan de implementacion es el tasks.md de un cambio, y aqui NO hay ningun cambio declarado todavia. `
            + `Lo que falta no es el plan: es la PROPUESTA (el porque, la fase, el dueno, la aprobacion). Crea antes el cambio `
            + `-> /faro:cambio (o ${SPEC_BASE}/changes/<cambio>/proposal.md con estado: borrador), confirmalo con el usuario, `
            + `y escribe entonces el plan como ${destino}. No lo dejes en '${relRepo}'.`,
        'PreToolUse',
        'El plan va dentro del cambio, no en una carpeta aparte: asi el avance se ve en un unico sitio',
      );
      return;
    }
    // GATE SPEC-DRIVEN (codigo): editar src/ EXIGE un cambio spec-driven APROBADO. Nada va "a la ligera":
    // todo cambio es HIPOTESIS hasta validarlo (analiza, lee el codigo, valida con fuentes, pregunta
    // sin inventar, crea las tasks) y recien entonces se implementa. Escape de emergencia: rama hotfix/<motivo>.
    const inSrc = /(^|\/)src\//.test(norm);
    if (inSrc && !NO_INSTANCIA && parseEstado()) {
      const gb = ramaActual() || '';
      if (/^hotfix\//.test(gb)) {
        avisar(`HOTFIX (${gb}): editas src/ sin change aprobado — permitido por EMERGENCIA. Deja el motivo en el commit y REGULARIZA con un cambio spec-driven (proposal + tasks) en cuanto pase la urgencia.`, 'PreToolUse', '⚠ hotfix: src/ sin spec (regulariza luego)');
        return;
      }
      const aprob = listSpecs().filter((s) => s.fm && s.fm.estado === 'aprobada');
      if (!aprob.length) {
        deny(
          'BLOQUEADO: cambias codigo (src/) SIN spec aprobada. Nada va "a la ligera": todo cambio es una HIPOTESIS hasta validarlo. ' +
          `Antes de tocar src/: (1) analiza y LEE el codigo afectado; (2) valida las hipotesis con fuentes (WebSearch / MCP / docs oficiales); (3) PREGUNTA al usuario lo que no sepas con certeza (sin inventar ni asumir); (4) crea el cambio ${CHANGES_DIR}/<slug>/proposal.md (/faro:cambio) y APRUEBALO (estado: aprobada) con su tasks.md. ` +
          'Recien con el change aprobado, implementa contra sus tasks. Emergencia real: trabaja en una rama hotfix/<motivo>.',
          'PreToolUse', '⛔ src/ sin spec aprobada — crea y aprueba un change (/faro:cambio) antes de codificar',
        );
        return;
      }
      avisar(`Editas src/ con ${aprob.length} change(s) aprobado(s) (${aprob.map((s) => s.name).join(', ')}): trabaja CONTRA su tasks.md (marca los checkboxes) y no te salgas del alcance de la spec. Si este cambio no encaja en ninguna, crea/actualiza el change ANTES de codificar.`, 'PreToolUse');
      return;
    }
    if (esArchivoEstado(fp)) {
      avisar(
        `Vas a modificar ${ESTADO_FILE} (fuente de verdad del faseo). Reglas: fases_total = secciones ` +
        `'### Fase N · <nombre> — <estado>'; estados ${VALID_STATES.join(' | ')}; solo UNA fase activa (${ACTIVE_STATES.join('/')}); ` +
        `tareas checkbox por fase (owner opcional '@usuario' · bloqueo opcional '[bloq: <motivo>]' — el harness las agrupa); frontmatter admite 'funcional: <ruta>'; ` +
        `cada fase EXIGE una linea 'Objetivo: AAAA-MM-DD' (fecha tentativa, se reajusta libremente despues si cambia el alcance — el harness calcula la deriva); ` +
        `cerrar fase exige todas las tareas hechas + informe en ${REPORTING}/informes/.`,
        'PreToolUse',
      );
      return;
    }
    // Cambios spec-driven: proposal.md (la spec) exige frontmatter de ciclo de vida y partir del
    // funcional; tasks.md (el plan) exige su proposal APROBADA. Es el gate spec->plan del estandar.
    // #293: lectura dual — el gate reconoce el cambio en faro/gestion/cambios y en gestion/cambios (sin migrar).
    const chM = norm.match(new RegExp(`/(?:${PATHS.BASE}/)?gestion/cambios/changes/([^/]+)/(proposal|tasks)\\.md$`));
    if (chM && chM[1] !== 'archive') {
      const slug = chM[1];
      if (chM[2] === 'proposal') {
        const sinFun = !funcionalExists();
        avisar(
          `Proposal del cambio '${slug}'.${sinFun ? ` ATENCION: no existe el funcional (${funcionalPath() || 'sin declarar'}) — toda spec debe partir de el.` : ''} ${specFmTemplate()}`,
          'PreToolUse',
          sinFun ? '⚠ Cambio sin funcional del que partir' : undefined,
        );
      } else {
        // GATE spec->plan DETERMINISTA (bloqueante, no aviso): no se planifica sin proposal APROBADA y sin dudas.
        const spec = listSpecs().find((s) => s.name === slug);
        if (!spec) {
          deny(
            `tasks.md sin proposal: crea antes ${CHANGES_DIR}/${slug}/proposal.md (la spec, con frontmatter de ciclo de vida) y apruebala. El plan (COMO) exige su proposal (QUE) aprobada.`,
            'PreToolUse', `⛔ Plan (tasks.md) sin proposal del cambio '${slug}'`,
          );
        } else if (spec.fm.estado !== 'aprobada' && spec.fm.estado !== 'implementada') {
          deny(
            `La proposal del cambio '${slug}' esta en estado '${spec.fm.estado || 'sin estado'}'. Apruebala (estado: aprobada + aprobada_por) antes de planificar tasks.md — no se planifica sobre una proposal no aprobada.`,
            'PreToolUse', `⛔ tasks.md sobre proposal no aprobada: ${slug}`,
          );
        } else if (clarifyCount(spec.rel)) {
          deny(
            `La proposal del cambio '${slug}' tiene ${clarifyCount(spec.rel)} marcador(es) [CLARIFICAR: ...] sin resolver — NO se planifica con dudas abiertas: resuelvelas con el usuario primero.`,
            'PreToolUse', `⛔ tasks.md bloqueado: proposal '${slug}' con [CLARIFICAR] pendientes`,
          );
        }
      }
      return;
    }
    const m = matchRule(fp);
    if (!m) {
      // Documento en documentos/ = HIPOTESIS hasta validarla (analiza, valida con fuentes, pregunta sin inventar).
      if (new RegExp(`/${DOCS}/.+\\.md$`).test(norm) && !NO_INSTANCIA)
        avisar('Documento en documentos/: TRATALO COMO HIPOTESIS hasta validarlo. Antes de darlo por bueno: LEE el codigo/fuentes que afirma, valida los datos con fuentes (WebSearch / MCP / docs oficiales), PREGUNTA al usuario lo que no sepas (sin inventar ni asumir cifras/hechos) y refleja SOLO lo verificado, citando de donde sale cada afirmacion.', 'PreToolUse');
      return;
    }
    if (!m.ok) {
      avisar(
        `ATENCION previa (${m.folder}): '${m.name}' NO cumple la convencion ${m.expected}; corrige el nombre antes de escribir.`,
        'PreToolUse',
        `⚠ Documento en ${m.folder}: nombre fuera de convencion`,
      );
      return;
    }
    if (m.folder === `${REPORTING}/informes`) {
      avisar(
        'Informe de fase: cubre objetivo, entregables, tareas completadas, desviaciones y recomendacion para la fase siguiente.',
        'PreToolUse',
      );
      return;
    }
    // Documento controlado en documentos/ (nombre OK) = HIPOTESIS hasta validarla.
    if (new RegExp(`/${DOCS}/.+\\.md$`).test(norm) && !NO_INSTANCIA) {
      avisar('Documento en documentos/: TRATALO COMO HIPOTESIS hasta validarlo. Antes de darlo por bueno: LEE el codigo/fuentes que afirma, valida los datos con fuentes (WebSearch / MCP / docs oficiales), PREGUNTA al usuario lo que no sepas (sin inventar ni asumir cifras/hechos) y refleja SOLO lo verificado, citando de donde sale cada afirmacion.', 'PreToolUse');
      return;
    }
    // todo correcto -> silencio
  });
}

// PROTECCION main/master en comandos Bash (ciclo de vida git). Distingue por rama ACTUAL
// (la rama en la que se integra es la que esta checked out):
//   - en rama principal (main/master): 'git commit' directo -> DENY; 'git merge'/'git push' -> ASK
//     (es la aprobacion; la ejecuta el usuario, no Claude).
//   - en develop/feature: no interfiere -> merge feature->develop y commits pasan por el flujo normal.
// Patrones de comando DESTRUCTIVO (borrado recursivo/forzado, historial git irreversible, credenciales).
// Tratados como codigo de seguridad (recomendacion Anthropic): bloquean SIEMPRE, no dependen de rama/repo FARO.
// Revisar cada 3-6 meses: reglas pensadas para un modelo mas propenso a atajos peligrosos pueden quedar obsoletas.
const DESTRUCTIVE_CMD_PATTERNS = [
  [/\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\b/i, 'rm -rf (borrado recursivo forzado)'],
  [/\bgit\s+push\s+(?!--force-with-lease\b)(--force\b|-f\b)/i, 'git push --force (sobreescribe historial remoto; usa --force-with-lease si hace falta)'],
  [/\bgit\s+reset\s+--hard\b/i, 'git reset --hard (descarta cambios locales sin posibilidad de deshacer)'],
  [/\bgit\s+clean\s+-\w*f\w*d?\b/i, 'git clean -fd (borra archivos sin trackear irrecuperablemente)'],
  [/\bchmod\s+-R\s+000\b|\bchmod\s+000\b/i, 'chmod 000 (deja archivos inaccesibles)'],
  [/>\s*\/dev\/sd[a-z]\b/i, 'escritura directa a un dispositivo de bloque'],
  [/\bmkfs\./i, 'mkfs (formatea un sistema de archivos)'],
];
// GATE DE PLATAFORMA: detecta los dos atajos con los que el agente se salta el token del harness.
// Devuelve {motivo, alerta} o null. Es un DETECTOR PURO (sin efectos) para poder testearlo suelto.
//
//  1) el binario `gh` — puede no estar instalado, y aunque lo este usa OTRA credencial que la del
//     harness, asi que el resultado depende de como tenga cada uno su maquina.
//  2) `curl` contra api.github.com — esquiva el token y suele acabar en un 401 que nadie entiende.
//
// Precision del patron: se exige `gh` en POSICION DE COMANDO (inicio, o tras ; & | ( o &&), para no
// cazar 'git push', 'github.com' ni ninguna palabra que solo CONTENGA "gh".
function preBashPlataformaIssue(cmd) {
  const c = String(cmd || '');
  // EXENCION EXPLICITA: el propio harness ('node .../harness.js gh ...') es la via CORRECTA y nunca
  // debe bloquearse. Caso real (0.14.0, otra sesion): el gate salto sobre el comando del harness y el
  // mensaje le decia al agente "usa harness.js gh" — que era exactamente lo que estaba ejecutando.
  // Se comprueba ANTES que cualquier patron: si el comando invoca harness.js, no es el binario gh.
  if (/harness\.js["']?\s+/.test(c)) return null;
  // Binario 'gh' en POSICION DE COMANDO: inicio de linea (tambien tras un salto), o tras ; & | ( &&.
  const usaGh = /(^|\n|[;&|(]\s*|&&\s*|\|\|\s*)\s*gh(\s|$)/.test(c);
  const curlApi = /\bcurl\b[^\n]*\bapi\.github\.com\b/.test(c);
  if (!usaGh && !curlApi) return null;

  const f = forgeInfo();
  const H = 'node .claude/hooks/harness.js';   // el modo plugin reescribe esta ruta al emitir
  if (f.forge !== 'github') {
    return {
      motivo:
        `BLOQUEADO: este comando habla con la API de GitHub, pero la forja de este repo es ${f.forge.toUpperCase()}` +
        `${f.host ? ` (${f.host})` : ''}. No hay nada que arreglar en el comando: el harness todavia NO tiene adaptador para esa forja. ` +
        `NO reintentes ni busques rutas equivalentes. Lo que SI funciona aqui es el gobierno local (${H} validate | specs | rama | ramas | codigo), que es git puro. ` +
        'Para integrar, sube la rama y abre la peticion desde la web de la forja: el enlace lo imprime el propio git push.',
      alerta: `⛔ Comando de GitHub en un repo ${f.forge} — sin adaptador`,
    };
  }
  return {
    motivo:
      `BLOQUEADO: ${usaGh ? 'el binario `gh`' : '`curl` contra api.github.com'} NO es la via. Puede no estar instalado y, si lo esta, usa una credencial DISTINTA a la del harness — el resultado depende de como tenga su maquina cada persona. ` +
      `Usa SIEMPRE \`${H} gh <ruta> [METODO] [json]\`, que YA lleva el token del harness (~/.faro.json). Ejemplos: ` +
      `ver PRs -> \`${H} pr\` · abrir PR -> \`${H} gh repos/${f.owner || '<org>'}/${f.project || '<repo>'}/pulls POST '{"title":"..","head":"<rama>","base":"develop","body":".."}'\` · tu rol -> \`${H} role\`. ` +
      `Si responde SIN_TOKEN, la UNICA accion correcta es \`${H} auth\` (device-flow, codigo de 6 digitos) y reintentar. NUNCA pidas instalar \`gh\` ni un token a mano.`,
    alerta: '⛔ Usa `harness.js gh` (lleva el token), no el CLI de GitHub',
  };
}

// GUARDA de comando: volcado de credenciales por consola, y revision del area de preparacion
// antes de un commit (secretos, ficheros de credenciales, ficheros enormes). Devuelve {motivo,alerta}.
function preBashGuardaIssue(cmd) {
  const vol = CTX.volcadoCredencial(cmd);
  if (vol) {
    return {
      motivo: `BLOQUEADO: ese comando volcaria el contenido de '${vol}', que es un fichero de CREDENCIALES. ` +
        'Lo que se imprime queda en la transcripcion de la sesion y puede acabar en un log o en un informe. ' +
        'Si necesitas saber QUE variables define, mira su fichero de ejemplo (.env.example) o lista solo los NOMBRES de las claves, nunca sus valores.',
      alerta: `⛔ Volcado de credenciales bloqueado (${vol})`,
    };
  }
  if (!CTX.esGitCommit(cmd)) return null;
  const r = CTX.revisarStaged();
  if (!r.hallazgos.length) return null;
  const conSecreto = r.hallazgos.filter((h) => h.secretos.length);
  const sensibles = r.hallazgos.filter((h) => h.sensible);
  const grandes = r.hallazgos.filter((h) => h.grande);
  const partes = [];
  // El motivo NOMBRA el hallazgo pero NUNCA reproduce el valor: seria filtrarlo otra vez, en el propio aviso.
  if (conSecreto.length) partes.push(`SECRETOS en ${conSecreto.map((h) => `${h.ruta} (${h.secretos.join(', ')})`).join(' · ')}`);
  if (sensibles.length) partes.push(`FICHEROS DE CREDENCIALES: ${sensibles.map((h) => h.ruta).join(' · ')}`);
  if (grandes.length) partes.push(`FICHEROS ENORMES (>${r.max_kb} KB): ${grandes.map((h) => `${h.ruta} (${h.kb} KB)`).join(' · ')}`);
  if (!partes.length) return null;
  return {
    motivo:
      `BLOQUEADO: este commit publicaria — ${partes.join(' | ')}. ` +
      (conSecreto.length || sensibles.length
        ? 'Un secreto publicado es IRREVERSIBLE: aunque borres el commit, la clave queda comprometida y hay que ROTARLA. ' +
          'Sacalo del area de preparacion (git restore --staged <fichero>), anadelo a .gitignore, mueve el valor a una variable de entorno y deja solo su NOMBRE en el fichero de ejemplo. '
        : '') +
      (grandes.length ? `Un fichero grande entra en el historial y ya no sale: sacalo del commit y, si hace falta versionarlo, usa Git LFS o publicalo como adjunto de release. ` : '') +
      'Si es un FALSO POSITIVO (una clave de ejemplo, un fixture de test), explicaselo al usuario y que lo confirme el.',
    alerta: `⛔ Commit bloqueado: ${conSecreto.length ? 'posible SECRETO' : sensibles.length ? 'fichero de credenciales' : 'fichero enorme'} en el area de preparacion`,
  };
}

// RAMA A MANO sin issue: 'git switch -c fix/x' o 'git checkout -b fix/x' se saltaba el gate de
// 'harness.js rama'. Mismo alcance que ese gate (repo con faseo, o el motor) y mismas exenciones:
// ramas de gestion (chore) y las que ya llevan su numero ('fix/12-...').
function preBashRamaSinIssue(cmd) {
  const m = String(cmd).match(/(?:^|[\s;&|(])git\b[^;&|]*?\b(?:switch\s+(?:-c|-C|--create)|checkout\s+(?:-b|-B))\s+(["']?)([^\s"';&|]+)\1/);
  if (!m) return null;
  const nombre = m[2];
  const tm = nombre.match(WORK_BRANCH_RE);
  if (!tm || TIPOS_GESTION.includes(tm[1]) || /^[a-z]+\/\d+-/.test(nombre)) return null;
  if (!IS_ENGINE && !parseEstado()) return null;
  const tipoIssue = (TIPO_RAMA_A_ISSUE[tm[1]] || { tipo: 'tarea' }).tipo;
  return {
    motivo: `BLOQUEADO: rama '${nombre}' sin issue. Declara primero la tarea (tipo '${tipoIssue}'; un fallo detectado es un bug) ` +
      `con 'harness.js asignar-tarea ... --tipo ${tipoIssue}' y abre la rama con 'harness.js rama ${tm[1]} "<desc>" --issue <N>'.`,
    alerta: `⛔ Rama sin issue: '${nombre}'`,
  };
}

function preBashDestructivoIssue(cmd) {
  for (const [re, desc] of DESTRUCTIVE_CMD_PATTERNS) if (re.test(cmd)) return desc;
  return null;
}
// Orden que lanza un gate pesado (vitest, jest, tsc, wrangler deploy, <gestor> test|build|typecheck|lint).
const RE_GATE_PESADO = /\b(?:vitest|jest|tsc|wrangler\s+deploy)\b|\b(?:pnpm|npm|yarn|npx|bun)\b[^|;&\n]{0,200}\b(?:test|build|typecheck|lint)\b/;
function avisoSaturacionBash(cmd) {
  try {
    if (!RE_GATE_PESADO.test(String(cmd).slice(0, 2000))) return;
    const aviso = require('./lib/gobernador.js').avisoSaturacion(process.env, ROOT);
    if (aviso) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: aviso } }) + '\n');
  } catch { /* un fallo del aviso nunca bloquea */ }
}
function cmdPreBash() {
  // stdin ya se leyo arriba (salida temprana de ordenes inocuas): se reutiliza ese payload.
  const conPayload = (cb) => (_payloadSync !== undefined ? cb(_payloadSync) : readStdin(cb));
  conPayload((payload) => {
    const cmd = ((payload.tool_input || {}).command) || '';
    // Comando DESTRUCTIVO: bloquea siempre, cualquier repo/rama — no es negociable con un 'ask'.
    const destructivo = preBashDestructivoIssue(cmd);
    if (destructivo) {
      deny(
        `BLOQUEADO: comando destructivo detectado (${destructivo}). Si de verdad hace falta, el USUARIO debe ` +
        'ejecutarlo el mismo desde su terminal — el agente no lo lanza directamente. Si crees que es un falso ' +
        'positivo (la ruta es claramente segura y aislada), explica al usuario por que y pidele que lo confirme.',
        'PreToolUse',
        '⛔ Comando destructivo bloqueado — pide confirmacion humana explicita fuera del agente',
      );
      return;
    }
    // ALCANCE (#150): escribir (git commit/push/add…, redirecciones, rm/mv/cp…) en otro repo se bloquea;
    // leer no. Va despues de la via temprana de ordenes inocuas, que nunca decide sobre rutas.
    {
      let aj = null;
      try { aj = require('./lib/alcance.js').analizarComando(cmd, _rootPorDefecto); }
      catch (e) { aj = { nivel: 'ask', ruta: '', motivo: `no se pudo cargar el control de alcance (${(e && e.message) || e})` }; }
      if (aj && aj.nivel === 'ask') {
        ask(`La orden podria escribir fuera del repo de esta sesion (${aj.motivo || aj.ruta}). Confirma solo si el destino es el repo de esta sesion; si es de otro repo, abre alli un issue con asignar-tarea --repo.`,
          'PreToolUse', '⚠ Destino no comprobable — confirma que escribe en el repo de la sesion');
        return;
      }
      if (aj) {
        const destino = aj.sinRemoto ? '<org>/<repo>' : aj.repo;
        const via = `abre un issue en ese repo con \`node .claude/hooks/harness.js asignar-tarea "<titulo>" <login> --repo ${destino} --tipo <tipo>\``;
        deny(
          aj.tipo === 'git-ambiguo'
            ? `BLOQUEADO: no puedo comprobar a que repo apunta '${aj.ruta}' (variable o sustitucion) en un git que escribe. Usa una ruta literal; si es de otro repo, ${via}.`
            : `BLOQUEADO: la orden escribe en '${aj.ruta}', del repo ${aj.repo}${aj.sinRemoto ? ' (sin remoto)' : ''}, que no es el de esta sesion: ${via}. Leer ese repo si esta permitido.`,
          'PreToolUse',
          aj.tipo === 'git-ambiguo' ? '⛔ git sobre un repo no comprobable — usa una ruta literal' : `⛔ ${aj.repo} no es el repo de esta sesion — abre un issue alli`,
        );
        return;
      }
    }
    // SERVIDORES DE DESARROLLO (#177): el agente no los levanta; entrega comando y puerto y el usuario los
    // lanza aparte. `ask`, no deny: red de seguridad (lib/servidores.js), no frontera. Tests/builds no se tocan.
    {
      let srv = null;
      try { srv = require('./lib/servidores.js').detectarServidor(cmd); } catch { srv = null; }
      if (srv) {
        ask(require('./lib/servidores.js').MENSAJE, 'PreToolUse', '⚠ Servidor de desarrollo — lo levantas tú, en una terminal aparte');
        return;
      }
    }
    // GATE DE PLATAFORMA (sustituye a mil caracteres de instruccion por turno).
    // El contexto pedia en CADA prompt "no uses el binario gh, usa el subcomando del harness".
    // Un texto cuesta tokens siempre y se puede desobedecer; un deny cuesta CERO, solo se lee cuando
    // alguien se equivoca de verdad, y no se puede ignorar. Mismo patron que el veto al commit en
    // la rama principal: ahi el harness no pide, veta.
    const plataforma = preBashPlataformaIssue(cmd);
    if (plataforma) { deny(plataforma.motivo, 'PreToolUse', plataforma.alerta); return; }
    // GUARDAS DE SEGURIDAD: lo que la industria bloquea por defecto y aqui no se miraba.
    // El de SECRETOS es el unico cuyo fallo es IRREVERSIBLE: publicada la clave, hay que rotarla
    // aunque se borre el commit. Por eso se comprueba ANTES del commit, no despues.
    const gu = preBashGuardaIssue(cmd);
    if (gu) { deny(gu.motivo, 'PreToolUse', gu.alerta); return; }
    const rsi = preBashRamaSinIssue(cmd);
    if (rsi) { deny(rsi.motivo, 'PreToolUse', rsi.alerta); return; }
    // Deploy a produccion (repos con codigo) = APROBACION: avisa (no bloquea; lo aplica el usuario). Dormido en documental.
    const _cmb = codeMod();
    if (_cmb && _cmb.isDeployCmd(cmd)) {
      ask('Deploy manual detectado. ' + _cmb.deployNote(), 'PreToolUse', '⚠ Deploy manual — normalmente el deploy es por push (CI)');
      return;
    }
    // #182: ante un gate pesado, UNA linea si el sistema ya esta saturado (silencio si todo va bien).
    if (!/\bgit\b/.test(cmd)) { avisoSaturacionBash(cmd); return; }
    // La proteccion sigue al repo OBJETIVO del comando, no solo al de la sesion: cubre
    // 'git -C <ruta> ...' y 'cd <ruta> && git ...' (tambien desde subagentes/background).
    let root = ROOT;
    const mC = cmd.match(/\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const mCd = cmd.match(/(?:^|[;&|(]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))\s*(?:&&|;)/);
    const cand = (mC && (mC[1] || mC[2] || mC[3])) || (mCd && (mCd[1] || mCd[2] || mCd[3]));
    if (cand) { try { const p = path.resolve(ROOT, cand.replace(/\$\w+/g, '')); if (p && fs.existsSync(p)) root = p; } catch {} }
    let branch = null;
    try { branch = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch {}
    if (!branch) return;
    // Solo gobernamos repos FARO (archivo de estado o template). Otros repos objetivo —una
    // herramienta, un repo ajeno— NO se tocan: la proteccion de ciclo no les aplica.
    // BUG HISTORICO (corregido en 0.9.1): exigia ADEMAS la copia legada .claude/hooks/harness.js,
    // resto del mundo pre-plugin — los repos en MODO PLUGIN (lo normal hoy) quedaban SIN el bloqueo
    // de main/develop aunque el README lo describe como obligatorio. El ciclo aplica SIEMPRE.
    // Deteccion TRIPLE (mas robusta que solo ESTADO.md): estado del trabajo, metadato de
    // clasificacion o settings del repo declarando el plugin faro — cualquiera marca repo gobernado.
    if (root === ROOT && IS_ENGINE) return; // el MOTOR queda exento a proposito (modo motor)
    const declaraFaro = (() => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
        return !!(s.enabledPlugins && Object.keys(s.enabledPlugins).some((k) => /^faro@/.test(k) && s.enabledPlugins[k] === true));
      } catch { return false; }
    })();
    const Pr = require('./lib/paths.js')(root);
    const esFaro = fs.existsSync(path.join(root, Pr.ESTADO)) || fs.existsSync(path.join(root, Pr.CONFIG)) ||
      declaraFaro || /^template-/i.test(path.basename(root));
    if (!esFaro) return;
    const targetIsTemplate = /^template-/i.test(path.basename(root));
    if (targetIsTemplate) return; // modo template: el estandar se edita/commitea directo en main
    const gitCommitAny = /(^|[\s;&|(])git\b(?:\s+-C\s+\S+|\s+-[^\s]+|\s+--[^\s]+)*\s+commit\b/.test(cmd);
    const gitMergeAny = /(^|[\s;&|(])git\b[\s\S]*?\bmerge\b/.test(cmd);
    // GATE develop: la integracion SOLO recibe MERGES/PR (via /faro:consolidar); el commit DIRECTO se BLOQUEA
    // (develop deja de ser zona de trabajo — el estandar es <tipo>/<slug> -> PR/merge a develop). Los merges SI pasan.
    if (branch === 'develop' && gitCommitAny && !gitMergeAny) {
      deny(
        `BLOQUEADO: 'git commit' directo en 'develop'${root !== ROOT ? ` (repo: ${path.basename(root)})` : ''} — develop es la INTEGRACION y NO se edita a mano (ni tu, ni owner/admin/maintainer). ` +
        `El trabajo va en una rama <tipo>/<slug> (node .claude/hooks/harness.js rama <tipo> "<tema>") y entra por PR/merge (via /faro:consolidar). Cambiate a una rama de cambio y commitea alli.`,
        'PreToolUse',
        '⛔ git commit bloqueado en develop — trabaja en <tipo>/<slug> y consolida por PR',
      );
      return;
    }
    if (!isNoWrite(branch)) return; // <tipo>/<slug>: flujo normal (main/master/develop ya tratados)
    // Repo objetivo DISTINTO al de la sesion en rama principal: mismo veto/confirmacion (generico, sin rol).
    if (root !== ROOT) {
      if (gitCommitAny && !gitMergeAny) {
        deny(`BLOQUEADO: 'git commit' directo en '${branch}' del repo ${path.basename(root)} (rama principal de solo-integracion). Cambia alli a develop/feature y commitea; a la principal se llega SOLO por merge.`, 'PreToolUse', `⛔ git commit bloqueado en '${branch}' (${path.basename(root)})`);
      } else if (gitMergeAny || /(^|[\s;&|(])git\b[\s\S]*?\bpush\b/.test(cmd)) {
        ask(`Merge/push sobre '${branch}' del repo ${path.basename(root)} (rama principal): a main se llega con /faro:publicar. Confirma solo si eres tu y sabes lo que publicas.`, 'PreToolUse', `⚠ Publicacion sobre '${branch}' (${path.basename(root)})`);
      }
      return;
    }
    const g = gitInfo();
    if (!g) return;
    const gitMerge = /(^|[\s;&|(])git\b[\s\S]*?\bmerge\b/.test(cmd);
    const gitPush = /(^|[\s;&|(])git\b[\s\S]*?\bpush\b/.test(cmd);
    const gitCommit = /(^|[\s;&|(])git\b(?:\s+-C\s+\S+|\s+-[^\s]+|\s+--[^\s]+)*\s+commit\b/.test(cmd);
    if (gitCommit && !gitMerge) {
      deny(
        `BLOQUEADO: 'git commit' directo en '${g.branch}' (rama principal de solo-integracion). ` +
        `main/master NUNCA se commitean directo: cambia a develop o feature (git switch develop) y commitea alli; ` +
        `a la principal se llega SOLO publicando (/faro:publicar).`,
        'PreToolUse',
        `⛔ git commit bloqueado en '${g.branch}' — commitea en develop/feature`,
      );
      return;
    }
    if (gitMerge || gitPush) {
      // ROL por usuario git (paridad GitLab): 'maintainers:' en el frontmatter de ESTADO.md.
      // Quien NO este en la lista es DEVELOPER -> DENY a main. MAINTAINER -> ASK guiado (Claude puede
      // aplicar el merge CON tu confirmacion, uno a uno). Sin lista -> ASK generico. GitLab refuerza en servidor.
      const rr = resolveRole();
      const rol = rr && rr.rol;
      const maints = (rr && rr.maints) || [];
      if (rol === 'developer') {
        deny(
          `BLOQUEADO: rol DEVELOPER de '${g.user || '(sin user.name)'}' segun ${rr.via}${maints.length ? ` (maintainers: ${maints.join(', ')})` : ''}. ` +
          `Un developer trabaja en feature/develop; publicar a '${g.branch}' (/faro:publicar) lo hace un MAINTAINER (GitLab lo refuerza en servidor).`,
          'PreToolUse', `⛔ ${gitMerge ? 'Merge' : 'Push'} a '${g.branch}': rol developer`,
        );
        return;
      }
      ask(
        rol === 'maintainer'
          ? `Rol MAINTAINER (${g.user}). ${gitMerge ? 'Merge' : 'Push'} sobre '${g.branch}': la via es /faro:publicar (valida el ciclo, version y tag). Si aun asi lo haces a mano, revisa antes /faro:pendientes (QUE entra y de quien). Confirma para aplicarlo.`
          : `${gitMerge ? 'Merge' : 'Push'} sobre '${g.branch}' (rama principal): a main se llega con /faro:publicar. Confirma solo si eres tu (declara 'maintainers:' en el frontmatter de ${ESTADO_FILE} para control por rol).`,
        'PreToolUse',
        `⚠ ${gitMerge ? 'Merge' : 'Push'} de publicacion sobre '${g.branch}'`,
      );
    }
  });
}

// Silencioso salvo riesgo: alerta si el faseo queda invalido, el nombrado no cumple,
// o el frontmatter de una spec esta incompleto/invalido.
function cmdDocCheck() {
  payloadHook((payload) => {
    const fp = (payload.tool_input || {}).file_path;
    if (esArchivoEstado(fp)) {
      invalidarEstado(); // el archivo acaba de cambiar: invalida la cache de lib/estado.js
      const { errs } = validateEstado();
      if (errs.length) {
        emit(
          `VALIDACION FASEO (${ESTADO_FILE}) — ${errs.length} error(es):\n${errs.map((e) => `- ${e}`).join('\n')}`,
          'PostToolUse',
          `⚠ Faseo invalido: ${errs.length} error(es) en ${ESTADO_FILE}`,
        );
        return;
      }
      // Control de replanificacion: cambiar una fecha 'Objetivo:' no es un edit silencioso.
      const diff = git('diff', '--unified=0', '--', ESTADO_FILE) || '';
      const replan = diff.split('\n').filter((l) => /^[-+][^-+].*objetivo\s*:?\**\s*\d{4}-\d{2}-\d{2}/i.test(l));
      if (replan.length) {
        emit(
          `REPLANIFICACION DETECTADA en ${ESTADO_FILE} (cambio de fecha Objetivo):\n${replan.map((l) => `  ${l}`).join('\n')}\n` +
          `Una fecha objetivo NO se cambia en silencio: registra la correccion como ADR en ${SP}/decisions/ ` +
          '(fecha anterior, nueva, causa y a que fases arrastra) y menciona la desviacion en el proximo informe. ' +
          'Si el cambio fue un error, revierte la fecha.',
          'PostToolUse',
          '⚠ Replanificacion: cambio de fecha Objetivo — exige ADR con la justificacion',
        );
      }
      return; // faseo correcto y sin replanificacion -> silencio
    }
    // Proposal de cambio spec-driven: valida el frontmatter de ciclo de vida tras escribir.
    const chM = String(fp || '').replace(/\\/g, '/').match(new RegExp(`/(?:${PATHS.BASE}/)?gestion/cambios/changes/([^/]+)/proposal\\.md$`)); // #293: lectura dual
    if (chM && chM[1] !== 'archive') {
      const spec = listSpecs().find((s) => s.name === chM[1]);
      const issues = spec ? specIssues(spec) : [];
      if (issues.length) {
        emit(
          `PROPOSAL ${chM[1]} — frontmatter incompleto/invalido:\n${issues.map((i) => `- ${i}`).join('\n')}\n${specFmTemplate()}`,
          'PostToolUse',
          `⚠ Proposal sin ciclo de vida valido: ${chM[1]} (${issues.length} problema/s)`,
        );
      }
      return;
    }
    // Documento CONTROLADO (con doc_id): validacion de control documental INMEDIATA al escribir.
    const normFp = String(fp || '').replace(/\\/g, '/');
    if (/\.md$/i.test(normFp) && /\/(docs|superpowers)\//.test(normFp)) {
      const rel = normFp.split(/\/(docs|superpowers)\//).slice(-2).join('/');
      const d = docsControlados().find((x) => normFp.endsWith(x.rel));
      if (d) {
        const issues = [...docControlIssues(d), ...docPlacementIssues(d)];
        const dup = docsDuplicados(docsControlados()).includes(d.id);
        if (issues.length || dup) {
          emit(
            `DOCUMENTO CONTROLADO ${d.id} (${rel}) — control documental incompleto:\n` +
            [...issues, ...(dup ? [`doc_id '${d.id}' DUPLICADO en otro documento`] : [])].map((i) => `- ${i}`).join('\n') +
            `\nFrontmatter exigido: doc_id (unico, CLAVE-TIPO-NNN via 'harness.js docref <TIPO>'; gestionala con 'harness.js clave'; la CLAVE corta se declara en 'clave:' de ESTADO.md) · title · version (SemVer) · date · status (draft|in_review|approved|obsolete) · author. La aprobacion real la da el merge a main.`,
            'PostToolUse',
            `⚠ Documento controlado ${d.id}: ${issues.length + (dup ? 1 : 0)} problema(s) de control documental`,
          );
          return;
        }
        // Publicado en un catalogo EXTERNO (agnostico: 'external_id' generico, cualquier sistema
        // que el equipo conecte, sea cual sea) y modificado -> recuerda el versionado. El
        // harness NO conoce ni escribe en ningun catalogo concreto; solo avisa si el frontmatter
        // ya trae ese id.
        if (d.fm.external_id) {
          emit(
            `Documento ${d.id} tiene publicacion externa registrada (external_id ${d.fm.external_id}) y acabas de modificarlo. ` +
            `Si el cambio es sustantivo: sube la 'version' (SemVer) + fila en Control de versiones. (La re-publicacion en el catalogo externo es cosa de esa integracion, fuera de este harness.)`,
            'PostToolUse',
            `↻ ${d.id} modificado — recuerda subir version`,
          );
          return;
        }
      }
    }
    const m = matchRule(fp);
    if (!m) return;
    // El nombrado fuera de convencion YA se avisa en pre-doc (antes de escribir, que es cuando aun
    // sirve de algo: "corrige el nombre ANTES de escribir"). Repetirlo aqui era el MISMO aviso dos
    // veces por la misma escritura, y el segundo llega tarde — el fichero ya esta en disco.
    // Las tres carpetas con regla de nombrado (brainstorming/, decisions/, informes/) pasan siempre
    // por el aviso de pre-doc: los retornos tempranos de ahi son de proposal/tasks, que viven en
    // subcarpeta y para los que matchRule devuelve null. No se pierde cobertura.
    if (!m.ok) return;
  });
}

// Stop: recordatorio de commit si quedan cambios documentales sin versionar.
// CRITERIO bloqueo/aviso (#124), el mismo que el vigilante:
//   - BLOQUEO (exit 2 + stderr): solo lo que el agente DEBE resolver antes de cerrar el turno — los
//     artefactos que el propio trabajo genero o actualizo (ESTADO.md, CLAUDE.md, reporting) sueltos.
//   - AVISO (systemMessage + exit 0): todo lo informativo — documentos propios sin commitear, ramas de
//     otros pendientes en el remoto (eso lo dice el vigilante, nunca el Stop). Un exit 2 por algo que
//     no toca resolver obliga al modelo a seguir y la plataforma lo pinta como error.
function cmdStopCheck() {
  readStdin((payload) => {
    if (payload.stop_hook_active) return;
    // UNA lectura de git, no las tres de gitInfo(): aqui no se usa ni la rama ni el usuario, y esto
    // corre al cerrar CADA turno. Misma optimizacion que se hizo en 'pre-doc' con ramaActual().
    const dirtyDocs = docsSinCommitear();
    const avisoProc = require('./lib/procesos.js').avisoCorto(process.env, ROOT);   // #177: '' si todo OK (silencio)
    if (!dirtyDocs.length) {
      if (avisoProc) process.stdout.write(JSON.stringify({ suppressOutput: true, systemMessage: `⚠ ${avisoProc}` }) + "\n");
      return;
    }
    const shown = dirtyDocs.slice(0, 4).join(', ') + (dirtyDocs.length > 4 ? ` (+${dirtyDocs.length - 4} mas)` : '');
    // CICLO DE COMMIT: los artefactos que el trabajo GENERA o ACTUALIZA por el camino (informe
    // semanal auto-generado, ESTADO.md, CLAUDE.md, reporting) FORMAN PARTE del commit del trabajo
    // en curso — no se dejan "sueltos" para nunca. Si no hay trabajo en curso, commit documental propio.
    // El informe SEMANAL queda FUERA del filtro que bloquea, a proposito. Lo escribia el harness solo
    // en cada SessionStart (hasta #125; ahora solo se anuncia y se genera a peticion con
    // 'harness.js informe-semanal'), y los repos pueden conservar uno suelto de entonces: bloquear el
    // turno por el seria castigar al usuario por algo que hizo el motor. Sigue saliendo en el aviso
    // de 'documento(s) sin commitear', que es donde le corresponde estar.
    const generados = dirtyDocs.filter((d) => /(^|\/)(ESTADO\.md|CLAUDE\.md)$/.test(d) || (/gestion\/reporting\//.test(d) && !/-semanal-informe\.md$/.test(d)));
    // AVISO -> GATE. Esto era solo `systemMessage`: TEXTO, que compite con miles de caracteres de
    // contexto y se ignora en la practica (lo reporto el usuario: el agente lo lee y sigue de largo).
    // La regla que el propio motor ya aplica al binario gh vale igual aqui: un texto se desobedece,
    // un bloqueo no. Codigo de salida 2 = senal de bloqueo documentada, y el motivo viaja por stderr.
    // Se bloquea SOLO por los artefactos GENERADOS (informe semanal, ESTADO, CLAUDE, reporting):
    // dejar trabajo propio a medias es legitimo; dejar sueltos los que el harness acaba de generar,
    // no. La guarda stop_hook_active (arriba) corta el bucle: si ya venimos de un bloqueo, no repite.
    if (generados.length) {
      // La salida DEPENDE DE LA RAMA, y decirlo importa: en develop/main el propio motor prohibe
      // 'git commit', asi que un mensaje que solo dice "commitealos" manda contra otro bloqueo.
      // Caso real: al arrancar un repo legacy, FARO GENERA ESTADO.md estando en develop — el motor
      // creaba el fichero, exigia commitearlo y prohibia hacerlo donde estabas. Callejon sin salida.
      // isNoWrite, NO isProtected: 'protegida' son solo main/master (las principales, para detectar
      // cual es la de aprobacion). La que importa aqui es 'sin escritura directa', que incluye
      // develop y las ramas de entorno que el repo declare en faro/config.json — que son exactamente
      // aquellas donde el motor va a rechazar el commit que este mensaje esta pidiendo.
      const rama = ramaActual();
      const salida = isNoWrite(rama)
        ? `Estas en '${rama}', donde el motor NO deja commitear (es integracion/publicacion). Crea primero la rama `
          + `y los cambios viajan contigo: git switch -c chore/estado-inicial  (o 'harness.js rama chore "estado inicial"'). `
          + 'Despues commitea alli y entra por PR.'
        : 'Incluyelos en el commit del trabajo en curso, o haz un commit documental propio si no hay trabajo abierto.';
      process.stderr.write(
        `BLOQUEADO: ${generados.length} artefacto(s) que este trabajo genero o actualizo siguen sin `
        + `commitear: ${generados.join(", ")}. No cierres el turno dejandolos sueltos. ${salida}\n`
      );
      process.exit(2);
    }
    process.stdout.write(JSON.stringify({
      suppressOutput: true,
      systemMessage: `\u26a0 ${dirtyDocs.length} documento(s) sin commitear: ${shown} — convencion: commit por cambio documental (rama feature -> develop -> main)${avisoProc ? ' · ' + avisoProc : ''}`,
    }) + "\n");
  });
}

// Validacion completa para CLI/CI (gate de merge): exit code != 0 si hay errores.
function cmdValidate() {
  // Estructura de referencia (specs/, changes/archive, reporting/...): en 'session' se garantiza
  // SIEMPRE; 'validate' puede correr en CI sin sesion previa (ej. primer push), asi que se
  // AUTOCREA aqui tambien — idempotente y no bloqueante (mkdir con carpetas ya existentes no falla).
  // Sin esto, un CI limpio validaba contra una estructura que nunca llego a existir.
  // MISMA EXENCION QUE 'session' (linea ~882): en modo MOTOR el andamio de instancia no pinta nada.
  // Sin esta guarda, un 'validate' en el repo del plugin sembraba 21 carpetas vacias (gestion/,
  // documentos/, fuentes/, notebooks/...) que el motor no usa y que nadie habia pedido.
  if (!IS_ENGINE && !SIN_ADOPTAR) REF_DIRS.forEach((d) => fs.mkdirSync(path.join(ROOT, d), { recursive: true }));
  const errs = [];
  // Modo template: el estandar no es una instancia — sin INICIATIVA.md ni funcional que exigir
  // (el nombrado y las specs SI se validan, para que los ejemplos del template esten en regla).
  if (!NO_INSTANCIA) {
    const { errs: faseo } = validateEstado();
    errs.push(...faseo.map((e) => `[faseo] ${e}`));
    // FORMATO de cada fase ABIERTA — RIGIDO, no negociable: la fase ES el hito, y sin id (#N),
    // responsable (@usuario) y descripcion no se puede gobernar ni contabilizar nada. La
    // flexibilidad vive en el CONTENIDO del issue (el agente amplia lo que encuentra), no aqui.
    // Las fases cerradas quedan fuera: son historico y reescribirlas seria falsear lo que paso.
    const iniF = parseEstado();
    if (iniF) {
      const cl = require('./lib/ciclo.js');
      for (const f of iniF.fases) errs.push(...cl.huecosDeFase(f).map((e) => `[faseo] ${e}`));
    }
    if (!funcionalExists()) {
      errs.push(`[funcional] no hay documento funcional (declara 'funcional: <ruta>' en ${ESTADO_FILE} o crea documentos/funcional/*.md).`);
    }
    // Clave sin declarar + YA hay documentos emitidos: BLOQUEA (gestion documental estricta). Sin
    // esto, se siguen generando doc_id con una clave derivada que despues no se puede corregir sin
    // romper los ya emitidos. Mientras NO haya documentos, solo se avisa (docLines/claveIssues).
    if (docsControlados().length > 0) {
      const iniC = parseEstado();
      if (iniC && iniC.fm && !iniC.fm.clave && !iniC.fm.key) {
        errs.push(`[clave] hay ${docsControlados().length} documento(s) emitido(s) SIN 'clave:' declarada en ${ESTADO_FILE} — fija la clave (2-10 letras, estilo Jira; harness.js clave --sugerir "<nombre>") antes de generar mas doc_id. Cambiarla despues NO reescribe los ya emitidos.`);
      }
    }
  }
  for (const [folder, re, expected] of NAMING_RULES) {
    const dir = folder.slice(1, -1);
    for (const f of listFiles(dir)) {
      if (!re.test(f.name)) errs.push(`[nombrado] ${f.rel} no cumple ${expected}`);
    }
  }
  for (const s of listSpecs()) {
    specIssues(s).forEach((i) => errs.push(`[spec] ${s.name}: ${i}`));
  }
  // GATES DE CICLO DE VIDA spec<->tasks<->fase (100% aplicado, deterministas, del lado harness).
  // El motor specs.js cubre deltas y archivado; aqui se cubre la coherencia proposal/tasks/ESTADO.md.
  if (!NO_INSTANCIA) {
    const iniCV = parseEstado();
    // set de textos de tarea de ESTADO.md (para validar que 'tareas:[...]' de una proposal EXISTE).
    const tareasEstado = iniCV ? iniCV.fases.flatMap((f) => f.tareas.map((t) => t.text.toLowerCase())) : [];
    for (const s of listSpecs()) {
      const estado = s.fm.estado;
      // SIN TASKS = ERROR: aprobada exige tasks.md; implementada exige tasks.md al 100%.
      if (estado === 'aprobada' && !hasTasks(s.name)) {
        errs.push(`[ciclo] cambio '${s.name}' esta 'aprobada' pero NO tiene tasks.md — un cambio aprobado DEBE tener su plan (${CHANGES_DIR}/${s.name}/tasks.md con checkboxes).`);
      }
      if (estado === 'implementada') {
        if (!hasTasks(s.name)) {
          errs.push(`[ciclo] cambio '${s.name}' esta 'implementada' pero NO tiene tasks.md — no puede estar implementado sin plan.`);
        } else {
          const prog = progressOf(tasksPath(s.name));
          const m = prog.match(/^(\d+)\/(\d+)/);
          if (!m || m[1] !== m[2] || m[2] === '0') {
            errs.push(`[ciclo] cambio '${s.name}' esta 'implementada' pero tasks.md no esta al 100% (${prog}) — marca todas las tareas o revierte el estado.`);
          }
        }
      }
      // ANCLAJE change->fase: la fase declarada DEBE existir en ESTADO.md. Un cambio nacido antes de
      // que el faseo la contemple queda colgado de algo que no esta — y como el hito de la forja sale
      // de estas mismas fases ('hito sync'), tampoco tendra hito donde anclarse. 'backlog' es la sala
      // de espera declarada, no un numero de fase; sin fase no hay nada que contrastar.
      const faseDecl = s.fm.fase;
      if (iniCV && faseDecl != null && String(faseDecl).trim() !== '' && String(faseDecl).toLowerCase() !== 'backlog') {
        const n = String(faseDecl).trim();
        if (!iniCV.fases.some((f) => String(f.num) === n)) {
          errs.push(
            `[ciclo] cambio '${s.name}' declara 'fase: ${n}' pero esa fase NO existe en ${ESTADO_FILE} ` +
            `(hay ${iniCV.fases.length}: ${iniCV.fases.map((f) => f.num).join(', ') || 'ninguna'}). ` +
            'Corrige la fase del cambio, o anade esa fase al faseo primero. Si aun no tiene fase decidida: \'fase: backlog\'.',
          );
        }
      }
      // LIGADURA change -> DECISION: el proposal dice el QUE, el ADR el POR QUE tecnico. Un cambio
      // de codigo sin decision citada pierde el enfoque elegido, y el siguiente que lo toque lo
      // reinventa (o lo contradice sin saberlo). Solo aplica a cambios de CODIGO: un cambio
      // documental u organizativo no arrastra una decision de arquitectura.
      // 'sin_spec: true' ya declara que el cambio no toca ninguna capacidad -> queda fuera.
      // "Tiene codigo" = src/ en la raiz o, en un monorepo, src/ en alguna app (#132): mirar solo la
      // raiz apagaba este enlace en silencio en todo monorepo.
      const repoConCodigo = fs.existsSync(path.join(ROOT, 'src')) || appsConCodigo().length > 0;
      if (repoConCodigo && s.fm.sin_spec !== true) {
        let adrs = [];
        try { adrs = fs.readdirSync(path.join(ROOT, `${SP}/decisions`)).filter((f) => f.endsWith('.md')); } catch {}
        const msg = require('./lib/ciclo.js').coherenciaCambioDecision({
          slug: s.name, decision: s.fm.decision, tocaCodigo: true, decisionesExistentes: adrs,
        });
        if (msg) errs.push(`[ciclo] ${msg}`);
      }
      // COHERENCIA change<->fase: cada fragmento de 'tareas:[...]' DEBE existir en ESTADO.md.
      if (iniCV && tareasEstado.length) {
        for (const fr of specTareas(s.fm)) {
          if (!tareasEstado.some((tx) => tx.includes(fr.toLowerCase()))) {
            errs.push(`[ciclo] cambio '${s.name}': la tarea referenciada "${fr}" (frontmatter tareas:) NO existe en ${ESTADO_FILE} — corrige la referencia o añade la tarea a la fase.`);
          }
        }
      }
    }
  }
  const controlados = docsControlados();
  docsDuplicados(controlados).forEach((id) => errs.push(`[docs] doc_id duplicado: ${id} (debe ser unico).`));
  for (const d of controlados) {
    docControlIssues(d).forEach((i) => errs.push(`[docs] ${d.rel}: ${i}`));
    docPlacementIssues(d).forEach((i) => errs.push(`[docs] ${d.rel}: ${i}`));
  }
  kpiIssues().forEach((i) => errs.push(`[kpi] ${i}`));
  requisitosIssues().forEach((i) => errs.push(`[req] ${i}`));
  if (!NO_INSTANCIA) personasEstadoIssues().forEach((i) => errs.push(`[personas] ${i}`));
  if (!NO_INSTANCIA) clasificacionIssues().forEach((i) => errs.push(`[clasificacion] ${i}`));
  // Gates de codigo (solo INSTANCIAS con codigo — dormido en documental y en modo template, que lleva placeholders a proposito).
  const avisosDeps = []; // gates NO evaluados por problema de dependencias (se emiten con los avisos, no bloquean)
  const _cm = NO_INSTANCIA ? null : codeMod();
  let notaGates = ''; // monorepo (#130): que apps se ejecutaron y por que
  if (_cm && _cm.hasCode()) {
    _cm.validationIssues().forEach((i) => errs.push(`[stack] ${i}`));
    // Los GATES (typecheck/lint/test/build + simulacro de despliegue) son lo unico caro de validate (#167:
    // >2 min en un monorepo real, el 98 % del tiempo). Solo corren si se piden: --gates (apps afectadas),
    // --todas o --app <id>. consolidar y publicar piden --todas; `harness.js gates` los corre sueltos.
    const _og = opcionesGates();
    const _pidenGates = _og.gates || _og.todas || _og.apps.length > 0;
    if (!_pidenGates) notaGates = 'Gates: no ejecutados (validate no los corre por defecto). Pídelos con `validate --gates` (apps afectadas), `--todas` o `--app <id>`; consolidar y publicar corren la batería completa.\n';
    const _gr = _pidenGates ? _cm.gateResults(_og) : [];
    if (_gr.alcance) notaGates = `Gates por app: ${_gr.alcance.resumen}\n`;
    for (const [name, r] of _gr) {
      if (r.status === 'fail' && r.timeout) errs.push(`[gates] ${name}: ${r.out.replace(/^tiempo agotado/, 'TIEMPO AGOTADO')}`);
      else if (r.status === 'fail') errs.push(`[gates] ${name}: FALLA\n${r.out.split('\n').slice(-8).map((l) => '    ' + l).join('\n')}`);
      // 'deps' = el gate NO se pudo evaluar por el entorno (p. ej. pnpm aborta por builds sin
      // aprobar). NO es un fallo del gate: avisa sin bloquear, y dice el arreglo concreto — antes
      // salia como "[gates] lint: FALLA" con un stacktrace de pnpm y mandaba a depurar el linter.
      // (Se acumula aparte: flowWarns aun no existe a esta altura del validate.)
      else if (r.status === 'deps') avisosDeps.push(`[deps] ${name}: no evaluado — ${r.motivo}`);
      // 'busy' (#182) = sistema saturado: el gate no se evaluo, asi que NO se da por bueno; se reintenta cuando acaben los otros.
      else if (r.status === 'busy') errs.push(`[gates] ${name}: NO EVALUADO (sistema saturado) — ${String(r.out).split('\n')[0]}`);
    }
  }
  // Specs NATIVAS FARO (specs.js): ciclo spec-driven, VITAL en TODOS los repos (doc/worker/app).
  // Valida los deltas + escenarios de los cambios con el motor nativo (sin librerias).
  // (binario en PATH). Si no esta, se avisa mas abajo (no bloquea) para que se instale.
  // SPECS NATIVAS FARO (specs.js, sin librerias): rigor de deltas + escenarios verificables.
  // Estricto donde HAY deltas (errores bloquean); los cambios legados sin deltas generan AVISO (no bloquean),
  // pero los cambios NUEVOS deben traer changes/<id>/specs/<capacidad>/spec.md (DEBE... + "#### Escenario:").
  let ospNote = null;
  if (!NO_INSTANCIA) {
    const sm = specsMod();
    if (sm) {
      const sv = sm.validateAll();
      for (const e of sv.errs) errs.push(`[specs] ${e}`);
      if (sv.warns.length) ospNote = `specs (rigor nativo): ${sv.warns.join(' · ')}`;
    }
  }
  // Git-flow: avisos NO bloqueantes (un template recien copiado aun no tiene develop; no debe romper CI).
  const flowWarns = [...avisosDeps];
  const flow = NO_INSTANCIA ? null : gitFlow(); // en modo template el ciclo develop/feature no aplica
  if (flow && !flow.develop) flowWarns.push("no existe la rama 'develop' (integracion) — crea el ciclo: git switch -c develop && git push -u origin develop.");
  if (flow && flow.onProtected) flowWarns.push(`estas en '${flow.branch}' (rama principal de solo-integracion): trabaja en develop o feature/<tema>; a la principal se llega por merge.`);
  if (flow && flow.unmerged && flow.unmerged.length) flowWarns.push(`features sin integrar en develop: ${flow.unmerged.join(', ')}.`);
  // NO se avisa de "develop lleva N commit(s) sin pasar a main": publicar es BAJO DEMANDA (main es el
  // RELEASE y puede agrupar varios ciclos), asi que no haber publicado NO es una deuda — es el estado
  // normal. El aviso venia del modelo viejo, cuando aprobar iba pegado a cada ciclo, y su lenguaje de
  // "pendiente" empujaba a publicar por quitarse el aviso de encima: justo lo que 0.37.0 quiso evitar.
  // La senal util no es CUANTOS commits llevas sin publicar, sino si lo acumulado esta APTO para
  // promocionar — y esa pregunta se responde cuando alguien la hace ('release', 'publicar'), no dando
  // la lata en cada validate. Ver el aviso de 'consolidar' (ESTADO: develop LISTO para publicar), que
  // solo aparece con el gate en verde y dice "puedes si quieres", no "deberias".
  if (ospNote) flowWarns.push(ospNote);
  // Tareas hechas sin cerrar / cerradas sin evidencia (#71): de la CACHE que deja el vigilante o el
  // ultimo consolidar — validate sigue siendo sincrono y sin red.
  avisosTareasDeCache().forEach((w) => flowWarns.push(`[tareas] ${w}`));
  // Worktrees de agentes (#251): sin .claude/worktrees/ en el .gitignore versionado aparecen como cambios sin seguimiento.
  try { if (require('./lib/worktrees.js').gitignoreFalta(ROOT)) flowWarns.push('[worktrees] falta .claude/worktrees/ en el .gitignore: node harness.js worktrees --ignorar'); } catch { /* el aviso es opcional */ }
  // Claves del gestor que ya no se usan (#218): un aviso, nunca un fallo.
  gestorAntiguoLines().forEach((w) => flowWarns.push(`[gestor] ${w.replace(/^ⓘ /, '')}`));
  // Registros estructurados de tareas (#149): solo si el repo los tiene (gestion/tareas/); sin ellos,
  // ni se carga el modulo. En fases cerradas solo cuentan los errores de estructura.
  if (fs.existsSync(path.join(ROOT, SP, 'tareas'))) {
    require('./lib/tareas-json.js').avisos(ROOT).forEach((w) => flowWarns.push(`[tareas-json] ${w}`));
    const _res = require('./lib/resumen-json.js').aviso(ROOT);
    if (_res) flowWarns.push(`[tareas-json] ${_res}`);
    const _idx = require('./lib/estado-indice.js').aviso(ROOT);
    if (_idx) flowWarns.push(`[estado-indice] ${_idx}`);
    const _rotas = require('./lib/navegacion.js').avisoRotas(ROOT);   // #157: enlaces rotos, nunca bloquea
    if (_rotas) flowWarns.push(`[referencias] ${_rotas}`);
  }
  // GUARDIANES de higiene (avisan, NO bloquean CI): cambios implementados sin archivar, fases
  // estancadas, riesgos con estado no reconocido. Higiene de gestion, no formato — no deben
  // tumbar un merge.
  if (!NO_INSTANCIA) {
    for (const s of listSpecs()) {
      if (s.fm.estado === 'implementada' && hasTasks(s.name)) {
        const prog = progressOf(tasksPath(s.name));
        const m = prog.match(/^(\d+)\/(\d+)/);
        if (m && m[1] === m[2] && m[2] !== '0') {
          const dias = Math.floor((Date.now() - s.mtime.getTime()) / 86400000);
          if (dias >= 7) flowWarns.push(`cambio '${s.name}' esta 'implementada' al 100% desde hace ${dias} dia(s) SIN ARCHIVAR — cierra el ciclo con /faro:archivar.`);
        }
      }
    }
    const iniStale = parseEstado();
    if (iniStale) {
      const activa = iniStale.fases.find((f) => isActive(f.estado));
      if (activa && activa.open > 0) {
        const last = lastCommitOf(ESTADO_FILE);
        const dias = last ? Math.floor((Date.now() - new Date(last.date).getTime()) / 86400000) : null;
        if (dias !== null && dias >= 14) {
          flowWarns.push(`Fase ${activa.num} (${activa.nombre}) tiene ${activa.open} tarea(s) abierta(s) y ${ESTADO_FILE} lleva ${dias} dia(s) sin actualizarse (ultimo cambio: ${last.author}) — revisa el estado real de la fase.`);
        }
      }
    }
    riskEstadoIssues().forEach((i) => flowWarns.push(`[riesgos] ${i}`));
    // RIA e ISO/IEC 42001 (#227): si ESTADO.md declara `ia:`; sin declaracion, sugiere la skill si el repo usa IA (#232). Lectura de texto, sin procesos ni red.
    try {
      const _ria = require('./lib/riesgos-ia.js').revisar({ estado: path.join(ROOT, ESTADO_FILE), riesgos: path.join(ROOT, SP, 'risks.md'), compliance: path.join(ROOT, SP, 'compliance'), raiz: ROOT, modo: ((faroSchema() || {}).enums || {}).ria?.modo });
      _ria.errores.forEach((e) => errs.push(`[ria] ${e}`));
      _ria.avisos.forEach((w) => flowWarns.push(`[ria] ${w}`));
    } catch { /* el aviso es opcional */ }
    // MONOREPO (#129): apps sin declarar, declaradas inexistentes, sin CLAUDE.md propio, o una
    // declaracion que incumple el contrato. Avisa: el workspace evoluciona antes que faro/config.json.
    require('./lib/apps.js').avisos(ROOT, { schema: faroSchema() }).forEach((w) => flowWarns.push(`[monorepo] ${w}`));
    require('./lib/tdd.js').validarConfig(ROOT, { schema: faroSchema() }).forEach((w) => flowWarns.push(`[tdd] ${w}`));
    // TESTS POR DOMINIO (#178): config mal formada, codigo sin dominio y dominios cuyo test depende de otro.
    try { const D = require('./lib/dominios.js'); [...D.validarConfig(ROOT), ...D.avisosCobertura(ROOT)].forEach((w) => flowWarns.push(`[tests] ${w}`)); } catch { /* el aviso es opcional */ }
    require('./lib/alcance.js').validarConfig(ROOT, { schema: faroSchema() }).forEach((w) => flowWarns.push(`[alcance] ${w}`));
    // FUERA DE ALCANCE del funcional: el contrato del tipo FUN ya lo exige como seccion, pero nadie
    // comprobaba que estuviera RELLENA — un encabezado con nada debajo pasaba. Es el unico criterio
    // escrito para descartar peticiones con fundamento, asi que sin el todo lo que llegue queda sin
    // decidir. Avisa (no bloquea): el funcional se escribe con el usuario, no se exige de golpe.
    try {
      const _fp = funcionalPath();
      if (_fp) {
        const _av = require('./lib/triaje.js').faltaFueraDeAlcance(fs.readFileSync(path.join(ROOT, _fp), 'utf8'), _fp);
        if (_av) flowWarns.push(`[alcance] ${_av}`);
      }
    } catch { /* sin funcional legible: ya avisa el harness por otro lado */ }
    const _adr = adrIssues();
    _adr.forEach((i) => flowWarns.push(`[decisiones] ${i}`));
    // Los ADR NUEVOS incompletos tumban validate: es lo unico que impide que la deuda de criterio
    // siga creciendo. Los anteriores al corte solo avisan (van en la lista de arriba).
    (_adr.bloqueantes || []).forEach((i) => errs.push(`[decisiones] ${i}`));
    // TRAZABILIDAD de requisitos (RTM ligera): red del gestor tecnico — avisa, no tumba un merge.
    trazabilidadWarns().forEach((w) => flowWarns.push(`[requisitos] ${w}`));
    const sinDigerir = fuentesSinDigerir();
    if (sinDigerir.length) flowWarns.push(`[digestion] ${sinDigerir.length} fuente(s) sin digerir (posteriores al funcional/${ESTADO_FILE}): ${sinDigerir.slice(0, 3).map((f) => f.rel).join(', ')}${sinDigerir.length > 3 ? ' …' : ''} — lanza la digestion (leer, extraer requisitos/decisiones/riesgos, actualizar funcional + registro).`);
    // description en docs controlados: RECOMENDADA, no bloquea (los ~docs ya emitidos no se rompen;
    // los nuevos la traen por directiva). Ayuda a inventario, enrutado y catalogo externo.
    const _ctrl = docsControlados();
    const sinDesc = _ctrl.filter((d) => !d.fm.description);
    if (sinDesc.length) flowWarns.push(`[docs] ${sinDesc.length} documento(s) sin 'description:' (una linea de que va, <=160 car.): ${sinDesc.slice(0, 4).map((d) => d.id).join(', ')}${sinDesc.length > 4 ? ' …' : ''} — anadela al actualizar cada doc.`);
    // description DEMASIADO LARGA: la portada del entregable la recorta a 3 lineas -> avisar para
    // que se resuma (es un resumen de una linea, no un parrafo).
    const descLarga = _ctrl.filter((d) => d.fm.description && String(d.fm.description).length > 160);
    if (descLarga.length) flowWarns.push(`[docs] 'description:' demasiado larga (>160 car.; la portada la recorta): ${descLarga.slice(0, 4).map((d) => d.id).join(', ')}${descLarga.length > 4 ? ' …' : ''} — resumela en UNA frase.`);
  }
  // HEXAGONAL (#280): declarada en ARCHITECTURE.md -> sus violaciones bloquean el gate; sin declarar
  // en un repo con codigo -> aviso con el plan. Un repo documental (sin ARCHITECTURE.md) no oye nada.
  if (!NO_INSTANCIA) {
    const _og = opcionesGates();
    hexagonalEnValidate(errs, flowWarns, _og.gates || _og.todas || _og.apps.length > 0);
  }
  const flowBlock = flowWarns.length ? `\nAvisos (NO bloquean CI):\n${flowWarns.map((w) => `- ${w}`).join('\n')}\n` : '';
  if (errs.length) {
    process.stdout.write(`VALIDACION: ${errs.length} error(es)\n${errs.map((e) => `- ${e}`).join('\n')}\n${notaGates}${flowBlock}`);
    process.exit(1);
  }
  process.stdout.write(`VALIDACION OK: faseo, funcional, nombrado y frontmatter de specs en regla.\n${notaGates}${flowBlock}`);
}

// Alcance de los gates POR APP (#130), de la linea de comandos de 'gates' y 'validate':
// --todas (bateria completa: lo que pasan consolidar y publicar) o --app <id> (repetible o 'a,b').
// Sin nada, las apps afectadas por el cambio. En un repo simple no cambia nada.
function opcionesGates() {
  const a = process.argv.slice(3);
  const apps = [];
  for (let i = 0; i < a.length; i++) if (a[i] === '--app' && a[i + 1]) apps.push(...a[++i].split(',').map((x) => x.trim()).filter(Boolean));
  // #182: --sin-cache ignora los verdes guardados; --simulacro fuerza `wrangler deploy --dry-run` (por defecto solo al publicar o si el cambio afecta al despliegue).
  return { todas: a.includes('--todas'), gates: a.includes('--gates'), apps, sinCache: a.includes('--sin-cache') || process.env.FARO_SIN_CACHE === '1', simulacro: a.includes('--simulacro') };
}

// Apps del monorepo con codigo propio (apps/<x>/src). [] en un repo simple. Memo: validate lo
// pregunta una vez por cambio (#132).
let _appsConCodigo;
function appsConCodigo() {
  if (_appsConCodigo) return _appsConCodigo;
  const ap = require('./lib/apps.js');
  _appsConCodigo = ap.esMonorepo(ROOT)
    ? ap.apps(ROOT, { schema: faroSchema() }).filter((a) => a.ruta && fs.existsSync(path.join(ROOT, a.ruta, 'src')))
    : [];
  return _appsConCodigo;
}

// APPS del monorepo (#129): que apps hay, que es cada una (rol declarado) y que se deduce de su
// carpeta (worker, front, contrato, changelog, tests). La logica vive en lib/apps.js, que es lo que
// consultan gates/release/skills por app; aqui solo se presenta. CLI: harness.js apps [--json].
function cmdApps() {
  const ap = require('./lib/apps.js');
  const schema = faroSchema();
  const declarado = ap.esMonorepo(ROOT);
  const ws = ap.workspace(ROOT);
  const lista = ap.apps(ROOT, { schema });
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ monorepo: declarado, workspace: ws, tag: (ap.leerConfig(ROOT) || {}).tag || ap.TAG_DEFECTO, apps: lista }, null, 2) + '\n');
    return;
  }
  if (!declarado && !lista.length) {
    process.stdout.write(`Este repo no es un monorepo: sin "monorepo" en ${CONFIG_FILE} ni workspace (pnpm-workspace.yaml / workspaces de package.json).\n`);
    return;
  }
  const out = [`APPS — ${declarado ? `monorepo declarado en ${CONFIG_FILE}` : `monorepo SIN declarar en ${CONFIG_FILE}`}${ws.fuente ? ` · workspace: ${ws.fuente}` : ''}`];
  for (const a of lista) {
    const quien = a.paquete ? ` · ${a.paquete}${a.version ? `@${a.version}` : ''}` : '';
    const ras = ap.rasgosTexto(a);
    const rol = a.rol ? a.rol : (a.tipo === 'paquete' ? 'paquete compartido' : 'rol sin declarar');
    const donde = a.existe ? a.ruta : 'NO EXISTE en el workspace';
    out.push(`- ${a.id} (${donde}) — ${rol}${quien}${ras ? ` · ${ras}` : ''}${a.equipo ? ` · equipo ${a.equipo}` : ''}`);
  }
  if (!declarado) out.push('', `Para activar el modo monorepo, declara las apps en ${CONFIG_FILE} > "monorepo": { "apps": { "<app>": { "rol": "<una frase>", "funcional": "<doc_id>", "equipo": "<team>" } }, "tag": "{app}@{version}" }.`);
  process.stdout.write(out.join('\n') + '\n');
}

// harness.js codeowners [--comprobar] (#134): .github/CODEOWNERS por app (equipo de faro/config.json =
// team de la org) y .github/labeler.yml (actions/labeler v7: app:<id> si el PR toca apps/<id>/**).
// Bloque marcado e idempotente: lo manual no se toca. Ver lib/apps-forja.js.
function cmdCodeowners() {
  const f = forgeInfo();
  if (f.forge !== 'desconocida' && !FORGE.capacidades(f.forge).codeowners) { console.log(`codeowners: CODEOWNERS de GitHub y actions/labeler son de GitHub; esta forja es ${f.forge}. Nada que generar.`); return; }
  const code = require('./lib/apps-forja.js').cmdCodeowners(ROOT, { org: f.owner || null, schema: faroSchema(), comprobar: process.argv.includes('--comprobar') });
  if (code) process.exit(code);
}

// harness.js monorepo init|importar (#161, #162): convertir un repo simple en monorepo, nacer
// preparado o importar repos existentes como apps. Dry-run por defecto; --confirmo aplica. La logica
// vive en lib/monorepo*.js; aqui solo se cablea con la forja (org de la sesion, etiquetas, CODEOWNERS).
function ctxMonorepo() {
  const f = forgeInfo();
  const af = require('./lib/apps-forja.js');
  const m = forjaMod();
  const ensureLabels = m ? async (lista) => {
    const hechas = [];
    for (const a of lista) { const n = await m.asegurarEtiquetaApp(a.id, a.rol ? `App ${a.id}: ${a.rol}`.slice(0, 100) : null); if (n) hechas.push(n); }
    return hechas;
  } : null;
  return {
    root: ROOT, schema: faroSchema(), org: f.owner || null, ensureLabels,
    codeownersFn: () => af.cmdCodeowners(ROOT, { org: f.owner || null, schema: faroSchema() }),
  };
}
async function cmdMonorepo() {
  const code = await require('./lib/monorepo.js').cli(process.argv.slice(3), ctxMonorepo());
  if (code) process.exit(code);
}

// harness.js app nueva <id> --plantilla <repo> --rol "<frase>" (#216): instanciar una app del monorepo
// desde una plantilla de la organizacion. Logica en lib/app-nueva.js; mismo cableado que monorepo.
async function cmdApp() {
  const code = await require('./lib/app-nueva.js').cli(process.argv.slice(3), ctxMonorepo());
  if (code) process.exit(code);
}

// harness.js ficha <N> [--json] (#134): ficha autocontenida (< 2.000 tokens) del issue para el
// subagente implementador: issue + app y sus rasgos + cambio spec-driven vinculado + rutas.
async function cmdFicha() {
  const num = String(process.argv[3] || '').replace(/^#/, '');
  if (!/^\d+$/.test(num)) { console.log('Uso: node .claude/hooks/harness.js ficha <numero-issue> [--json]'); process.exit(1); }
  const fi = require('./lib/ficha.js');
  const ap = require('./lib/apps.js');
  const m = forjaMod();
  if (!m) { SIN_FORJA('ficha'); return; }
  const r = await m.leerIssue(num);
  if (r.sinToken) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth.'); process.exit(2); }
  if (!r.ok || !r.body) { console.log(`No pude leer el issue #${num} (HTTP ${r.status}).`); process.exit(1); }
  const issue = fi.normalizarIssue(r.body);
  const schema = faroSchema();
  const lista = ap.apps(ROOT, { schema });
  const ids = fi.appsDeEtiquetas(issue.etiquetas);
  const apps = lista.filter((a) => ids.includes(a.id));
  const appsDesconocidas = ids.filter((id) => !lista.some((a) => a.id === id));
  const slug = fi.buscarCambio(ROOT, SPEC_BASE, issue.numero, issue.cuerpo);
  const cambio = slug ? fi.resumenCambio(ROOT, SPEC_BASE, slug) : null;
  const txt = fi.componerFicha({ issue, apps, appsDesconocidas, cambio, monorepo: ap.esMonorepo(ROOT) });
  if (process.argv.includes('--json')) { process.stdout.write(JSON.stringify({ issue: issue.numero, apps: apps.map((a) => a.id), cambio: slug, tokens: fi.estimarTokens(txt), ficha: txt }, null, 2) + '\n'); return; }
  process.stdout.write(txt + '\n');
}

// Panel de promocion para quien APRUEBA: features pendientes de integrar en develop (responsable + resumen)
// y develop pendiente de aprobar a main (por autor, a quien preguntar). CLI: harness.js pendientes.
function cmdPendientes() {
  const flow = gitFlow();
  if (!flow) { process.stdout.write('Sin repo git.\n'); return; }
  const lines = ['PANEL DE PROMOCION (para quien tiene permisos de merge):'];
  if (!flow.develop) lines.push("- No existe 'develop' todavia (crea el ciclo primero).");
  else if (!flow.unmerged.length) lines.push('- Features pendientes de integrar en develop: ninguna.');
  else {
    lines.push('Features SIN integrar en develop:');
    for (const f of flow.unmerged) {
      const who = git('log', '-1', '--format=%an', f) || '?';
      const n = git('rev-list', '--count', `develop..${f}`) || '?';
      const subs = (git('log', '--format=%s', '-3', `develop..${f}`) || '').split('\n').filter(Boolean).join(' · ');
      lines.push(`- ${f} · responsable: ${who} · ${n} commit(s)${subs ? ` · ${subs}` : ''}`);
    }
  }
  if (flow.mainName && flow.aheadOfMain > 0) {
    lines.push('', `Develop pendiente de PUBLICAR a ${flow.mainName} (${flow.aheadOfMain} commit(s)) — por autor:`);
    const raw = git('log', '--format=%an|%s', `${flow.mainName}..develop`) || '';
    const byAuthor = new Map();
    raw.split('\n').filter(Boolean).forEach((l) => { const p = l.indexOf('|'); const an = l.slice(0, p); if (!byAuthor.has(an)) byAuthor.set(an, []); byAuthor.get(an).push(l.slice(p + 1)); });
    for (const [an, subs] of byAuthor) lines.push(`- ${an} (${subs.length}): ${subs.slice(0, 4).join(' · ')}${subs.length > 4 ? ` (+${subs.length - 4} mas)` : ''}`);
    lines.push(`Publicar (quien tenga permiso): /faro:publicar — valida el ciclo, propone version, tagea y publica.`);
  } else if (flow.mainName) lines.push('', `Develop -> ${flow.mainName}: al dia (nada pendiente de publicar).`);
  process.stdout.write(lines.join('\n') + '\n');
}

// Genera el ID de documento: CLAVE-TIPO-NNN. CLAVE = clave corta del repo (o derivada del nombre);
// NNN = siguiente correlativo de ese tipo escaneando documentos/ y gestion/. Uso: harness.js docref <TIPO>.
function cmdDocRef() {
  // Formato CORTO estilo Jira (decision 2026-07-29): CLAVE-TIPO-NNN, SIN prefijo de organizacion
  // (alargaba sin aportar: el repo ya define la org). DOC_ORG queda como prefijo OPCIONAL via env,
  // para quien lo quiera explicito.
  const org = process.env.DOC_ORG || '';
  const tipo = String(process.argv[3] || 'DOC').toUpperCase().replace(/[^A-Z]/g, '') || 'DOC';
  const ini = parseEstado();
  let raw = ini && ini.fm.iniciativa ? ini.fm.iniciativa : path.basename(ROOT);
  // Issue #1: normalizar diacriticos ANTES de filtrar (Transformación -> TRANSFORMACION, nunca
  // TRANSFORMACIN) — mismo patron NFD que ya usa la normalizacion de estados.
  raw = String(raw).normalize('NFD').replace(/[̀-ͯ]/g, '');
  // CLAVE DE PROYECTO corta, estandar de industria (estilo Jira, 2-10 letras, declarada UNA vez).
  // Prioridad: 'clave:'/'key:' del frontmatter de ESTADO.md (ya validada a 2-10 por claveValida al
  // fijarla con 'harness.js clave' — NO se trunca aqui); sin clave declarada, se DERIVA por siglas
  // de las palabras significativas (sin articulos), y con una sola palabra, sus 6 primeras letras.
  // Los doc_id legados (ORG-CLAVE-TIPO-NNN) siguen siendo validos — series independientes.
  let proj = String((ini && (ini.fm.clave || ini.fm.key)) || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
  if (!proj) {
    const STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'o', 'u', 'a', 'e', 'en', 'para', 'por', 'con', 'sin', 'al', 'un', 'una', 'the', 'of', 'and', 'for', 'to']);
    const words = raw.split(/[^a-zA-Z0-9]+/).filter(Boolean).filter((w) => !STOP.has(w.toLowerCase()));
    proj = (words.length >= 2 ? words.map((w) => w[0]).join('') : (words[0] || 'INI'));
    proj = proj.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'INI';
  }
  const pre = org ? `${org}-` : '';
  const re = new RegExp(`doc_id:\\s*${pre}${proj}-${tipo}-(\\d+)`, 'i');
  let max = 0;
  for (const dir of [DOCS, SP]) {
    for (const f of walkFiles(dir)) {
      if (!/\.md$/.test(f.name)) continue;
      let t = ''; try { t = fs.readFileSync(path.join(ROOT, f.rel), 'utf8'); } catch {}
      const g = new RegExp(re.source, 'ig'); let m;
      while ((m = g.exec(t))) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    }
  }
  process.stdout.write(`${pre}${proj}-${tipo}-${String(max + 1).padStart(3, '0')}\n`);
}

// tipo: TODO lo que hace falta para escribir un documento de ese tipo, desde el CONTRATO UNICO
// (faro-schema.json). Antes esto vivia repartido: la cabecera repetida en 33 plantillas .md, la
// carpeta destino en CLAUDE.md, el criterio en la cabeza de quien lo hubiera hecho antes. Cambiar
// un campo obligaba a tocar 33 ficheros y los repos ya creados ni se enteraban.
// Ahora: una entrada en el schema -> llega a todos los repos por autoUpdate. Y como el harness
// VALIDA contra ese mismo schema, la instruccion y la validacion no pueden divergir.
function cmdTipo() {
  const s = faroSchema();
  const tipos = (s && s.enums && s.enums.tipos_documento) || [];
  const arg = String(process.argv[3] || '').trim().toUpperCase();
  // SIN argumento -> CATALOGO: que tipos existen y para que sirve cada uno, agrupados por ambito.
  // Es el primer nivel: el agente ve el abanico y ELIGE con el usuario. Despues pide el detalle de
  // uno concreto (segundo nivel) y escribe con esa guia. Sin esto, el agente elegiria de memoria.
  if (!arg) {
    const porAmbito = new Map();
    for (const t of tipos) {
      const a = t.ambito || 'otros';
      if (!porAmbito.has(a)) porAmbito.set(a, []);
      porAmbito.get(a).push(t);
    }
    const out = ['CATALOGO de tipos de documento (contrato: faro-schema.json)', ''];
    for (const [amb, lista] of porAmbito) {
      out.push(amb.toUpperCase());
      for (const t of lista) {
        const guia = t.instrucciones ? (t.instrucciones.cuando || '') : (t.estandar ? `estandar: ${t.estandar}` : '');
        const corta = guia.length > 96 ? guia.slice(0, 93).replace(/\s+\S*$/, '') + '…' : guia;
        out.push(`  ${t.codigo.padEnd(5)} ${t.nombre}${corta ? ` — ${corta}` : ''}${t.instrucciones ? '' : '  [sin guia detallada]'}`);
      }
      out.push('');
    }
    out.push('Detalle de uno (secciones, criterio, errores, frontmatter):  harness.js tipo <CODIGO>');
    process.stdout.write(out.join('\n') + '\n');
    return;
  }
  const t = tipos.find((x) => x.codigo === arg);
  if (!t) { process.stdout.write(`TIPO_DESCONOCIDO: '${arg}' no esta en faro-schema.json. Tipos validos: ${tipos.map((x) => x.codigo).join(' ')}\n`); process.exit(2); }

  const out = [];
  out.push(`${t.codigo} · ${t.nombre}${t.ambito ? ` (ambito ${t.ambito})` : ''}`);
  if (t.estandar) out.push(`Estandar de industria: ${t.estandar}`);
  if (t.subtipos) out.push(`Subtipos: ${t.subtipos.join(' · ')} — elige UNO con el usuario, no asumas.`);
  const carpeta = PATHS.ruta(t.carpeta || `documentos/<tema>/`);   // #293: segun el layout
  out.push(`Carpeta: ${carpeta}`);

  // HERENCIA: la guia sale de la FAMILIA (como funciona / que debe hacer / por que asi...), y el
  // tipo solo anade lo suyo si lo declara. Asi 5-8 guias buenas cubren los 37 tipos, en vez de 37
  // fichas que nadie mantiene. Lo propio del tipo MANDA sobre lo heredado.
  const familias = (s.enums && s.enums.familias_documento) || {};
  const f = t.familia ? familias[t.familia] : null;
  const i = Object.assign({}, f || {}, t.instrucciones || {});
  if (f) out.push('', `FAMILIA: ${t.familia} — ${f.pregunta}`);
  if (i.cuando) out.push('', 'CUANDO SE USA', '  ' + i.cuando);
  if (i.secciones) out.push('', 'SECCIONES', ...i.secciones.map((x) => '  - ' + x));
  if (i.criterio) out.push('', 'CRITERIO', '  ' + i.criterio);
  if (i.diagramas) out.push('', 'DIAGRAMAS (Mermaid, dentro del MD)', '  ' + i.diagramas);
  if (i.errores) out.push('', 'ERRORES TIPICOS', ...i.errores.map((x) => '  - ' + x));
  if (!f && !t.instrucciones) out.push('', `(Sin familia ni guia declarada. Sigue el estandar indicado y el frontmatter comun.)`);

  const fm = (s.enums && s.enums.frontmatter_comun) || null;
  if (fm) {
    out.push('', 'FRONTMATTER (copia LITERAL — lo valida el harness)');
    out.push('  Obligatorios: ' + (fm.obligatorios || []).join(', '));
    if (fm.doc_id) out.push(`  doc_id: ${fm.doc_id.formato} — generalo con: harness.js docref ${t.codigo}` + (fm.doc_id.nota ? `\n    ${fm.doc_id.nota}` : ''));
    if (fm.version) out.push(`  version: ${fm.version.formato}. ${fm.version.nota || ''}`);
    if (fm.status) out.push(`  status: ${(fm.status.valores || []).join(' | ')}. ${fm.status.nota || ''}`);
    if (fm.opcionales && fm.opcionales.length) out.push('  Opcionales: ' + fm.opcionales.join(', '));
    if (fm.nombre_fichero) out.push(`  Fichero: ${fm.nombre_fichero}`);
    // Los tres roles NO son el mismo dato ni llevan el mismo identificador: quien redacta trabaja
    // en el repo (login), quien pide suele ser de negocio y no tiene cuenta (correo corporativo).
    if (fm.roles) {
      out.push('', 'PERSONAS (no se inventan: si aplica y no se sabe, PREGUNTA)');
      for (const [rol, r] of Object.entries(fm.roles)) {
        if (rol.startsWith('_')) continue;
        out.push(`  ${rol}${r.obligatorio ? '' : ' (opcional)'}: ${r.que}`);
        out.push(`    identificador: ${r.identificador}${r.obtener ? ` · ${r.obtener}` : ''}`);
        if (r.nota) out.push(`    ${r.nota}`);
      }
      if (fm.roles._regla) out.push('  ' + fm.roles._regla);
    }
  }
  process.stdout.write(out.join('\n') + '\n');
}

// plantilla: resuelve la RUTA de la plantilla de un tipo (lookup rapido para el redactor; las plantillas
// se agrupan por AMBITO en documentos/plantillas/<ambito>/). Uso:
//   harness.js plantilla <TIPO>   -> imprime la ruta (avisa si falta el fichero)
//   harness.js plantilla --list   -> catalogo por ambito (codigo · nombre · ruta)
function cmdPlantilla() {
  const s = faroSchema();
  const tipos = (s && s.enums && s.enums.tipos_documento) || [];
  const arg = String(process.argv[3] || '').trim();
  if (!arg || arg === '--list' || arg === '-l') {
    const orden = ['producto', 'operaciones', 'gobierno', 'negocio', 'gestion', 'otros'];
    const byAmbito = {};
    for (const t of tipos) { const a = t.ambito || 'otros'; (byAmbito[a] = byAmbito[a] || []).push(t); }
    const ambitos = Object.keys(byAmbito).sort((x, y) => (orden.indexOf(x) < 0 ? 99 : orden.indexOf(x)) - (orden.indexOf(y) < 0 ? 99 : orden.indexOf(y)));
    const out = ['Catalogo de plantillas por ambito (documentos/plantillas/<ambito>/):'];
    for (const a of ambitos) {
      out.push(`\n[${a}]`);
      for (const t of byAmbito[a]) out.push(`  ${String(t.codigo).padEnd(5)} ${String(t.nombre || '').slice(0, 44).padEnd(44)} ${t.plantilla || '(sin plantilla)'}`);
    }
    process.stdout.write(out.join('\n') + '\n');
    return;
  }
  const tipo = arg.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const def = tipos.find((t) => String(t.codigo).toUpperCase() === tipo);
  if (!def) { process.stdout.write(`Tipo '${tipo}' no existe en faro-schema.json. Tipos: ${tipos.map((t) => t.codigo).join(', ')}\n`); process.exit(1); }
  // Los esqueletos .md por tipo se retiraron del template (0.7.x): la guia la da el CONTRATO por
  // FAMILIA, que no envejece en cada repo. Si el repo conserva una plantilla propia se sigue usando;
  // si no, se redirige a 'tipo', que es donde esta ahora la estructura y el criterio.
  const plantilla = def.plantilla ? PATHS.ruta(def.plantilla) : null;   // #293: documentos/ o faro/documentos/
  const local = plantilla ? path.join(ROOT, plantilla) : null;
  if (!def.plantilla || (local && !/<subtipo>/.test(plantilla) && !fs.existsSync(local))) {
    process.stdout.write(`${tipo} (${def.nombre}) no usa esqueleto: la estructura y el criterio los da el contrato.\n  node .claude/hooks/harness.js tipo ${tipo}\n${def.familia ? `  familia: ${def.familia}\n` : ''}`);
    return;
  }
  if (/<subtipo>/.test(plantilla)) {
    // Solo se listan las que EXISTEN en el repo (personalizadas). Marcar como [FALTA] las que ya
    // no se distribuyen mandaba a crear ficheros que el modelo por familias hizo innecesarios.
    const subs = (def.subtipos || []).map((x) => plantilla.replace('<subtipo>', x)).filter((r) => fs.existsSync(path.join(ROOT, r)));
    if (!subs.length) {
      process.stdout.write(`${def.codigo} (${def.nombre}) no usa esqueleto: la estructura y el criterio los da el contrato.\n  node .claude/hooks/harness.js tipo ${def.codigo}\n${def.familia ? `  familia: ${def.familia}\n` : ''}${def.subtipos ? `  subtipos: ${def.subtipos.join(' · ')} — elige UNO con el usuario\n` : ''}`);
      return;
    }
    process.stdout.write(`${def.codigo} (${def.nombre}) · plantillas propias de este repo:\n${subs.map((r) => '  ' + r).join('\n')}\n`);
    return;
  }
  const falta = !fs.existsSync(path.join(ROOT, plantilla)) ? '  [FALTA EL FICHERO]' : '';
  process.stdout.write(`${plantilla}${falta}\n`);
}

// Identidad CANONICA por EMAIL (estable; el nombre es fragil: mismo autor con dos nombres
// se parte, dos personas con el mismo nombre se mezclan). El noreply de GitHub
// (id+login@users.noreply.github.com) encierra el login -> lo extraemos como identidad fiable.
function canonId(email, name) {
  const e = String(email || '').trim().toLowerCase();
  const m = e.match(/^(?:\d+\+)?([a-z0-9-]+)@users\.noreply\.github\.com$/);
  const gh = m ? m[1] : null;
  return { key: gh || e || String(name || '').trim(), email: e || null, name: String(name || '').trim() || e || gh || '?', gh };
}

// Estadisticas de conocimiento por usuario git: quien ha tocado que area documental,
// quien aprueba specs y quien cierra tareas. Heuristica transparente, no verdad absoluta:
// senala al "referente" probable (a quien preguntar), no mide calidad. Identidad por EMAIL.
function cmdStats() {
  if (!gitInfo()) { process.stdout.write('Sin repo git: no hay estadisticas.\n'); return; }
  const AREAS = [
    ['cambios', new RegExp(`^${SPEC_BASE}/`)],
    ['decisiones', new RegExp(`^(?:${SP}|superpowers)/decisions/`)],
    ['informes', new RegExp(`^(?:${INFORMES}|${SP}/informes|superpowers/informes)/`)],
    ['docs', new RegExp(`^(?:${DOCS}|docs)/`)],
    ['tecnico', new RegExp(`^(?:${FLOWS}|flow|${SRC}|resources)/`)],
    ['presentaciones', new RegExp(`^(?:${PRESENTACIONES}|${SP}/presentaciones|superpowers/presentaciones)/`)],
    ['estado', /^(ESTADO|INICIATIVA)\.md$/],
  ];
  const raw = git('log', '--format=@@%an|%ae', '--name-only') || '';
  const authors = new Map();
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) {
      const [nm, em] = line.slice(2).split('|');
      const id = canonId(em, nm);
      if (!authors.has(id.key)) authors.set(id.key, { commits: 0, areas: {}, name: id.name, email: id.email, gh: id.gh });
      cur = authors.get(id.key);
      cur.commits += 1;
    } else if (line.trim() && cur) {
      const f = line.trim().replace(/^"|"$/g, '');
      for (const [area, re] of AREAS) {
        if (re.test(f)) { cur.areas[area] = (cur.areas[area] || 0) + 1; break; }
      }
    }
  }
  const aprobaciones = {};
  for (const s of listSpecs()) {
    if (s.fm.aprobada_por) aprobaciones[s.fm.aprobada_por] = (aprobaciones[s.fm.aprobada_por] || 0) + 1;
  }
  const ini = parseEstado();
  const owned = {}; const ownedDone = {};
  if (ini) {
    for (const f of ini.fases) {
      for (const t of f.tareas) {
        if (!t.owner) continue;
        owned[t.owner] = (owned[t.owner] || 0) + 1;
        if (t.done) ownedDone[t.owner] = (ownedDone[t.owner] || 0) + 1;
      }
    }
  }
  const rows = [...authors.values()].map((a) => {
    const A = (k) => a.areas[k] || 0;
    const apr = aprobaciones[a.name] || 0;   // aprobaciones/owner se declaran por NOMBRE (@handle)
    const done = ownedDone[a.name] || 0;
    // score = 3x(cambios+decisiones+docs) + 2x(informes+aprobaciones+tareas cerradas) + 1x commits
    const score = 3 * (A('cambios') + A('decisiones') + A('docs')) + 2 * (A('informes') + apr + done) + a.commits;
    return { name: a.name, email: a.email, gh: a.gh, a, apr, owned: owned[a.name] || 0, done, score };
  }).sort((x, y) => y.score - x.score);
  const lines = [
    `ESTADISTICAS DE CONOCIMIENTO POR USUARIO GIT · ${(ini && ini.fm.iniciativa) || 'iniciativa'}`,
    'score = 3x(toques specs+decisiones+funcional) + 2x(informes+aprobaciones de spec+tareas cerradas como owner) + 1x commits',
    '',
    ...rows.map((r) => {
      const A = (k) => r.a.areas[k] || 0;
      const who = r.gh ? `${r.name} (@${r.gh})` : `${r.name}${r.email ? ` <${r.email}>` : ''}`;
      return `- ${who} · score ${r.score} · commits ${r.a.commits} · cambios ${A('cambios')} · decisiones ${A('decisiones')} · docs ${A('docs')} · informes ${A('informes')} · tecnico ${A('tecnico')} · aprobaciones ${r.apr} · tareas owner ${r.done}/${r.owned}`;
    }),
  ];
  if (rows.length) {
    lines.push('', `Referente probable de la iniciativa: ${rows[0].name}${rows[0].gh ? ` (@${rows[0].gh})` : ''} (mayor contribucion documental; a quien preguntar primero).`);
  }
  // Validacion de identidad del usuario ACTUAL: su git email vs su cuenta GitHub (para que su trabajo SE LE ATRIBUYA).
  const myEmail = String(git('config', 'user.email') || '').trim().toLowerCase();
  if (myEmail) {
    const myId = canonId(myEmail, git('config', 'user.name') || '');
    // La cuenta se lee de la CREDENCIAL guardada para el host de este repo (harness.js auth), en las
    // dos forjas. Antes se preguntaba al CLI 'gh': GitHub-only y prohibido por el propio motor.
    const fj = forgeInfo();
    const nombreForja = FORGE.nombreForja(fj.forge);
    let cuenta = null;
    try { const gh = ghMod(); const e = gh && gh.CRED && fj.host ? gh.CRED.entrada(fj.host) : null; cuenta = (e && e.user) || null; } catch {}
    if (!cuenta && fj.forge === 'github') { try { cuenta = ghMod().cachedUser(); } catch {} }
    const ghLogin = cuenta && cuenta.login;
    const ghEmail = String((cuenta && cuenta.email) || '').toLowerCase();
    lines.push('');
    if (!ghLogin) lines.push(`Identidad: git email ${myEmail}. (Sin credencial guardada para ${fj.host || 'este host'} -> no se valida el match con ${nombreForja}; conecta con harness.js auth.)`);
    else if (myId.gh && myId.gh === String(ghLogin).toLowerCase()) lines.push(`Identidad OK: tus commits (${myEmail}) se atribuyen a @${ghLogin} en ${nombreForja}.`);
    else if (ghEmail && ghEmail === myEmail) lines.push(`Identidad OK: tu git email coincide con tu cuenta de ${nombreForja} (@${ghLogin}).`);
    else lines.push(`⚠ Identidad: commiteas como ${myEmail} pero tu cuenta en ${nombreForja} es @${ghLogin}${ghEmail ? ` (email ${ghEmail})` : ''} -> puede que NO se te atribuya. Ajusta: git config user.email <email-de-tu-cuenta>.`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

// Linea de estado permanente en el terminal (statusLine): iniciativa · fase · rama · alertas.
function cmdStatusLine() {
  const ini = parseEstado();
  const g = gitInfo();
  const parts = [];
  if (ini && ini.fases.length) {
    parts.push(ini.fm.iniciativa || 'iniciativa');
    const actual = ini.fases.find((f) => isActive(f.estado));
    if (actual) {
      let seg = `F${actual.num} ${actual.nombre} ${actual.done}/${actual.done + actual.open}`;
      if (actual.objetivo) {
        const dias = Math.round((new Date(actual.objetivo) - Date.now()) / 86400000);
        seg += dias < 0 ? ` ⏰+${-dias}d` : ` ⏳${dias}d`;
      }
      parts.push(seg);
    }
  } else {
    parts.push('sin ' + ESTADO_FILE);
  }
  if (g) {
    const ramaFueraDeFlujo = !NO_INSTANCIA && !isProtected(g.branch) && g.branch !== 'develop' && !WORK_BRANCH_RE.test(g.branch);
    parts.push(`⎇ ${g.branch}${ramaFueraDeFlujo ? ' ⚠fuera de flujo' : ''}${g.dirty ? ` +${g.dirty}` : ''}`);
  }
  const risks = openRisksCount();
  if (risks) parts.push(`⚠${risks} riesgos`);
  const { errs } = validateEstado();
  if (errs.length) parts.push(`FASEO ✗${errs.length}`);
  process.stdout.write(parts.join(' · '));
}

// estado-json: exporta el estado COMPLETO como JSON derivado para integraciones externas
// (dashboards, catalogos, cualquier sistema — agnostico al cual). La fuente de verdad sigue
// siendo el markdown (ESTADO.md legible, diffs revisables en PR); el JSON es una VISTA
// generada, nunca se edita a mano.
// `tarea migrar` / `tarea sync`: lee la forja con ghApi/ghRepo del motor (GitHub); sin token o en otra forja trabaja offline.
async function cmdTareaMigrar() {
  const sub = process.argv[3];
  if (sub !== 'migrar' && sub !== 'sync') { console.error('uso: harness.js tarea <id> | validar | set | migrar | sync'); process.exitCode = 1; return; }
  let gh = null;
  const fj = forgeInfo();
  if (FORGE.capacidades(fj.forge).tareasSync) { const m = ghMod(); if (m && m.ghApi && m.ghRepo) gh = { ghApi: m.ghApi, ghRepo: m.ghRepo }; }
  else { const motivo = FORGE.sinCapacidad(fj.forge, 'tareasSync'); if (motivo) console.log(motivo.join('\n')); }
  const modulo = sub === 'sync' ? './lib/tarea-sync.js' : './lib/tareas-migracion.js';
  process.exitCode = await require(modulo).cli(ROOT, process.argv.slice(4), { gh });
}
function cmdEstadoJson() {
  const ini = parseEstado();
  const c = clasificacion();
  const g = gitInfo();
  const out = {
    archivo: ESTADO_FILE,
    nombre: (ini && ini.fm.iniciativa) || null,
    concepto: c.concepto,
    domain: c.domain,
    estado: (ini && ini.fm.estado) || null,
    fase_actual: ini ? (Number.parseInt(ini.fm.fase_actual, 10) || null) : null,
    fases: ini ? ini.fases.map((f) => ({
      num: f.num, nombre: f.nombre, estado: f.estado, objetivo: f.objetivo, descripcion: f.descripcion, clickup: f.cuid,
      tareas: f.tareas.map((x) => ({ texto: x.text, hecha: x.done, owner: x.owner, clickup: x.cuid })),
    })) : [],
    kpis: (parseKpis() || []).map((k) => ({ id: k.id, nombre: k.nombre, ...k.campos, mediciones: k.mediciones })),
    requisitos: (parseRequisitos() || []).map((r) => ({ id: r.id, nombre: r.nombre, ...r.campos })),
    documentos: docsControlados().map((d) => ({ doc_id: d.id, titulo: d.title, status: d.status, ruta: d.rel })),
    riesgos_abiertos: openRisksCount(),
    // SEÑALES recalculadas en cada invocacion (canal estructurado para integraciones):
    // lo que el harness "sabe" en este instante, como datos y no como prosa.
    senales: {
      fuentes_sin_digerir: fuentesSinDigerir().map((f) => f.rel),
      requisitos_sin_cobertura: requisitosStats().sin_cobertura,
    },
    git: g ? { rama: g.branch, usuario: g.user, sin_commitear: g.dirty } : null,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

// PLANTILLAS DE MARCA (html/): las provee el PLUGIN, con override por repo.
// Antes vivian SOLO en el repo (copiadas del template al crearlo) y eso las condenaba a envejecer:
// mejorar el diseno obligaba a re-aplicar la capa FARO repo por repo, y 'faro check' ni lo detectaba
// (solo mira si existe la carpeta documentos/, nunca su contenido). Ademas, un repo adoptado sin esa
// carpeta se quedaba sin one-pager con un "copiala del template" que el usuario no sabia resolver.
// Ahora: si el repo tiene la suya, MANDA la del repo (personalizacion de marca por proyecto); si no,
// la del plugin — que se actualiza sola con autoUpdate. Nunca falta.
// MANDA EL PLUGIN, SIEMPRE. El fallback "repo -> plugin" parecia razonable (permitir personalizar)
// pero en la practica hacia lo contrario de lo que se buscaba: los repos creados antes de 0.4.32
// conservan una copia de las plantillas del dia en que nacieron, NADIE las personalizo, y esa copia
// GANABA — asi que seguian generando one-pagers sin los arreglos de impresion mientras el plugin
// tenia la version buena. Una plantilla heredada no es una decision de diseno: es deuda.
// Personalizar de verdad se hace con OVERRIDE EXPLICITO: documentos/plantillas/html/<nombre>.custom.html.
// Ese sufijo obliga a que exista intencion — no se hereda por copiar un repo.
function plantillaMarca(nombre) {
  const custom = path.join(ROOT, `${DOCS}/plantillas/html/${nombre.replace(/\.(html|mjs)$/, '.custom.$1')}`);
  if (fs.existsSync(custom)) return { ruta: custom, origen: 'repo (override explicito)' };
  const enPlugin = path.join(__dirname, '..', 'plantillas', 'html', nombre);
  if (fs.existsSync(enPlugin)) return { ruta: enPlugin, origen: 'plugin' };
  // Ultimo recurso: una copia legada en el repo. Se usa para no dejar al usuario sin artefacto,
  // pero se AVISA — es justo lo que hay que retirar (faro check lo ofrece).
  const legada = path.join(ROOT, `${DOCS}/plantillas/html/${nombre}`);
  if (fs.existsSync(legada)) {
    process.stdout.write(`AVISO: usando la plantilla LEGADA del repo (${nombre}); el plugin no esta disponible. Retirala con 'faro check' para recibir las mejoras.\n`);
    return { ruta: legada, origen: 'repo (legada)' };
  }
  return null;
}

// docgen: genera el HTML de marca desde un MD reusando la plantilla (render-doc.mjs). Uso: harness.js docgen <md> [out].
function cmdDocGen() {
  // Modo: vista documento (vertical, default) o vista presentacion (horizontal, --presentacion).
  const rest = process.argv.slice(3);
  const pres = rest.includes('--presentacion') || rest.includes('--presentation');
  const positional = rest.filter((a) => !a.startsWith('--'));
  const inMd = positional[0];
  if (!inMd) { process.stdout.write('Uso: node .claude/hooks/harness.js docgen <entrada.md> [salida.html] [--presentacion]\n'); return; }
  const rd = plantillaMarca('render-doc.mjs');
  if (!rd) { process.stdout.write('Falta render-doc.mjs (ni en documentos/plantillas/html/ ni en el plugin) — reinstala el plugin.\n'); process.exit(1); }
  const script = rd.ruta;
  // Destino: para artefactos de reporting (gestion/reporting/{informes,presentaciones}/<tema>/) el HTML sale
  // HERMANO en su misma subcarpeta (junto al MD confeccionado por el agente). Para el resto, el
  // entregable ESTANDAR documentos/entregables/<doc_id>-<slug-titulo>-v<version>[-presentacion].html.
  let outArg = positional[1];
  if (!outArg) {
    const inRel = path.relative(ROOT, path.resolve(ROOT, inMd)).replace(/\\/g, '/');
    if (new RegExp(`^${REPORTING}/(informes|presentaciones)/[^/]+/`).test(inRel)) {
      // REPORTING = SNAPSHOT DATADO, SIEMPRE. Antes se heredaba el nombre del MD tal cual, asi que un
      // MD sin fecha producia un HTML sin fecha (y aparecian '-v1-/-v2-' en presentaciones/, mezclando
      // el versionado SemVer de documentos/ con el datado de reporting). Aqui NO hay artefacto "vivo":
      // el vigente es el de fecha mas reciente. Si el nombre ya trae AAAA-MM-DD se respeta; si no, se
      // antepone la de hoy. Misma fecha -> sobrescribe; fecha nueva -> snapshot nuevo. Sin SemVer.
      let salida = inRel.replace(/\.md$/i, (pres ? '-presentacion' : '') + '.html');
      const dir = path.dirname(salida), base = path.basename(salida);
      if (!/\d{4}-\d{2}-\d{2}/.test(base)) {
        const hoy = new Date().toISOString().slice(0, 10);
        salida = `${dir}/${hoy}-${base.replace(/-v\d+(\.\d+)*(?=-|\.)/i, '')}`;   // fuera el -vN: en reporting la fecha ES la version
      }
      outArg = salida;
    } else {
      let fm = {}; try { fm = parseFrontmatter(fs.readFileSync(path.resolve(ROOT, inMd), 'utf8')); } catch {}
      // Estandar: <doc_id>-<slug-titulo>-v<version> (codigo diferencia + titulo legible + version).
      const _slugT = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const _nom = String(fm.doc_id || path.basename(inMd, '.md')) + (_slugT(fm.title) ? '-' + _slugT(fm.title) : '');
      const base = _nom + '-v' + String(fm.version || '1.0') + (pres ? '-presentacion' : '') + '.html';
      fs.mkdirSync(path.join(ROOT, `${DOCS}/entregables`), { recursive: true });
      outArg = `${DOCS}/entregables/` + base;
    }
  }
  const args = [script, inMd, outArg];
  if (pres) args.push('--presentacion');
  try { process.stdout.write(execFileSync('node', args, { windowsHide: true, cwd: ROOT, encoding: 'utf8' })); }
  catch (e) { process.stdout.write([e && e.stdout, e && e.stderr].map((x) => (x ? String(x) : '')).join('') || (e && e.message) || 'error generando el documento'); process.exit(1); }
  // Coherencia estado<->rama: el merge a main/master ES la aprobacion del documento.
  try {
    const g = gitInfo();
    let t = ''; try { t = fs.readFileSync(path.resolve(ROOT, inMd), 'utf8'); } catch {}
    const st = (t.match(/^status:\s*(.+)$/m) || [])[1];
    if (g && st) {
      if (isProtected(g.branch) && g.dirty) process.stdout.write(`AVISO: ${g.dirty} cambio(s) sin commitear en '${g.branch}' — el documento generado puede NO reflejar lo aprobado.\n`);
      if (isProtected(g.branch) && !g.dirty && !/approved/i.test(st)) process.stdout.write(`COHERENCIA: estas en '${g.branch}' sin pendientes (todo mergeado = APROBADO) pero el doc dice 'status: ${st.trim()}' — actualiza el frontmatter a 'approved' (via feature/develop) o genera desde develop si sigue en revision.\n`);
      if (!isProtected(g.branch) && /approved/i.test(st)) process.stdout.write(`COHERENCIA: el doc dice 'approved' pero estas en '${g.branch}' — la aprobacion la da el merge a main/master; manten 'draft'/'in_review' hasta aprobar.\n`);
    }
  } catch {}
}

// ---------- Planificacion (#218, #277): como organiza el planificador externo este repo (solo lectura). ----------
async function cmdPlanificacion() {
  const pl = planificacion();
  if (!pl) {
    console.log('planificacion: no hay planificador declarado. Si una herramienta organiza el trabajo y deja marcas en la forja');
    console.log(`(su marca de épica en la descripción de los milestones), decláralo en ${CONFIG_FILE} o en ~/.faro.json:`);
    console.log('  "planificacion": { "prefijo": "<prefijo>", "nombre": "<Nombre>" }');
    return;
  }
  const gh = forjaMod();
  if (!gh) return SIN_FORJA('planificacion');
  const rel = await pl.leerRelacion(gh.ghApi || gh.api, forgeInfo());
  if (process.argv.includes('--json')) { console.log(JSON.stringify(rel, null, 2)); return; }
  for (const l of pl.pintar(rel)) console.log(l);
}

// Capa de CODIGO (modulo code.js, stack-aware): gates/faro:infra/faro:deps + lineas de sesion.
// Ausente o en modo 'none' (repo documental) = dormido; el harness es identico en doc/worker/app.
let _specsMod;
function specsMod() {
  if (_specsMod !== undefined) return _specsMod;
  const mod = path.join(__dirname, 'lib', 'specs.js');
  // FUENTE DE RUTA UNICA: pasamos specBase (paths.js) para que el motor mire la MISMA carpeta que el harness.
  // faroSchema entra para que el motor de specs pueda leer el modo EARS del contrato del repo.
  _specsMod = fs.existsSync(mod) ? require(mod)({ ROOT, specBase: SPEC_BASE, faroSchema }) : null;
  return _specsMod;
}
let _ghMod;
function ghMod() {
  if (_ghMod !== undefined) return _ghMod;
  const mod = path.join(__dirname, 'lib', 'github.js');
  // CABLEADO COMPLETO (igual que la rama de GitLab de forjaMod): github.js reenvia estas piezas a
  // sus submodulos — 'fases'/'isDone'/'isActive' a github-gestion.js (hitos = fases de ESTADO.md) y
  // a github-tareas.js (asignar-tarea --hito), y 'faroSchema' al catalogo de labels. Sin ellas,
  // 'hito sync' decia "ESTADO.md sin fases" con el fichero lleno, y '--hito N' rechazaba toda fase.
  _ghMod = fs.existsSync(mod) ? require(mod)({
    ROOT, git, IS_TEMPLATE: NO_INSTANCIA, specBase: SPEC_BASE, forge: forgeInfo, faroSchema,
    fases: () => { const i = parseEstado(); return i ? i.fases : []; }, isDone, isActive,
    // Para avisar al abrir el PR si la rama toca trabajo y no cita issue. Va por ctx (no con un
    // require directo en github.js) porque 'git' es interna a git.js y se resuelve contra ROOT.
    ramaEsSoloGestion,
    // Planificador externo (dominio ya configurado o null): los adaptadores lo leen, no lo construyen.
    planificacion: planificacion(),
  }) : null;
  return _ghMod;
}
// SELECTOR DE FORJA: las operaciones de plataforma (rol, peticiones, tareas, equipo, clave, resumen,
// conexion) las atiende el adaptador de la forja detectada en el remoto. GitHub = github.js (como
// siempre); GitLab = forge-gitlab.js (mismo contrato); otra forja = null, y cada subcomando lo dice.
// La IDENTIDAD (correo git, ssh) sigue en github.js porque es transversal a la forja.
let _forjaMod;
function forjaMod() {
  if (_forjaMod !== undefined) return _forjaMod;
  const f = forgeInfo();
  if (f.forge === 'github') return (_forjaMod = ghMod());
  if (f.forge === 'gitlab') {
    const mod = path.join(__dirname, 'lib', 'forge-gitlab.js');
    const gh = ghMod();
    _forjaMod = fs.existsSync(mod) ? require(mod)({
      ROOT, git, forge: forgeInfo, faroSchema, specBase: SPEC_BASE,
      // Fases de ESTADO.md para la gestion nativa (hitos = fases): las lee el submodulo de gestion.
      fases: () => { const i = parseEstado(); return i ? i.fases : []; }, isDone, isActive,
      tokenPara: (h) => (gh && gh.CRED ? gh.CRED.tokenPara(h) : null),
      guardarToken: (h, d) => (gh && gh.CRED ? gh.CRED.guardarToken(h, d) : null),
      planificacion: planificacion(),
    }) : null;
    return _forjaMod;
  }
  return (_forjaMod = null);
}
const SIN_FORJA = (que) => { const f = forgeInfo(); console.log(`${que}: no hay adaptador para esta forja (${f.forge}${f.host ? ' · ' + f.host : ''}). El gobierno local (validate, specs, rama, ramas, codigo) funciona igual. Para integrar, sube la rama y abre la peticion desde la web.`); };
let _codeMod;
function codeMod() {
  if (_codeMod !== undefined) return _codeMod;
  const mod = path.join(__dirname, 'lib', 'code.js');
  // 'forge' para que pueda decir QUE url de repo declarar en wrangler, no solo que falta.
  _codeMod = fs.existsSync(mod) ? require(mod)(ROOT, { forge: forgeInfo }) : null;
  return _codeMod;
}

// ---------- harness.js ci: genera el CI REAL a partir de TUS gates (harness.js gates) ----------
// El harness ya sabe que comandos corre 'harness.js gates' (scripts de package.json o git config
// faro.gates); esto los traduce al fichero de la forja que corresponda para que se ejecuten en el
// runner de verdad en cada peticion de integracion, no solo cuando alguien los corre en local.
// DETERMINISTA (tabla fija de runtimes + tus comandos, cero improvisacion del modelo) y SEGURO POR
// DISENO: si el fichero de CI YA EXISTE, no se toca — nunca sobrescribe lo que el equipo ya tiene.
function ymlValor(v) {
  // Valor YAML minimo. Las VERSIONES van SIEMPRE entre comillas: sin ellas, '20.10' lo lee YAML como
  // numero y se convierte en 20.1 (una version que no existe) — bug clasico de los workflows.
  const s = String(v);
  if (/^[\d.]+$/.test(s) || /[\s:#]/.test(s)) return `'${s.replace(/'/g, "''")}'`;
  return s;
}
// MONOREPO (#130): en una peticion, solo las apps cambiadas (+ dependientes) con el filtro de pnpm;
// en push a develop/main la variable queda vacia y corren todas.
const NOTA_FILTRO_CI = '# Monorepo: en cada peticion corren solo las apps cambiadas y sus dependientes (pnpm --filter "...[origin/<destino>]"); en push a develop/main, todas.';
function gitlabCiYaml(plan, gates) {
  const img = plan.runtime.gitlabImage || 'TODO: pon aqui la imagen de tu stack (ej. python:3.12-slim, golang:1.23) — el harness no la pudo inferir';
  const filtro = plan.filtroCambios
    ? [`'export ${plan.filtroCambios}=""; if [ -n "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" ]; then git fetch -q origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"; export ${plan.filtroCambios}="--filter=...[origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME]"; fi'`]
    : [];
  const script = [...(plan.install ? [plan.install] : []), ...filtro, ...gates.map((g) => g.run)];
  // Gestor que no trae la imagen (pnpm, #143): before_script lo habilita y cache guarda su store.
  const before = plan.runtime.gitlabBefore || [];
  const cache = plan.runtime.gitlabCache;
  const variables = [
    ...(plan.filtroCambios ? [`    GIT_DEPTH: ${ymlValor('0')}`] : []),
    // corepack pregunta antes de descargar el gestor; en CI no hay nadie que conteste
    ...(before.some((l) => /corepack/.test(l)) ? [`    COREPACK_ENABLE_DOWNLOAD_PROMPT: ${ymlValor('0')}`] : []),
  ];
  return [
    '# .gitlab-ci.yml generado por FARO (node .claude/hooks/harness.js ci) a partir de TUS gates',
    `# (${plan.mode === 'cloudflare' ? 'wrangler + package.json' : plan.install ? 'scripts de package.json' : 'git config faro.gates'}).`,
    '# El harness NO impone herramientas: esto ejecuta EXACTAMENTE lo mismo que `harness.js gates` en',
    '# local. Es un PUNTO DE PARTIDA tuyo — ajustalo libremente, el harness nunca lo reescribe solo',
    '# (si este fichero ya existe la proxima vez, no se toca).',
    '#',
    '# Alternativa nativa de GitLab: si prefieres que la plataforma lo resuelva todo sola (build, test,',
    '# analisis de seguridad, empaquetado y despliegue) sin ningun fichero, activa Auto DevOps en',
    '# Settings > CI/CD — pero asume despliegue en contenedores sobre Kubernetes; si tu proyecto no',
    '# encaja ahi (una libreria, un CLI, un sitio estatico), este fichero explicito es la opcion.',
    ...(plan.filtroCambios ? [NOTA_FILTRO_CI] : []),
    'stages: [gates]',
    '',
    'gates:',
    '  stage: gates',
    `  image: ${img}`,
    ...(variables.length ? ['  variables:', ...variables] : []),
    ...(cache ? ['  cache:', '    key:', '      files:', `        - ${cache.key}`, '    paths:', ...cache.paths.map((p) => `      - ${p}`)] : []),
    ...(before.length ? ['  before_script:', ...before.map((c) => `    - ${c}`)] : []),
    '  script:',
    ...script.map((c) => `    - ${c}`),
    '  rules:',
    '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"',
    '    - if: $CI_COMMIT_BRANCH == "main"',
    '    - if: $CI_COMMIT_BRANCH == "develop"',
    '',
  ].join('\n');
}
// actions/checkout en su mayor vigente (github.com/actions/checkout/releases, verificado 2026-10-11: v7,
// node24, runner >= 2.327.1: los hospedados ya lo cumplen). setup-node y pnpm/action-setup, en lib/code.js.
const ACCION_CHECKOUT = 'actions/checkout@v7';
// Pasos de runtime que un CI propio necesita ademas de instalar y correr gates (habilitar pnpm, setup de
// Node): se listan en el aviso de «mergea a mano» para que no falte el que habilita el gestor.
function pasosRuntimeManuales(plan, forge) {
  const rt = plan.runtime || {};
  const con = (w) => Object.entries(w).map(([k, v]) => k + ': ' + v).join(', ');
  const out = [];
  if (forge === 'github') {
    for (const p of rt.ghPre || []) out.push('paso ' + p.uses + (p.with ? ' con ' + con(p.with) : '') + ' (antes de setup-node)');
    if (rt.ghSetup) out.push('paso ' + rt.ghSetup.uses + ' con ' + con(rt.ghSetup.with));
  } else {
    for (const l of rt.gitlabBefore || []) out.push('before_script: ' + l);
    if (rt.gitlabCache) out.push('cache: key ' + rt.gitlabCache.key + ', paths ' + rt.gitlabCache.paths.join(', '));
  }
  return out;
}
function githubCiYaml(plan, gates) {
  const setup = plan.runtime.ghSetup;
  const lines = [
    '# .github/workflows/ci.yml generado por FARO (node .claude/hooks/harness.js ci) a partir de TUS',
    `# gates (${plan.mode === 'cloudflare' ? 'wrangler + package.json' : plan.install ? 'scripts de package.json' : 'git config faro.gates'}).`,
    '# El harness NO impone herramientas: esto ejecuta EXACTAMENTE lo mismo que `harness.js gates` en',
    '# local. Es un PUNTO DE PARTIDA tuyo — ajustalo libremente, el harness nunca lo reescribe solo',
    '# (si este fichero ya existe la proxima vez, no se toca).',
    ...(plan.filtroCambios ? [NOTA_FILTRO_CI] : []),
    'name: CI (gates de FARO)',
    'on:',
    '  pull_request:',
    '  push:',
    '    branches: [main, develop]',
    'jobs:',
    '  gates:',
    '    runs-on: ubuntu-latest',
    ...(plan.filtroCambios ? ['    env:', `      ${plan.filtroCambios}: "${'$'}{{ github.event_name == 'pull_request' && format('--filter=...[origin/{0}]', github.base_ref) || '' }}"`] : []),
    '    steps:',
    `      - uses: ${ACCION_CHECKOUT}`,
    // el filtro por cambios compara con la rama destino: necesita la historia, no un clon superficial
    ...(plan.filtroCambios ? ['        with:', '          fetch-depth: 0'] : []),
  ];
  // Gestor que no trae el runner (pnpm, #143): va ANTES de setup-node, que lo necesita para cachear.
  for (const p of plan.runtime.ghPre || []) {
    lines.push(`      - uses: ${p.uses}`);
    if (p.with) {
      lines.push('        with:');
      for (const [k, v] of Object.entries(p.with)) lines.push(`          ${k}: ${ymlValor(v)}`);
    }
  }
  if (setup) {
    lines.push(`      - uses: ${setup.uses}`);
    lines.push('        with:');
    for (const [k, v] of Object.entries(setup.with)) lines.push(`          ${k}: ${ymlValor(v)}`);
  }
  if (plan.install) lines.push(`      - run: ${plan.install}`);
  for (const g of gates) lines.push(`      - run: ${g.run}`);
  lines.push('');
  return lines.join('\n');
}
function cmdCi() {
  const c = codeMod();
  if (!c || c.mode() === 'none') { console.log('Sin codigo aqui (repo documental): no hay CI de codigo que generar.'); return; }
  const plan = c.ciPlan();
  if (!plan.gates.length) {
    console.log('Sin gates declarados todavia: declara scripts en package.json (lint/test/build/typecheck) o `git config faro.gates "<comando>"`, y repite `harness.js ci`.');
    return;
  }
  const f = forgeInfo();
  let rel, contenido;
  if (f.forge === 'gitlab') { rel = '.gitlab-ci.yml'; contenido = gitlabCiYaml(plan, plan.gates); }
  else if (f.forge === 'github') { rel = path.join('.github', 'workflows', 'ci.yml'); contenido = githubCiYaml(plan, plan.gates); }
  else {
    console.log(`Forja '${f.forge}' sin plantilla de CI conocida: te dejo el YAML aqui para que lo pegues donde corresponda (GitLab: .gitlab-ci.yml · GitHub: .github/workflows/ci.yml):\n\n${gitlabCiYaml(plan, plan.gates)}`);
    return;
  }
  const destino = path.join(ROOT, rel);
  if (fs.existsSync(destino)) {
    const pasos = [...pasosRuntimeManuales(plan, f.forge), ...(plan.install ? [plan.install] : []), ...plan.gates.map((g) => g.run)];
    console.log(`Ya existe ${rel.split(path.sep).join('/')}: el harness NO lo sobrescribe (podria tener cosas tuyas que este generador no sabe). Si quieres que corra los mismos gates, mergea a mano estos pasos (en este orden):\n  ${pasos.join('\n  ')}`);
    if (f.forge === 'github' && plan.mode === 'monorepo') cmdCiMonorepoGithub(true);
    return;
  }
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, contenido);
  const relMostrar = rel.split(path.sep).join('/');
  console.log(`✅ ${relMostrar} creado, con estos gates (los mismos que 'harness.js gates'): ${plan.gates.map((g) => g.name).join(', ')}.\n   Revisalo, ajusta la imagen/version si hace falta, y commitealo — a partir de ahi corre solo en cada peticion de integracion.`);
  // El pipeline por si solo INFORMA; lo que lo convierte en requisito es el ajuste del proyecto. Se
  // sugiere AQUI y no antes: exigirlo sin pipeline (proyecto recien creado, o repo documental que no
  // lo tendra nunca) bloquearia toda fusion. Ahora que el fichero existe, ya tiene sentido.
  if (f.forge === 'gitlab') console.log('   Siguiente paso, cuando este commiteado y corriendo: `node .claude/hooks/harness.js exigir-pipeline` (un Maintainer/Owner) para que una peticion con el pipeline en ROJO no se pueda fusionar. Sin eso, el pipeline solo informa.');
  else if (f.forge === 'github') console.log('   Siguiente paso, cuando este commiteado y corriendo: en la proteccion de rama, marca este workflow como "required status check" (un admin) para que un PR en ROJO no se pueda mergear. Sin eso, el pipeline solo informa.');
  if (f.forge === 'github' && plan.mode === 'monorepo') cmdCiMonorepoGithub(false);
}
// Monorepo en GitHub (#155): ademas del CI, el workflow que aplica el labeler (app:<id> por ficheros
// tocados). No pisa uno existente. CODEOWNERS y .github/labeler.yml los genera 'harness.js codeowners';
// con --con-codeowners se generan en este mismo paso.
function cmdCiMonorepoGithub(ciExistia) {
  const af = require('./lib/apps-forja.js');
  const r = af.escribirWorkflowLabeler(ROOT);
  if (r === 'creado') console.log('✅ ' + af.RUTA_WORKFLOW_LABELER + ' creado (pull_request_target SIN checkout del PR, permisos minimos): etiqueta cada PR con app:<id> segun los ficheros que toca.');
  else if (ciExistia) console.log('Ya existe ' + af.RUTA_WORKFLOW_LABELER + ': no se toca. Si no lo tuviera, el workflow es este (actions/labeler):\n' + af.PASO_LABELER.split('\n').map((l) => '  ' + l).join('\n'));
  else console.log('Ya existe ' + af.RUTA_WORKFLOW_LABELER + ': no se toca.');
  if (process.argv.includes('--con-codeowners')) cmdCodeowners();
  else console.log('   El workflow necesita ' + af.RUTA_LABELER + ' (y CODEOWNERS por app): `node .claude/hooks/harness.js codeowners` genera CODEOWNERS y labeler.yml, o repite este comando con --con-codeowners para generarlos aqui.');
}
// Lineas de codigo para la sesion (gates listos + infra + routing de skills). Vacio si no hay codigo (doc).
function codeSessionLines() {
  const c = codeMod();
  if (!c || !c.hasCode()) return [];
  return [...c.gateReadinessLines(), ...c.infraLines(), ...c.skillRoutingLines(), ...(c.testDisciplineLines ? c.testDisciplineLines() : [])];
}

// pr crear — abrir una peticion de integracion POR INTENCION, en la forja que sea. La skill /faro:pr
// deja de conocer la forma de la API: 'harness.js pr crear --base develop --titulo "..." --cuerpo "..." [--revisor login]...'
async function cmdPrCrear(m) {
  const a = process.argv.slice(4);
  const val = (k) => { const i = a.indexOf(k); return i >= 0 ? (a[i + 1] || '') : null; };
  const revisores = []; for (let i = 0; i < a.length; i++) if (a[i] === '--revisor' && a[i + 1]) revisores.push(a[i + 1]);
  const base = val('--base') || 'develop';
  const titulo = val('--titulo'); const cuerpo = val('--cuerpo') || '';
  const head = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (!titulo) { console.log('Uso: node .claude/hooks/harness.js pr crear --base <rama-destino> --titulo "<titulo>" [--cuerpo "<texto>"] [--revisor <login>]...'); process.exit(1); }
  if (!head || isNoWrite(head)) { console.log(`No se abre una peticion desde '${head}': crea antes una rama de trabajo (harness.js rama <tipo> "<tema>").`); process.exit(1); }
  // SIN ISSUE NO HAY PETICION (#71), salvo que el cambio sea solo de gestion (ESTADO.md, CHANGELOG,
  // informes): decide lo que CAMBIA, no el prefijo de la rama. La referencia valida es la MISMA que
  // usa el reconciliador para cerrar (lib/tarea.js issuesDePr): el numero de la rama o 'Closes #N'.
  // Una mencion suelta ('ver #5') no cierra nada, asi que tampoco cuenta aqui.
  const tareaLib = require('./lib/tarea.js');
  const refs = tareaLib.issuesDePr({ head: { ref: head }, title: titulo, body: cuerpo });
  // 'Refs #N' de SU rama (#91) tambien ancla: la peticion avanza esa tarea, solo que no la cierra.
  const soloRef = Boolean(issueDeRama(head)) && tareaLib.soloReferencia({ title: titulo, body: cuerpo }, issueDeRama(head));
  if (!refs.size && !soloRef) {
    let soloGestion = false;
    try { soloGestion = ramaEsSoloGestion(base); } catch { soloGestion = false; }
    if (!soloGestion) {
      console.log(`No abro la peticion: '${head}' no esta anclada a ninguna tarea y el cambio toca trabajo (codigo o documentos).`);
      console.log('   Sin tarea, lo que entra no esta en el faseo: nadie lo ve, nadie lo cierra y no cuenta para ninguna fase.');
      console.log('   1) Crea la tarea:   harness.js asignar-tarea "<titulo>" <login> "" "" --tipo <tipo> --hito <N>');
      console.log(`   2) Ancla la peticion: pon "Closes #<N>" en --cuerpo (o trabaja en una rama <tipo>/<N>-<slug>).`);
      process.exit(1);
    }
  }
  // La rama TIENE que estar publicada antes: la forja no abre una peticion desde algo que no ha
  // visto. Sin esto fallaba siempre la primera vez, y el 'push -u' manual que venia despues era lo
  // que de verdad lo arreglaba (se vivia como un error transitorio que se iba al reintentar).
  const pub = publicarRamaSiHaceFalta(head);
  if (!pub.ok) { console.log(`No puedo abrir la peticion: ${pub.msg}`); process.exit(1); }
  if (pub.publicada) console.log(`Rama '${head}' publicada en origin (hacia falta para abrir la peticion).`);
  // BUG -> FIX con su estandar (#74): la peticion de una rama de bug lleva Causa · Arreglo · Test, que
  // es lo que el comentario de cierre copia a la tarea. Si ya las trae, no se tocan.
  const prefijo = String(head).split('/')[0];
  let cuerpoBase = cuerpo;
  if ((TIPO_RAMA_A_ISSUE[prefijo] || {}).tipo === 'bug' && !/^#{1,4}\s*Causa\s*$/im.test(cuerpo)) {
    cuerpoBase = `${String(cuerpo).trimEnd()}${cuerpo ? '\n\n' : ''}## Causa\n\n<que lo provocaba>\n\n## Arreglo\n\n<que se cambio>\n\n## Test\n\n<test de regresion que falla sin el arreglo y pasa con el>`;
  }
  // El issue de la rama se CIERRA solo al fusionar, sin depender de que nadie se acuerde de
  // escribirlo: el numero ya viaja en '<tipo>/<N>-<slug>'.
  const cuerpoFinal = conCierreDeIssue(cuerpoBase, head);
  const nIssue = issueDeRama(head);
  const r = await m.crearPr({ titulo, cuerpo: cuerpoFinal, head, base, revisores });
  if (r.sinToken) { console.log(`SIN_TOKEN: conectate -> node .claude/hooks/harness.js auth`); process.exit(2); }
  if (!r.ok) { console.log(`No pude abrir la peticion${r.status ? ` (HTTP ${r.status})` : ''}${r.msg ? `: ${r.msg}` : ''}.`); process.exit(1); }
  console.log(`✅ Peticion abierta: ${head} -> ${base}  ·  ${r.url}${revisores.length ? `  ·  revisor(es): ${revisores.join(', ')}` : ''}`);
  if (soloRef) console.log(`  ⓘ La peticion dice 'Refs #${nIssue}': al fusionarse la tarea #${nIssue} sigue ABIERTA (se avanza, no se termina). Cuando un PR la deje hecha, que diga "Closes #${nIssue}".`);
  else if (nIssue && cuerpoFinal !== cuerpo) console.log(`  Cierra la tarea #${nIssue} al fusionarse ("Closes #${nIssue}", anadido por el harness).`);
  else if (!nIssue) console.log(`  ⚠ La rama '${head}' no esta anclada a ninguna tarea: al fusionarse NO cerrara nada. Si corresponde a una, cierrala tu (harness.js cerrar-tarea <N>).`);
}

// terminar — UNA orden que cierra el ciclo del trabajo de esta rama: commitea lo que quede, valida y
// abre la peticion (con su 'Closes #N'). Existe porque el harness MARCABA [x] y se paraba ahi:
// el trabajo se quedaba hecho pero sin salir de la rama, con su tarea abierta y la fase sin cerrar.
// Sin --confirmo solo ENSENA el plan: es el usuario quien decide publicar hacia fuera.
async function cmdTerminar() {
  const confirmo = process.argv.includes('--confirmo');
  const flow = gitFlow();
  if (!flow) { console.log('Sin repo git.'); return; }
  const rama = flow.branch;
  const ini = parseEstado();
  const fase = ini ? (ini.fases.find((f) => isActive(f.estado)) || null) : null;
  // ¿Ya hay peticion abierta para esta rama? Abrir una segunda seria ruido, no cierre.
  let prAbierto = null;
  const gh = forjaMod();
  if (gh && gh.prAbiertoDe) { try { prAbierto = await gh.prAbiertoDe(rama); } catch { /* sin red: seguimos */ } }
  const plan = require('./lib/ciclo.js').planTerminar({
    rama, sucio: git('status', '--porcelain') || '', integrada: !(flow.unmerged || []).includes(rama),
    publicada: !!git('rev-parse', '--verify', `origin/${rama}`), fase, prAbierto,
  });
  if (!plan.ok) { console.log(plan.motivo); return; }

  console.log(`Cerrar el ciclo de '${rama}':`);
  for (const p of plan.pasos) {
    if (p.tipo === 'commit') console.log(`  1. Commitear ${p.ficheros.length} fichero(s) sin guardar.`);
    if (p.tipo === 'validate') console.log('  2. Validar el ciclo (si falla, no se abre nada).');
    if (p.tipo === 'pr') console.log(`  3. Abrir la peticion hacia develop${p.issue ? ` — cerrara la tarea #${p.issue} al integrarse` : ''}.`);
  }
  for (const a of plan.avisos) console.log(`  ⚠ ${a}`);
  if (!confirmo) {
    console.log('\nNo he hecho NADA todavia (abrir la peticion se ve fuera). Confirma con el usuario y reinvoca: node .claude/hooks/harness.js terminar --confirmo');
    return;
  }

  for (const p of plan.pasos) {
    if (p.tipo === 'commit') {
      gitWrite('add', '-A');
      gitWrite('commit', '-m', `feat: ${plan.pasos.find((x) => x.tipo === 'pr').titulo}`);
      console.log(`✅ Commiteados ${p.ficheros.length} fichero(s).`);
    }
    if (p.tipo === 'validate') {
      const v = require('child_process').spawnSync(process.execPath, [__filename, 'validate', '--gates'], { windowsHide: true, cwd: ROOT, stdio: 'inherit' });
      if (v.status !== 0) { console.log('\nCANCELADO: la validacion falla. Arreglalo y reintenta; no he abierto ninguna peticion.'); return; }
    }
    if (p.tipo === 'pr') {
      const titulo = p.titulo.charAt(0).toUpperCase() + p.titulo.slice(1);
      const r = require('child_process').spawnSync(process.execPath, [__filename, 'pr', 'crear', '--base', 'develop', '--titulo', titulo], { windowsHide: true, cwd: ROOT, stdio: 'inherit' });
      if (r.status !== 0) { console.log('\nNo pude abrir la peticion (ver arriba). El trabajo esta commiteado y validado.'); return; }
    }
  }
  console.log('\nCiclo cerrado. Queda integrarlo: /faro:consolidar (quien pueda) y despues /faro:publicar para publicarlo.');
}

// 'release' — el REGISTRO: que hay acumulado sin publicar, desde que punto, y que version tocaria.
// Solo LEE. Publicar a produccion sin esto es a ciegas: nadie sabe cuantos ciclos lleva encima ni
// desde cuando. Es lo que convierte el release en una decision informada en vez de un merge mas.
function releaseInfo() {
  const cl = require('./lib/ciclo.js');
  // Lo PUBLICADO se mide contra MAIN (#116): los tags de version se crean en el merge de main, que no es
  // antecesor de develop. Con 'describe' desde HEAD, en develop salia un tag antiguo y todo lo ya
  // publicado parecia pendiente. Pendiente = lo que esta aqui y no en main.
  // En un monorepo los tags de las apps ('api@1.2.0') no son de la raiz: solo cuentan los 'v<version>' (#131).
  const soloRaiz = require('./lib/apps.js').esMonorepo(ROOT) ? ['--match', 'v[0-9]*'] : [];
  const main = ['main', 'master'].find((b) => git('rev-parse', '--verify', '--quiet', `refs/heads/${b}`))
    || ['origin/main', 'origin/master'].find((b) => git('rev-parse', '--verify', '--quiet', `refs/remotes/${b}`)) || null;
  const ultimoTag = (main ? git('describe', '--tags', '--abbrev=0', ...soloRaiz, main) : git('describe', '--tags', '--abbrev=0', ...soloRaiz)) || null;
  const rango = main ? `${main}..HEAD` : ultimoTag ? `${ultimoTag}..HEAD` : 'HEAD';
  const log = git('log', rango, '--no-merges', '--pretty=%s') || '';
  let changelog = '';
  try { changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'); } catch {}
  return cl.analizarRelease({
    ultimoTag,
    commits: log.split('\n').map((s) => s.trim()).filter(Boolean),
    unreleased: cl.leerUnreleased(changelog),
    versionActual: releaseMod().versionActual() || '0.0.0',
  });
}

// RELEASE POR APP (#131): en un monorepo cada app se publica con SU version, SU CHANGELOG y SU tag
// ('{app}@{version}'), y solo si cambio desde su ultimo tag. Lineas para 'release' y 'publicar'.
function lineasReleaseApps(ref = 'HEAD') {
  const rel = releaseMod();
  const plan = rel.planApps(ref);
  if (!plan.length) return [];
  const ap = require('./lib/apps.js');
  const out = [`Monorepo — release por app (tag '${(ap.leerConfig(ROOT) || {}).tag || ap.TAG_DEFECTO}'):`];
  for (const p of plan) {
    const id = p.app.id;
    if (p.estado === 'sin-cambios') { out.push(`  · ${id}: sin cambios desde ${p.desde || 'el inicio'} — no se toca.`); continue; }
    const cab = `  · ${id}: ${p.commits.length} cambio(s) desde ${p.desde || 'el inicio (primer release)'}`;
    if (p.estado === 'lista') out.push(`${cab} → version ${p.version} → tag ${p.tag} (CHANGELOG de la app al dia).`);
    else if (p.estado === 'ya-tageada') out.push(`${cab}, pero su version ${p.version} ya esta tageada — version sugerida ${p.sugerida} (${p.razon}); subela con /faro:changelog.`);
    else if (p.estado === 'sin-changelog') out.push(`${cab} → version ${p.version}, pero ${p.app.ruta}/CHANGELOG.md no tiene '## ${p.version}' — corre /faro:changelog para ${id} (bloquea publicar).`);
    else if (p.estado === 'version-invalida') out.push(`${cab}, pero su version '${p.version}' (o la plantilla del tag) no da un tag valido — corrigela (bloquea publicar).`);
    else if (p.estado === 'sin-version') out.push(`${cab}, pero ${p.app.ruta}/package.json no declara version — no se tagea.`);
    for (const c of p.commits.slice(0, 5)) out.push(`      - ${c}`);
    if (p.commits.length > 5) out.push(`      - (+${p.commits.length - 5} mas)`);
    if (p.acumulado) out.push(`      [Unreleased] de ${id}: ${p.acumulado.split('\n').filter((l) => l.trim()).slice(0, 3).map((l) => l.trim()).join(' · ')}`);
  }
  const her = rel.tagsHeredados();
  if (her.length) out.push(`  ⓘ Tag(s) heredado(s) ${her.join(', ')}: ambiguo(s) en un monorepo (no identifican ninguna app; la raiz no declara version) — se ignoran para la release por app y no se borran.`);
  return out;
}

function cmdReleaseAnalisis() {
  const r = releaseInfo();
  const apps = lineasReleaseApps('HEAD');
  if (apps.length) {
    // En un monorepo la raiz solo se analiza si declara version propia (si no, no se le exige).
    if (releaseMod().versionActual()) console.log(r.hayQuePublicar ? `Raiz: acumulado desde ${r.desde}: ${r.ciclos} cambio(s); version sugerida ${r.sugerida} — ${r.razon}.\n` : `Raiz: nada que publicar. ${r.motivo}\n`);
    console.log(apps.join('\n'));
    console.log(`\nPublicar a produccion (NO se automatiza, se invoca): node .claude/hooks/harness.js publicar --confirmo`);
    return;
  }
  if (!r.hayQuePublicar) { console.log(`Nada que publicar. ${r.motivo}`); return; }
  console.log(`Acumulado desde ${r.desde}: ${r.ciclos} cambio(s) sin publicar.`);
  for (const c of (r.commits || []).slice(0, 12)) console.log(`  · ${c}`);
  if ((r.commits || []).length > 12) console.log(`  · (+${r.commits.length - 12} mas)`);
  console.log(`\nVersion sugerida: ${r.sugerida} — ${r.razon}.`);
  if (r.acumulado) console.log(`\nNotas acumuladas en [Unreleased]:\n${r.acumulado.split('\n').slice(0, 10).map((l) => `  ${l}`).join('\n')}`);
  console.log(`\nPublicar a produccion (NO se automatiza, se invoca): node .claude/hooks/harness.js publicar --confirmo`);
}

const cmd = process.argv[2];
// ---------- Ramas de cambio con convencion (harness.js rama) ----------
// Crea una rama de TRABAJO <tipo>/<slug> desde develop y cambia a ella. Una rama = un cambio.
// Uso: node .claude/hooks/harness.js rama <tipo> "<descripcion>"
// Prefijo de rama -> tipo de issue del catalogo (faro-schema.json > enums.labels). Una rama fix/ es
// un bug; una feat/ es trabajo de PLAN. Asi el harness puede PROPONER el comando exacto en vez de
// dejar que cada uno adivine que tipo poner.
// Prefijos de GESTION: cierre de ciclo, no trabajo que planificar. Archivar un cambio, bumpear la
// version o actualizar ESTADO.md tras aprobar son el FINAL de trabajo que ya tuvo su issue — pedirles
// uno propio seria una tarea para cerrar otra tarea. No se les avisa al crear la rama; si acaban
// tocando codigo, el gate real llega al abrir la peticion (donde ya hay diff que mirar).
const TIPOS_GESTION = ['chore'];

// 'extra' añade la dimension TRANSVERSAL que el prefijo ya implica: un hotfix es urgente por
// definicion, no hace falta que nadie se acuerde de marcarlo.
const TIPO_RAMA_A_ISSUE = {
  feat: { tipo: 'requerimiento' },
  fix: { tipo: 'bug' }, bug: { tipo: 'bug' }, bugfix: { tipo: 'bug' },
  hotfix: { tipo: 'bug', extra: 'urgente' },
  docs: { tipo: 'documentacion' },
  refactor: { tipo: 'tarea' },
  perf: { tipo: 'mejora' },
  chore: { tipo: 'tarea' },
  test: { tipo: 'tarea' },
  spike: { tipo: 'investigacion' },
};

function cmdRama() {
  const argsRama = process.argv.slice(3);
  // --issue <N>: la rama nace ANCLADA a una tarea ya existente. Es la via principal; sin el, se crea
  // igual pero acompañando (ver abajo) — bloquear aqui haria que la gente trabaje fuera del sistema.
  let issueArg = null;
  const libres = [];
  for (let i = 0; i < argsRama.length; i++) {
    if (argsRama[i] === '--issue') { issueArg = (argsRama[i + 1] || '').replace(/^#/, ''); i++; continue; }
    const mI = argsRama[i].match(/^--issue=#?(.+)$/); if (mI) { issueArg = mI[1]; continue; }
    libres.push(argsRama[i]);
  }
  const tipo = (libres[0] || '').toLowerCase();
  const desc = libres.slice(1).join(' ').trim();
  const tipos = BRANCH_TYPES.filter((t) => t !== 'feature');
  if (!tipo || !BRANCH_TYPES.includes(tipo)) {
    console.log(`Uso: node .claude/hooks/harness.js rama <tipo> "<descripcion>" [--issue <N>]\n  tipos: ${tipos.join(' | ')}\n  (feat=funcionalidad · fix/bug=correccion · hotfix=urgencia · refactor · perf · docs · chore · test · spike=exploracion)\n  --issue <N>: ancla la rama a una tarea ya creada (via recomendada: el PR saldra con "Closes #N").`);
    process.exit(1);
  }
  if (!desc) { console.log(`Falta la descripcion: node .claude/hooks/harness.js rama ${tipo} "<que hace el cambio>"`); process.exit(1); }
  // GATE: una rama solo existe si hay un ISSUE detras. Primero se PIDE algo —el issue define que se
  // quiere y en que fase entra— y luego se abre la rama para atenderlo: asi nada se trabaja fuera del
  // sistema y la rama nace ya con su numero. Dos exenciones, ambas por imposibilidad, no por comodidad:
  //   · prefijos de GESTION (chore): cierre de ciclo, es el FINAL de trabajo que ya tuvo su issue.
  //   · repo sin ESTADO.md (nivel 0): no hay fases a las que anclar una tarea, no puede cumplirse.
  if (!issueArg && !TIPOS_GESTION.includes(tipo)) {
    const iniG = parseEstado();
    if (iniG) {
      const mapa = TIPO_RAMA_A_ISSUE[tipo] || { tipo: 'tarea' };
      const extraSug = mapa.extra ? ` --extra ${mapa.extra}` : '';
      const activa = iniG.fases.find((f) => isActive(f.estado));
      const faseSug = activa ? ` --hito ${activa.num}` : ' --hito <N|backlog>';
      console.log(`NO abro la rama: falta la TAREA. Una rama solo existe para atender un issue — primero se define QUE se quiere y en que fase entra, y luego se trabaja.`);
      console.log(`   1) Crea la tarea (tipo '${mapa.tipo}'${mapa.extra ? ` y ${mapa.extra}` : ''}${activa ? `, en la Fase ${activa.num} · ${activa.nombre}` : ''}):`);
      console.log(`      node .claude/hooks/harness.js asignar-tarea "${desc}" <login> "" "" --tipo ${mapa.tipo}${faseSug}${extraSug}`);
      console.log(`   2) Abre la rama anclada a su numero:`);
      console.log(`      node .claude/hooks/harness.js rama ${tipo} "${desc}" --issue <N>`);
      if (!activa) console.log(`   (Ninguna fase esta activa en ${ESTADO_FILE}: activa una, o usa --hito backlog si aun no se decide cuando.)`);
      process.exit(1);
    }
    // MOTOR: no tiene faseo, pero lo que se corrige o se anade al plugin se DECLARA igual — un fallo
    // detectado es un bug con su issue antes que una rama. Sin fase: el issue va sin hito.
    if (!iniG && IS_ENGINE) {
      const mapa = TIPO_RAMA_A_ISSUE[tipo] || { tipo: 'tarea' };
      console.log(`NO abro la rama: falta el ISSUE. Tambien en el motor: primero se declara (tipo '${mapa.tipo}'), luego se trabaja.`);
      console.log(`   1) node .claude/hooks/harness.js asignar-tarea "${desc}" <login> "" "" --tipo ${mapa.tipo}${mapa.extra ? ` --extra ${mapa.extra}` : ''}`);
      console.log(`   2) node .claude/hooks/harness.js rama ${tipo} "${desc}" --issue <N>`);
      process.exit(1);
    }
  }
  // Con issue, el numero va en el nombre: de un vistazo se sabe a que responde la rama.
  const nombre = issueArg ? `${tipo}/${issueArg}-${slugify(desc)}` : `${tipo}/${slugify(desc)}`;
  const g = gitInfo();
  if (!g) { console.log('Esto no es un repo git (o no hay commits). Inicializa el ciclo primero.'); process.exit(1); }
  if (git('rev-parse', '--verify', '--quiet', `refs/heads/${nombre}`) !== null) {
    git('switch', nombre); console.log(`Rama '${nombre}' ya existia -> cambiado a ella.`); return;
  }
  const flow = gitFlow();
  const base = flow && flow.develop ? 'develop' : g.branch;
  git('switch', '-c', nombre, base);
  const ahora = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (ahora !== nombre) { console.log(`No pude crear '${nombre}' desde '${base}'. Hazlo a mano: git switch -c ${nombre} ${base}`); process.exit(1); }
  // PUBLICAR la rama al crearla (no dejarla solo local): -u para trackear origin y que el trabajo sea visible/seguible.
  // Si no hay remoto o falla la red, se avisa (no rompe: la rama existe en local igual).
  let publicada = false;
  if (git('remote', 'get-url', 'origin')) {
    // lib/subir.js (#194): push normal y, si falla por credenciales/red, por HTTPS con el token del harness.
    // Antes: 15s de timeout — un push que tardaba mas SUBIA igual, pero aqui se daba por fallido.
    publicada = require('./lib/subir.js')([nombre], { ROOT, upstream: true }).ok;
  }
  console.log(`Rama de cambio creada: ${nombre}  (desde ${base})${publicada ? ' y PUBLICADA en origin' : ''} — ya trabajas aqui.`);
  if (!publicada && git('remote', 'get-url', 'origin')) console.log(`  (No pude publicarla ahora — publicala cuando puedas: git push -u origin ${nombre})`);
  // ACOMPAÑAR, no solo exigir: ninguna rama deberia nacer suelta — nace de una tarea, y toda tarea
  // cuelga de un hito. Si la rama viene con --issue, ya esta anclada y no hay nada que decir. Si no,
  // se crea igual (bloquear aqui empuja a trabajar fuera del sistema) pero se dice QUE falta y se da
  // el comando exacto, con el tipo que corresponde al prefijo y la fase ACTIVA por defecto — que es
  // donde va lo que aparece mientras se trabaja: un bug o un hotfix no hay ni que decidirlos.
  if (issueArg) {
    console.log(`  Anclada a la tarea #${issueArg}: al abrir la peticion (harness.js pr crear) el harness pone "Closes #${issueArg}" y la tarea se cierra sola al integrarse.`);
    // TRABAJO DUPLICADO: si ese issue ya tiene otra rama publicada, alguien esta (o estuvo) en ello.
    // No se impide —puede ser legitimo— pero hay que decirlo ANTES de empezar, con quien y cuando.
    // Lo que NO se puede saber es si alguien la tiene abierta AHORA sin haber publicado: el trabajo
    // local ajeno es invisible hasta que se sube.
    try {
      const remotas = (git('branch', '-r', '--format=%(refname:short)') || '').split('\n')
        .map((s) => s.trim().replace(/^origin\//, ''))
        .filter((b) => b && b !== nombre && new RegExp(`(^|/)${issueArg}-`).test(b));
      for (const otra of remotas) {
        const quien = git('log', '-1', '--format=%an', `origin/${otra}`);
        const cuando = git('log', '-1', '--format=%ar', `origin/${otra}`);
        console.log(`  ⚠ La tarea #${issueArg} YA tiene otra rama publicada: '${otra}'${quien ? ` · ultimo commit de ${quien}` : ''}${cuando ? ` (${cuando})` : ''}.`);
        console.log(`     Comprueba que no estais haciendo lo mismo antes de seguir.`);
      }
    } catch {}
  } else if (TIPOS_GESTION.includes(tipo)) {
    // TRABAJO vs GESTION: archivar un cambio, bumpear la version o actualizar ESTADO.md tras
    // aprobar son CIERRE DE CICLO, no tareas nuevas — son el final de trabajo que YA tuvo su issue.
    // Exigirles uno seria pedir una tarea para cerrar otra tarea: ruido que entrena a ignorar el
    // aviso. Se dice POR QUE no se pide, para que no parezca un olvido del harness.
    // (El gate de verdad llega al abrir el PR: si el diff toco src/, ahi si se exige — ver cmdPrCrear.)
    console.log(`  Rama de GESTION (cierre de ciclo): no se le pide tarea propia. Archivar, versionar o actualizar ${ESTADO_FILE} no es trabajo nuevo, es el final de trabajo que ya tuvo la suya.`);
    console.log(`     Si esta rama acaba tocando codigo, entonces SI necesita tarea: se te exigira al abrir la peticion.`);
  } else {
  }
  console.log(`  Al terminar NO integres a ciegas: VALIDA primero (node .claude/hooks/harness.js validate + revisor-code/auditor).`);
  console.log(`  Luego integra CON confirmacion: PR a develop (recomendado, validado) o merge validado a develop (git switch develop && git merge --no-ff ${nombre}); a main solo se llega publicando (/faro:publicar, quien tenga permiso). Aplica a TODOS, tambien owner/admin.`);
  if (['feat', 'fix', 'bug', 'bugfix', 'refactor', 'perf'].includes(tipo) && fs.existsSync(path.join(ROOT, '.claude/hooks/code.js')))
    console.log('  Recuerda: tocar src/ EXIGE un cambio spec-driven APROBADO (/faro:cambio -> aprobar). Nada "a la ligera".');
}

// consolidar: para owner/admin/maintainer, AYUDA a consolidar develop -> main (= la aprobacion):
// CONSOLIDAR (trabajo -> develop): integracion ACTIVA con criterio. Valida el ROL, analiza las ramas de
// trabajo <tipo>/<slug> sin integrar (o los PRs abiertos a develop), valida el GATE (validate) y mergea a
// develop las que pasan. NO toca main (eso es /faro:publicar). develop deja de ser zona de edicion a mano.
// FALLO 4 reportado: 'consolidar --help' ejecutaba la validacion REAL (con su gate y sus efectos)
// en vez de mostrar ayuda — pedir ayuda nunca debe disparar la operacion.
const pidioAyuda = () => process.argv.slice(3).some((a) => a === '--help' || a === '-h' || a === 'help');

function ayudaConsolidar() {
  console.log([
    'USO: harness.js consolidar [<PR|issue|rama>...] [--todas] [--todas-las-ramas]',
    '',
    'Consolida (integra) en develop SOLO lo pedido. Solo admin/owner/maintainer.',
    '  consolidar 65            -> la rama del PR #65 (o del issue #65, o una rama por su nombre).',
    '  consolidar               -> solo las ramas con PR abierto a develop; las demas, se avisan y no entran.',
    '  --todas-las-ramas        -> todas las ramas de trabajo sin integrar (comportamiento anterior).',
    '  --todas                  -> valida con la bateria completa en vez de solo lo que tocan las ramas.',
    'Que hace, en orden:',
    '  1. Valida tu ROL contra GitHub (si no puedes consolidar, para y te dice que lances /faro:pr).',
    '  2. Gate: ejecuta `validate` solo de lo que tocan las ramas (en un monorepo, sus apps) — si falla, NO integra nada.',
    '  3. Cambia a develop, commitea lo que hubiera suelto y mergea cada rama elegida (--no-ff).',
    '  4. Sube develop y avisa si quedo trabajo local sin subir de pasadas anteriores.',
    '',
    'Un conflicto REAL se aborta solo y se te dice cual; si el proceso git no termina (repo enorme),',
    'se PARA y te pide revisar a mano en vez de dejar el repositorio a medias.',
    '',
    'Relacionados: /faro:pr (pedir integracion) · /faro:publicar (develop -> main) · /faro:pendientes.',
  ].join('\n'));
}

function ayudaPublicar() {
  console.log([
    'USO: harness.js publicar [--confirmo]',
    '',
    'Aprueba develop -> main (la publicacion de lo aprobado). Solo admin/owner/maintainer.',
    'SIN --confirmo: solo MUESTRA que se aprobaria (commits incluidos) y NO toca nada.',
    'CON --confirmo: valida rol + gate `validate`, archiva los cambios implementados, mergea',
    'develop -> main, crea el tag vX.Y.Z de la version y sube todo.',
    '',
    'El --confirmo lo pasa la skill /faro:publicar SOLO despues de que TU confirmes: el rol decide',
    'quien PUEDE aprobar, no sustituye tu confirmacion.',
    '',
    'Relacionados: /faro:consolidar (a develop) · /faro:pr · /faro:pendientes.',
  ].join('\n'));
}

// CERRAR UNA FASE: la ceremonia que faltaba. Todo el ciclo estaba cableado punta a punta (rama ->
// terminar -> consolidar -> publicar) menos esto, que eran cuatro pasos manuales — marcar checkbox,
// escribir el informe, editar ESTADO.md, tagear — y que 'publicar' terminaba pidiendo al humano.
//
// PRIMERO valida y dice QUE falta (todo de una vez, no de uno en uno); solo con --confirmo escribe.
// Es el unico comando que escribe el faseo, asi que toca lo minimo: la cabecera de la fase y
// 'fase_actual' (ver cerrarFaseEnTexto, fijado con tests que comprueban que no cambia nada mas).
async function cmdCerrarFase() {
  const num = Number.parseInt(process.argv[3], 10);
  if (!Number.isInteger(num)) { console.log('Uso: harness.js cerrar-fase <N> [--confirmo]'); process.exit(1); }
  const ini = parseEstado();
  if (!ini) { console.log(`No hay ${ESTADO_FILE}: no hay faseo que cerrar.`); process.exit(1); }
  const fase = ini.fases.find((f) => f.num === num) || null;
  const cl = require('./lib/ciclo.js');

  // La forja manda sobre el checkbox: un '[x]' no es evidencia de que el trabajo saliera. Si no se
  // puede consultar (sin red/token) llega vacio y NO bloquea — quedarse sin conexion no puede
  // impedir gobernar el faseo.
  let desajustes = [];
  const gh = forjaMod();
  if (fase && gh && gh.issueEstado) {
    const estados = {};
    for (const t of (fase.tareas || [])) {
      const ref = cl.refDeTarea(t.text);
      if (!ref || !ref.issue) continue;
      try { const e = await gh.issueEstado(String(ref.issue)); if (e) estados[String(ref.issue)] = e; } catch { /* no se pudo mirar */ }
    }
    desajustes = cl.desajustesDelFaseo([fase], estados);
  }

  const siguiente = (ini.fases.find((f) => f.num > num && !isDone(f.estado)) || {}).num ?? null;
  const plan = cl.planCerrarFase({ fase, informe: fase ? informeExists(num) : false, desajustes, siguiente, dirInformes: PATHS.dir('informes') });
  if (!plan.ok) {
    console.log(`NO se puede cerrar la Fase ${num} todavia:`);
    for (const f of plan.faltan) console.log(`  - ${f}`);
    process.exit(1);
  }

  if (!process.argv.includes('--confirmo')) {
    console.log(`Se CERRARIA la Fase ${num} · ${fase.nombre}:`);
    console.log(`  - ${ESTADO_FILE}: la fase pasa a 'done'${plan.faseActual ? ` y fase_actual avanza a ${plan.faseActual}` : ' (era la ultima fase: fase_actual no cambia)'}.`);
    console.log(`  - Se cierra su hito en la forja (si tiene tareas abiertas dentro, la forja avisa y NO lo cierra).`);
    console.log(`  - Se crea el tag 'fase-${num}'.`);
    console.log(`\nEsto NO se ha hecho todavia. Confirma con el usuario (AskUserQuestion) y, si dice que si, reinvoca: node "\${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" cerrar-fase ${num} --confirmo`);
    return;
  }

  const ruta = path.join(ROOT, ESTADO_FILE);
  const texto = fs.readFileSync(ruta, 'utf8');
  const nuevo = require('./lib/estado.js').cerrarFaseEnTexto(texto, num, plan.faseActual);
  if (nuevo === texto) { console.log(`No pude reescribir la Fase ${num} en ${ESTADO_FILE} (¿formato de cabecera inesperado?). No he tocado nada.`); process.exit(1); }
  fs.writeFileSync(ruta, nuevo, 'utf8');
  invalidarEstado();   // el fichero acaba de cambiar: la cache mentiria
  console.log(`✅ Fase ${num} cerrada en ${ESTADO_FILE}${plan.faseActual ? ` · fase_actual -> ${plan.faseActual}` : ''}.`);

  // El hito lo cierra syncHitos, que ya sabe hacerlo (y tiene el cierre forzoso: no cierra un hito
  // con tareas abiertas dentro, avisa). No se replica esa logica aqui.
  if (gh && gh.syncHitos) {
    try {
      const out = await gh.syncHitos();
      if (out && out.length) console.log(`Hitos sincronizados:\n${out.join('\n')}`);
    } catch { console.log('⚠ No pude sincronizar los hitos (¿sin red o token?): hazlo con `harness.js hito sync`.'); }
  }

  const tag = `fase-${num}`;
  if ((git('tag', '-l', tag) || '').trim()) console.log(`ℹ El tag '${tag}' ya existia.`);
  else {
    const r = gitWrite('tag', '-a', tag, '-m', `Fase ${num} · ${fase.nombre} cerrada`);
    console.log(r.ok ? `🏷  Tag '${tag}' creado. Subelo: git push origin ${tag}` : `⚠ No pude crear el tag '${tag}': creralo a mano con 'git tag -a ${tag}'.`);
  }
  console.log(`\nLa fase queda cerrada. El trabajo que venga despues NO reabre esta fase: va a la fase actual (con '--origen-fase ${num}' si viene de aqui) o al Backlog.`);
}

async function cmdConsolidar() {
  const flow = gitFlow();
  if (!flow) { console.log('Sin repo git.'); return; }
  if (!flow.develop) { console.log("No hay rama 'develop'. Crea el ciclo: git switch -c develop && git push -u origin develop."); return; }
  // Rol: integrar a develop es operacion de admin/owner/maintainer (develop bloqueado a escritura directa).
  const gh = forjaMod();
  if (gh) {
    const ri = await gh.roleInfo();
    if (ri && ri.sinToken) { console.log('SIN_TOKEN: conectate -> node .claude/hooks/harness.js auth (codigo de 6 digitos).'); return; }
    if (ri && !ri.puedeAprobar) { console.log(`NO puedes consolidar a 'develop' (rol '${ri.perm}'). Quien trabaja lanza /faro:pr; un owner/admin/maintainer consolida.`); return; }
  }
  const sinIntegrar = (flow.unmerged || []);
  // Aunque no haya ramas que integrar, develop puede llevar trabajo SIN SUBIR de una pasada
  // anterior (fallo 2 reportado): hay que decirlo, no callar.
  if (!sinIntegrar.length) { console.log("Nada que consolidar: no hay ramas de trabajo <tipo>/<slug> sin integrar en develop."); avisarDevelopSinSubir(); return; }
  // SOLO LO PEDIDO (#226): `consolidar <PR|issue|rama>...` integra eso; sin argumentos, solo las ramas con
  // PR abierto a develop. `--todas-las-ramas` recupera el comportamiento anterior.
  const argv = process.argv.slice(3);
  const pedidas = argv.filter((a) => !a.startsWith('--'));
  const todasLasRamas = argv.includes('--todas-las-ramas');
  let prs = null;
  if (!todasLasRamas && gh && gh.prsDeRama) {
    prs = new Map();
    for (const r of sinIntegrar) {
      let l = null;
      try { l = await gh.prsDeRama(r); } catch { l = null; }
      if (l === null) { prs = null; break; }
      prs.set(r, l);
    }
  }
  const sel = require('./lib/consolidar.js').seleccionarRamas({ ramas: sinIntegrar, pedidas, prs, issueDeRama, todasLasRamas });
  if (sel.noEncontradas.length) console.log(`⚠ No encuentro entre las ramas sin integrar: ${sel.noEncontradas.join(', ')}.`);
  if (sel.sinConsultar) { console.log(`No pude consultar los PRs abiertos, y sin ellos no integro a ciegas. Nombra lo que quieres integrar: harness.js consolidar <PR|issue|rama>. Ramas sin integrar: ${sinIntegrar.join(', ')}`); return; }
  if (sel.sinPr.length) console.log(`ⓘ Sin PR abierto a develop, NO se integran: ${sel.sinPr.join(', ')} (nómbralas para integrarlas).`);
  let unmerged = sel.ramas;
  if (!unmerged.length) { console.log('Nada que consolidar con lo pedido.'); return; }
  // CI DE LA FORJA (#289): con faro/config.json > validacion = ci|ambos se lee el CI del PR/MR de cada rama.
  // Rojo o en curso no entra; verde (modo ci) no repite la suite; sin CI o sin minutos, suite completa local.
  const eci = require('./lib/estado-ci.js');
  let meta = null; try { meta = JSON.parse(fs.readFileSync(path.join(ROOT, CONFIG_FILE), 'utf8')); } catch { meta = null; }
  const modoV = eci.modoValidacion(meta);
  const estadosCi = [];
  for (const rama of unmerged) {
    if (!eci.consultaCi(modoV) || !gh || !gh.estadoCi) { estadosCi.push({ rama, estado: null, fallidos: [] }); continue; }
    let lista = prs && prs.get(rama);
    if (!lista && gh.prsDeRama) { try { lista = await gh.prsDeRama(rama); } catch { lista = null; } }
    const abierto = (lista || []).find((p) => p && (p.state === 'open' || p.state === 'opened'));
    const e = abierto ? await gh.estadoCi(abierto.number) : null;
    estadosCi.push({ rama, estado: e && e.ok ? e.estado : 'sin-ci', fallidos: (e && e.fallidos) || [] });
  }
  // GATE: validar el estado del ciclo ANTES de integrar. Si falla, NO se integra nada. Los gates, solo de
  // lo que tocan las ramas que entran (#226): en un monorepo, sus apps; `consolidar --todas` pide la bateria completa.
  const ap = require('./lib/apps.js');
  const monorepo = ap.esMonorepo(ROOT);
  const argsLocal = (ramas) => {
    const tocados = [...new Set(ramas.flatMap((r) => (git('diff', '--name-only', `develop...${r}`) || '').split(/\r?\n/).filter(Boolean)))];
    return require('./lib/consolidar.js').argsValidate({ monorepo, apps: monorepo ? ap.appsAfectadas(ROOT, tocados).apps.map((a) => a.id) : [], todas: argv.includes('--todas') });
  };
  const dCi = eci.decidirConsolidar({ modo: modoV, ramas: estadosCi, argsLocal });
  for (const a of dCi.avisos) console.log(a);
  if (!dCi.args) { console.log('Nada que consolidar ahora: el CI de lo pedido está en rojo o en curso.'); return; }
  unmerged = dCi.integrar;
  console.log(`Consolidar a 'develop' (${unmerged.length} rama[s]): ${unmerged.join(', ')}`);
  const argsV = argv.includes('--todas') ? argsLocal(unmerged) : dCi.args;
  console.log(`Validacion: harness.js ${argsV.join(' ')}`);
  const v = require('child_process').spawnSync(process.execPath, [__filename, ...argsV], { windowsHide: true, cwd: ROOT, stdio: 'inherit' });
  if (v.status !== 0) { console.log('\nCONSOLIDACION CANCELADA: la validacion falla. Arregla el ciclo (tasks/specs/estados) antes de integrar.'); return; }
  const cur = git('rev-parse', '--abbrev-ref', 'HEAD') || 'develop';
  git('switch', 'develop');
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'develop') { console.log('No pude cambiar a develop (¿cambios sin commitear?). Resuelve y reintenta.'); return; }
  // Salvaguarda 'nada suelto': si develop trae cambios sin commitear, los commiteamos ANTES de integrar
  // (mismo cuidado que /faro:publicar) — asi develop queda limpio y coherente, sin estados a medias.
  // Pero SOLO lo ya versionado ('add -u'): un fichero SIN VERSIONAR no entra solo (#117: con 'add -A'
  // unos exports locales de n8n acabaron en develop y en main). Si hay alguno, se para y se dice.
  const porcelain = git('status', '--porcelain') || '';
  const sueltos = require('./lib/git.js').ficherosSinVersionar(porcelain);
  if (sueltos.length) { console.log(require('./lib/git.js').avisoSinVersionar(sueltos, 'CONSOLIDACION')); return; }
  const sucio = porcelain.trim();
  if (sucio) {
    git('add', '-u');
    git('commit', '-m', 'chore: cambios pendientes en develop antes de consolidar');
    console.log(`Commit previo en develop: ${sucio.split('\n').length} fichero(s) pendientes incluidos.`);
  }
  const done = [];
  for (const rama of unmerged) {
    limpiarIndexLockHuerfano(); // basura de un git muerto anterior bloquearia el merge con un error opaco
    const r = gitWrite('merge', '--no-ff', rama, '-m', `merge ${rama} -> develop: consolidacion (integracion)`);
    if (r.ok) { done.push(rama); console.log(`  ✅ ${rama} integrada en develop`); continue; }
    // DISTINGUIR los dos casos (antes se confundian comparando HEAD, y todo era "conflicto"):
    if (r.matado) {
      // El proceso git NO termino por si mismo (timeout/kill): el repo puede estar A MEDIAS.
      // NO se hace 'merge --abort' a ciegas — con el indice a medias suele fallar y enmascara el
      // problema real. Se informa con precision para que se revise a mano.
      console.log(`  ⛔ ${rama}: el proceso 'git merge' NO termino (posible cuelgue o repo muy grande). El repositorio puede haber quedado A MEDIAS.`);
      console.log(`     Revisa a mano ANTES de reintentar:  git -C "${ROOT}" status  ·  si hay un merge a medias: git merge --abort  ·  si sobra .git/index.lock (sin git vivo): borralo.`);
      break; // no se sigue con mas ramas sobre un estado incierto
    }
    // exit != 0 con proceso terminado = conflicto REAL (o merge rechazado): abortable con seguridad.
    const ab = gitWrite('merge', '--abort');
    console.log(`  ⚠ ${rama} NO integrada (conflicto real): resuelvela a mano.${ab.ok ? ' (merge abortado, develop intacto)' : ' (ATENCION: el abort tambien fallo — revisa git status)'}`);
    if (r.salida) console.log(`     git dijo: ${r.salida.split('\n').slice(0, 3).join(' | ')}`);
  }
  if (cur !== 'develop' && cur) git('switch', cur);
  if (done.length) {
    console.log(`\n✅ Consolidadas ${done.length} rama[s] en develop. Subiendo develop...`);
    // DEVELOP PROTEGIDA en la forja (#194): subirOIntegrar sube develop local (merges + commit previo) a
    // una rama temporal, la integra por peticion con el token del harness, verifica y alinea develop.
    const p = await require('./lib/subir.js').subirOIntegrar('develop', { ROOT, gh, titulo: `Consolidar en develop: ${done.join(', ')}` });
    console.log(p.ok ? `✅ develop subido${p.via === 'token' ? ' (con el token del harness)' : p.via === 'api' ? ' (por peticion)' : ''}.` : `⚠ No pude subir develop: ${p.msg}`);
    console.log('Estados actualizados por la validacion. Cuando develop este listo para publicar a main: /faro:publicar.');
    // CIERRE ACTIVO de las tareas integradas. El 'Closes #N' solo cierra la de SU peticion: una rama
    // integrada por merge directo, o varias consolidadas de golpe, dejan tareas vivas cuyo trabajo ya
    // esta en develop. Aqui se cierran de verdad, no se confia en que la forja lo hiciera.
    if (gh && gh.issueEstado && gh.cerrarIssue) {
      const cl = require('./lib/ciclo.js');
      const tareaLib = require('./lib/tarea.js');
      for (const rama of done) {
        const n = issueDeRama(rama);
        let est = null;
        if (n) { try { est = await gh.issueEstado(n); } catch { est = null; } }
        // Si su PR dice 'Refs #N' (#91), la rama avanza la tarea sin terminarla: no se cierra. Sin PR
        // (merge directo) o sin poder consultarlo, manda el numero de la rama, como siempre.
        let soloRef = false;
        if (n && est === 'open' && gh.prsDeRama) {
          try { soloRef = ((await gh.prsDeRama(rama)) || []).some((p) => tareaLib.soloReferencia(p, n)); } catch { soloRef = false; }
        }
        // 'no pude consultar' NO es 'ya esta cerrada': antes las dos caian en el mismo 'continue'
        // silencioso y la tarea se quedaba abierta para siempre sin que nadie se enterara.
        const plan = cl.planCierreDeTarea({ issue: n, estado: est, rama, soloReferencia: soloRef });
        if (plan.nota) console.log(`  ⓘ ${plan.nota}`);
        if (plan.accion === 'avisar') { console.log(`  ⚠ ${plan.aviso}`); continue; }
        if (plan.accion !== 'cerrar') continue;
        const r = await gh.cerrarIssue(n, plan.motivo);
        console.log(r ? `  ✅ Tarea #${n} cerrada (su trabajo ya esta en develop).` : `  ⚠ No pude cerrar la tarea #${n}: cierrala con 'harness.js cerrar-tarea ${n}'.`);
      }
    }
    // DETECCION TEMPRANA de la ligadura cambio <-> tarea. El trabajo se cumple AQUI, en develop: al
    // integrar, el 'Closes #N' cierra la tarea. Si un cambio 'implementada' la tiene todavia abierta,
    // decirlo AHORA (barato de arreglar) y no en /faro:publicar, que ya es el ultimo cierre.
    if (gh && gh.issueEstado) {
      const cl = require('./lib/ciclo.js');
      for (const s of listSpecs().filter((x) => x.fm.estado === 'implementada' && x.fm.issue)) {
        let est = null;
        try { est = await gh.issueEstado(String(s.fm.issue)); } catch { est = null; }
        // Sin poder consultar no se puede afirmar que la ligadura este bien NI que este mal: se dice
        // que no se comprobo, en vez de dejar creer que se comprobo y salio limpia.
        if (est === null) { console.log(`\n⚠ no pude consultar la tarea #${s.fm.issue} del cambio '${s.name}' (¿sin red o token?): su ligadura NO queda comprobada.`); continue; }
        const msg = cl.coherenciaCambioIssue({ slug: s.name, estado: s.fm.estado, issue: String(s.fm.issue), issueEstado: est, archivando: false });
        if (msg) console.log(`\n⚠ ${msg}`);
      }
    }
    // CIERRE DETERMINISTA (#71): ademas de las ramas de esta pasada, cualquier tarea cuyo PR ya este
    // integrado (por la web, la API o una consolidacion anterior) se cierra aqui, y su [x] se marca.
    await reconciliarTareas(gh, { cerrar: true, marcar: true });
    await avisarDesajusteConLaForja(gh);
  } else {
    console.log('\nNada integrado (conflictos). Resuelvelos y reintenta.');
  }
  avisarDevelopSinSubir();
  avisarListoParaPublicar();
}

// ESTADO.md dice una cosa y la forja dice otra: un checkbox marcado [x] cuyo issue sigue ABIERTO es
// trabajo que se dio por hecho sin salir; un issue CERRADO sin marcar es trabajo hecho que el faseo
// no refleja. Las dos direcciones enganan a quien lee el estado.
//
// Se mira en 'consolidar' y 'publicar' — los dos momentos donde aun se puede corregir — y NO en
// 'validate' ni en la sesion: ambas son sincronas y sin red, y volverlas asincronas por esto las
// haria lentas y fragiles en CI y en cada hook de escritura.
//
// AVISA, no bloquea: detectar no es decidir. Puede haber motivos legitimos (la tarea se cerro desde
// la web, el checkbox se marcara en el mismo commit que viene). Y sin token/red/forja no se inventa
// nada: un issue que no se pudo consultar simplemente no cuenta.
// CALCULA los desajustes (no imprime nada). Separado de quien los muestra para poder reutilizarlo
// desde sitios que no escriben en stdout — el vigilante en background señala por stderr.
// ---------- CIERRE DETERMINISTA de tareas (#71) ----------
// UNA regla (lib/tarea.js) decide si una tarea esta hecha a partir de hechos de la forja (PR que la
// referencia fusionado en develop/main). Aqui solo se RECOGE y se EJECUTA segun el modo:
//   cerrar  -> cierra por API las hechas, con el comentario estandar (consolidar, publicar)
//   marcar  -> [x] en ESTADO.md de las lineas '#N' cerradas, con commit propio en develop (la forja manda)
// Siempre deja el resumen en CACHE: la sesion y validate son sincronos y sin red, y leen de ahi.
// Sin forja o sin red: lo dice y no concluye nada ("no pude mirar" no es "no hay nada").
function rutaCacheTareas() { return rutaObservado().replace(/observado-/, 'tareas-'); }
function leerCacheTareas() { try { return JSON.parse(fs.readFileSync(rutaCacheTareas(), 'utf8')); } catch { return null; } }
function guardarCacheTareas(resumen) { try { fs.writeFileSync(rutaCacheTareas(), JSON.stringify({ ts: Date.now(), ...resumen })); } catch { /* sin cache: se recalculara */ } }
// Avisos de la cache para la sesion y validate (sin red). Vacio si no hay cache o no hay nada.
function avisosTareasDeCache() {
  const c = leerCacheTareas();
  if (!c) return [];
  const out = [];
  if ((c.hechasSinCerrar || []).length) out.push(`${c.hechasSinCerrar.length} tarea(s) HECHAS sin cerrar (su PR ya esta integrado): ${c.hechasSinCerrar.map((n) => `#${n}`).join(', ')} — el proximo 'consolidar' o 'publicar' las cierra (las del Backlog, muevelas antes a su fase).`);
  if ((c.mencionadas || []).length) out.push(`${c.mencionadas.length} tarea(s) ABIERTAS que un PR integrado menciona sin cerrarlas: ${c.mencionadas.map((n) => `#${n}`).join(', ')} — si estan hechas, 'harness.js cerrar-tarea <N>'; en adelante, 'Closes #N' en el PR.`);
  // BANDEJA DE ENTRADA (#84): sin hito no es un fallo, es lo pendiente de triar (lo que llega de fuera).
  if ((c.bandeja || []).length) out.push(`${c.bandeja.length} en la BANDEJA DE ENTRADA sin triar (sin hito o 'reporte'): ${c.bandeja.slice(0, 8).map((n) => `#${n}`).join(', ')}${c.bandeja.length > 8 ? '…' : ''} — /faro:triaje (lista: harness.js triaje --bandeja).`);
  if ((c.sinEvidencia || []).length) out.push(`${c.sinEvidencia.length} tarea(s) cerradas SIN evidencia (ningun PR integrado las referencia): ${c.sinEvidencia.map((n) => `#${n}`).join(', ')} — confirma que se hicieron, o reabrelas.`);
  return out;
}

// 'Publicada en vX' en las tareas hechas cuyo commit de merge entra en este tag y no en el anterior.
// 'texto' (opcional, #131): en un monorepo un mismo merge publica varios tags de app; la tarea se
// anota UNA vez con todos ('api@1.3.0, web@0.4.0'), midiendo con el primero.
async function comentarPublicadas(gh, rec, tag, texto = tag) {
  if (!rec || !gh || !gh.comentarIssue) return;
  const previo = git('describe', '--tags', '--abbrev=0', `${tag}^`);
  const dentro = (sha) => sha && gitWrite('merge-base', '--is-ancestor', sha, tag).ok && !(previo && gitWrite('merge-base', '--is-ancestor', sha, previo).ok);
  const nuevas = rec.evaluaciones.filter((e) => e.estado === 'hecha' && e.evidencia && dentro(e.evidencia.commit));
  let n = 0;
  for (const e of nuevas) if (await gh.comentarIssue(e.numero, `Publicada en ${texto} (PR #${e.evidencia.pr}).`)) n++;
  if (n) console.log(`\n🏷  ${n} tarea(s) anotadas como publicadas en ${texto}: ${nuevas.map((e) => `#${e.numero}`).join(', ')}.`);
}

async function reconciliarTareas(gh, { cerrar = false, marcar = false, version = null, silencioso = false } = {}) {
  const log = (s) => { if (!silencioso) console.log(s); };
  if (!gh || !gh.hechosTareas) return null;
  let hechos = null;
  try { hechos = await gh.hechosTareas(); } catch { hechos = null; }
  if (!hechos) { log('\n⚠ No pude consultar la forja (¿sin red o token?): el cierre de tareas NO se comprobo.'); return null; }
  const tarea = require('./lib/tarea.js');
  const r = tarea.reconciliar(hechos);
  // BANDEJA DE ENTRADA (#84): lo pendiente de triar, recuperado por "abierto sin hito o 'reporte'".
  const catalogo = ((faroSchema() || {}).enums || {}).labels || [];
  r.resumen.bandeja = tarea.bandejaDeEntrada(hechos.issues, catalogo).map((e) => e.numero);
  if (r.resumen.bandeja.length) log(`  ⓘ ${r.resumen.bandeja.length} en la bandeja de entrada sin triar — /faro:triaje (harness.js triaje --bandeja).`);
  const cerradas = new Set(hechos.issues.filter((i) => i.state === 'closed' && i.state_reason !== 'not_planned').map((i) => i.number));
  if (cerrar && gh.cerrarIssue) {
    for (const e of r.porCerrar) {
      const ok = await gh.cerrarIssue(e.numero, tarea.comentarioDeCierre(e, { version }));
      if (ok) { cerradas.add(e.numero); r.resumen.hechasSinCerrar = r.resumen.hechasSinCerrar.filter((n) => n !== e.numero); }
      // La epica del planificador, si su milestone la lleva: el issue ya trae el milestone, sin otra llamada (#218).
      const iss = hechos.issues.find((i) => i.number === e.numero);
      const pl = planificacion(); const epica = pl ? pl.lineaEpica(iss && iss.milestone) : '';
      log(ok ? `  ✅ Tarea #${e.numero} cerrada: PR #${e.evidencia.pr} integrado en ${e.evidencia.base}.${epica ? ` ${epica}` : ''}` :`  ⚠ No pude cerrar la tarea #${e.numero}: cierrala con 'harness.js cerrar-tarea ${e.numero}'.`);
    }
  } else if (r.porCerrar.length) {
    log(`\n⚠ ${r.porCerrar.length} tarea(s) HECHAS sin cerrar: ${r.porCerrar.map((e) => `#${e.numero} (PR #${e.evidencia.pr})`).join(', ')}.`);
  }
  for (const e of r.enBacklog) log(`  ⚠ Tarea #${e.numero} hecha (PR #${e.evidencia.pr}) pero sigue en el Backlog: muevela a su fase —  harness.js mover-tarea ${e.numero} --hito <N>  — y se cerrara.`);
  for (const e of r.mencionadas) log(`  ? Tarea #${e.numero} abierta: el PR #${e.evidencia.pr} integrado la menciona, pero sin 'Closes'. Si esta hecha: harness.js cerrar-tarea ${e.numero}.`);
  for (const e of r.sinEvidencia) log(`  ⚠ Tarea #${e.numero} cerrada SIN evidencia (ningun PR integrado la referencia): confirma que se hizo.`);
  guardarCacheTareas(r.resumen);
  if (marcar) marcarTareasEnEstado(cerradas, log);
  return r;
}

// [x] en ESTADO.md de lo cerrado, con commit propio en develop. Se escribe en develop (donde vive la
// integracion) y se vuelve a la rama en la que se estaba. Si no hay ESTADO.md (motor) o nada que
// marcar, no hace nada.
function marcarTareasEnEstado(cerradas, log) {
  const ruta = path.join(ROOT, ESTADO_FILE);
  if (!cerradas.size || !fs.existsSync(ruta)) return;
  const cur = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (cur !== 'develop') { git('switch', 'develop'); if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'develop') { log(`  ⚠ No pude cambiar a develop para marcar ${ESTADO_FILE}: marca los [x] a mano.`); return; } }
  try {
    const { texto, marcadas } = require('./lib/tarea.js').marcarEnEstado(fs.readFileSync(ruta, 'utf8'), cerradas);
    if (!marcadas.length) return;
    fs.writeFileSync(ruta, texto, 'utf8');
    gitWrite('add', ESTADO_FILE);
    const c = gitWrite('commit', '-m', `chore(estado): [x] de tareas cerradas en la forja (${marcadas.map((n) => `#${n}`).join(', ')})`);
    if (c.ok) {
      const p = require('./lib/subir.js')(['develop'], { ROOT });
      log(`  ✅ ${ESTADO_FILE}: marcadas [x] ${marcadas.map((n) => `#${n}`).join(', ')}${p.ok ? ' (subido)' : p.rechazado ? ' — develop esta protegida: sube con el proximo /faro:publicar (por peticion)' : ` — no pude subir develop: ${p.msg}`}.`);
    }
  } finally { if (cur && cur !== 'develop') git('switch', cur); }
}

async function calcularDesajustes(gh) {
  const vacio = { desajustes: [], estados: {}, fases: [] };
  if (!gh || !gh.issueEstado) return vacio;
  const ini = parseEstado();
  if (!ini || !ini.fases || !ini.fases.length) return vacio;
  const cl = require('./lib/ciclo.js');
  const abiertas = ini.fases.filter((f) => !isDone(f.estado));
  const ids = new Set();
  for (const f of abiertas) {
    for (const t of (f.tareas || [])) {
      const ref = cl.refDeTarea(t.text);
      if (ref && ref.issue) ids.add(String(ref.issue));
    }
  }
  if (!ids.size) return vacio;
  const estados = {};
  for (const id of ids) {
    try { const e = await gh.issueEstado(id); if (e) estados[id] = e; } catch { /* no se pudo mirar: no cuenta */ }
  }
  // Se devuelven tambien los ESTADOS y las FASES, no solo los desajustes: el vigilante los compara
  // con lo que vio la ultima vez para poder explicar QUE PASO, no solo que algo no cuadra.
  return { desajustes: cl.desajustesDelFaseo(abiertas, estados), estados, fases: abiertas };
}

async function avisarDesajusteConLaForja(gh) {
  const { desajustes } = await calcularDesajustes(gh);
  if (!desajustes.length) return;
  console.log(`\n⚠ ${ESTADO_FILE} y la forja NO dicen lo mismo (${desajustes.length}; no bloquea):`);
  for (const d of desajustes.slice(0, 8)) console.log(`  - ${d}`);
  if (desajustes.length > 8) console.log(`  (+${desajustes.length - 8} mas)`);
  console.log(`  La forja manda: el proximo 'consolidar' cierra lo hecho y marca sus [x]. Un [x] con la tarea abierta: cierrala (harness.js cerrar-tarea <N>) o desmarcala.`);
}

// CONTRATO (capa 2 de verificacion): ¿lo que el codigo EXPONE sigue siendo lo que el documento dice
// que expone? Los gates responden "¿compila? ¿pasan los tests?" y la evidencia "¿esta probado lo
// pactado?". Esta es la tercera, y es la que rompe integraciones AJENAS: alguien anade una ruta o un
// campo, actualiza SUS tests, todo verde... y el funcional que leyo el cliente ya no describe la
// realidad. Nadie se entera hasta que un tercero integra contra el papel y se estrella.
//
// AVISA, no bloquea: la deriva puede ser deliberada (se amplio el alcance, toca actualizar el doc) o
// un descuido, y quien lo sabe es el humano. Como gate se sortearia borrando la linea del documento,
// que es justo lo contrario de lo que se busca.
// ---------- Hexagonal (#280): las dependencias reales contra las capas que declara ARCHITECTURE.md ----------
// CABLEADO: el dominio (lib/hexagonal.js) recibe textos; el adaptador de disco (lib/hexagonal-fuentes.js)
// los lee de cada base. En un monorepo cada app se mide con SU contrato (apps/<x>/ARCHITECTURE.md).
function hexagonalBases() {
  if (require('./lib/apps.js').esMonorepo(ROOT)) {
    return require('./lib/apps.js').apps(ROOT, { schema: faroSchema() })
      .filter((a) => a.existe && a.tipo === 'app' && a.contrato).map((a) => ({ id: a.id, base: a.ruta }));
  }
  return fs.existsSync(path.join(ROOT, 'ARCHITECTURE.md')) ? [{ id: null, base: '' }] : [];
}
function hexagonalDe(b) {
  const HX = require('./lib/hexagonal.js');
  const { arquitectura, ficheros } = require('./lib/hexagonal-fuentes.js')({ fs, path, ROOT }).leerBase(b.base);
  const declaracion = HX.leerDeclaracion(arquitectura);
  const res = HX.comprobar(declaracion, ficheros);
  return { app: b.id, base: b.base || '.', declaracion, ...res, ficheros };
}
function hexagonalEnValidate(errs, warns, gate) {
  let bases = [];
  try { bases = hexagonalBases(); } catch { return; }
  for (const b of bases) {
    const r = hexagonalDe(b);
    const donde = b.id ? `app ${b.id}` : 'ARCHITECTURE.md';
    if (!r.declaracion.declarada) { warns.push(`[hexagonal] ${donde} no declara la sección '## Hexagonal': propuesta y pasos de migración con harness.js hexagonal --plan${b.id ? ` ${b.id}` : ''}`); continue; }
    if (r.conforme) continue;
    const det = [...r.errores, ...r.violaciones.slice(0, 5).map((v) => `${b.base && b.base !== '.' ? `${b.base}/` : ''}${v.rel}:${v.linea} ${v.regla} (${v.detalle})`)];
    const msg = `[hexagonal] ${donde}: ${r.violaciones.length} violación(es)${r.errores.length ? ' y declaración incompleta' : ''} — ${det.join(' · ')}${r.violaciones.length > 5 ? ' …' : ''} (detalle: harness.js hexagonal)`;
    (gate ? errs : warns).push(msg);
  }
}
function cmdHexagonal() {
  const HX = require('./lib/hexagonal.js');
  const args = process.argv.slice(3);
  const appId = args.find((x) => !x.startsWith('-'));
  const json = args.includes('--json');
  const plan = args.includes('--plan');
  let bases = hexagonalBases();
  if (require('./lib/apps.js').esMonorepo(ROOT)) {
    if (appId) {
      const a = require('./lib/apps.js').apps(ROOT, { schema: faroSchema() }).find((x) => x.id === appId);
      if (!a) { console.log(`La app '${appId}' no existe en este monorepo (harness.js apps).`); process.exit(1); }
      bases = [{ id: a.id, base: a.ruta }];
    }
  } else if (!bases.length) bases = plan ? [{ id: null, base: '' }] : [];
  if (!bases.length) {
    console.log('hexagonal: no hay ARCHITECTURE.md (repo sin código o sin contrato): nada que comprobar. /faro:code lo crea con la sección «## Hexagonal».');
    return;
  }
  const resultados = bases.map(hexagonalDe);
  if (plan) {
    const planes = resultados.map((r) => ({ app: r.app, base: r.base, plan: HX.planMigracion(r.ficheros) }));
    if (json) { console.log(JSON.stringify(planes.length === 1 ? planes[0] : planes, null, 2)); return; }
    planes.forEach((p, i) => { if (i) console.log(''); HX.pintarPlan(p.app ? `app ${p.app}` : p.base, p.plan).forEach((l) => console.log(l)); });
    return;
  }
  const sinFicheros = resultados.map(({ ficheros, ...r }) => r);
  if (json) console.log(JSON.stringify(sinFicheros.length === 1 ? sinFicheros[0] : sinFicheros, null, 2));
  else resultados.forEach((r) => HX.pintar(r.app ? `app ${r.app}` : r.base, r.declaracion, r).forEach((l) => console.log(l)));
  if (resultados.some((r) => r.declaracion.declarada && !r.conforme)) process.exit(1);
}

function cmdContrato() {
  if (require('./lib/apps.js').esMonorepo(ROOT)) {
    contratoPorApp(process.argv.slice(3).find((x) => !x.startsWith('-')));
    return;
  }
  // El contrato documentado se busca donde de verdad se escribe: el funcional declarado y el
  // documento de arquitectura. No se inventa un formato nuevo — se lee lo que ya hay.
  const docs = [];
  try { const fp = funcionalPath(); if (fp) docs.push({ rel: fp, texto: fs.readFileSync(path.join(ROOT, fp), 'utf8') }); } catch { /* sin funcional */ }
  try {
    const dir = path.join(ROOT, DOCS, 'arquitectura');
    for (const f of fs.readdirSync(dir).filter((x) => /\.md$/i.test(x))) {
      docs.push({ rel: `${DOCS}/arquitectura/${f}`, texto: fs.readFileSync(path.join(dir, f), 'utf8') });
    }
  } catch { /* sin doc de arquitectura */ }
  try { docs.push({ rel: 'ARCHITECTURE.md', texto: fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8') }); } catch { /* no existe */ }

  informarContrato(docs, codigoDeSrc(''), 'src/');
}

// El codigo de <base>/src (base '' = la raiz), y solo lo que puede registrar rutas. Sin recursion
// infinita ni node_modules. 'rel' sale relativo a la raiz, para que el aviso diga a que fichero ir.
function codigoDeSrc(base) {
  const codigo = [];
  const EXT = /\.(js|mjs|cjs|ts|tsx|jsx)$/i;
  const SALTAR = /(^|[\\/])(node_modules|dist|build|\.git|coverage)([\\/]|$)/;
  (function recorrer(dir, rel) {
    let entradas = [];
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SALTAR.test(r)) continue;
      if (e.isDirectory()) recorrer(path.join(dir, e.name), r);
      else if (EXT.test(e.name)) {
        try { codigo.push({ rel: r, texto: fs.readFileSync(path.join(dir, e.name), 'utf8') }); } catch { /* ilegible */ }
      }
    }
  })(path.join(ROOT, base, 'src'), base ? `${base}/src` : 'src');
  return codigo;
}

// MONOREPO (#132): el contrato de cada app es apps/<x>/ARCHITECTURE.md contra apps/<x>/src. Con
// <app>, solo esa; sin ella, todas las apps que tienen contrato. CLI: harness.js contrato [app].
function contratoDeApp(a) {
  console.log(`[${a.id}] ${a.contrato}`);
  informarContrato([{ rel: a.contrato, texto: fs.readFileSync(path.join(ROOT, a.contrato), 'utf8') }], codigoDeSrc(a.ruta), `${a.ruta}/src/`);
}
function contratoPorApp(appId) {
  const lista = require('./lib/apps.js').apps(ROOT, { schema: faroSchema() }).filter((a) => a.existe && a.tipo === 'app');
  if (appId) {
    const a = lista.find((x) => x.id === appId);
    if (!a) {
      console.log(`La app '${appId}' no existe en este monorepo. Apps: ${lista.map((x) => x.id).join(', ') || 'ninguna'} (harness.js apps).`);
      process.exit(1);
    }
    if (!a.contrato) { console.log(`La app '${a.id}' no tiene contrato (${a.ruta}/ARCHITECTURE.md): no hay nada que contrastar.`); return; }
    contratoDeApp(a);
    return;
  }
  const conContrato = lista.filter((a) => a.contrato);
  if (!conContrato.length) {
    console.log('Ninguna app del monorepo tiene contrato (apps/<x>/ARCHITECTURE.md): no hay nada que contrastar.');
    return;
  }
  conContrato.forEach((a, i) => { if (i) console.log(''); contratoDeApp(a); });
  const sin = lista.filter((a) => !a.contrato).map((a) => a.id);
  if (sin.length) console.log(`\nApps sin contrato (no se contrastan): ${sin.join(', ')}.`);
}

// Contrasta un contrato documentado con un codigo e imprime el resultado. 'donde' nombra lo que se
// recorrio, para el mensaje de "no aplica".
function informarContrato(docs, codigo, donde) {
  const mod = require('./lib/contrato.js');
  const d = mod.derivaDeContrato(docs.map((x) => x.texto).join('\n'), codigo);
  const nombreDoc = docs.length ? docs.map((x) => x.rel).join(' + ') : 'la documentacion';

  if (!d.documentados && !d.implementados) {
    console.log(`Sin endpoints ni en la documentacion ni en ${donde}: aqui no hay contrato de API que contrastar.`);
    return;                                   // no es "cuadra": es que no aplica
  }
  console.log(`Contrato de API · documentados: ${d.documentados} · en codigo: ${d.implementados} · coinciden: ${d.coinciden}`);
  const aviso = mod.avisoDeriva(d, { doc: nombreDoc });
  if (!aviso) { console.log('✅ El codigo expone exactamente lo que la documentacion dice.'); return; }
  console.log(`\n⚠ DERIVA DE CONTRATO:\n${aviso}`);
}

// TRIAJE de lo que llega de fuera (reportes, peticiones, ideas). No CLASIFICA — JUZGA: dice si algo
// merece hacerse y POR QUE, citando lo escrito (el fuera de alcance del funcional, los requisitos y
// los ADR). Sin nada escrito contra lo que juzgar no inventa criterio: dice que falta decidir.
//
// Imprime JSON para que el skill lo orqueste (preguntar al usuario, publicar el comentario en el
// issue). El harness da el DIAGNOSTICO; quien decide y quien escribe en la forja es el flujo de
// arriba, con el usuario delante.
function criterioDisponible() {
  const triaje = require('./lib/triaje.js');
  let funcional = '';
  try { const fp = funcionalPath(); if (fp) funcional = fs.readFileSync(path.join(ROOT, fp), 'utf8'); } catch { /* sin funcional */ }

  const dir = path.join(ROOT, `${SP}/decisions`);
  const decisiones = [];
  try {
    for (const f of fs.readdirSync(dir).filter((x) => /\.md$/i.test(x))) {
      const texto = fs.readFileSync(path.join(dir, f), 'utf8');
      const fm = parseFrontmatter(texto) || {};
      decisiones.push({ archivo: `${SP}/decisions/${f}`, titulo: fm.title || f.replace(/\.md$/i, ''), status: fm.status || '', texto, legacy: adrEsLegacy(f) });
    }
  } catch { /* sin decisiones */ }

  const requisitos = parseRequisitos() || [];
  return { triaje, funcional, decisiones, requisitos };
}

// BANDEJA DE ENTRADA (#84): lo que espera triaje, recuperado de la forja por "abierto sin hito o con
// 'reporte'" — no depende de ningun hito ni del canal por el que llego (Userback, web, formulario).
async function cmdTriajeBandeja() {
  const gh = forjaMod();
  if (!gh || !gh.hechosTareas) { console.log('Sin forja con API (o sin token): no puedo leer la bandeja. Conecta con: harness.js auth'); return; }
  let hechos = null;
  try { hechos = await gh.hechosTareas(); } catch { hechos = null; }
  if (!hechos) { console.log('No pude consultar la forja (¿sin red o token?): la bandeja NO se ha leido.'); return; }
  const catalogo = ((faroSchema() || {}).enums || {}).labels || [];
  const b = require('./lib/tarea.js').bandejaDeEntrada(hechos.issues, catalogo);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(b, null, 2)); return; }
  if (!b.length) { console.log('Bandeja de entrada vacia: no hay nada esperando triaje.'); return; }
  console.log(`BANDEJA DE ENTRADA — ${b.length} sin triar (la mas antigua primero):`);
  for (const e of b) {
    const senales = [e.tipo ? `tipo sugerido: ${e.tipo}` : 'sin tipo', e.origen ? `origen: ${e.origen}` : null,
      e.votos ? `${e.votos} 👍` : null, e.comentarios ? `${e.comentarios} comentario(s)` : null, e.deFuera ? 'de fuera' : 'del equipo'].filter(Boolean);
    console.log(`  #${e.numero} ${e.titulo}\n     ${senales.join(' · ')} · hace ${e.dias}d`);
  }
  console.log("\nTriar uno: /faro:triaje <N> — si APLICA recibe tipo, plantilla y hito (mover-tarea <N> --hito <K|backlog>); si no, se cierra como 'not_planned' con el motivo.");
}

// ADJUNTOS de un issue (#108): capturas y documentos del cuerpo y de los comentarios, descargados para
// que el agente los LEA antes del veredicto. Acepta '<N>' (este repo) u 'org/repo#N'.
async function cmdTriajeAdjuntos() {
  const ref = String(process.argv[4] || '');
  const m = ref.match(/^(?:([\w.-]+(?:\/[\w.-]+)+)#)?(\d+)$/);
  if (!m) { console.log('Uso: harness.js triaje adjuntos <N> | <proyecto>#<N>'); return; }
  const fm = forjaMod();
  if (!fm) { console.log('Sin forja con API: no puedo leer la tarea.'); return; }
  const leido = await fm.adjuntosDeIssue(m[2], m[1]);
  if (leido.sinToken) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth  (codigo de 6 digitos).'); return; }
  if (!leido.ok) { console.log(leido.msg); return; }
  const adj = require('./lib/adjuntos.js');
  const encontrados = adj.extraerAdjuntos(leido.textos.join('\n\n'));
  if (!encontrados.length) { console.log(JSON.stringify({ issue: leido.nombre, adjuntos: [] }, null, 2)); return; }
  const dir = path.join(require('os').tmpdir(), 'faro-triaje', leido.carpeta);
  const res = await adj.descargar(encontrados, dir, { token: leido.token, ghHost: leido.host });
  console.log(JSON.stringify({ issue: leido.nombre, carpeta: dir, adjuntos: res }, null, 2));
}

function cmdTriaje() {
  if (process.argv.includes('--bandeja')) return cmdTriajeBandeja();
  if (process.argv[3] === 'adjuntos') return cmdTriajeAdjuntos();
  const { triaje, funcional, decisiones, requisitos } = criterioDisponible();
  const arg = process.argv[3] || '';

  // Sin argumento: DIAGNOSTICO del criterio disponible. Es lo primero que hay que mirar en un repo
  // que adopta FARO — si no hay criterio, el triaje solo puede devolver "falta decidir" a todo, y
  // mas vale saberlo antes de usarlo que despues.
  if (!arg || arg === '--criterio') {
    const c = triaje.criterioDelRepo({ funcional, decisiones, requisitos });
    console.log(JSON.stringify({
      ...c,
      funcional: funcionalPath() || null,
      decisionesLegacy: decisiones.filter((d) => d.legacy && triaje.seccionesQueFaltan(d).length)
        .map((d) => ({ archivo: d.archivo, faltan: triaje.seccionesQueFaltan(d), preguntas: triaje.preguntasADR(d) })),
    }, null, 2));
    return;
  }

  // Con argumento: juzga UN reporte. Se acepta JSON ({titulo, cuerpo}) o texto suelto, porque esto
  // se invoca tanto desde el skill (que ya tiene el issue) como a mano para probar un criterio.
  let reporte;
  try { reporte = JSON.parse(arg); } catch { reporte = { titulo: arg, cuerpo: process.argv[4] || '' }; }
  const juicio = triaje.juzgar({
    titulo: reporte.titulo || '', cuerpo: reporte.cuerpo || '',
    requisitos, decisiones, fueraAlcance: triaje.fueraDeAlcance(funcional),
  });
  console.log(JSON.stringify({ ...juicio, comentario: triaje.comentario(juicio, { titulo: reporte.titulo || '' }) }, null, 2));
}

// VIGILANTE EN BACKGROUND. Consulta la forja y SEÑALA al agente solo si hay algo que decir.
//
// Existe porque los avisos que necesitan RED no caben en ningun hook sincrono: 'session' y 'validate'
// no tocan la red a proposito (volverlos asincronos los haria lentos y fragiles en CI y en cada hook
// de escritura), asi que el aviso de desajuste acabo desterrado a 'consolidar'/'publicar' — donde
// solo se ve si alguien invoca esos comandos.
//
// Contrato con el hook (campo 'asyncRewake' del handler, documentado en code.claude.com/docs/en/hooks):
// corre en background sin bloquear y DESPIERTA al agente si sale con codigo 2, mostrandole el stderr
// como system reminder. De ahi que aqui se escriba por stderr y no por stdout.
//
// SILENCIO cuando todo cuadra, y es lo mas importante del diseño: un aviso que salta siempre se
// aprende a ignorar, y entonces deja de avisar de nada (la evidencia sobre alert fatigue es dura:
// ~62% de las alertas se ignoran por volumen). Sin desajustes, sale con 0 y nadie se entera de que
// esto corrio.
// El registro de lo OBSERVADO vive fuera del repo, en el directorio persistente del plugin: es
// estado derivado (se reconstruye leyendo la forja), versionarlo generaria conflictos de merge en
// cada rama, y no aporta nada al historial del proyecto.
function rutaObservado() {
  const base = process.env.CLAUDE_PLUGIN_DATA || path.join(require('os').tmpdir(), 'faro-observado');
  try { fs.mkdirSync(base, { recursive: true }); } catch {}
  // Una entrada por repo: la misma maquina trabaja en varios, y mezclarlos daria falsos cambios.
  const repo = (forgeInfo().path || ROOT).replace(/[^\w.-]+/g, '-');
  return path.join(base, `observado-${repo}.json`);
}

async function cmdVigilar() {
  // '--ahora': la MISMA comprobacion, pero a peticion y en claro. Existe porque el vigilante solo
  // corre en SessionStart, y a mitad de sesion la unica via era lanzar 'session' entero y filtrar su
  // salida con grep: ~14s BLOQUEANDO el hilo para sacar dos lineas, recalculando todo lo demas.
  // Ademas, en un repo LEGACY recien adoptado el primer arranque no tiene foto anterior con la que
  // comparar, asi que el vigilante calla — y quien pregunta se queda sin respuesta.
  // Sale con 0 SIEMPRE: aqui lo pide un humano, y un exit 2 se leeria como fallo del comando.
  const aPeticion = process.argv.includes('--ahora');

  // RECONOCIMIENTO de un repo que aun no usa FARO. El analisis en si era util —el usuario lo queria—;
  // lo que sobraba era hacerlo BLOQUEANDO el arranque y, de paso, ordenar crear ESTADO.md antes de
  // nada. Aqui se hace en segundo plano: el arranque devuelve el control al instante y el retrato
  // llega despues, como aviso. Solo la PRIMERA vez por repo: repetirlo en cada sesion seria el mismo
  // martillo con otro tono.
  if (SIN_ADOPTAR && !aPeticion) {
    const marca = path.join(path.dirname(rutaObservado()), `reconocido-${path.basename(rutaObservado())}`);
    if (fs.existsSync(marca)) process.exit(0);          // ya se conto: silencio
    try {
      const rec = require('./lib/reconocer.js');
      const rutas = (git('ls-files') || '').split('\n').map((s) => s.trim()).filter(Boolean);
      // Historia: un repo con anos de commits no se adopta igual que uno de ayer.
      const commits = Number(git('rev-list', '--count', 'HEAD')) || null;
      const autores = (git('shortlog', '-sn', '--all') || '').split('\n').filter(Boolean).length || null;
      const desde = (git('log', '--reverse', '--format=%ad', '--date=short') || '').split('\n')[0] || null;
      // Globs del workspace (si lo hay) para que el retrato vea las apps del monorepo y su stack.
      const workspaces = require('./lib/apps.js').workspace(ROOT).globs;
      const texto = rec.retrato(rec.reconocer(rutas, { commits, autores, desde, workspaces }), { adoptado: false });
      try { fs.writeFileSync(marca, new Date().toISOString()); } catch { /* sin marca: se repetira, no es grave */ }
      if (texto) { process.stderr.write(`${texto}\n`); process.exit(2); }
    } catch { /* sin git o repo raro: no se cuenta nada */ }
    process.exit(0);
  }

  // Cierre de tareas (#71): detectar y dejar la cache para la sesion y validate. Aqui NUNCA se cierra
  // nada — eso es de consolidar/publicar, que son decisiones; el vigilante solo mira.
  try { await reconciliarTareas(forjaMod(), { silencioso: !aPeticion }); } catch { /* sin forja/red */ }

  let res = { desajustes: [], estados: {}, fases: [] };
  try { res = await calcularDesajustes(forjaMod()); } catch { /* sin forja/red: nada que vigilar */ }
  const { desajustes, estados, fases } = res;

  if (aPeticion) {
    if (!Object.keys(estados).length) {
      console.log('No pude consultar la forja (sin token, sin red o sin tareas con #N en el faseo): no se nada del estado real.');
      console.log('Eso NO quiere decir que cuadre — quiere decir que no lo se.');
      process.exit(0);
    }
    if (!desajustes.length) {
      console.log(`${ESTADO_FILE} y la forja dicen lo mismo (${Object.keys(estados).length} tarea(s) consultada(s)).`);
      process.exit(0);
    }
    console.log(`${ESTADO_FILE} y la forja NO dicen lo mismo (${desajustes.length}):`);
    for (const d of desajustes) console.log(`  - ${d}`);
    console.log(`\nLa forja manda: el proximo 'consolidar' cierra lo hecho y marca sus [x] en ${ESTADO_FILE}. Un [x] con la tarea abierta: cierrala (harness.js cerrar-tarea <N>) o desmarcala.`);
    process.exit(0);
  }

  // REGISTRO de lo observado: comparar con la vez anterior es lo que permite explicar QUE PASO en
  // vez de solo "esto no cuadra". Sin la foto anterior, un checkbox sin marcar con el issue cerrado
  // y un checkbox marcado con el issue abierto se ven iguales — y son problemas OPUESTOS.
  const cl = require('./lib/ciclo.js');
  const js = require('./lib/json-seguro.js');
  const ruta = rutaObservado();
  const previo = js.leerJson(ruta, null);
  const cambios = cl.cambiosObservados(previo && previo.estados, estados);
  const porIssue = Object.fromEntries(cambios.map((c) => [c.issue, { ...c, cuando: new Date().toISOString() }]));

  // Solo se guarda si se pudo consultar algo: con la forja caida, guardar un mapa vacio borraria la
  // foto anterior y con ella la capacidad de explicar el proximo cambio.
  if (Object.keys(estados).length) {
    const historia = (previo && previo.cambios) || [];
    js.escribirJsonAtomico(ruta, {
      estados,
      visto: new Date().toISOString(),
      // Se guardan los ultimos 50 cambios, no todos: esto es una ayuda para explicar lo reciente, no
      // un archivo historico. Un fichero que crece sin limite acaba sin que nadie lo mire.
      cambios: [...historia, ...Object.values(porIssue)].slice(-50),
    }, 0o600);
  }

  // DESFASE con el remoto en las ramas de INTEGRACION. Se comprueba AQUI y no en 'session' porque
  // exige 'fetch' —una operacion de RED— y el arranque es sincrono: meterlo alli alargaria cada
  // sesion. En background no cuesta espera a nadie.
  //
  // fetch --all --prune, avance seguro de main/develop, tu rama frente a su remoto y las ramas remotas
  // pendientes de validar (#106). Si el fetch falla lo dice: comparar con refs viejas diria "estas al
  // dia" con doce commits de retraso, que es peor que no decir nada.
  //
  // CRITERIO bloqueo/aviso (#124): exit 2 DESPIERTA al agente y la plataforma lo presenta como error
  // de bloqueo, asi que se reserva para lo que el agente DEBE atender (desajustes con la forja, base
  // movida, rama por detras/divergida, remoto sin comprobar). Lo puramente informativo —ramas de
  // otros pendientes de validar— va al HUMANO por systemMessage y sale con 0.
  let desfase = { accion: [], info: [] };
  try {
    const ra = require('./lib/remoto-arranque.js');
    desfase = ra.clasificarAvisos(ra.revisarRemoto(ROOT));
  } catch { /* sin git o sin remoto: nada que comparar */ }
  const avisosDesfase = [...desfase.accion, ...desfase.info];

  if (!desajustes.length && !desfase.accion.length) {
    if (desfase.info.length) process.stdout.write(JSON.stringify({ systemMessage: desfase.info.join('\n') }) + '\n');
    process.exit(0);   // nada que el agente deba resolver: no se le despierta
  }

  if (avisosDesfase.length && !desajustes.length) {
    process.stderr.write(`${avisosDesfase.join('\n')}\n`);
    process.exit(2);
  }

  // Con la historia delante se explica cada desajuste (que paso y cuando); sin ella, se describe.
  const explicados = [];
  for (const f of fases) {
    for (const t of (f.tareas || [])) {
      const ref = cl.refDeTarea(t.text);
      if (!ref || !ref.issue) continue;
      const e = cl.explicarDesajuste({
        issue: ref.issue, titulo: ref.titulo, marcado: !!t.done,
        estadoForja: estados[String(ref.issue)] || null,
        cambio: porIssue[String(ref.issue)] || null,
      });
      if (e) explicados.push(`  - Fase ${f.num}: ${e}`);
    }
  }
  const cuerpo = explicados.length ? explicados : desajustes.slice(0, 8).map((d) => `  - ${d}`);
  const lineas = [
    ...avisosDesfase,                 // el desfase primero: condiciona todo lo demas
    ...(avisosDesfase.length ? [''] : []),
    `${ESTADO_FILE} y la forja NO dicen lo mismo (${desajustes.length}):`,
    ...cuerpo.slice(0, 8),
    ...(cuerpo.length > 8 ? [`  (+${cuerpo.length - 8} mas)`] : []),
  ];
  process.stderr.write(lineas.join('\n'));
  process.exit(2);   // 2 = despierta al agente con lo de arriba
}

// El unico rastro de "develop esta listo para publicar" era una linea de texto perdida en medio de
// mucho output ("Estados actualizados... /faro:publicar."), facil de saltarse en una consolidacion
// ruidosa o en un loop autonomo. Esta linea declara el ESTADO sin ambiguedad, al final, siempre que
// haya algo que publicar y el gate este en verde -- NO pregunta ni ejecuta publicar (eso sigue siendo
// bajo demanda, decision del usuario): solo hace el aviso imposible de pasar por alto.
function avisarListoParaPublicar() {
  invalidarFlow(); // el merge/push de arriba cambio el estado de las ramas: gitFlow() cacheado mentiria
  const flow = gitFlow();
  if (!flow || !flow.mainName || !(flow.aheadOfMain > 0)) return;
  const v = require('child_process').spawnSync(process.execPath, [__filename, 'validate', '--todas'], { windowsHide: true, cwd: ROOT, encoding: 'utf8' });
  if (v.status !== 0) return;   // si el gate no esta en verde, no se declara "listo"
  console.log(`\nESTADO: develop LISTO para publicar (${flow.aheadOfMain} commit(s) sin pasar a ${flow.mainName}, validate OK). Cuando quieras: /faro:publicar.`);
}

// FALLO 2 reportado: el push de develop vivia DENTRO de 'if (done.length)'. Si el merge ya se habia
// completado en una invocacion anterior, la siguiente decia "Nada que consolidar" y NUNCA empujaba:
// develop se quedaba N commits por delante en LOCAL, en silencio (caso real: 51 commits). Ahora se
// comprueba SIEMPRE, se integre algo en esta pasada o no.
function avisarDevelopSinSubir() {
  const local = git('rev-parse', '--verify', '--quiet', 'refs/heads/develop');
  if (!local) return;
  const remoto = git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/develop');
  if (!remoto) { console.log("\nAVISO: 'develop' no existe en origin — subela: git push -u origin develop"); return; }
  const pendientes = git('rev-list', '--count', 'origin/develop..develop');
  const n = pendientes === null ? null : Number(pendientes);
  if (n === null) { console.log("\nAVISO: no pude comparar 'develop' con 'origin/develop' (¿sin fetch?). Comprueba a mano: git fetch origin && git status."); return; }
  if (n > 0) {
    console.log(`\n⚠ develop LOCAL va ${n} commit(s) por delante de origin/develop — SIN SUBIR (el trabajo integrado no ha salido de tu maquina).`);
    console.log('   Subelo:  git push origin develop');
  }
}

// PUBLICAR (develop -> main, el RELEASE; se llamaba 'aprobar' hasta 0.37.0, nombre ya retirado sin
// alias): valida el ROL (API) y que develop este por delante; luego, EN ESTE ORDEN
// (critico para que main quede COMPLETO y sin cambios sueltos):
//   1) ARCHIVA primero los changes 'implementada' (aplica deltas a specs vivas + mueve a archive/).
//      Si alguno falla -> CANCELA sin tocar main (nada a medias).
//   2) COMMITEA en develop TODO lo pendiente (el archivado + cualquier cambio suelto de trabajo).
//   3) VALIDA el gate con todo ya dentro.
//   4) merge develop -> main -> vuelve -> push. Asi el archivado entra en el MISMO main que se aprueba.
// CONFIRMACION EXPLICITA (0.9.5): el rol de GitHub decide QUIEN PUEDE aprobar, pero por si solo NO
// es la aprobacion — un agente con rol de maintainer podia antes invocar este comando y mergear a
// main sin que el USUARIO hubiera confirmado en la conversacion (el comentario historico "invocarlo
// ES tu aprobacion" asumia que solo llegabas aqui tras decidirlo). Ahora, SIN --confirmo, el comando
// se PARA tras mostrar que se aprobaria (no ejecuta el merge); la skill /faro:publicar pasa --confirmo
// SOLO tras el AskUserQuestion explicito al usuario (paso 4 de la skill).
async function cmdPublicar() {
  // REGISTRO antes de tocar produccion: desde que release, cuanto lleva acumulado y que version
  // tocaria. Publicar a ciegas es justo lo que esto evita.
  const info = releaseInfo();
  if (info.hayQuePublicar) console.log(`Acumulado desde ${info.desde}: ${info.ciclos} cambio(s). Version sugerida ${info.sugerida} (${info.razon}).
`);
  const confirmado = process.argv.includes('--confirmo');
  const gh = forjaMod(); if (!gh) { SIN_FORJA('publicar'); return; }
  const flow = gitFlow();
  if (!flow || !flow.develop) { console.log("No hay rama 'develop'. Crea el ciclo: git switch -c develop && git push -u origin develop."); return; }
  const main = flow.mainName || 'main';
  // Issue #2: distinguir "0 = al dia" de "-1 = no pude comparar" — el -1 avisa en vez de callar.
  if (flow.aheadOfMain < 0) { console.log(`No pude comparar develop con '${main}' (¿falta la rama? ¿remoto sin fetch?). Ejecuta: git fetch origin ${main}:${main}  y reintenta.`); return; }
  if (flow.aheadOfMain === 0) { console.log(`Nada que aprobar: '${main}' ya esta al dia con develop.`); return; }
  // Monorepo (#131): que app se publicara, con que version y tag, y cuales no se tocan.
  const releaseApps = lineasReleaseApps('develop');
  if (releaseApps.length) console.log(`${releaseApps.join('\n')}\n`);
  const ri = await gh.roleInfo();
  if (!ri) { console.log('No detecto el repo remoto (origin).'); return; }
  if (ri.sinToken) { console.log('SIN_TOKEN: conectate primero -> node .claude/hooks/harness.js auth (codigo de 6 digitos).'); return; }
  if (!ri.puedeAprobar) { console.log(`NO puedes publicar a '${main}' (rol '${ri.perm}'). Abre el PR a develop (/faro:pr) y pide la publicacion a un owner/admin/maintainer (harness.js pendientes).`); return; }
  if (!confirmado) {
    const subs = (git('log', '--format=%s', `${main}..develop`) || '').split('\n').filter(Boolean);
    console.log(
      `Se APROBARIA develop -> ${main} (${flow.aheadOfMain} commit(s)) como ${ri.perm}:\n` +
      subs.slice(0, 15).map((s) => `  - ${s}`).join('\n') + (subs.length > 15 ? `\n  (+${subs.length - 15} mas)` : '') +
      `\n\nEsto NO se ha aprobado todavia. Confirma con el usuario (AskUserQuestion) y, si dice que si, reinvoca: node "\${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" publicar --confirmo`,
    );
    return;
  }
  const cur = git('rev-parse', '--abbrev-ref', 'HEAD') || 'develop';
  console.log(`Aprobar develop -> ${main} (${flow.aheadOfMain} commit(s)) como ${ri.perm}.`);

  // CI DE LA FORJA (#289): con validacion = ci|ambos, el CI de develop en rojo bloquea ANTES de tocar nada.
  // La suite local completa del paso 3 se mantiene: lleva el commit de archivado que el CI no ha visto.
  {
    const eci = require('./lib/estado-ci.js');
    let meta = null; try { meta = JSON.parse(fs.readFileSync(path.join(ROOT, CONFIG_FILE), 'utf8')); } catch { meta = null; }
    const modoV = eci.modoValidacion(meta);
    if (eci.consultaCi(modoV) && gh.estadoCiCommit) {
      const sha = git('rev-parse', '--verify', '--quiet', 'refs/remotes/origin/develop');
      const e = sha ? await gh.estadoCiCommit(sha) : null;
      const dp = eci.decidirPublicar({ modo: modoV, estado: e && e.ok ? e.estado : 'sin-ci', fallidos: (e && e.fallidos) || [] });
      if (dp.aviso) console.log(dp.aviso);
      if (dp.bloquear) { console.log(`\nAPROBACION CANCELADA: arregla el CI de develop y reintenta. No he tocado '${main}'.`); return; }
    }
  }

  // Debemos operar sobre develop (el archivado y su commit se hacen ANTES del merge, sobre develop).
  // Issue #2: develop puede no existir en LOCAL (repo clonado tras trabajar en feature/*, o recien
  // clonado); se crea la rama de tracking desde origin/develop antes de intentar el switch.
  if (cur !== 'develop') {
    if (!flow.developLocal && flow.developRemote) {
      git('fetch', 'origin', 'develop');
      git('switch', '-c', 'develop', '--track', 'origin/develop');
    } else {
      git('switch', 'develop');
    }
    if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'develop') { console.log(`No pude cambiar a 'develop' (¿cambios sin commitear en '${cur}'?). Commitea/guarda y reintenta.`); return; }
  }

  // SIN VERSIONAR (#117): se comprueba AQUI, antes de archivar. El archivado crea ficheros nuevos a
  // proposito (specs vivas, archive/) y el commit de aprobacion los recoge con 'add -A'; lo que hubiera
  // suelto de antes acabaria en main sin que nadie lo decidiera.
  const sueltosPub = require('./lib/git.js').ficherosSinVersionar(git('status', '--porcelain'));
  if (sueltosPub.length) { console.log(require('./lib/git.js').avisoSinVersionar(sueltosPub, 'PUBLICACION')); return; }

  // 0) CIERRE DETERMINISTA (#71): lo que tiene su PR integrado se cierra AHORA, con evidencia. Asi la
  //    ligadura cambio <-> tarea de abajo solo cancela por lo que de verdad no ha salido.
  const recPublicar = await reconciliarTareas(gh, { cerrar: true, marcar: true });

  // 1) CIERRE DE ESTADOS ANTES DEL MERGE: archiva los changes 'implementada' (deltas -> specs vivas + archive/).
  //    Si ALGUNO falla, cancelamos: nada de medio-archivar ni de mergear un main incompleto.
  const sm = specsMod();
  if (sm) {
    const cerrables = listSpecs().filter((s) => s.fm.estado === 'implementada');
    // LIGADURA cambio <-> tarea, justo antes de archivar (que es DECLARAR el trabajo terminado).
    // Al integrar en develop, el 'Closes #N' ya cerro la tarea; si sigue abierta aqui, es que ese
    // trabajo NO paso por el flujo. No se archiva a ciegas algo que la forja dice que sigue vivo.
    if (cerrables.length && gh && gh.issueEstado) {
      const incoherentes = [];
      const sinComprobar = [];
      for (const s of cerrables) {
        if (!s.fm.issue) continue;
        let est = null;
        try { est = await gh.issueEstado(String(s.fm.issue)); } catch { est = null; }
        // Aqui NO se cancela por no poder consultar: dejaria sin publicar a quien esta sin red, y
        // publicar es la accion que mas cuesta reintentar. Pero tampoco se calla: se dice que esa
        // ligadura quedo SIN COMPROBAR, para que quien aprueba sepa que garantia tiene y cual no.
        if (est === null) { sinComprobar.push(`#${s.fm.issue} (cambio '${s.name}')`); continue; }
        const msg = require('./lib/ciclo.js').coherenciaCambioIssue({
          slug: s.name, estado: s.fm.estado, issue: String(s.fm.issue), issueEstado: est, archivando: true,
        });
        if (msg) incoherentes.push(msg);
      }
      if (sinComprobar.length) {
        console.log(`\n⚠ No pude consultar ${sinComprobar.length} tarea(s) (¿sin red, token caducado o limite de la API?): ${sinComprobar.join(', ')}.`);
        console.log('   Su ligadura cambio <-> tarea NO queda comprobada: sigo, pero no lo des por verificado.');
      }
      if (incoherentes.length) {
        console.log(`\nAPROBACION CANCELADA: ${incoherentes.length} cambio(s) con su tarea sin cerrar. No he tocado '${main}'.`);
        for (const m of incoherentes) console.log(`  - ${m}`);
        return;
      }
    }
    if (cerrables.length) {
      console.log(`\nArchivando ${cerrables.length} cambio(s) 'implementada' ANTES de consolidar:`);
      const fallidos = [];
      for (const s of cerrables) {
        const r = sm.archiveChange(s.name, {});
        console.log(r.ok ? `  ✅ ${s.name}: ${String(r.msg).split('\n')[0]}` : `  ✖ ${s.name} NO archivado — ${String(r.msg).split('\n')[0]}`);
        if (!r.ok) fallidos.push(s.name);
      }
      if (fallidos.length) { console.log(`\nAPROBACION CANCELADA: no pude archivar ${fallidos.join(', ')}. No he tocado '${main}'. Arregla los deltas y reintenta.`); return; }
    }
  }

  // 2) COMMIT DE APROBACION en develop: incluye el archivado + cualquier cambio suelto -> nada queda fuera del main.
  const sucio = (git('status', '--porcelain') || '').trim();
  if (sucio) {
    git('add', '-A');
    git('commit', '-m', `chore: cierre de ciclo (archivado + cambios pendientes) para aprobar -> ${main}`);
    console.log(`\nCommit de aprobacion en develop: ${sucio.split('\n').length} fichero(s) incluidos (archivado + pendientes).`);
  }

  // 3) VALIDAR el gate con TODO ya dentro de develop.
  console.log(`\nValido el gate antes de aprobar...\n`);
  // '--todas': publicar ejecuta los gates de TODAS las apps del monorepo, no solo las del ultimo cambio.
  const v = require('child_process').spawnSync(process.execPath, [__filename, 'validate', '--todas'], { windowsHide: true, cwd: ROOT, stdio: 'inherit' });
  if (v.status !== 0) { console.log('\nAPROBACION CANCELADA: la validacion falla. Arregla lo anterior y reintenta (el archivado ya quedo commiteado en develop).'); return; }

  // ULTIMO momento util para ver si el faseo y la forja se contradicen: despues de esto ya es main.
  // Avisa, no cancela — lo que se publica es el CODIGO, y un checkbox sin marcar no lo invalida.
  await avisarDesajusteConLaForja(gh);

  // 3.5) COHERENCIA CHANGELOG <-> version, ANTES de tocar main: sin esto se podia tagear una
  // version que el CHANGELOG no documenta (el tag, la version y el CHANGELOG dejan de decir lo
  // mismo). Se comprueba aqui, no despues del merge, para no dejar 'main' a medias si falta.
  const chg = changelogTieneVersion();
  if (!chg.ok) { console.log(`\nAPROBACION CANCELADA: ${chg.msg}`); return; }
  // POR APP (#131): en un monorepo, cada app CAMBIADA debe tener su version en SU CHANGELOG. Una app
  // sin cambios no se mira; una con cambios pero version ya tageada, se avisa (no se publica).
  const esMono = require('./lib/apps.js').esMonorepo(ROOT);
  if (esMono) {
    const coh = releaseMod().coherenciaApps('HEAD');
    if (!coh.ok) { console.log(`\nAPROBACION CANCELADA: ${coh.errores.length} app(s) sin su version en su CHANGELOG. No he tocado '${main}'.`); for (const e of coh.errores) console.log(`  - ${e}`); return; }
    for (const a of coh.avisos) console.log(`\n⚠ ${a}`);
  }
  // Sin version el ciclo SIGUE (no se puede exigir lo que el repo no declara), pero se avisa: sin
  // ella no hay tag ni Release, y el trabajo se publica sin dejar un punto al que volver. Todo
  // trabajo deberia versionarse — tambien el de gestion, cuyos entregables son informes y
  // funcionales. Se dice como activarlo en vez de dejarlo en silencio.
  if (chg.version === null && esMono) {
    console.log(`\nⓘ La raiz del monorepo no declara version: se versiona y se publica por app (sin tag de raiz).`);
  } else if (chg.version === null) {
    console.log(`\n⚠ Este repo no declara version (sin package.json ni .claude-plugin/plugin.json en la raiz): se aprueba igual, pero SIN tag ni Release — no quedara un punto concreto al que volver.`);
    console.log(`   Para versionarlo: crea un package.json con {"name","version"} (basta con eso, no hace falta que sea un paquete npm) y documenta cada version en CHANGELOG.md. El harness tageara y publicara el Release solo a partir de la proxima aprobacion.`);
  }

  // 4) MERGE develop -> main -> vuelve -> push. El main aprobado incluye el archivado (mismo commit).
  // Issue #2: '${main}' puede no existir como rama LOCAL (repo clonado y trabajado solo desde develop) —
  // sin esto 'git switch main' fallaba. Se crea la rama de tracking local desde origin/${main} si falta.
  if (!flow.mainLocal) {
    git('fetch', 'origin', main);
    git('switch', '-c', main, '--track', `origin/${main}`);
  } else {
    git('switch', main);
  }
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== main) { console.log(`No pude cambiar a '${main}'. Consolida a mano tras resolver.`); return; }
  limpiarIndexLockHuerfano(); // basura de un git muerto anterior bloquearia el merge con un error opaco
  const mainAntes = git('rev-parse', main);   // para deshacer el merge local si hay que ir por peticion (#194)
  const mr = gitWrite('merge', '--no-ff', 'develop', '-m', `merge develop -> ${main}: consolidacion aprobada (${ri.perm})`);
  const back = (cur === main || !cur) ? 'develop' : cur;
  if (mr.matado) {
    // El proceso git NO termino (timeout/kill) — el repo puede estar A MEDIAS. No se aborta a ciegas.
    console.log(`\n⛔ El proceso 'git merge' NO termino (posible cuelgue o repo muy grande): '${main}' puede haber quedado A MEDIAS.`);
    console.log(`   Revisa a mano ANTES de reintentar:  git -C "${ROOT}" status  ·  si hay un merge a medias: git merge --abort  ·  si sobra .git/index.lock (sin git vivo): borralo.`);
    return;
  }
  if (mr.ok) {
    git('switch', back);
    console.log(`\n✅ Aprobado en '${main}' (tu aprobacion), con el ciclo cerrado. Subiendo develop + '${main}'...`);
    // SUBIDA (#194) por lib/subir.js: push normal y, si falla por credenciales/red, con el token del
    // harness. develop primero: lleva el commit de aprobacion, y la peticion por API lo necesita.
    const subir = require('./lib/subir.js');
    // develop primero: lleva el commit de cierre de ciclo. Si develop tambien esta protegida en la forja,
    // entra por peticion desde una rama temporal (subirOIntegrar) y develop local se alinea con la forja.
    const subeDev = await subir.subirOIntegrar('develop', { ROOT, gh, titulo: `Cierre de ciclo para publicar -> ${main}` });
    if (subeDev.via === 'api') {
      console.log(`\n'develop' esta protegida: el cierre de ciclo entro por peticion${subeDev.numero ? ` #${subeDev.numero}` : ''}.`);
      // develop local es ahora el merge commit de la forja: el merge de main se rehace sobre ESE develop.
      // Si no, develop quedaria un commit por delante de main y el proximo publicar sugeriria una version vacia.
      if (mainAntes && subir.moverRama(main, mainAntes, { ROOT }).ok && git('switch', main) !== null) {
        gitWrite('merge', '--no-ff', 'develop', '-m', `merge develop -> ${main}: consolidacion aprobada (${ri.perm})`);
        git('switch', back);
      }
    }
    let subeMain = subeDev.ok ? subir([main], { ROOT }) : { ok: false, msg: `develop no llego a la forja (${subeDev.msg}), y '${main}' no se publica sin ella.` };
    // RAMA PROTEGIDA (#194): la forja rechaza el push directo a main pero admite la PETICION. Se integra
    // develop -> main por la API con el token del harness, se VERIFICA el resultado en la forja y solo
    // entonces main local pasa a ese commit (sobre el que se tagea).
    if (!subeMain.ok && subeMain.rechazado) {
      console.log(`\n'${main}' esta protegida: la integro por peticion (API) con el token del harness...`);
      const ip = await subir.integrar({ ROOT, gh, head: 'develop', base: main, titulo: `Publicar develop -> ${main}${info.sugerida ? ` (${info.sugerida})` : ''}`, cuerpo: `Publicacion aprobada (${ri.perm}) con /faro:publicar.`, debeContener: git('rev-parse', 'develop') });
      if (ip.ok) {
        const mv = subir.moverRama(main, ip.sha, { ROOT });
        subeMain = mv.ok ? { ok: true, via: 'api', msg: '' } : { ok: false, fusionada: true, msg: `fusionada por peticion, pero ${mv.msg}` };
        console.log(`✅ Peticion ${ip.numero ? `#${ip.numero} ` : ''}fusionada en '${main}'${ip.url ? ` · ${ip.url}` : ''}.`);
      } else subeMain = { ok: false, fusionada: ip.fusionada, msg: ip.msg };
    }
    const publicado = subeMain.ok;
    // Si main NO llego a la forja se deshace SIEMPRE el merge local: si no, main local quedaria por
    // delante, el reintento compararia main..develop = 0 y diria "nada que aprobar" sin haber publicado.
    // Excepcion: la forja YA fusiono pero no se pudo comprobar o alinear. Ahi main SI esta publicada y lo
    // que falta es traerla y tagear, no repetir la publicacion.
    let deshecho = false;
    if (!publicado && !subeMain.fusionada && mainAntes && git('rev-parse', main) !== mainAntes) deshecho = subir.moverRama(main, mainAntes, { ROOT }).ok;
    // TAG de version (0.9.4) sobre la rama PRINCIPAL ya publicada (no sobre HEAD: aqui ya se volvio a
    // 'back', #78). Va DESPUES de subir main: si main entro por peticion, el commit es el de la forja.
    // Monorepo sin version en la raiz (#131): no hay tag de raiz que crear ni que avisar.
    const tagRes = (!publicado || (esMono && chg.version === null)) ? { ok: false, tag: null, msg: null } : tagVersionSiProcede(main);
    if (tagRes.msg) console.log(tagRes.ok ? `\n🏷  ${tagRes.msg}` : `\n⚠ ${tagRes.msg}`);
    // UN TAG POR APP CAMBIADA (#131), sobre main. Las apps sin cambios no se tocan.
    const tagsApps = (publicado && esMono) ? releaseMod().tagearApps(main) : [];
    for (const t of tagsApps) console.log(t.ok ? `\n🏷  ${t.app.id}: ${t.msg}` : `\n⚠ ${t.app.id}: ${t.msg}`);
    const tagsOk = tagsApps.filter((t) => t.ok && t.tag);
    const subidos = [...(tagRes.ok && tagRes.tag ? [tagRes.tag] : []), ...tagsOk.map((t) => t.tag)];
    const subeTags = subidos.length ? subir(subidos, { ROOT }) : { ok: true };
    const pr = { status: publicado && subeTags.ok ? 0 : 1 };   // las releases necesitan main y tags en la forja
    if (publicado) {
      console.log(`\n✅ SUBIDO (${main}${subeDev.ok ? ' + develop' : ''}${subidos.length && subeTags.ok ? ` + ${subidos.join(' + ')}` : ''})${subeMain.via === 'api' ? ' — por peticion' : subeMain.via === 'token' ? ' — con el token del harness' : ''}. Estas en '${git('rev-parse', '--abbrev-ref', 'HEAD')}'. Dispara el CI.`);
      if (!subeTags.ok) console.log(`\n⚠ No pude subir los tags (${subidos.join(', ')}): ${subeTags.msg}`);
    } else {
      const sigueMerge = mainAntes && git('rev-parse', main) !== mainAntes;
      if (subeMain.fusionada) console.log(`\n⚠ '${main}' YA esta fusionada en la forja, pero ${subeMain.msg}\n   NO relances /faro:publicar: trae '${main}' (/faro:sincronizar) y crea el tag de la version sobre ella (harness.js release te dice cual falta).`);
      else console.log(`\n⚠ '${main}' NO llego a la forja: ${subeMain.msg}${deshecho ? ` He deshecho el merge local de '${main}': cuando se resuelva, /faro:publicar lo reintenta entero.` : sigueMerge ? ` OJO: '${main}' local conserva el merge sin publicar — devuelvelo a ${mainAntes.slice(0, 7)} antes de reintentar.` : ''} Estas en '${git('rev-parse', '--abbrev-ref', 'HEAD')}'.`);
    }
    // Release POR APP en la forja, con las notas del CHANGELOG de CADA app (#131).
    if (pr.status === 0 && tagsOk.length) {
      const fm = forjaMod();
      for (const t of tagsOk) {
        try {
          const notas = releaseMod().notasDeVersion(t.version, t.app);
          if (!fm || !fm.publicarRelease) break;
          const res = await fm.publicarRelease(t.tag, notas || `Version ${t.version} de ${t.app.id}.`);
          if (res.ok) console.log(res.yaExistia ? `\nRelease ${t.tag}: ya estaba publicado.` : `\n✅ Release ${t.tag} publicado con las notas de ${t.app.ruta}/CHANGELOG.md${res.url ? ` · ${res.url}` : ''}.`);
          else console.log(`\n⚠ El tag ${t.tag} esta subido pero NO pude publicar su Release (${res.msg}). Reintentalo cuando puedas.`);
        } catch (e) { console.log(`\n⚠ El tag ${t.tag} esta subido pero fallo la publicacion de su Release (${(e && e.message) || e}).`); }
      }
      if (!(tagRes.ok && tagRes.tag)) await comentarPublicadas(gh, recPublicar, tagsOk[0].tag, tagsOk.map((t) => t.tag).join(', '));
    }
    // RELEASE en la forja, con las notas del CHANGELOG. Paso OBLIGATORIO del ciclo, no opcional: sin
    // el, el tag existe pero la pagina de Releases queda vacia y las notas escritas no llegan a nadie.
    // Solo si el PUSH fue bien: un release necesita un tag que la forja ya tenga. Si falla, se avisa
    // con el comando para retomarlo — el tag ya esta creado, que es lo irreversible.
    if (pr.status === 0 && tagRes.ok && tagRes.tag) {
      try {
        const fm = forjaMod();
        const rel = releaseMod();
        const notas = rel.notasDeVersion ? rel.notasDeVersion(tagRes.version || String(tagRes.tag).replace(/^v/, '')) : null;
        if (fm && fm.publicarRelease) {
          const res = await fm.publicarRelease(tagRes.tag, notas || `Version ${tagRes.tag}.`);
          if (res.ok) console.log(res.yaExistia ? `\nRelease ${tagRes.tag}: ya estaba publicado.` : `\n✅ Release ${tagRes.tag} publicado con las notas del CHANGELOG${res.url ? ` · ${res.url}` : ''}.`);
          else console.log(`\n⚠ El tag ${tagRes.tag} esta subido pero NO pude publicar el Release (${res.msg}). Reintentalo cuando puedas; el resto del ciclo esta completo.`);
        }
      } catch (e) { console.log(`\n⚠ El tag ${tagRes.tag} esta subido pero fallo la publicacion del Release (${(e && e.message) || e}).`); }
    }
    // TRAZABILIDAD de la release: cada tarea hecha cuyo merge entra en este tag lo lleva escrito.
    if (pr.status === 0 && tagRes.ok && tagRes.tag) await comentarPublicadas(gh, recPublicar, tagRes.tag);
    // Hitos de la forja = fases de ESTADO.md: se sincronizan al aprobar (crea/cierra/reabre). Best-effort.
    try { const fm = forjaMod(); if (fm && fm.syncHitos) { const ls = await fm.syncHitos(); if (ls.length) console.log(`\nHitos de la forja sincronizados con las fases:\n${ls.join('\n')}`); } } catch {}
    console.log(`Los [x] de ${ESTADO_FILE} los marca el harness al reconciliar con la forja. Si una fase queda completa, cierrala (/faro:cerrar-fase: informe + estado done + tag fase-N).`);
  } else {
    // exit != 0 con proceso terminado = conflicto REAL: abortable con seguridad (a diferencia del
    // caso 'matado', ya tratado arriba, donde el estado es incierto y NO se aborta a ciegas).
    const ab = gitWrite('merge', '--abort');
    git('switch', back);
    console.log(`\n⚠ CONFLICTOS reales al mergear develop -> ${main}.${ab.ok ? ` Merge abortado ('${main}' intacto) y te devolvi a '${back}'.` : ' ATENCION: el abort tambien fallo — revisa git status antes de seguir.'} Resuelvelo por /faro:pr o a mano.`);
    if (mr.salida) console.log(`   git dijo: ${mr.salida.split('\n').slice(0, 3).join(' | ')}`);
  }
}

// ---------- One-pager / Roadmap: logica extraida a lib/onepager.js (modularizacion) ----------
let _opMod = null;
function opMod() {
  if (!_opMod) _opMod = require(path.join(__dirname, 'lib', 'onepager.js'))({ fs, path, ROOT, SP, PRESENTACIONES, parseEstado, clasificacion, tipoInfo, parseKpis, plantillaMarca });
  return _opMod;
}

// REPORTE DE NEGOCIO en Word con la plantilla neutra de FARO (#121): el documento que se reenvia a negocio. Misma
// fuente que el one-pager; reporting SIEMPRE datado (misma fecha = se actualiza). Se genera EN MEMORIA
// ({ buffer, huella, hoy }) y solo toca disco con escribir().
function reporteNegocio() {
  const ini = parseEstado();
  if (!ini) return null;
  const hoy = new Date().toISOString().slice(0, 10);
  const r = require('./lib/reporte-negocio.js').generarReporte({ modelo: opMod().buildOnepagerModel(), fases: ini.fases, fm: ini.fm, hoy });
  const ruta = path.join(ROOT, INFORMES, `${hoy}-reporte-negocio.docx`);
  return { buffer: r.buffer, huella: r.huella, hoy, escribir: () => { fs.mkdirSync(path.dirname(ruta), { recursive: true }); fs.writeFileSync(ruta, r.buffer); return ruta; } };
}
function cmdReporteNegocio() {
  const rep = reporteNegocio();
  if (!rep) { console.log(`No hay ${ESTADO_FILE}: el reporte de negocio sale del faseo.`); return; }
  const r = { ruta: rep.escribir(), huella: rep.huella };
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ ruta: path.relative(ROOT, r.ruta).replace(/\\/g, '/'), huella: r.huella })); return; }
  console.log(`Reporte de negocio (Word): ${path.relative(ROOT, r.ruta).replace(/\\/g, '/')}`);
}

if (cmd === 'session') cmdSessionRouted();
else if (cmd === 'status') cmdSession({ completo: true });   // CLI a mano: sin stdin que leer
// estado: el DETALLE bajo demanda que el indice de sesion ya no inyecta (convenciones, documentos,
// requisitos uno a uno, codigo, planes), en texto plano (#127).
else if (cmd === 'estado') cmdSession({ completo: true, texto: true });
else if (cmd === 'prompt-context') cmdPromptContext();
else if (cmd === 'pre-doc') cmdPreDoc();
else if (cmd === 'pre-bash') cmdPreBash();
else if (cmd === 'doc-check') cmdDocCheck();
else if (cmd === 'stop-check') cmdStopCheck();
else if (cmd === 'validate') cmdValidate();
// informe-semanal: genera el informe semanal ejecutivo. Antes lo escribia el arranque de sesion sin
// que nadie lo pidiera (#125); ahora el arranque solo lo anuncia y esto lo genera a peticion.
else if (cmd === 'informe-semanal') {
  const rel = ensureWeeklyReport();
  console.log(rel ? `Informe semanal generado: ${rel}. Revisalo e incluyelo en el commit del trabajo en curso.`
    : parseEstado() ? 'Ya hay un informe semanal de los ultimos 7 dias: no se genera otro.' : `Sin ${ESTADO_FILE}: no hay trabajo del que informar.`);
}
else if (cmd === 'docref') cmdDocRef();
else if (cmd === 'plantilla') cmdPlantilla();
else if (cmd === 'tipo') cmdTipo();
else if (cmd === 'identity') ghMod().cmdIdentity();
else if (cmd === 'auth') { const m = forjaMod(); if (!m) SIN_FORJA('auth'); else m.cmdAuth(); }
else if (cmd === 'gh') { if (forgeInfo().forge !== 'github') { SIN_FORJA('gh (transporte de la API de GitHub)'); console.log('En GitLab usa los comandos por intencion: role · pr · issue · comentar · mis-tareas · asignar-tarea · equipo · clave.'); } else ghMod().cmdGh(); }
else if (cmd === 'pr' && ['ver', 'aprobar', 'mergear'].includes(process.argv[3])) {
  const m = forjaMod(); const sub = process.argv[3]; const iid = process.argv[4];
  const fn = m && ({ ver: m.cmdPrVer, aprobar: m.cmdPrAprobar, mergear: m.cmdPrMergear })[sub];
  if (!fn) SIN_FORJA(`pr ${sub}`);
  else if (!/^\d+$/.test(iid || '')) { console.log(`Uso: harness.js pr ${sub} <numero>${sub === 'mergear' ? ' --confirmo [--squash|--sin-squash]' : ''}`); process.exit(1); }
  else fn(iid, process.argv.slice(5));
}
else if (cmd === 'pr' && process.argv[3] === 'revisor') { const m = forjaMod(); if (!m) SIN_FORJA('pr revisor'); else require('./lib/forge-intencion.js').cmdPrRevisor(m, process.argv.slice(4)); }
else if (cmd === 'pr' && process.argv[3] === 'crear') { const m = forjaMod(); if (!m || !m.crearPr) SIN_FORJA('pr crear'); else cmdPrCrear(m); }
else if (cmd === 'pr') { const m = forjaMod(); if (!m) SIN_FORJA('pr'); else m.cmdPr(); }
else if (cmd === 'role') { const m = forjaMod(); if (!m) SIN_FORJA('role'); else m.cmdRole(); }
else if (cmd === 'approvers') { const m = forjaMod(); if (!m || !m.approvers) { console.log('[]'); } else { m.approvers().then((a) => console.log(JSON.stringify(a))).catch(() => console.log('[]')); } }
else if (cmd === 'miembro' || cmd === 'miembros') { const m = forjaMod(); if (!m || !m.cmdMiembro) SIN_FORJA('miembro (equipo del proyecto)'); else m.cmdMiembro(); }
else if (cmd === 'equipo' || cmd === 'team') { const m = forjaMod(); if (!m) SIN_FORJA('equipo'); else m.cmdEquipo(); }
else if (cmd === 'asignar-tarea' || cmd === 'asignar') { const m = forjaMod(); if (!m) SIN_FORJA('asignar-tarea'); else m.cmdAsignarTarea(); }
else if (cmd === 'mis-tareas' || cmd === 'mis-issues') { const m = forjaMod(); if (!m) SIN_FORJA('mis-tareas'); else m.cmdMisTareas(); }
// AUDITA / REPARA el formato de los issues. Sin numero audita todos los abiertos; con
// numero muestra como quedaria y solo escribe con --confirmo. El harness pone el
// ESQUELETO; investigar que pretendia el trabajo y si se hizo es juicio -> /faro:tareas.
else if (cmd === 'reparar-tarea' || cmd === 'auditar-tareas') { const m = forjaMod(); if (!m) SIN_FORJA('reparar-tarea'); else if (!m.cmdRepararTarea) console.log(FORGE.sinCapacidad(forgeInfo().forge, 'repararTarea').join('\n')); else m.cmdRepararTarea(); }
// issue / comentar: leer y escribir una tarea por INTENCION; skills y agentes no escriben rutas de ninguna API.
else if (cmd === 'issue') { const m = forjaMod(); if (!m) SIN_FORJA('issue'); else require('./lib/forge-intencion.js').cmdIssue(m, process.argv.slice(3)); }
else if (cmd === 'comentar') { const m = forjaMod(); if (!m) SIN_FORJA('comentar'); else require('./lib/forge-intencion.js').cmdComentar(m, process.argv.slice(3)); }
else if (cmd === 'descartar-tarea' || cmd === 'descartar') { const m = forjaMod(); if (!m) SIN_FORJA('descartar-tarea'); else m.cmdDescartarTarea(); }
// mover-tarea: saca del Backlog a su fase (o mueve entre fases) dejando constancia en el issue.
// cerrar-tarea: cierra como COMPLETADA, y se niega si la tarea sigue en el Backlog (de la sala de
// espera solo se sale a una fase: lo que se hizo pertenecia a alguna).
else if (cmd === 'ampliar-tarea' || cmd === 'ampliar') { const m = forjaMod(); if (!m) SIN_FORJA('ampliar-tarea'); else m.cmdAmpliarTarea(); }
else if (cmd === 'campos-tarea' || cmd === 'campos') { const m = forjaMod(); if (!m) SIN_FORJA('campos-tarea'); else if (!m.cmdCamposTarea) console.log(FORGE.sinCapacidad(forgeInfo().forge, 'camposTarea').join('\n')); else m.cmdCamposTarea(); }
else if (cmd === 'mover-tarea' || cmd === 'mover') { const m = forjaMod(); if (!m || !m.cmdMoverTarea) SIN_FORJA('mover-tarea'); else m.cmdMoverTarea(); }
else if (cmd === 'cerrar-tarea' || cmd === 'cerrar') { const m = forjaMod(); if (!m || !m.cmdCerrarTarea) SIN_FORJA('cerrar-tarea'); else m.cmdCerrarTarea(); }
// cerrar-fase: la CEREMONIA de cierre (valida, escribe ESTADO.md, cierra el hito y tagea). Distinta
// de 'cerrar-tarea', que cierra UN issue: aqui se cierra el bloque entero y su registro historico.
else if (cmd === 'cerrar-fase') cmdCerrarFase();
// vigilar --ahora: la MISMA comprobacion a peticion, para preguntarla a mitad de sesion. ~0,8s y sin
// bloquear, frente a los ~14s de lanzar 'session' entero y filtrarlo con grep. Sale con 0 siempre.
// vigilar: corre EN BACKGROUND (hook con 'asyncRewake') y solo habla si hay algo que decir. Sale con
// 2 y escribe por stderr para despertar al agente; con 0 y en silencio cuando todo cuadra.
else if (cmd === 'vigilar') cmdVigilar();
else if (cmd === 'procesos') process.exitCode = require('./lib/procesos.js').cli(process.argv.slice(3), { root: ROOT });
// worktrees de agentes (#251): lista, --limpiar (borra solo limpios e integrados), --ignorar, --al-terminar (hook SubagentStop).
else if (cmd === 'worktrees') process.exitCode = require('./lib/worktrees.js').cli(process.argv.slice(3), { root: ROOT });
else if (cmd === 'migrar-layout') process.exitCode = require('./lib/migrar-layout.js').cli(process.argv.slice(3), { root: ROOT });
// triaje: JUZGA lo que llega de fuera contra lo escrito. Sin argumento, diagnostica cuanto criterio
// hay para juzgar (lo primero que mirar en un repo que adopta FARO).
else if (cmd === 'triaje') cmdTriaje();
else if (cmd === 'gh-refresh') { const m = forjaMod(); if (m && m.cmdGhRefresh) m.cmdGhRefresh(); }
else if (cmd === 'resumen-refresh') { const nowMs = Number(process.argv[3]) || 0; if (nowMs) agregadoMod().refrescarAgregado(nowMs); }
else if (cmd === 'resumen') {
  const ag = agregadoMod();
  const c = ag.agregadoCache();
  if (!c) { console.log('Resumen agregado: aun sin datos — se calcula en breve (o fuerza ya: node .claude/hooks/harness.js resumen-refresh ' + Date.now() + ').'); }
  else {
    const edad = Math.round((Date.now() - c.ts) / 60000);
    console.log(`RESUMEN AGREGADO de este repo (actualizado hace ${edad} min):`);
    console.log(c.ramas ? `  Ramas: ${c.ramas.vivas} viva(s) · ${c.ramas.muertas} muerta(s) (borrables con 'harness.js ramas --purge')` : '  Ramas: sin datos');
    console.log(typeof c.tus_issues_abiertos === 'number' ? `  Tus tareas (Issues) abiertas: ${c.tus_issues_abiertos}` : '  Tus tareas: sin datos (¿SIN_TOKEN? -> harness.js auth)');
    // Vigilancia del anclaje al ciclo (0.31.1): tareas de PLAN (requerimiento/tarea/mejora/...) sin
    // hito -> quedarian invisibles al cerrar la fase que las contiene. Se dice aunque sea 0 aqui (a
    // diferencia del resumen de sesion, que calla en 0): este comando es CONSULTA explicita.
    if (typeof c.plan_sin_hito === 'number') {
      const estanc = c.plan_sin_hito_estancadas > 0 ? ` (${c.plan_sin_hito_estancadas} llevan >30 dias sin tocarse)` : '';
      console.log(`  Tareas planificadas SIN fase: ${c.plan_sin_hito}${estanc}${c.plan_sin_hito > 0 ? ' — asignalas con \'asignar-tarea --hito <N>\' o revisa si siguen vigentes' : ''}`);
    }
  }
}
else if (cmd === 'clave') { const m = forjaMod(); if (!m) SIN_FORJA('clave'); else m.cmdClave(); }
else if (cmd === 'proteger') { const m = forjaMod(); if (!m || !m.cmdProteger) SIN_FORJA('proteger'); else m.cmdProteger(); }
else if (cmd === 'hito' || cmd === 'hitos') { const m = forjaMod(); if (!m || !m.cmdHito) SIN_FORJA('hito (fase = hito de GitLab)'); else m.cmdHito(); }
else if (cmd === 'tiempo') { const m = forjaMod(); const motivo = FORGE.sinCapacidad(forgeInfo().forge, 'tiempo'); if (m && m.cmdTiempo) m.cmdTiempo(); else if (motivo) console.log(motivo.join('\n')); else SIN_FORJA('tiempo'); }
else if (cmd === 'enlazar') { const m = forjaMod(); const motivo = FORGE.sinCapacidad(forgeInfo().forge, 'enlazar'); if (m && m.cmdEnlazar) m.cmdEnlazar(); else if (motivo) console.log(motivo.join('\n')); else SIN_FORJA('enlazar'); }
else if (cmd === 'renombrar') { const m = forjaMod(); if (!m || !m.cmdRenombrar) SIN_FORJA('renombrar (en GitHub lo hace el agente renombrador-faro con harness.js gh repos/<org>/<repo> PATCH)'); else m.cmdRenombrar(); }
else if (cmd === 'exigir-pipeline') { const m = forjaMod(); if (!m || !m.cmdExigirPipeline) SIN_FORJA('exigir-pipeline (ajuste de proyecto de GitLab: no fusionar con el pipeline en rojo)'); else m.cmdExigirPipeline(); }
else if (cmd === 'reglas-push') { const m = forjaMod(); if (!m || !m.cmdReglasPush) SIN_FORJA('reglas-push (funcion propia de GitLab Premium/Ultimate: reglas de push del proyecto)'); else m.cmdReglasPush(); }
else if (cmd === 'bloquear-pr') { const m = forjaMod(); if (!m || !m.cmdBloquearMr) SIN_FORJA('bloquear-pr (funcion propia de GitLab Premium/Ultimate: enlaces de bloqueo entre peticiones)'); else m.cmdBloquearMr(); }
else if (cmd === 'terminar') { cmdTerminar(); }
else if (cmd === 'consolidar') { if (pidioAyuda()) ayudaConsolidar(); else cmdConsolidar(); }
// 'publicar' = sacar a produccion (develop -> main). Es un RELEASE bajo demanda, no el cierre de
// cada ciclo: eso ocurre en develop.
else if (cmd === 'publicar') { if (pidioAyuda()) ayudaPublicar(); else cmdPublicar(); }
else if (cmd === 'release') { cmdReleaseAnalisis(); }
else if (cmd === 'specs') { const sm = specsMod(); if (!sm) { console.log('Falta .claude/hooks/specs.js (motor de specs nativo).'); process.exit(1); } sm.cmdSpecs(); }
else if (cmd === 'ramas') { const mod = path.join(__dirname, 'lib', 'ramas.js'); if (!fs.existsSync(mod)) { console.log('Falta .claude/hooks/ramas.js (modulo de ramas).'); process.exit(1); } require('child_process').spawnSync(process.execPath, [mod, ...process.argv.slice(3)], { windowsHide: true, stdio: 'inherit' }); }
else if (cmd === 'sincronizar' || cmd === 'sync-local') { const mod = path.join(__dirname, 'lib', 'sincronizar.js'); if (!fs.existsSync(mod)) { console.log('Falta lib/sincronizar.js (modulo de sincronizacion).'); process.exit(1); } require(mod).cmdSincronizar(ROOT); }
else if (cmd === 'rama' || cmd === 'branch') cmdRama();
else if (cmd === 'forge' || cmd === 'forja') FORGE.cmdForge(git);
else if (cmd === 'atomico' || cmd === 'atomicidad') cmdAtomico();
else if (cmd === 'codigo' || cmd === 'salud') cmdCodigo();
// contrato: ¿lo que el codigo EXPONE sigue siendo lo que el documento dice que expone? Avisa, no
// bloquea: una deriva puede ser deliberada, y como gate se sortearia borrando la linea del documento.
else if (cmd === 'contrato') cmdContrato();
else if (cmd === 'hexagonal') cmdHexagonal();
else if (cmd === 'onepager') opMod().cmdOnepager();
else if (cmd === 'reporte-negocio') cmdReporteNegocio();
else if (cmd === 'roadmap') opMod().cmdRoadmap();
else if (cmd === 'estado-json') cmdEstadoJson();
// tarea migrar (#149 parte 2): rellena gestion/tareas/ del historico; la forja entra por el transporte del motor.
else if (cmd === 'tarea') cmdTareaMigrar();
else if (cmd === 'docgen') cmdDocGen();
else if (cmd === 'pendientes') cmdPendientes();
else if (cmd === 'apps') cmdApps();
else if (cmd === 'codeowners') cmdCodeowners();
else if (cmd === 'monorepo') cmdMonorepo();
else if (cmd === 'app') cmdApp();
else if (cmd === 'ficha') cmdFicha();
// tdd-pre|tdd-post|tdd-stop|tdd-revisar: se despachan al PRINCIPIO del fichero (ver tras ROOT).
else if (cmd === 'planificacion') cmdPlanificacion();
else if (cmd === 'ci') cmdCi();
else if (cmd === 'gates' || cmd === 'infra' || cmd === 'deps') { const c = codeMod(); if (!c) { console.log('Falta .claude/hooks/code.js (capa de codigo).'); process.exit(1); } cmd === 'gates' ? c.cmdGates(opcionesGates()) : cmd === 'infra' ? c.cmdInfra() : c.cmdDeps(); }
else if (cmd === 'stats') cmdStats();
else if (cmd === 'status-line') cmdStatusLine();
else if (cmd) { console.error(`harness.js: subcomando desconocido '${cmd}'. Usa uno de: session|status · estado · prompt-context · validate · informe-semanal · specs · ramas · sincronizar · rama|branch · pr crear · forge|forja · atomico|atomicidad · codigo|salud · contrato · ci · exigir-pipeline · proteger · renombrar · hito · tiempo · enlazar · miembro · pr ver|aprobar|mergear · pr · role · terminar · consolidar · release · publicar · pendientes · apps · codeowners · ficha · tarea · resumen-json · estado-indice · ir · refs · tdd-pre|tdd-post|tdd-stop · tdd-revisar · tests-dominios · procesos · worktrees · recursos · monorepo · app nueva · gh · auth · gates|infra|deps · onepager · reporte-negocio · estado-json · docgen · docref · tipo · plantilla · clave · identity · approvers · equipo|team · asignar-tarea|asignar · ampliar-tarea|ampliar · campos-tarea|campos · mover-tarea|mover · cerrar-tarea|cerrar · reparar-tarea · mis-tareas|mis-issues · descartar-tarea|descartar · stats · planificacion.`); process.exit(2); }
