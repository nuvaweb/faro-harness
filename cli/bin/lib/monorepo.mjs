// monorepo.mjs — alta de un MONOREPO desde el wizard (#5). El CLI lo hace SOLO, sin el plugin: clona
// cada plantilla, la deja en apps/<id> (sin su historial ni su gestión) y monta el workspace pnpm de la
// raíz. Antes se delegaba en `harness.js app nueva` del plugin y, mientras ese comando no existía, el
// wizard creaba un "monorepo" vacío. El layout es el que el plugin gobierna después (monorepo init):
// pnpm-workspace.yaml con apps/*, package.json raíz con scripts `pnpm -r`, .faro.json > monorepo.apps.
// Fallo CERRADO: si una app falla, no queda nada a medias en el árbol.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NATURALEZAS } from './model.mjs';
import { rutaConfig } from './layout.mjs';
import { personalizarPlantilla } from './plantilla.mjs';

const ID_APP = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
// Ficheros de la RAÍZ que crea o toca el alta del monorepo: se fotografían para deshacer si algo falla.
// #293: la configuración FARO vive en faro/config.json (o .faro.json sin migrar): se fotografían las dos.
const RAIZ_TOCADA = ['pnpm-workspace.yaml', 'package.json', '.node-version', '.faro.json', 'faro/config.json', '.gitignore'];
// Lo que el .gitignore de la RAÍZ debe cubrir en un monorepo de Workers: pnpm install deja node_modules/
// en la raíz, y wrangler o un .dev.vars pueden aparecer fuera de apps/<id> (el .gitignore de cada app
// solo cubre su carpeta). Secretos con sus variantes explícitas, como en la plantilla.
const GITIGNORE_MONOREPO = [
  'node_modules/', '.pnpm-store/', 'dist/', 'build/', '.output/', '.turbo/', 'coverage/', '*.tsbuildinfo',
  '.wrangler/', '.mf/', 'worker-configuration.d.ts',
  '.env', '.env.*', '!.env.example', '.dev.vars', '.dev.vars.*', '!.dev.vars.example', '*.pem', '*.key',
  '*.log', 'pnpm-debug.log*',
];
// Lo que trae la plantilla y NO es de la app: historial, gestión FARO y config del workspace (sube a
// la raíz). El lockfile de la plantilla lleva su importer en '.', no en apps/<id>: lo regenera pnpm install.
const NO_ES_DE_APP = new Set([
  '.git', 'node_modules', 'faro', 'gestion', 'ESTADO.md', '.faro.json', '.claude',
  '.github', '.gitlab-ci.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml',
]);
// Mismos scripts de raíz que `harness.js monorepo init` del plugin.
const SCRIPTS_RAIZ = ['build', 'test', 'lint', 'typecheck', 'dev'];

// Plantillas que se pueden instanciar como app de un monorepo (`monorepo: true`). El catálogo remoto
// puede no traer aún la marca: se hereda la del catálogo local.
function plantillasMonorepo(nat) {
  const out = {};
  for (const [k, pl] of Object.entries((nat && nat.plantillas) || {})) {
    const local = Object.values(NATURALEZAS).map((n) => n.plantillas && n.plantillas[k]).find(Boolean) || {};
    const m = { ...local, ...pl };
    if (m.monorepo === true) out[k] = { ...m, id: m.id || k };
  }
  return out;
}

// undefined si vale; si no, el motivo (formato de `validate` de clack).
function validarIdApp(id, usados = []) {
  const v = String(id || '').trim();
  if (!ID_APP.test(v)) return 'Usa minúsculas, números y guiones (ej. web, api, admin).';
  if (usados.includes(v)) return `Ya hay una app '${v}' en este monorepo.`;
  return undefined;
}

const appDe = (key, pl, id, rol) => ({ id, rol: rol || pl.etiqueta, plantilla: key, repo: pl.repo, url: pl.url });

