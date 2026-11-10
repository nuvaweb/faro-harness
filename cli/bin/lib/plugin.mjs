// plugin.mjs — PREPARACIÓN DEL PLUGIN faro en la máquina y en el repo (extraído de repo.mjs):
// settings de distribución según la forja del perfil, credenciales para que Claude Code baje el
// marketplace, instalación/actualización por CLI (scope user + refresco de instalaciones 'project'
// anticuadas), migración de la copia legada del motor y plantillas heredadas.
// El plugin es la fuente de verdad: aquí solo se prepara su uso, nunca se copia su contenido.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ok, warn, say, caja, confirma, C, YES, DRY, saveConfig, loadConfig } from './core.mjs';
import { PERFILES, marketplaceDe, bloqueSettings } from './perfil.mjs';

// Specs spec-driven: motor NATIVO del harness (.claude/hooks/specs.js) — nada que instalar.
// Plugin superpowers de Claude Code — VITAL para el ciclo FARO (brainstorm→spec→plan). Detecta e INSTRUYE.
// Bloque de DISTRIBUCION del plugin faro en el settings del REPO (viaja con el clon): con el,
// Claude Code ofrece instalar el plugin al abrir el repo y lo AUTO-ACTUALIZA (autoUpdate — en
// marketplaces no oficiales viene desactivado por defecto; sin el flag NO se actualiza solo).
// MERGE idempotente: conserva las claves existentes (permissions, hooks...) y solo completa lo que
// falte. Devuelve true si cambio algo (el caller decide commit). El harness valida esto en sesion.
// superpowers se declara desde el marketplace OFICIAL de Anthropic (decision 2026-08-03): es la
// fuente canonica, ya viene conocida por Claude Code y es de donde se instala por defecto. El plugin
// existe tambien en 'obra/superpowers-marketplace', pero los IDs NO son intercambiables:
// 'superpowers@claude-plugins-official' solo resuelve si ESE marketplace esta declarado. Mezclar
// ambos entre repos es lo que producia "enabled in project settings but isn't installed here".
// Entradas de enabledPlugins cuyo marketplace NO esta declarado en extraKnownMarketplaces: Claude
// Code sabe que quieres el plugin pero no de donde bajarlo -> "isn't installed here" en CADA clon.
// Se REPORTAN (no se borran solas: pueden ser plugins legitimos del equipo ajenos a FARO).
function pluginsHuerfanos(s) {
  const conocidos = new Set(['claude-plugins-official', ...Object.keys(s.extraKnownMarketplaces || {})]);
  return Object.keys(s.enabledPlugins || {}).filter((k) => { const mk = k.split('@')[1]; return mk && !conocidos.has(mk); });
}

// ¿El settings ya declara bien la distribucion? 'git' es lo que escribe el wizard; 'github' y 'url'
// siguen valiendo en los repos que nacieron antes: el harness del plugin acepta las tres.
function settingsPluginOk(s, { marketplace = 'faro-marketplace' } = {}) {
  const mks = (s && s.extraKnownMarketplaces) || {}, eps = (s && s.enabledPlugins) || {};
  const mk = mks[marketplace];
  const fuenteOk = !!(mk && mk.source && ['git', 'github', 'url'].includes(mk.source.source));
  const spOk = eps['superpowers@claude-plugins-official'] === true && !!mks['claude-plugins-official'];
  return !!(mk && fuenteOk && mk.autoUpdate === true && eps[`faro@${marketplace}`] === true && spOk);
}

function escribirSettingsPlugin(destino, perfil = PERFILES.github, { override = '' } = {}) {
  const f = path.join(destino, '.claude', 'settings.json');
  let antes = ''; try { antes = fs.readFileSync(f, 'utf8'); } catch {}
  let s = {}; try { s = JSON.parse(antes) || {}; } catch {}
  // Bloque segun la FORJA del perfil (repo en GitHub -> source github, espejo; en GitLab -> source url,
  // principal), igual que bloqueSettings() del plugin. 'source' se sustituye entero (no se funde: un
  // repo que cambia de forja no debe arrastrar el repo de la otra). El oficial se declara EXPLICITAMENTE.
  const b = bloqueSettings(perfil, override);
  const mk = { ...(s.extraKnownMarketplaces || {}) };
  for (const [k, v] of Object.entries(b.extraKnownMarketplaces)) mk[k] = { ...(mk[k] || {}), ...v };
  s.extraKnownMarketplaces = mk;
  s.enabledPlugins = { ...(s.enabledPlugins || {}), ...b.enabledPlugins };
  const despues = JSON.stringify(s, null, 2) + '\n';
  const huerfanos = pluginsHuerfanos(s);
  if (huerfanos.length) {
    warn(`Plugins declarados sin su marketplace: ${huerfanos.join(', ')} — Claude Code no sabrá de dónde instalarlos (error "isn't installed here" en cada clon).`);
    say(`  ${C.d}Si los queréis: declara su marketplace en extraKnownMarketplaces. Si no: quítalos de enabledPlugins.${C.x}`);
  }
  if (despues === antes) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, despues, 'utf8');
  ok(`Plugins declarados en .claude/settings.json (faro + superpowers, con sus marketplaces) — el equipo lo hereda al clonar.`);
  return true;
}

