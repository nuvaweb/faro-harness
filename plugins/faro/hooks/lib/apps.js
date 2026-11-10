// lib/apps.js — MODO MONOREPO: que apps tiene este repo y que es cada una (#129).
//
// Un monorepo FARO tiene UNA gestion en la raiz (ESTADO, RAID, requisitos, documentos) y varias apps
// en el workspace (apps/*). Este modulo es el UNICO sitio donde el motor lo averigua: gates, release,
// skills e issues por app le preguntan aqui, para que nadie reinvente la deteccion.
//
// Dos fuentes, a proposito separadas:
//   - lo DECLARADO (.faro.json > monorepo): rol, funcional y equipo de cada app, y la plantilla del
//     tag. La clave 'monorepo' es la que ACTIVA el modo: un workspace sin ella es solo un dato.
//   - lo DEDUCIDO del disco: ruta, paquete y version (package.json), worker (wrangler.*), front,
//     contrato (ARCHITECTURE.md), changelog propio y tests. Lo tecnico no se declara: se lee, porque
//     una declaracion a mano se queda vieja y el disco no miente.
//
// El contexto POR APP no lo inyecta FARO: lo carga Claude Code solo, leyendo el CLAUDE.md anidado de
// cada carpeta cuando se trabaja en ella. Por eso aqui solo se comprueba que exista.
//
// Sin dependencias: fs/path nativos y un parser minimo de pnpm-workspace.yaml.
'use strict';
const fs = require('fs');
const path = require('path');

const FARO_JSON = '.faro.json';
const TAG_DEFECTO = '{app}@{version}';
// Carpetas del workspace que contienen codigo COMPARTIDO, no apps desplegables. Su contenido no se
// exige declarado. El contrato (faro-schema.json > enums.monorepo.carpetas_paquete) puede ampliarlas.
const CARPETAS_PAQUETE = ['packages', 'libs'];
const NO_ENTRAR = new Set(['node_modules', '.git', 'dist', 'build', '.wrangler', '.next', '.output', '.turbo', 'coverage']);