// --monorepo --plantilla=<clave>: una app, con el id por defecto de la plantilla y sin preguntar.
function appsDesdeFlags(nat, plantillaKey) {
  const pl = plantillasMonorepo(nat)[plantillaKey];
  return pl ? [appDe(plantillaKey, pl, pl.id)] : null;
}

// Metadato de clasificación del repo (.faro.json). `plantilla` = clave del catálogo, solo en app única:
// en un monorepo cada app se registra en monorepo.apps.<id>.
function payloadMeta({ domain = null, teams = [], tags = [], naturaleza = null, plantilla = null, validacion = null } = {}) {
  const out = { domain: domain || null, teams: teams || [], tags: tags || [] };
  if (naturaleza) out.naturaleza = naturaleza;
  if (plantilla) out.plantilla = plantilla;
  return out;
}

// El template suele traer ya un .faro.json (p. ej. solo con teams): se COMPLETA con lo del alta. Un
// valor vacío del alta (null, []) no borra lo que el template ya traía.
function fusionarMeta(previa, payload) {
  const out = { ...(previa || {}) };
  for (const [k, v] of Object.entries(payload || {})) {
    const vacio = v == null || (Array.isArray(v) && !v.length);
    if (!vacio || !(k in out)) out[k] = v;
  }
  return out;
}

const ultimaLinea = (txt) => String(txt || '').trim().split('\n').filter(Boolean).pop() || '';
// Ningun mensaje de error sale con credenciales: el clon de la plantilla lleva el token en la URL y
// execFileSync mete el comando entero en e.message.
const sinCredenciales = (txt) => String(txt || '').replace(/(https?:\/\/)[^/@\s]+@/g, '$1***@');

const leerJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const escribirJson = (f, obj) => fs.writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', 'utf8');