// Migracion copia legada -> PLUGIN: retira los ficheros FARO de .claude/hooks/ (solo los conocidos;
// lo ajeno se respeta), desconecta el cableado 'hooks' del settings.json CONSERVANDO permisos y
// overrides, y quita .claude/commands/faro/ (el plugin provee /faro:*). Con la copia presente el
// plugin se INHIBE (gobierna la copia); tras esto, gobierna el plugin: una sola fuente, auto-update.
// Sirve igual para adopciones nuevas (borra lo que el overlay del template acabe de copiar).
const FARO_HOOK_FILES = ['harness.js', 'clickup.js', 'code.js', 'github.js', 'paths.js', 'ramas.js', 'self-hint.js', 'specs.js', 'hooks.json', 'harness-manifest.json', 'package.json', 'faro-schema.json', 'docs-json.js'];
// Agentes FARO conocidos (los provee el plugin; incluye nombres LEGADOS ya renombrados/retirados).
const FARO_AGENT_FILES = ['adoptador-faro.md', 'analista-kpis.md', 'auditor-iniciativa.md', 'auditor-faro.md', 'gestor-clickup.md', 'gestor-directus.md', 'gestor-forja.md', 'gestor-github.md', 'gestor-requisitos.md', 'gestor-riesgos.md', 'presentador-iniciativa.md', 'presentador-faro.md', 'redactor-documento.md', 'redactor-informe.md', 'redactor-tecnico.md', 'renombrador-faro.md', 'revisor-spec.md', 'revisor-code.md', 'revisor-code-worker.md'];
// Ficheros del motor que algunas copias legadas dejaron en .claude/ raiz (docs del motor: al plugin).
const FARO_ENGINE_FILES = ['harness-manifest.json', 'modelo-faro.md', 'docs-json.js'];
// Listas DERIVADAS de la cache del plugin instalado (~/.claude/plugins/cache/faro-marketplace/faro/<mayor>):
// las estaticas de arriba se quedan cortas en cuanto el plugin anade ficheros (hooks/lib/, agentes
// nuevos, plantillas nuevas). Union de ambas = una copia legada hecha desde un plugin reciente
// tambien se limpia entera. Vacias si no hay cache.
function listasDesdeCache() {
  const base = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'faro-marketplace', 'faro');
  const vacio = { hooks: [], lib: false, agents: [], plantillas: [] };
  try {
    const vers = fs.readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(cmpVersion);
    if (!vers.length) return vacio;
    const raiz = path.join(base, vers[vers.length - 1]);
    const ls = (p) => { try { return fs.readdirSync(p).filter((n) => !n.startsWith('.')); } catch { return []; } };
    return { hooks: ls(path.join(raiz, 'hooks')).filter((n) => n !== 'lib'), lib: fs.existsSync(path.join(raiz, 'hooks', 'lib')), agents: ls(path.join(raiz, 'agents')), plantillas: ls(path.join(raiz, 'plantillas', 'html')) };
  } catch { return vacio; }
}
function migrarCopiaLegada(destino, { perfil = null, override = '' } = {}) {
  const mkCm = marketplaceDe(perfil || PERFILES.github, override);
  const fuenteCm = mkCm.url;
  // NO se corta en harness.js: una migracion anterior pudo quedar A MEDIAS (hooks fuera, agentes
  // dentro) — se limpia TODO lo FARO conocido que siga presente; lo ajeno se respeta siempre.
  const cl = (...p) => path.join(destino, '.claude', ...p);
  let algo = false;
  const rm = (p) => { try { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); algo = true; } } catch {} };
  const cache = listasDesdeCache();
  for (const f of new Set([...FARO_HOOK_FILES, ...cache.hooks])) rm(cl('hooks', f));
  rm(cl('hooks', 'lib'));   // motor modular del plugin (>= 0.10): una copia legada reciente lo trae entero
  for (const f of new Set([...FARO_AGENT_FILES, ...cache.agents])) rm(cl('agents', f));
  for (const f of FARO_ENGINE_FILES) rm(cl(f));
  rm(cl('commands', 'faro'));
  for (const d of ['hooks', 'agents', 'commands']) { try { if (fs.existsSync(cl(d)) && !fs.readdirSync(cl(d)).length) fs.rmSync(cl(d), { recursive: true, force: true }); } catch {} }
  try {
    const s = JSON.parse(fs.readFileSync(cl('settings.json'), 'utf8'));
    let sCambio = false;
    if (s && s.hooks) { delete s.hooks; sCambio = true; }
    // statusLine apuntando a la copia legada recien retirada -> fuera (si no, barra de estado rota).
    if (s && s.statusLine && /\.claude[\\/]hooks[\\/]/.test(String((s.statusLine || {}).command || ''))) { delete s.statusLine; sCambio = true; }
    // Permisos MUERTOS: reglas allow que invocan la copia legada (el archivo ya no existe).
    if (s && s.permissions && Array.isArray(s.permissions.allow)) {
      const antes = s.permissions.allow.length;
      s.permissions.allow = s.permissions.allow.filter((r) => !/\.claude[\\/]hooks[\\/]/.test(String(r)));
      if (s.permissions.allow.length !== antes) sCambio = true;
    }
    if (sCambio) { fs.writeFileSync(cl('settings.json'), JSON.stringify(s, null, 2) + '\n', 'utf8'); algo = true; }
  } catch {}
  // ONBOARDING sin motor: tras la migracion, entre el pull y aceptar el plugin NO corre ningun
  // hook — el UNICO canal que Claude Code lee SIEMPRE es CLAUDE.md. Se le antepone un bloque
  // corto (una vez; marcador 'plugin faro') que guia a cualquier companero que abra el repo.
  try {
    const cmPath = path.join(destino, 'CLAUDE.md');
    const cm = fs.readFileSync(cmPath, 'utf8');
    if (!/plugin faro/i.test(cm)) {
      const aviso = [
        '> **Este repo se gobierna por el PLUGIN faro de Claude Code** (el motor ya NO vive en `.claude/`).',
        '> Si las skills `/faro:*` no responden: acepta instalar el plugin cuando Claude Code lo ofrezca',
        '> (requiere acceso al proyecto del plugin con git autenticado) y ejecuta `/reload-plugins`. Manual:',
        `> \`/plugin marketplace add ${fuenteCm}\` → \`/plugin install faro@faro-marketplace\` (scope project).`,
        '', '',
      ].join('\n');
      fs.writeFileSync(cmPath, aviso + cm, 'utf8');
      algo = true;
      ok('CLAUDE.md: bloque de arranque del plugin antepuesto (guia a quien abra el repo sin el plugin).');
    }
  } catch {}
  // AVISOS de restos que NO se tocan en automatico (decision humana):
  try {
    const ci = fs.readFileSync(path.join(destino, '.gitlab-ci.yml'), 'utf8');
    if (/\.claude[\\/]hooks[\\/]/.test(ci)) warn('.gitlab-ci.yml invoca el harness legado (ya retirado) — actualiza el CI o borra el archivo si este repo no usa GitLab.');
  } catch {}
  try {
    const cm = fs.readFileSync(path.join(destino, 'CLAUDE.md'), 'utf8');
    if (/\.claude[\\/]hooks[\\/]/.test(cm)) warn('CLAUDE.md referencia el motor legado — reconcilialo con la fase 2 (/faro:adoptar dentro de Claude), que re-mapea docs al modelo plugin.');
  } catch {}
  // faro-schema.json en .claude/ raiz = copia SEMILLA del contrato (el motor vive SOLO en el
  // plugin, siempre al dia via auto-update) — una copia local queda desactualizada y TAPA el
  // contrato real. Se elimina directo al migrar: nada que decidir, el plugin manda.
  if (fs.existsSync(cl('faro-schema.json'))) { fs.rmSync(cl('faro-schema.json'), { force: true }); algo = true; }
  if (algo) ok('Copia legada del harness retirada — este repo pasa a gobernarse por el PLUGIN faro (una sola fuente, auto-update).');
  return algo;
}