const leer = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } };
const leerJson = (abs) => { const t = leer(abs); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } };
const existe = (abs) => { try { return fs.existsSync(abs); } catch { return false; } };
const esDir = (abs) => { try { return fs.statSync(abs).isDirectory(); } catch { return false; } };
const posix = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const parseJsonc = (texto) => {
  if (!texto) return null;
  try { return JSON.parse(texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')); } catch { return null; }
};

// ---------- lo declarado ----------

function faroJson(root) { return leerJson(path.join(root, FARO_JSON)) || {}; }

/** El bloque .faro.json > monorepo tal cual, o null si no existe (o no es un objeto). */
function leerConfig(root) {
  const m = faroJson(root).monorepo;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
}

/** ¿Esta ACTIVO el modo monorepo? Solo por declaracion explicita (.faro.json > monorepo). */
function esMonorepo(root) { return leerConfig(root) !== null; }

// ---------- lo deducido: el workspace ----------

/**
 * Globs de 'packages:' de un pnpm-workspace.yaml. Parser MINIMO: lista en bloque ('- x') o en linea
 * ([a, b]); quita comillas; descarta negaciones ('!...'); se detiene en la siguiente clave raiz.
 */
function parsePnpmWorkspace(texto) {
  const out = [];
  const limpiar = (s) => s.trim().replace(/^['"]|['"]$/g, '').trim();
  const lineas = String(texto || '').split(/\r?\n/);
  let dentro = false;
  for (const l of lineas) {
    const sin = l.replace(/\s+#.*$/, '');
    if (/^\s*#/.test(sin) || !sin.trim()) continue;
    const item = sin.match(/^\s*-\s*(.+)$/);
    if (item) { if (dentro) out.push(limpiar(item[1])); continue; }
    const clave = sin.match(/^(\S[^:]*):\s*(.*)$/);
    if (clave) {
      dentro = clave[1].trim() === 'packages';
      if (dentro && clave[2].trim().startsWith('[')) {
        clave[2].replace(/^\s*\[|\]\s*$/g, '').split(',').map(limpiar).filter(Boolean).forEach((g) => out.push(g));
        dentro = false;
      }
    }
  }
  return out.filter((g) => g && !g.startsWith('!'));
}

/** De donde sale el workspace y sus globs: {fuente: 'pnpm-workspace.yaml'|'package.json'|null, globs}. */
function workspace(root) {
  const yaml = leer(path.join(root, 'pnpm-workspace.yaml'));
  if (yaml != null) return { fuente: 'pnpm-workspace.yaml', globs: parsePnpmWorkspace(yaml) };
  const pkg = leerJson(path.join(root, 'package.json'));
  const ws = pkg && pkg.workspaces;
  const globs = Array.isArray(ws) ? ws : (ws && Array.isArray(ws.packages) ? ws.packages : null);
  if (globs) return { fuente: 'package.json', globs: globs.map(String).filter((g) => g && !g.startsWith('!')) };
  return { fuente: null, globs: [] };
}

// Globs SIMPLES: 'dir/*' (un nivel; 'dir/**' se trata igual) o una ruta literal. Lo demas se ignora.
function expandirGlob(root, glob) {
  const g = posix(glob).replace(/^\.\//, '');
  const m = g.match(/^(.*?)\/\*\*?$/);
  if (m) {
    const base = m[1];
    let hijos = [];
    try { hijos = fs.readdirSync(path.join(root, base), { withFileTypes: true }); } catch { return []; }
    return hijos.filter((d) => d.isDirectory() && !NO_ENTRAR.has(d.name)).map((d) => `${base}/${d.name}`).sort();
  }
  if (g.includes('*')) return [];
  return esDir(path.join(root, g)) ? [g] : [];
}

function carpetasPaquete(schema) {
  const s = schema && schema.enums && schema.enums.monorepo;
  return (s && Array.isArray(s.carpetas_paquete)) ? s.carpetas_paquete : CARPETAS_PAQUETE;
}

/** Miembros del workspace (carpetas con package.json): [{id, ruta, tipo:'app'|'paquete'}]. */
function descubrir(root, { schema } = {}) {
  const paquetes = carpetasPaquete(schema);
  const vistos = new Set();
  const out = [];
  for (const g of workspace(root).globs) {
    for (const ruta of expandirGlob(root, g)) {
      if (vistos.has(ruta) || !existe(path.join(root, ruta, 'package.json'))) continue;
      vistos.add(ruta);
      const base = path.posix.basename(ruta);
      const id = out.some((a) => a.id === base) ? ruta : base;
      out.push({ id, ruta, tipo: paquetes.includes(ruta.split('/')[0]) ? 'paquete' : 'app' });
    }
  }
  return out;
}

// ---------- lo deducido: los rasgos de una app ----------

function workerDe(root, ruta) {
  for (const f of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
    const t = leer(path.join(root, ruta, f));
    if (t == null) continue;
    let nombre = null;
    if (f.endsWith('.toml')) { const m = t.match(/^\s*name\s*=\s*["']([^"']+)["']/m); nombre = m ? m[1] : null; }
    else { const c = parseJsonc(t); nombre = c && typeof c.name === 'string' ? c.name : null; }
    return { fichero: `${ruta}/${f}`, nombre };
  }
  return null;
}

const CONFIG = (dir, base) => ['js', 'mjs', 'cjs', 'ts', 'mts'].some((e) => existe(path.join(dir, `${base}.config.${e}`)));
function frontDe(root, ruta, pkg) {
  const dir = path.join(root, ruta);
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const tiene = (re) => Object.keys(deps).some((d) => re.test(d));
  if (CONFIG(dir, 'next') || tiene(/^next$/)) return 'next';
  if (CONFIG(dir, 'astro') || tiene(/^astro$/)) return 'astro';
  if (tiene(/^@tanstack\/(react|solid)-start$|^@tanstack\/start$/)) return 'tanstack';
  if (tiene(/^@react-router\/dev$/)) return 'react-router';
  if (CONFIG(dir, 'vite') || tiene(/^vite$/)) return 'vite';
  return null;
}

// Tests junto al codigo (src/**/*.test.ts): se buscan con un recorrido acotado, sin node_modules.
function hayTestsColocados(dirAbs, profundidad = 6, presupuesto = { n: 2000 }) {
  if (profundidad < 0 || presupuesto.n <= 0) return false;
  let ents = [];
  try { ents = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return false; }
  for (const e of ents) {
    if (--presupuesto.n <= 0) return false;
    if (e.isFile() && /\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) return true;
  }
  return ents.some((e) => e.isDirectory() && !NO_ENTRAR.has(e.name) && hayTestsColocados(path.join(dirAbs, e.name), profundidad - 1, presupuesto));
}
function testsDe(root, ruta) {
  const carpeta = ['tests', 'test', '__tests__', 'e2e'].find((d) => esDir(path.join(root, ruta, d)));
  return { carpeta: carpeta ? `${ruta}/${carpeta}` : null, colocados: hayTestsColocados(path.join(root, ruta, 'src')) };
}

/** Rasgos tecnicos de la carpeta de una app (rutas relativas a la raiz, con '/'). */
function rasgos(root, ruta) {
  const pkg = leerJson(path.join(root, ruta, 'package.json'));
  const rel = (f) => (existe(path.join(root, ruta, f)) ? `${ruta}/${f}` : null);
  return {
    paquete: (pkg && typeof pkg.name === 'string') ? pkg.name : null,
    version: (pkg && typeof pkg.version === 'string') ? pkg.version : null,
    worker: workerDe(root, ruta),
    front: frontDe(root, ruta, pkg),
    contrato: rel('ARCHITECTURE.md'),
    changelog: rel('CHANGELOG.md'),
    claudeMd: existe(path.join(root, ruta, 'CLAUDE.md')),
    agentsMd: existe(path.join(root, ruta, 'AGENTS.md')),
    tests: testsDe(root, ruta),
  };
}

// ---------- la vista unica ----------

/** Plantilla del tag de release por app aplicada: '{app}@{version}' -> 'gold-api@0.12.0'. */
function tagDe(root, appId, version) {
  if (!version) return null;
  const cfg = leerConfig(root);
  const plantilla = (cfg && typeof cfg.tag === 'string' && cfg.tag.trim()) ? cfg.tag.trim() : TAG_DEFECTO;
  return plantilla.replace(/\{app\}/g, appId).replace(/\{version\}/g, version);
}

const RASGOS_VACIOS = { paquete: null, version: null, worker: null, front: null, contrato: null, changelog: null, claudeMd: false, agentsMd: false, tests: { carpeta: null, colocados: false } };

/**
 * TODAS las apps: declaradas (.faro.json > monorepo.apps) ∪ descubiertas (workspace).
 * Orden: el del workspace; las declaradas que no existen, al final. Repo simple -> [].
 */
function apps(root, { schema } = {}) {
  const decl = ((leerConfig(root) || {}).apps) || {};
  const declaradas = (decl && typeof decl === 'object' && !Array.isArray(decl)) ? decl : {};
  const out = [];
  const usados = new Set();
  for (const d of descubrir(root, { schema })) {
    const key = Object.prototype.hasOwnProperty.call(declaradas, d.id) ? d.id : null;
    if (key) usados.add(key);
    const meta = key && declaradas[key] && typeof declaradas[key] === 'object' ? declaradas[key] : {};
    const r = rasgos(root, d.ruta);
    out.push({
      id: d.id, ruta: d.ruta, tipo: d.tipo, origen: key ? 'ambas' : 'descubierta', existe: true,
      rol: meta.rol || null, funcional: meta.funcional || null, equipo: meta.equipo || null,
      ...r, tag: tagDe(root, d.id, r.version),
    });
  }
  for (const [id, m] of Object.entries(declaradas)) {
    if (usados.has(id)) continue;
    const meta = m && typeof m === 'object' ? m : {};
    out.push({
      id, ruta: null, tipo: 'app', origen: 'declarada', existe: false,
      rol: meta.rol || null, funcional: meta.funcional || null, equipo: meta.equipo || null,
      ...RASGOS_VACIOS, tests: { carpeta: null, colocados: false }, tag: null,
    });
  }
  return out;
}

// Ruta de fichero -> relativa a la raiz, con '/'. Acepta absolutas y barras de Windows.
function relativa(root, ruta) {
  let r = posix(ruta);
  const abs = posix(path.resolve(root));
  if (path.isAbsolute(String(ruta)) || /^[A-Za-z]:\//.test(r)) {
    const rr = posix(path.relative(abs, r));
    if (!rr.startsWith('..')) r = rr;
  }
  return r.replace(/^\.\//, '');
}

/** La app duena de una ruta (la de prefijo mas largo), o null si cae fuera de toda app. */
function appDeRuta(root, ruta, lista) {
  const r = relativa(root, ruta);
  let mejor = null;
  for (const a of (lista || apps(root))) {
    if (!a.ruta) continue;
    if ((r === a.ruta || r.startsWith(`${a.ruta}/`)) && (!mejor || a.ruta.length > mejor.ruta.length)) mejor = a;
  }
  return mejor;
}

/** Apps tocadas por una lista de ficheros (un diff): {apps: App[] sin repetir, fueraDeApps: string[]}. */
function appsAfectadas(root, ficheros) {
  const lista = apps(root);
  const tocadas = new Map();
  const fuera = [];
  for (const f of ficheros || []) {
    const a = appDeRuta(root, f, lista);
    if (a) tocadas.set(a.id, a); else fuera.push(relativa(root, f));
  }
  return { apps: lista.filter((a) => tocadas.has(a.id)), fueraDeApps: fuera };
}

/** Rasgos en una linea legible: 'worker, front tanstack, contrato, changelog, tests'. */
function rasgosTexto(a) {
  const t = [];
  if (a.worker) t.push('worker');
  if (a.front) t.push(`front ${a.front}`);
  if (a.contrato) t.push('contrato');
  if (a.changelog) t.push('changelog');
  if (a.tests && a.tests.carpeta) t.push('tests');
  else if (a.tests && a.tests.colocados) t.push('tests colocados');
  if (!a.claudeMd && a.existe) t.push('SIN CLAUDE.md');
  return t.join(', ');
}

// ---------- contrato y avisos ----------

function contratoMonorepo(schema) {
  const s = (schema && schema.enums && schema.enums.monorepo) || {};
  return {
    clavesApp: Array.isArray(s.claves_app) ? s.claves_app : ['rol', 'funcional', 'equipo'],
    obligatoriasApp: Array.isArray(s.obligatorias_app) ? s.obligatorias_app : ['rol'],
    clavesRaiz: Array.isArray(s.claves_raiz) ? s.claves_raiz : ['apps', 'tag'],
    marcadoresTag: Array.isArray(s.tag_marcadores) ? s.tag_marcadores : ['{app}', '{version}'],
  };
}

/** Lo que la declaracion .faro.json > monorepo incumple del contrato (faro-schema.json). */
function validarConfig(root, { schema } = {}) {
  const cfg = leerConfig(root);
  if (!cfg) return [];
  const c = contratoMonorepo(schema);
  const out = [];
  for (const k of Object.keys(cfg)) if (!c.clavesRaiz.includes(k)) out.push(`.faro.json > monorepo.${k}: clave desconocida (válidas: ${c.clavesRaiz.join(', ')}).`);
  if (!cfg.apps || typeof cfg.apps !== 'object' || Array.isArray(cfg.apps)) {
    out.push(".faro.json > monorepo.apps debe ser un objeto { \"<app>\": { \"rol\": \"...\" } }.");
  } else {
    const teams = faroJson(root).teams;
    for (const [id, m] of Object.entries(cfg.apps)) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) { out.push(`.faro.json > monorepo.apps.${id} debe ser un objeto con ${c.obligatoriasApp.join(', ')}.`); continue; }
      for (const k of c.obligatoriasApp) if (!m[k] || !String(m[k]).trim()) out.push(`.faro.json > monorepo.apps.${id}: falta '${k}' (una frase de qué es la app).`);
      for (const k of Object.keys(m)) if (!c.clavesApp.includes(k)) out.push(`.faro.json > monorepo.apps.${id}.${k}: clave desconocida (válidas: ${c.clavesApp.join(', ')}).`);
      if (m.equipo && Array.isArray(teams) && teams.length && !teams.includes(m.equipo)) out.push(`.faro.json > monorepo.apps.${id}.equipo '${m.equipo}' no está en 'teams' (${teams.join(', ')}).`);
    }
  }
  if (cfg.tag !== undefined) {
    const falta = typeof cfg.tag !== 'string' ? c.marcadoresTag : c.marcadoresTag.filter((x) => !cfg.tag.includes(x));
    if (falta.length) out.push(`.faro.json > monorepo.tag '${cfg.tag}' debe incluir ${falta.join(' y ')} (por defecto '${TAG_DEFECTO}').`);
  }
  return out;
}

/**
 * Avisos para 'validate' (NO bloquean). Repo simple (sin workspace ni clave) -> [].
 * Workspace con apps pero SIN la clave -> una sola linea que sugiere declararlo.
 */
function avisos(root, { schema } = {}) {
  if (!esMonorepo(root)) {
    const ws = workspace(root);
    const candidatas = ws.fuente ? descubrir(root, { schema }).filter((a) => a.tipo === 'app') : [];
    if (!candidatas.length) return [];
    return [`workspace (${ws.fuente}) con ${candidatas.length} app(s) (${candidatas.map((a) => a.ruta).join(', ')}) sin modo monorepo: /faro:monorepo te guía (o decláralas en .faro.json > "monorepo": { "apps": { "<app>": { "rol": "..." } } }).`];
  }
  const out = validarConfig(root, { schema });
  for (const a of apps(root, { schema })) {
    if (a.tipo !== 'app') continue;
    if (a.origen === 'descubierta') out.push(`${a.ruta} está en el workspace sin declarar — añádela a .faro.json > monorepo.apps.${a.id} con su rol.`);
    else if (!a.existe) out.push(`app declarada '${a.id}' no existe en el workspace — quítala de .faro.json > monorepo.apps o crea su carpeta.`);
    if (a.existe && !a.claudeMd) out.push(`${a.ruta} no tiene CLAUDE.md propio — créalo con qué es la app y cómo se trabaja en ella (Claude Code lo carga al entrar en la carpeta).`);
  }
  return out;
}

module.exports = {
  TAG_DEFECTO, esMonorepo, leerConfig, workspace, parsePnpmWorkspace, descubrir, rasgos,
  apps, appDeRuta, appsAfectadas, tagDe, rasgosTexto, validarConfig, avisos,
};