// Bloques de primer nivel de un pnpm-workspace.yaml ({clave: [líneas hijas]}), sin comentarios.
// YAML mínimo a propósito: la config de pnpm de las plantillas son mapas y listas de un nivel.
function bloquesWorkspace(txt) {
  const out = {};
  let actual = null;
  for (const linea of String(txt || '').split(/\r?\n/)) {
    if (!linea.trim() || /^\s*#/.test(linea)) continue;
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(linea);
    if (m) { actual = m[1]; out[actual] = out[actual] || []; continue; }
    if (actual && /^\s/.test(linea)) out[actual].push(linea.replace(/\s+#.*$/, '').trimEnd());
  }
  return out;
}

// pnpm-workspace.yaml de la raíz: apps/* + packages/* y la config de pnpm de TODAS las plantillas
// (allowBuilds, minimumReleaseAgeExclude…), unida sin repetir. pnpm >= 10 solo la lee de la raíz.
function workspaceRaiz(configs) {
  const juntos = {};
  for (const txt of configs) {
    for (const [k, lineas] of Object.entries(bloquesWorkspace(txt))) {
      if (k === 'packages') continue;
      juntos[k] = juntos[k] || [];
      for (const l of lineas) if (!juntos[k].includes(l)) juntos[k].push(l);
    }
  }
  const partes = ['packages:\n  - "apps/*"\n  - "packages/*"\n'];
  for (const [k, lineas] of Object.entries(juntos)) if (lineas.length) partes.push(`${k}:\n${lineas.join('\n')}\n`);
  return partes.join('\n');
}

const claudeMdApp = (id, rol, nombrePaquete) => [
  `# ${id}`, '', String(rol || '').replace(/[\r\n]+/g, ' ').trim(), '',
  `> App del monorepo (\`apps/${id}\`). La gestión FARO (ESTADO, riesgos, requisitos, documentos) vive en la **raíz** del repo; aquí solo el código de esta app.`, '',
  '## Cómo se trabaja aquí', '',
  `- Comandos: \`pnpm --filter ${nombrePaquete} <script>\` desde la raíz, o \`pnpm <script>\` dentro de esta carpeta.`,
  `- Tag de release: \`${id}@<versión>\`; el CHANGELOG de la app es el de esta carpeta.`,
  `- Los issues de esta app llevan la etiqueta \`app:${id}\`.`, '',
].join('\n');

// Copia la plantilla clonada a apps/<id> y la hace de ESTE repo: nombre del paquete y del worker
// (<repo>-<id>), CLAUDE.md de la app. Devuelve la config de pnpm de la plantilla y su package.json.
function copiarApp({ destino, repoName, app, dirPlantilla }) {
  const dst = path.join(destino, 'apps', app.id);
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(dirPlantilla)) {
    if (NO_ES_DE_APP.has(e)) continue;
    fs.cpSync(path.join(dirPlantilla, e), path.join(dst, e), { recursive: true });
  }
  const nombre = `${repoName}-${app.id}`;
  const pkgF = path.join(dst, 'package.json');
  const pkg = leerJson(pkgF);
  if (pkg) escribirJson(pkgF, { ...pkg, name: nombre });
  personalizarPlantilla(dst, { repoName: nombre, marcadores: ['wrangler-name'] });
  if (!fs.existsSync(path.join(dst, 'CLAUDE.md'))) fs.writeFileSync(path.join(dst, 'CLAUDE.md'), claudeMdApp(app.id, app.rol, nombre), 'utf8');
  let ws = '';
  try { ws = fs.readFileSync(path.join(dirPlantilla, 'pnpm-workspace.yaml'), 'utf8'); } catch {}
  let nodeVersion = null;
  try { nodeVersion = fs.readFileSync(path.join(dirPlantilla, '.node-version'), 'utf8').trim() || null; } catch {}
  return { ws, pkg: pkg || {}, nodeVersion };
}

// Añade al .gitignore de la raíz las líneas del monorepo que falten (idempotente, por línea trim).
function completarGitignore(destino) {
  const f = path.join(destino, '.gitignore');
  let cur = ''; try { cur = fs.readFileSync(f, 'utf8'); } catch {}
  const hay = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const faltan = GITIGNORE_MONOREPO.filter((l) => !hay.has(l));
  if (!faltan.length) return;
  const base = cur.replace(/\s*$/, '');
  const bloque = `# --- monorepo (dependencias, build, wrangler y secretos de apps/*) ---\n${faltan.join('\n')}\n`;
  fs.writeFileSync(f, base ? `${base}\n\n${bloque}` : bloque, 'utf8');
}

// Raíz del monorepo: workspace, package.json con scripts `pnpm -r`, .gitignore y .faro.json > monorepo.apps.
// Lo que ya exista en la raíz (p. ej. un package.json del template) se RESPETA: no se pisa.
function escribirRaiz({ destino, repoName, apps, copias }) {
  fs.writeFileSync(path.join(destino, 'pnpm-workspace.yaml'), workspaceRaiz(copias.map((c) => c.ws)), 'utf8');
  if (!fs.existsSync(path.join(destino, 'package.json'))) {
    const conPm = copias.find((c) => c.pkg.packageManager) || { pkg: {} };
    escribirJson(path.join(destino, 'package.json'), {
      name: repoName, private: true,
      ...(conPm.pkg.packageManager ? { packageManager: conPm.pkg.packageManager } : {}),
      ...(conPm.pkg.engines ? { engines: conPm.pkg.engines } : {}),
      scripts: Object.fromEntries(SCRIPTS_RAIZ.map((k) => [k, `pnpm -r --if-present run ${k}`])),
    });
  }
  const nodeVersion = (copias.find((c) => c.nodeVersion) || {}).nodeVersion;
  if (nodeVersion && !fs.existsSync(path.join(destino, '.node-version'))) fs.writeFileSync(path.join(destino, '.node-version'), `${nodeVersion}\n`, 'utf8');
  completarGitignore(destino);
  const metaF = path.join(destino, rutaConfig(destino));
  fs.mkdirSync(path.dirname(metaF), { recursive: true });
  const meta = leerJson(metaF) || {};
  const previas = (meta.monorepo && meta.monorepo.apps) || {};
  meta.monorepo = { ...(meta.monorepo || {}), apps: { ...previas, ...Object.fromEntries(apps.map((a) => [a.id, { rol: a.rol }])) } };
  escribirJson(metaF, meta);
}

// Instancia cada app en el árbol de `destino`, SIN commit (lo hace el commit común).
// clonar(app, dir): deja la plantilla en dir (en real, clon público sin token).
// Si una app falla se deshace TODO: ni apps/ ni workspace a medias.
function instanciarMonorepo({ destino, repoName, apps, clonar }) {
  const foto = Object.fromEntries(RAIZ_TOCADA.map((f) => {
    try { return [f, fs.readFileSync(path.join(destino, f))]; } catch { return [f, null]; }
  }));
  const habiaApps = fs.existsSync(path.join(destino, 'apps'));
  const copias = [];
  for (const app of apps) {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-plantilla-'));
    try {
      const dir = path.join(tmpBase, app.repo || app.id);
      clonar(app, dir);
      copias.push(copiarApp({ destino, repoName, app, dirPlantilla: dir }));
    } catch (e) {
      deshacer(destino, apps, foto, habiaApps);
      const motivo = sinCredenciales(ultimaLinea(e.stderr) || ultimaLinea(e.stdout) || e.message);
      return { ok: false, hechos: [], error: `app '${app.id}': ${motivo}` };
    } finally {
      try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
    }
  }
  try { escribirRaiz({ destino, repoName, apps, copias }); }
  catch (e) {
    deshacer(destino, apps, foto, habiaApps);
    return { ok: false, hechos: [], error: `raíz del monorepo: ${sinCredenciales(e.message)}` };
  }
  return { ok: true, hechos: apps.map((a) => a.id), error: null };
}

function deshacer(destino, apps, foto, habiaApps) {
  try { execFileSync('git', ['-C', destino, 'reset', '-q'], { stdio: 'ignore' }); } catch {}
  for (const app of apps) { try { fs.rmSync(path.join(destino, 'apps', app.id), { recursive: true, force: true }); } catch {} }
  if (!habiaApps) { try { fs.rmSync(path.join(destino, 'apps'), { recursive: true, force: true }); } catch {} }
  for (const [f, contenido] of Object.entries(foto)) {
    const ruta = path.join(destino, f);
    try { if (contenido === null) fs.rmSync(ruta, { force: true }); else fs.writeFileSync(ruta, contenido); } catch {}
  }
}

// Las plantillas de stack son repos públicos: el clon no lleva credenciales (superficial: el historial
// no se copia). Una plantilla sin `url` no tiene de dónde salir.
function clonadorPublico(app, dir) {
  if (!app.url) throw new Error(`la plantilla ${app.repo} no tiene una URL pública`);
  try {
    execFileSync('git', ['-c', 'credential.helper=', 'clone', '-q', '--depth', '1', app.url, dir], {
      stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch { throw new Error(`no pude clonar la plantilla ${app.repo} (${app.url})`); }
}

// Lo que el wizard puede ofrecer: una plantilla sin URL pública no se puede instanciar.
function conPlantillasPublicas(naturalezas) {
  return Object.fromEntries(Object.entries(naturalezas).map(([k, n]) => {
    if (!n.plantillas) return [k, n];
    return [k, { ...n, plantillas: Object.fromEntries(Object.entries(n.plantillas).filter(([, pl]) => pl.url)) }];
  }));
}

export {
  plantillasMonorepo, validarIdApp, appsDesdeFlags, payloadMeta, fusionarMeta,
  instanciarMonorepo, clonadorPublico, conPlantillasPublicas, sinCredenciales, workspaceRaiz, completarGitignore,
};