// Claude Code clona los marketplaces por HTTPS y desde SU directorio. El origen es publico, asi que
// no hace falta cablear credenciales; 'git config faro.marketplaceUrl' lo sustituye (espejo propio).
// ¿Git puede leer una URL HTTPS sin pedir nada por consola? GIT_TERMINAL_PROMPT=0 + credential.interactive=false
// evitan que se cuelgue en un prompt: si le faltan credenciales, falla rapido (que es justo lo que queremos medir).
function puedeLeerHttps(url) {
  try {
    execFileSync('git', ['-c', 'credential.interactive=false', 'ls-remote', '--heads', url, 'HEAD'],
      { stdio: 'ignore', timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return true;
  } catch { return false; }
}

// Comprueba que Claude Code podra bajar el plugin. Si no, avisa y sigue: al plugin se llega por la red,
// no por una cuenta, y un repo creado sigue siendo valido sin el.
async function asegurarCredencialesPlugins({ perfil = null, override = '', silencioSiOk = true, leer = puedeLeerHttps } = {}) {
  if (DRY) { say(`  ${C.d}(dry-run) omito comprobar el marketplace de plugins${C.x}`); return { estado: 'dry' }; }
  const mk = marketplaceDe(perfil || PERFILES.github, override);
  if (leer(mk.url)) {
    if (!silencioSiOk) ok(`Plugin faro: marketplace accesible (${mk.url}).`);
    return { estado: 'ok' };
  }
  warn(`No puedo leer el marketplace del plugin faro (${mk.url}): revisa red, proxy o VPN. El repo queda bien; Claude Code lo instalará cuando llegue a esa URL.`);
  return { estado: 'sin-acceso' };
}

// PLANTILLAS HTML LEGADAS: los repos creados antes de que las plantillas de marca viajaran en el
// plugin (0.4.32) conservan su copia en documentos/plantillas/html/. El harness resuelve repo ->
// plugin, asi que esa copia GANA... y se quedo congelada el dia que nacio el repo: sin los arreglos
// de impresion (print-color-adjust, break-inside, control de desbordes) y sin las mejoras futuras.
// Nadie las personalizo — estan ahi por herencia, no por decision. Se detectan y se ofrece retirar
// las que sean copia sin tocar; si el equipo modifico alguna, esa se respeta (es personalizacion).
// Los nombres de las plantillas los da la caché del plugin instalado; aquí, solo el renderizador.
const PLANTILLAS_MARCA = ['render-doc.mjs'];
// Rutas donde han vivido las plantillas segun la epoca del repo. La vigente es documentos/plantillas/html/,
// pero los repos anteriores a la taxonomia nueva las tienen en docs/plantillas/ (legado): mirar solo la
// vigente dejaba esas copias intactas, tapando a las del plugin justo en los repos MAS antiguos.
const DIRS_PLANTILLAS = [
  ['documentos', 'plantillas', 'html'],
  ['docs', 'plantillas', 'html'],
  ['docs', 'plantillas'],
];
// NOMENCLATURA DOCUMENTAL: misma historia que las plantillas, pero peor — es la fuente de verdad de
// los doc_id. Se sembraba en cada repo y acabo habiendo 7 copias con 3 contenidos distintos (16 KB,
// 11 KB, 2 KB): si dos repos discrepan sobre que significa 'ANA' o que codigos existen, la
// documentacion de la organizacion deja de ser comparable. Desde plugin 0.8.5 la sirve el plugin
// (docs/nomenclatura-documental.md) y el contrato vigente de tipos es `harness.js tipo`.
const DOCS_LEGADOS = [
  ['documentos', 'nomenclatura-documental.md'],
  ['documentos', 'arquitectura', 'nomenclatura-documental.md'],
  ['docs', 'nomenclatura-documental.md'],
];
function plantillasLegadas(destino) {
  const out = [];
  const vistos = new Set();
  for (const seg of DOCS_LEGADOS) {
    const f = path.join(destino, ...seg);
    if (!fs.existsSync(f) || vistos.has(f)) continue;
    vistos.add(f);
    out.push({ nombre: seg[seg.length - 1], ruta: f, obsoleta: true, rel: path.relative(destino, f) });
  }
  for (const seg of DIRS_PLANTILLAS) {
    const dir = path.join(destino, ...seg);
    if (!fs.existsSync(dir)) continue;
    for (const n of new Set([...PLANTILLAS_MARCA, ...listasDesdeCache().plantillas])) {
      const f = path.join(dir, n);
      if (!fs.existsSync(f) || vistos.has(f)) continue;
      vistos.add(f);
      // Heuristica de "copia vieja": le faltan los arreglos de impresion que el plugin ya trae.
      // No se compara con el fichero del plugin (puede no estar instalado aun en esta maquina).
      // TODA copia sin sufijo .custom es legado: el plugin manda desde 0.8.x y personalizar de verdad
      // se hace con <nombre>.custom.html (override EXPLICITO, que no se hereda al copiar un repo).
      out.push({ nombre: n, ruta: f, obsoleta: true, rel: path.relative(destino, f) });
    }
  }
  return out;
}

// Reporta (y opcionalmente retira) el material de marca/convencion heredado (plantillas HTML +
// nomenclatura documental). Devuelve true si retiro algo.
async function revisarPlantillasLegadas(destino, { aplicar = true } = {}) {
  const list = plantillasLegadas(destino);
  if (!list.length) return false;
  const viejas = list.filter((p) => p.obsoleta);
  if (!viejas.length) {
    say(`  ${C.d}Material de marca local (${list.length}) — parece personalizado: se respeta (manda sobre lo del plugin).${C.x}`);
    return false;
  }
  warn(`${viejas.length} fichero(s) heredados que el plugin ya provee: ${viejas.map((p) => p.rel || p.nombre).join(', ')}`);
  say(`  ${C.d}Las plantillas de marca y la nomenclatura documental las sirve el plugin y se actualizan solas. Estas copias quedaron del día en que nació el repo: no reciben mejoras y, en el caso de la nomenclatura, hacen que cada repo acabe con una convención distinta (los doc_id dejan de ser comparables entre proyectos).${C.x}`);
  say(`  ${C.d}Si de verdad quieres una plantilla distinta en este repo, renómbrala a <nombre>.custom.html — ese override sí lo respeta el harness.${C.x}`);
  if (!aplicar || DRY) return false;
  if (!(YES || await confirma('¿Retirarlos? (el repo pasa a usar los del plugin, siempre al día)', 's'))) {
    say(`  ${C.d}Sin cambios — puedes retirarlos luego borrando esos ficheros.${C.x}`);
    return false;
  }
  let n = 0;
  for (const p of viejas) { try { fs.rmSync(p.ruta); n++; } catch {} }
  ok(`Retirados ${n} fichero(s) heredados — el repo pasa a usar los del plugin (nomenclatura: \`harness.js tipo\`).`);
  return n > 0;
}

// Node NO puede lanzar un .cmd/.bat en Windows sin shell:true: CreateProcess no los interpreta
// directamente (limitacion documentada de Node, no un bug de esta pieza). Sin esto, invocar
// 'claude.cmd' falla SIEMPRE con EINVAL, este el binario perfectamente instalado o no — reproducido
// 11 sep 2026: una instalacion npm global de Windows (el caso mas comun, 'npm install -g
// @anthropic-ai/claude-code') deja SOLO claude.cmd + claude (shim POSIX sin extension) + claude.ps1,
// nunca claude.exe. `claude.exe` en cands es el caso raro (instalador nativo); sin este fix, en el
// caso comun claudeBin() no encontraba NADA y instalarPluginsClaude() se degradaba en silencio a
// "no encuentro la CLI claude en el PATH" con el binario delante, dejando el plugin faro sin
// instalar/actualizar en cada crear/adoptar/check.
const necesitaShellWin = (b) => process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(b || ''));

// Binario de Claude Code. En Windows execFileSync NO resuelve la extension: 'claude' falla aunque
// exista claude.exe/.cmd en el PATH (mismo patron que editorBin con code/cursor). Ademas el
// instalador oficial lo deja en ~/.local/bin, que no siempre esta en el PATH del proceso que lanza
// el wizard (npx heredando un entorno distinto al de tu terminal). Se prueban variantes y rutas
// conocidas; el resultado se cachea porque esto se llama varias veces por ejecucion.
let _claudeBin;
function claudeBin() {
  if (_claudeBin !== undefined) return _claudeBin;
  const win = process.platform === 'win32';
  const home = os.homedir();
  const cands = win ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const rutas = [
    path.join(home, '.local', 'bin', win ? 'claude.exe' : 'claude'),
    path.join(home, '.claude', 'local', win ? 'claude.exe' : 'claude'),
  ];
  for (const b of [...cands, ...rutas]) {
    try { execFileSync(b, ['--version'], { stdio: 'ignore', timeout: 15000, shell: necesitaShellWin(b) }); _claudeBin = b; return b; } catch {}
  }
  _claudeBin = null;
  return null;
}

// Compara versiones x.y.z NUMERICAMENTE. Como texto, '0.9.2' > '0.10.0' seria cierto (falso), y el
// parser elegiria la entrada equivocada justo al cruzar la decena de minor — el salto que FARO ya
// tiene a la vista (0.9.x -> 0.10.x).
function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Estado REAL de los plugins segun Claude Code (no segun nuestro settings): 'claude plugin list'
// es la fuente soportada. installed_plugins.json es formato INTERNO (y su forma ha cambiado: las
// claves cuelgan de la raiz, no de .plugins — leerlo mal daba "no instalado" siempre).
// Devuelve Map<idPlugin, {version, scope, enabled}> o null si no hay CLI 'claude' disponible.
// PARSEO PURO de la salida de 'claude plugin list' (sin CLI: testeable en aislado, igual que
// accionParaPlugin). 'plugin list' repite el MISMO id una vez por instalacion: en una maquina con
// historial salen decenas de entradas 'project' (una por repo donde se acepto el plugin) ADEMAS de
// la 'user'. Medido en esta maquina: 13 entradas de faro@faro-marketplace (0.4.31, 0.8.5 x8 y 0.9.2
// x3 en project, mas la 0.9.2 en user). Con un m.set() plano GANABA LA ULTIMA -> se leia scope
// 'project' y accionParaPlugin decidia 'install' eternamente: el refresco NUNCA corria y el wizard
// reinstalaba en cada pasada (~19s tirados). Manda la entrada de scope 'user' (la que cubre TODOS
// los repos); entre varias del mismo scope, la de version mayor.
function parseListaPlugins(out) {
  const m = new Map();
  const mejor = (a, b) => {
    if (!a) return b;
    if (a.scope !== b.scope) return b.scope === 'user' ? b : a;   // 'user' gana al resto de scopes
    return cmpVersion(b.version, a.version) > 0 ? b : a;          // mismo scope: la mas nueva
  };
  let cur = null;
  const volcar = () => { if (cur) m.set(cur.id, mejor(m.get(cur.id), cur)); };
  for (const l of String(out || '').split(/\r?\n/)) {
    const h = l.match(/^\s*❯\s*(\S+)/);
    // Cabecera: cierra la entrada anterior (ya completa) y abre la nueva. Volcar al CERRAR, y no al
    // abrir, es lo que permite comparar por scope/version con todos sus campos ya leidos.
    if (h) { volcar(); cur = { id: h[1], version: null, scope: null, enabled: false }; continue; }
    if (!cur) continue;
    const v = l.match(/Version:\s*(\S+)/); if (v) cur.version = v[1];
    const sc = l.match(/Scope:\s*(\S+)/); if (sc) cur.scope = sc[1];
    if (/Status:/.test(l)) cur.enabled = /enabled/i.test(l);
  }
  volcar();   // la ultima entrada del listado no tiene cabecera detras que la cierre
  return m;
}

// TODAS las entradas por id (con scope y version): para detectar instalaciones 'project' anticuadas.
function parseListaPluginsTodas(out) {
  const m = new Map(); let cur = null;
  const volcar = () => { if (cur) { if (!m.has(cur.id)) m.set(cur.id, []); m.get(cur.id).push(cur); } };
  for (const l of String(out || '').split(/\r?\n/)) {
    const h = l.match(/^\s*❯\s*(\S+)/);
    if (h) { volcar(); cur = { id: h[1], version: null, scope: null, enabled: false }; continue; }
    if (!cur) continue;
    const v = l.match(/Version:\s*(\S+)/); if (v) cur.version = v[1];
    const sc = l.match(/Scope:\s*(\S+)/); if (sc) cur.scope = sc[1];
    if (/Status:/.test(l)) cur.enabled = /enabled/i.test(l);
  }
  volcar(); return m;
}
// Entradas project/local con version MENOR que la user: una instalacion 'project' PISA a la 'user'
// (medido: sesion corriendo con 0.9.7 teniendo 0.14.0 en user), asi que actualizar solo 'user' no basta.
function refrescosProject(todas, id) {
  const lista = todas.get(id) || [];
  const user = lista.find((e) => e.scope === 'user');
  if (!user) return [];
  return lista.filter((e) => (e.scope === 'project' || e.scope === 'local') && e.version && cmpVersion(e.version, user.version) < 0);
}

function listaPluginsCruda() {
  const bin = claudeBin();
  if (!bin) return null;
  // 60s: 'plugin list' puede tardar bastante en frio (antivirus + binario de ~285 MB). Con 20s se
  // agotaba y el CLI concluia "no encuentro la CLI claude" teniendola delante.
  try { return execFileSync(bin, ['plugin', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000, windowsHide: true, shell: necesitaShellWin(bin) }).toString(); }
  catch { return null; }   // no responde: no podemos instalar, se degrada a declarar
}
function estadoPluginsClaude() { const c = listaPluginsCruda(); return c === null ? null : parseListaPlugins(c); }

// INSTALACION REAL de los plugins (via CLI oficial no interactivo, Claude Code >= 2.x):
//   claude plugin marketplace add <repo> --scope user
//   claude plugin install <plugin>@<marketplace> --scope user
// SCOPE 'user' A PROPOSITO: instala UNA vez por MAQUINA y sirve para TODOS los repos. Con 'project'
// habria que reinstalar repo a repo y cualquier repo no cubierto abre sin plugin (sintoma tipico:
// "tengo que hacer /reload-plugins cada vez"). La DECLARACION sigue siendo del repo
// (escribirSettingsPlugin -> .claude/settings.json commiteado): eso es lo que hereda el equipo.
// Es idempotente y NO bloquea: si falta el binario 'claude' o falla la descarga, se avisa y el
// usuario mantiene el camino de siempre (aceptar el plugin al abrir Claude Code).
// Marketplace 'faro-marketplace' de scope USER: en una maquina solo puede haber UNO con ese nombre.
// Sale del origen publico; 'git config faro.marketplaceUrl' manda sobre el (cliente con espejo propio).
function fuenteMarketplaceUser(perfil = null, override = '') {
  const o = String(override || '').trim();
  if (o) return { fuente: o, url: o, origen: 'override' };
  const { url } = marketplaceDe(perfil || PERFILES.github, '');
  return { fuente: url, url, origen: 'publico' };
}
// Fuente con la que ESTA registrado 'faro-marketplace' en la maquina (known_marketplaces.json), o null.
function marketplaceRegistrado() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json'), 'utf8'));
    const e = j && j['faro-marketplace'] && j['faro-marketplace'].source;
    if (!e) return null;
    return e.source === 'github' ? String(e.repo) : String(e.url || e.path || '');
  } catch { return null; }
}
const mismaFuente = (a, b) => String(a || '').toLowerCase().replace(/\.git$/, '').replace(/\/$/, '') === String(b || '').toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
const MARKETPLACE_OFICIAL = { nombre: 'claude-plugins-official', fuente: 'anthropics/claude-plugins-official' };
const PLUGINS_INSTALL = [
  { id: 'faro@faro-marketplace', etiqueta: 'faro' },
  { id: 'superpowers@claude-plugins-official', etiqueta: 'superpowers' },
];

// CACHE HUERFANA: ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ acumula una carpeta por
// cada version que se instalo ALGUNA vez en esta maquina (medido: faro con 0.8.5/0.9.7/0.14.0 vivas a
// la vez, ~3 MB de las que ninguna era la activa). instalarPluginsClaude() nunca las borraba — no era
// un fallo funcional (Claude Code siempre usa la version que marca installed_plugins.json, no la
// carpeta mas reciente), pero tampoco es "actualizar bien": versiones que YA NO usa NADIE se quedan.
// La regla es conservadora a proposito: una version se borra SOLO si NINGUN scope, de NINGUN repo de
// la maquina, la referencia en installed_plugins.json — el registro real de Claude Code, no una
// suposicion nuestra. Una instalacion 'project' de otro repo que a proposito sigue en una version
// vieja (caso real, visto en esta maquina: superpowers 6.2.0 en un repo sin refrescar) queda intacta.
function versionesEnUso(instalados, id) {
  const lista = (instalados && instalados[id]) || [];
  return new Set(lista.map((e) => e && e.version).filter(Boolean));
}
function limpiarCacheAntigua({ homeDir = os.homedir(), aplicar = true } = {}) {
  let instalados = {};
  try { instalados = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; }
  catch { return { estado: 'sin-registro', borrados: [] }; }   // sin registro legible: no se toca nada
  const borrados = [];
  for (const p of PLUGINS_INSTALL) {
    const [nombre, marketplace] = p.id.split('@');
    const enUso = versionesEnUso(instalados, p.id);
    const base = path.join(homeDir, '.claude', 'plugins', 'cache', marketplace, nombre);
    let versiones = [];
    try { versiones = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+/.test(d.name)).map((d) => d.name); }
    catch { continue; }   // sin cache para este plugin: nada que limpiar
    for (const v of versiones) {
      if (enUso.has(v)) continue;
      const dir = path.join(base, v);
      if (aplicar) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { continue; } }
      borrados.push({ plugin: p.etiqueta, version: v, ruta: dir });
    }
  }
  return { estado: 'ok', borrados };
}

// Decision PURA (sin red/binario, testeable en aislado): dado el estado real de un plugin segun
// 'claude plugin list', que accion toca. 'update' es la novedad (0.34.2): antes, un plugin YA
// activo en scope user se daba por bueno sin comprobar version — el wizard nunca refrescaba la
// cache del usuario, asi que crear/adoptar/check podian quedarse trabajando con un plugin viejo
// (ej.: bugs ya corregidos en la ultima release, como el ciclo git sin bloquear en modo plugin).
// 'claude plugin update' es idempotente y rapido si ya esta al dia — se ejecuta SIEMPRE.
// Ejecucion NO bloqueante para poder lanzar en PARALELO los refrescos (marketplaces y plugins son
// independientes entre si). Medido en Windows: en serie el wizard se comia ~19s EXTRA por ejecucion
// (marketplace update 6.3s + 2.8s, plugin update 2.6s + 7.4s) sobre un 'faro check' que hoy responde
// en pocos segundos — inaceptable en el comando que uno lanza justo cuando algo va mal. En paralelo
// el coste baja al mas lento (~7s) y con TECHO propio: 300s dejaba el wizard colgado 5 minutos si la
// red arrastra, y este trabajo es una MEJORA oportunista, no un requisito para continuar.
const pExecFile = promisify(execFile);
const TIMEOUT_REFRESCO = 45000;
async function cmdPlugin(bin, args, timeout = TIMEOUT_REFRESCO, opts = {}) {
  try { await pExecFile(bin, args, { timeout, windowsHide: true, shell: necesitaShellWin(bin), ...opts }); return true; }
  catch { return false; }
}

// VENTANA del refresco. Cada comando 'claude' arranca un binario de ~285 MB: medido aqui, el coste
// fijo es ~2s por invocacion y el refresco completo (list + 2 marketplace update + 2 plugin update,
// ya paralelizado por etapas) se va a ~17-21s. Pagarlo en CADA 'faro check' es inaceptable: es el
// comando que uno lanza justo cuando algo va mal y quiere respuesta ya. Y no hace falta — el plugin
// publica versiones cada dias, no cada minuto, y Claude Code ademas tiene su propio autoUpdate.
// Con una marca diaria el caso comun sale GRATIS y el refresco sigue ocurriendo solo. '--reautorizar'
// lo fuerza, para cuando alguien quiere comprobar AHORA que tiene la ultima.
const REFRESCO_CADA_MS = 24 * 3600 * 1000;
function tocaRefrescar() {
  if (process.argv.includes('--reautorizar')) return true;   // el usuario pide comprobarlo ya
  try {
    const cfg = loadConfig() || {};
    const ts = cfg.plugins_refresco && cfg.plugins_refresco.ts;
    return !(ts && (Date.now() - ts) < REFRESCO_CADA_MS);
  } catch { return true; }   // sin config legible: refrescar (conservador)
}
function marcarRefresco() {
  try { const cfg = loadConfig() || {}; cfg.plugins_refresco = { ts: Date.now() }; saveConfig(cfg); } catch {}
}

function accionParaPlugin(st) {
  if (!st) return 'install';
  if (st.scope !== 'user') return 'install'; // mueve de scope (enable NO lo mueve)
  if (!st.enabled) return 'enable';
  return 'update';
}

async function instalarPluginsClaude({ silencioSiOk = true, destino = null, perfil = null, override = '', forzar = false } = {}) {
  if (DRY) { say(`  ${C.d}(dry-run) omito instalar plugins de Claude Code${C.x}`); return { estado: 'dry' }; }
  const mkFaro = fuenteMarketplaceUser(perfil, override);
  const MARKETPLACES_INSTALL = [{ nombre: 'faro-marketplace', fuente: mkFaro.fuente }, MARKETPLACE_OFICIAL];
  const cruda = listaPluginsCruda();
  const estado = cruda === null ? null : parseListaPlugins(cruda);
  const todas = cruda === null ? new Map() : parseListaPluginsTodas(cruda);
  const bin = claudeBin();
  if (estado === null) {
    caja([
      bin
        ? `${C.b}La CLI ${C.c}claude${C.x}${C.b} está, pero no pude consultar sus plugins${C.x} — no puedo dejarlos instalados por ti.`
        : `${C.b}No encuentro la CLI ${C.c}claude${C.x}${C.b} en el PATH${C.x} — no puedo dejar los plugins instalados por ti.`,
      `Los plugins quedan DECLARADOS en el settings del repo: al abrir Claude Code aquí te los ofrecerá.`,
      `Si prefieres dejarlo hecho ahora (una vez por máquina):`,
      `  ${C.c}claude plugin install faro@faro-marketplace --scope user${C.x}`,
      `  ${C.c}claude plugin install superpowers@claude-plugins-official --scope user${C.x}`,
    ], { titulo: 'Plugins: instalación manual', color: C.c });
    return { estado: 'sin-cli' };
  }
  const hechos = [], fallos = [], actualizados = [], sinRefrescar = [];
  const faltaAlgo = PLUGINS_INSTALL.some((p) => accionParaPlugin(estado.get(p.id)) !== 'update');
  // El refresco se salta si ya se hizo hoy Y no falta nada por instalar. Si falta algo, los
  // marketplaces son OBLIGATORIOS (sin ellos el ID <plugin>@<marketplace> no resuelve y el install
  // falla), asi que la ventana NUNCA puede saltarse una instalacion real: solo el refresco.
  const refrescar = forzar || tocaRefrescar();
  if (refrescar || faltaAlgo) {
    // En PARALELO: los marketplaces son independientes entre si. El REFRESCO del indice ('marketplace
    // update') es imprescindible — 'add' sobre un marketplace ya declarado NO lo actualiza, asi que sin
    // el 'plugin update' resuelve contra un indice rancio y responde "already at the latest version"
    // siendo falso. Fallar aqui no es motivo de alarma: solo significa que no habra refresco.
    // Si 'faro-marketplace' esta registrado con OTRA fuente (p. ej. el espejo de GitHub y ahora toca el
    // principal de GitLab), 'add' no lo cambia: se retira y se vuelve a declarar con la fuente buena.
    const reg = marketplaceRegistrado();
    if (reg && !mismaFuente(reg, mkFaro.fuente)) {
      if (await cmdPlugin(bin, ['plugin', 'marketplace', 'remove', 'faro-marketplace'])) say(`  ${C.d}Marketplace faro: ${reg} → ${mkFaro.fuente} (${mkFaro.origen === 'principal' ? 'el principal, en GitLab' : mkFaro.origen}).${C.x}`);
    }
    await Promise.all(MARKETPLACES_INSTALL.map(async (mk) => {
      await cmdPlugin(bin, ['plugin', 'marketplace', 'add', mk.fuente, '--scope', 'user']);   // ya declarado (lo normal) o sin red
      if (refrescar) await cmdPlugin(bin, ['plugin', 'marketplace', 'update', mk.nombre]);
    }));
  }
  // Los REFRESCOS de plugins ya activos van en paralelo entre si (independientes). Las instalaciones
  // reales quedan en serie: son el camino raro (primera vez / cambio de scope) y ahi el usuario
  // agradece ver una cosa a la vez antes que ganar segundos.
  if (refrescar) {
    await Promise.all(PLUGINS_INSTALL.filter((p) => accionParaPlugin(estado.get(p.id)) === 'update').map(async (p) => {
      const st = estado.get(p.id);
      // El UPDATE se contabiliza APARTE de install/enable a proposito: el plugin YA esta puesto y
      // sirviendo, asi que ni su exito es "instalado" ni su fallo es "no pude instalar" (ese aviso, con
      // su 'Manual: claude plugin install', asustaria por un simple refresco sin red).
      if (await cmdPlugin(bin, ['plugin', 'update', p.id, '--scope', 'user'])) actualizados.push(`${p.etiqueta}${st.version ? ` (tenias ${st.version})` : ''}`);
      else sinRefrescar.push(p.etiqueta);
    }));
    marcarRefresco();   // se marca aunque algun update falle: reintentar en bucle costaria ~20s por pasada
  }
  // Instalaciones 'project'/'local' del repo procesado ANTICUADAS respecto a 'user': se refrescan con
  // cwd en el repo, que es donde Claude Code las registra (sin cwd, 'update --scope project' no sabe cual).
  const refrescadosRepo = [];
  if (destino) {
    for (const p of PLUGINS_INSTALL) for (const e of refrescosProject(todas, p.id)) {
      if (await cmdPlugin(bin, ['plugin', 'update', p.id, '--scope', e.scope], TIMEOUT_REFRESCO, { cwd: destino })) refrescadosRepo.push(`${p.etiqueta} ${e.version} → al día (scope ${e.scope})`);
    }
  }
  for (const p of PLUGINS_INSTALL) {
    const st = estado.get(p.id);
    // Cuatro casos, y confundirlos deja el plugin sin cargar O desactualizado:
    //  - no instalado            -> install --scope user
    //  - instalado en OTRO scope -> install --scope user IGUAL. 'enable' NO mueve el scope: activaria
    //    una instalacion 'project' que solo cubre las rutas donde se registro, asi que en cualquier
    //    otro repo seguiria sin cargar (el caso real que obliga a /plugin reload en cada apertura).
    //  - instalado en user y desactivado -> enable (no hace falta reinstalar)
    //  - instalado en user y activo -> update SIEMPRE (idempotente; sin esto el wizard daba por
    //    bueno un plugin viejo sin refrescarlo — ver accionParaPlugin).
    const accion = accionParaPlugin(st);
    if (accion === 'update') continue;   // ya resuelto en paralelo arriba
    try {
      if (accion === 'install') execFileSync(bin, ['plugin', 'install', p.id, '--scope', 'user'], { stdio: 'ignore', timeout: 300000, shell: necesitaShellWin(bin) });
      else execFileSync(bin, ['plugin', 'enable', p.id, '--scope', 'user'], { stdio: 'ignore', timeout: 60000, shell: necesitaShellWin(bin) });
      hechos.push(st && st.scope && st.scope !== 'user' ? `${p.etiqueta} (movido de ${st.scope} a user)` : p.etiqueta);
    } catch { fallos.push(p); }
  }
  if (hechos.length) ok(`Plugins de Claude Code listos para TODOS tus repos: ${hechos.join(', ')} ${C.d}(scope user — una vez por máquina)${C.x}`);
  // Se informa SIEMPRE (no bajo silencioSiOk): los 3 flujos llaman sin argumentos, y callarlo dejaba
  // el caso NORMAL — plugin ya activo, que es el de todo usuario con FARO puesto — sin una sola linea.
  // Si el refresco trae una version nueva, el motor del usuario CAMBIA: eso se dice, no se oculta.
  if (actualizados.length) ok(`Plugins al día (última versión): ${actualizados.join(', ')} ${C.d}(reinicia Claude Code si estaba abierto)${C.x}`);
  if (refrescadosRepo.length) ok(`Plugin del repo actualizado: ${refrescadosRepo.join(', ')} ${C.d}(una instalación 'project' anticuada pisa a la de usuario)${C.x}`);
  if (sinRefrescar.length) say(`  ${C.d}No pude comprobar actualizaciones de: ${sinRefrescar.join(', ')} — sigue funcionando con la versión que ya tenías.${C.x}`);
  if (fallos.length) {
    warn(`No pude instalar: ${fallos.map((f) => f.etiqueta).join(', ')} — quedan declarados en el repo (Claude Code los ofrecerá al abrirlo).`);
    for (const f of fallos) say(`  ${C.d}Manual: ${C.c}claude plugin install ${f.id} --scope user${C.x}`);
  }
  // Cache huerfana: versiones que ya no usa NINGUN scope de NINGUN repo (segun el registro real de
  // Claude Code). Best-effort y silencioso salvo que de verdad borre algo — nunca bloquea el resultado.
  try {
    const limpieza = limpiarCacheAntigua({});
    if (limpieza.borrados.length) say(`  ${C.d}Caché: retiradas ${limpieza.borrados.length} versión(es) sin usar de ${[...new Set(limpieza.borrados.map((b) => b.plugin))].join(', ')} (${limpieza.borrados.map((b) => b.version).join(', ')}).${C.x}`);
  } catch {}
  return { estado: fallos.length ? 'parcial' : 'ok', hechos, actualizados, sinRefrescar, fallos: fallos.map((f) => f.id) };
}

// Compatibilidad: el nombre viejo se mantiene (lo importan los 3 flujos) pero ahora INSTALA de verdad
// ambos plugins, no solo reporta superpowers.
function asegurarPluginSuperpowers(o = {}) { return instalarPluginsClaude(o); }   // devuelve Promise: los 3 flujos la AWAITAN (sin await, el proceso puede terminar antes del refresco)


export {
  pluginsHuerfanos, settingsPluginOk, escribirSettingsPlugin,
  FARO_HOOK_FILES, FARO_AGENT_FILES, FARO_ENGINE_FILES, listasDesdeCache, migrarCopiaLegada,
  asegurarCredencialesPlugins,
  PLANTILLAS_MARCA, plantillasLegadas, revisarPlantillasLegadas,
  claudeBin, necesitaShellWin, cmpVersion, parseListaPlugins, parseListaPluginsTodas, refrescosProject, listaPluginsCruda, estadoPluginsClaude, fuenteMarketplaceUser, marketplaceRegistrado,
  versionesEnUso, limpiarCacheAntigua,
  accionParaPlugin, instalarPluginsClaude, asegurarPluginSuperpowers,
};
