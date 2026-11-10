// lib/app-nueva.js — `harness.js app nueva`: instanciar una app del monorepo desde una PLANTILLA de la
// organizacion (#216). Un solo camino comun para el wizard del CLI y /faro:code.
//
// Flujo:
//   1. validar (id libre, rol de una linea, plantilla de la MISMA organizacion) y el gate git
//      (lib/monorepo.js bloqueosGit; --inicial = repo recien creado de un solo commit);
//   2. traer la plantilla a un temporal (clone de solo lectura, sin hooks) y rechazar enlaces simbolicos;
//   3. copiar sus ficheros versionados a apps/<id>/ SIN historial y sin lo que es del repo plantilla y no
//      de la app (workspace, lock, .node-version, gestion/, .faro.json, ESTADO.md, .claude/);
//   4. normalizar: paquete renombrado al id, allowBuilds y minimumReleaseAgeExclude fusionados en el
//      pnpm-workspace.yaml raiz, packageManager y .node-version a la raiz si faltan, Workers
//      <repo>-<id>-dev|prod;
//   5. registrar como `monorepo init --app` (planInit/aplicarInit) + `plantilla` en .faro.json.
// Deja todo en el indice y NUNCA commitea (lo hace quien llama). Si algo falla tras copiar, deshace.
//
// SEGURIDAD: no se ejecuta nada de la plantilla; rutas validadas; git sin shell.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const mono = require('./monorepo.js');
const mp = require('./monorepo-plan.js');
const mg = require('./monorepo-gestion.js');
const imp = require('./monorepo-importar.js');

// Ficheros de la RAIZ de la plantilla que no se copian a la app (son del repo, no de la app).
const NO_COPIAR = [/^pnpm-workspace\.yaml$/, /^pnpm-lock\.yaml$/, /^\.node-version$/, /^\.faro\.json$/, /^ESTADO\.md$/, /^gestion\//, /^\.claude\//];
const WRANGLER = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

const leer = (abs) => mg.leerSeguro(abs);
const leerJson = (abs) => { const t = leer(abs); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } };
const escribirJson = (abs, j) => fs.writeFileSync(abs, JSON.stringify(j, null, 2) + '\n');

/** Lista `clave:` de un yaml (bloque de items '- x'). Pura. */
function listaYaml(yaml, clave) {
  const ls = String(yaml || '').replace(/\r\n/g, '\n').split('\n');
  const i = ls.findIndex((l) => l.replace(/\s+$/, '') === `${clave}:`);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < ls.length && /^\s+\S/.test(ls[j]); j++) { const m = ls[j].match(/^\s+-\s+['"]?([^'"\s#]+)['"]?\s*$/); if (m) out.push(m[1]); }
  return out;
}

/** Inserta en la lista `clave:` los items que falten (crea el bloque si no existe). Pura. */
function insertarEnLista(yaml, clave, items) {
  const ls = String(yaml || '').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const nuevas = items.map((x) => `  - ${x}`);
  if (!nuevas.length) return `${ls.join('\n')}\n`;
  const i = ls.findIndex((l) => l.replace(/\s+$/, '') === `${clave}:`);
  if (i < 0) return `${ls.join('\n')}\n\n${clave}:\n${nuevas.join('\n')}\n`;
  let j = i + 1;
  while (j < ls.length && /^\s+\S/.test(ls[j])) j++;
  ls.splice(j, 0, ...nuevas);
  return `${ls.join('\n')}\n`;
}

/** Sustituye name-dev / name-prod por <repo>-<id>-dev|prod en el texto de un wrangler.*. Pura. */
const renombrarWorker = (txt, repo, id) => String(txt).replace(/(["'])name-(dev|prod)\1/g, (_, q, e) => `${q}${repo}-${id}-${e}${q}`);

/** Nombre corto del repo para los Workers: el del remote origin (o la carpeta), en minusculas. */
function nombreRepo(root) {
  const rm = imp.remotoDe(root);
  const base = rm ? rm.repo : path.basename(path.resolve(root));
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

/** Validaciones previas (nada se toca). -> { errores, fuente, plantilla } */
function validar(root, { id, rol, plantilla, org }) {
  const errores = [];
  if (!mp.validarId(id)) errores.push(`id de app inválido '${String(id || '').slice(0, 40)}': minúsculas, dígitos y guiones (hasta 40, sin '/' ni '..').`);
  if (!mp.validarLinea(rol)) errores.push('--rol es obligatorio: una frase de una sola línea (hasta 200 caracteres) que diga qué es la app.');
  if (mp.validarId(id) && fs.existsSync(path.join(root, mp.rutaDeApp(id)))) errores.push(`apps/${id} ya existe: elige otro id (la app nueva no pisa una existente).`);
  if (!plantilla) { errores.push('--plantilla es obligatorio (REPO de la organización, org/repo, URL de GitHub o ruta local).'); return { errores }; }
  const texto = /^[A-Za-z0-9_.-]+$/.test(plantilla) && org && !fs.existsSync(plantilla) ? `${org}/${plantilla}` : plantilla;
  const v = imp.validarOrigen(texto, org, { permitirRuta: true });
  if (!v.ok) { errores.push(v.error); return { errores }; }
  const nombre = v.fuente.tipo === 'repo' ? v.fuente.repo : (imp.remotoDe(v.fuente.ruta) || {}).repo;
  return { errores, fuente: v.fuente, plantilla: nombre };
}

/** Ficheros versionados de la plantilla que van a la app (rutas relativas). */
const ficherosDeApp = (dir) => imp.ficherosRastreados(dir).filter((rel) => !NO_COPIAR.some((re) => re.test(rel)));

/** Plan (sin escribir) a partir de la plantilla ya traida. */
function planDesdePlantilla(root, dirTpl, { id }) {
  const p = { ficheros: ficherosDeApp(dirTpl), allowBuilds: [], excluir: [], packageManager: null, nodeVersion: null, workers: [], avisos: [] };
  const wsTpl = leer(path.join(dirTpl, 'pnpm-workspace.yaml'));
  const wsRaiz = leer(path.join(root, 'pnpm-workspace.yaml'));
  const abRaiz = mg.allowBuildsDe(wsRaiz);
  p.allowBuilds = Object.entries(mg.allowBuildsDe(wsTpl)).filter(([k, v]) => v === 'true' && !(k in abRaiz)).map(([k]) => k);
  const exRaiz = new Set(listaYaml(wsRaiz, 'minimumReleaseAgeExclude'));
  p.excluir = listaYaml(wsTpl, 'minimumReleaseAgeExclude').filter((x) => !exRaiz.has(x));
  const pkgTpl = leerJson(path.join(dirTpl, 'package.json')) || {};
  const pkgRaiz = leerJson(path.join(root, 'package.json')) || {};
  if (typeof pkgTpl.packageManager === 'string' && /^[a-z]+@[0-9][\w.+-]*$/.test(pkgTpl.packageManager)) {
    if (!pkgRaiz.packageManager) p.packageManager = pkgTpl.packageManager;
    else if (pkgRaiz.packageManager !== pkgTpl.packageManager) p.avisos.push(`la plantilla usa ${pkgTpl.packageManager} y la raíz ${pkgRaiz.packageManager}: rige el de la raíz.`);
  }
  const nvTpl = (leer(path.join(dirTpl, '.node-version')) || '').trim();
  const nvRaiz = (leer(path.join(root, '.node-version')) || '').trim();
  if (nvTpl && /^v?\d[\w.]*$/.test(nvTpl)) {
    if (!nvRaiz) p.nodeVersion = nvTpl;
    else if (nvRaiz !== nvTpl) p.avisos.push(`la plantilla usa Node ${nvTpl} y la raíz ${nvRaiz}: rige el de la raíz.`);
  }
  const repo = nombreRepo(root);
  for (const w of WRANGLER) if (p.ficheros.includes(w)) p.workers.push({ fichero: w, dev: `${repo}-${id}-dev`, prod: `${repo}-${id}-prod` });
  return p;
}

function render(id, rol, nombre, p, { aplicado = false } = {}) {
  const L = [`APP NUEVA — ${id} desde ${nombre}${aplicado ? ' · APLICADO' : ' · DRY-RUN (no se ha tocado nada)'}`, ''];
  L.push(`- apps/${id}/ ← ${p.ficheros.length} fichero(s) de la plantilla, sin su historial (sin workspace, lock ni gestion/).`);
  L.push(`- Registrar la app en .faro.json > monorepo.apps.${id} (rol: ${rol}; plantilla: ${nombre}), apps/${id}/CLAUDE.md y etiqueta app:${id}.`);
  L.push(`- apps/${id}/package.json: name → ${id}.`);
  if (p.allowBuilds.length) L.push(`- pnpm-workspace.yaml raíz: allowBuilds +${p.allowBuilds.join(', ')}.`);
  if (p.excluir.length) L.push(`- pnpm-workspace.yaml raíz: minimumReleaseAgeExclude +${p.excluir.join(', ')}.`);
  if (p.packageManager) L.push(`- package.json raíz: packageManager ${p.packageManager}.`);
  if (p.nodeVersion) L.push(`- .node-version raíz: ${p.nodeVersion}.`);
  for (const w of p.workers) L.push(`- apps/${id}/${w.fichero}: Worker ${w.dev} / ${w.prod}.`);
  if (p.avisos.length) L.push('', 'Avisos:', ...p.avisos.map((a) => `- ${a}`));
  return L;
}

/** Copia, normaliza y registra. Lanza si algo falla (quien llama deshace). -> hechos[] */
function aplicar(root, dirTpl, p, { id, rol, nombre, ctx, inicial }) {
  const hechos = [];
  const destino = path.join(root, mp.rutaDeApp(id));
  for (const rel of p.ficheros) {
    if (rel.split('/').some((s) => s === '..' || s === '') || path.isAbsolute(rel)) throw new Error(`ruta no permitida en la plantilla: ${rel}`);
    const de = path.join(dirTpl, rel);
    let st; try { st = fs.lstatSync(de); } catch { continue; }
    if (!st.isFile()) continue;
    const a = path.join(destino, rel);
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.copyFileSync(de, a);
  }
  hechos.push(`apps/${id}/: ${p.ficheros.length} fichero(s) copiados de ${nombre} (sin historial).`);
  const pkgApp = path.join(destino, 'package.json');
  const pkg = leerJson(pkgApp);
  if (pkg) { pkg.name = id; delete pkg.packageManager; escribirJson(pkgApp, pkg); }
  else escribirJson(pkgApp, { name: id, version: '0.0.0', private: true });
  for (const w of p.workers) {
    const abs = path.join(destino, w.fichero);
    fs.writeFileSync(abs, renombrarWorker(leer(abs), nombreRepo(root), id));
  }
  if (p.workers.length) hechos.push(`Worker(s): ${p.workers.map((w) => `${w.dev}/${w.prod}`).join(', ')}.`);
  const wsAbs = path.join(root, 'pnpm-workspace.yaml');
  let ws = leer(wsAbs);
  if (ws == null && !(leerJson(path.join(root, 'package.json')) || {}).workspaces) ws = mono.WORKSPACE_YAML;
  if (ws != null) {
    if (p.allowBuilds.length) ws = mg.insertarAllowBuilds(ws, p.allowBuilds);
    if (p.excluir.length) ws = insertarEnLista(ws, 'minimumReleaseAgeExclude', p.excluir);
    if (ws !== leer(wsAbs)) { fs.writeFileSync(wsAbs, ws); hechos.push('pnpm-workspace.yaml de la raíz actualizado.'); }
  }
  if (p.nodeVersion) { fs.writeFileSync(path.join(root, '.node-version'), `${p.nodeVersion}\n`); hechos.push(`.node-version de la raíz: ${p.nodeVersion}.`); }

  // registro: el mismo camino que `monorepo init --app` (gates ya comprobados antes de copiar)
  const pi = mono.planInit(root, { app: id, rol, crearPackageRaiz: true, saltarGates: true, inicial, schema: ctx.schema, org: ctx.org });
  if (!pi.aplicable && !pi.nada) throw new Error(`no puedo registrar la app: ${[...pi.errores, ...pi.bloqueos, ...pi.decisiones.filter((d) => d.bloquea).map((d) => d.pregunta)].join(' · ')}`);
  if (!pi.nada) {
    const r = mono.aplicarInit(root, pi, { git: true });
    if (r.errores.length) throw new Error(r.errores.join(' · '));
    hechos.push(...r.hechos);
  }
  const pkgRaizAbs = path.join(root, 'package.json');
  const pkgRaiz = leerJson(pkgRaizAbs);
  if (p.packageManager && pkgRaiz && !pkgRaiz.packageManager) { pkgRaiz.packageManager = p.packageManager; escribirJson(pkgRaizAbs, pkgRaiz); hechos.push(`package.json de la raíz: packageManager ${p.packageManager}.`); }
  const cfgAbs = path.join(root, '.faro.json');
  const cfg = leerJson(cfgAbs);
  if (!cfg || !cfg.monorepo || !cfg.monorepo.apps || !cfg.monorepo.apps[id]) throw new Error(`.faro.json no tiene monorepo.apps.${id} tras registrar la app.`);
  cfg.monorepo.apps[id].plantilla = nombre;
  escribirJson(cfgAbs, cfg);
  mono.gitRun(root, ['add', '-A']);
  return { hechos, plan: pi };
}

// Ficheros de la raiz que aplicar() puede tocar: se guardan para deshacer si falla.
const RAIZ_TOCABLE = ['pnpm-workspace.yaml', 'package.json', '.node-version', '.faro.json'];

function deshacer(root, id, copia) {
  try { fs.rmSync(path.join(root, mp.rutaDeApp(id)), { recursive: true, force: true }); } catch { /* best-effort */ }
  for (const [rel, txt] of Object.entries(copia)) {
    const abs = path.join(root, rel);
    try { if (txt == null) fs.rmSync(abs, { force: true }); else fs.writeFileSync(abs, txt); } catch { /* best-effort */ }
  }
  try { mono.gitRun(root, ['reset', '-q', '--', mp.rutaDeApp(id), ...RAIZ_TOCABLE]); } catch { /* sin nada en el indice */ }
}

function parseArgs(argv) {
  const o = { flags: new Set(), valores: {}, posicionales: [] };
  const CON_VALOR = new Set(['--plantilla', '--rol']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (CON_VALOR.has(a)) { if (argv[i + 1] === undefined) { o.error = `${a} necesita un valor`; break; } o.valores[a.slice(2)] = argv[++i]; }
    else if (a.startsWith('--')) o.flags.add(a);
    else o.posicionales.push(a);
  }
  return o;
}

const USO = 'Uso: harness.js app nueva <id> --plantilla <REPO|org/repo|url|ruta> --rol "<frase>" [--inicial] [--dry-run|--confirmo] [--json]\n     --inicial: repo recién creado (un solo commit): aplica aunque sea develop o la rama no esté anclada.';

/** `harness.js app nueva ...`. ctx = { root, schema, org, log, ensureLabels }. -> codigo de salida. */
async function cli(argv, ctx) {
  const log = ctx.log || console.log;
  const root = ctx.root;
  if (argv[0] !== 'nueva') { log(USO); return 2; }
  const o = parseArgs(argv.slice(1));
  if (o.error) { log(o.error); return 2; }
  if (o.flags.has('--confirmo') && o.flags.has('--dry-run')) { log('--confirmo y --dry-run se contradicen: elige uno.'); return 2; }
  if (o.posicionales.length !== 1) { log(USO); return 2; }
  const id = o.posicionales[0]; const rol = o.valores.rol;
  const confirmo = o.flags.has('--confirmo'); const json = o.flags.has('--json'); const inicial = o.flags.has('--inicial');
  const v = validar(root, { id, rol, plantilla: o.valores.plantilla, org: ctx.org });
  if (v.errores.length) { log(`APP NUEVA — no puedo continuar:\n${v.errores.map((e) => `- ${e}`).join('\n')}`); return 1; }
  const bloqueos = mono.bloqueosGit(root, { inicial, verbo: 'crear la app' });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-plantilla-'));
  try {
    let t;
    try { t = imp.traer(v.fuente, undefined, tmp); } catch (e) { log(`APP NUEVA — no pude traer la plantilla (solo lectura): ${imp.limpiarMsg(e)}`); return 1; }
    const enlaces = imp.enlacesEnIndice(imp.sh(t.dir, ['ls-files', '-s', '-z']));
    if (enlaces.length) { log(`APP NUEVA — la plantilla contiene ${enlaces.length} enlace(s) simbólico(s) (p. ej. ${enlaces[0]}): no se usa.`); return 1; }
    const p = planDesdePlantilla(root, t.dir, { id });
    if (!confirmo) {
      if (json) log(JSON.stringify({ id, rol, plantilla: v.plantilla, ...p, bloqueos, aplicado: false }, null, 2));
      else {
        log(render(id, rol, v.plantilla, p).join('\n'));
        if (bloqueos.length) log(['', 'BLOQUEOS para aplicar:', ...bloqueos.map((b) => `- ${b}`)].join('\n'));
        log(bloqueos.length ? '\nResuelve lo anterior y repite; con --confirmo se aplica.' : '\nPara aplicarlo: añade --confirmo (queda en el índice de git, sin commit).');
      }
      return 0;
    }
    if (bloqueos.length) { log([...render(id, rol, v.plantilla, p), '', 'BLOQUEOS para aplicar:', ...bloqueos.map((b) => `- ${b}`), '', 'No aplico: resuelve los bloqueos (o --inicial si es el primer commit del repo).'].join('\n')); return 1; }
    const copia = Object.fromEntries(RAIZ_TOCABLE.map((rel) => [rel, leer(path.join(root, rel))]));
    let res;
    try { res = aplicar(root, t.dir, p, { id, rol, nombre: v.plantilla, ctx, inicial }); } catch (e) {
      deshacer(root, id, copia);
      log(`APP NUEVA — falló al aplicar (${e.message}); se ha deshecho lo copiado.`);
      return 1;
    }
    let etiquetas = [];
    if (ctx.ensureLabels) { try { etiquetas = await ctx.ensureLabels([{ id, rol }]); } catch { etiquetas = []; } }
    if (json) log(JSON.stringify({ id, rol, plantilla: v.plantilla, ...p, aplicado: true, hechos: res.hechos, etiquetasCreadas: etiquetas }, null, 2));
    else {
      log(render(id, rol, v.plantilla, p, { aplicado: true }).join('\n'));
      log(['', 'Hecho:', ...res.hechos.map((h) => `- ${h}`)].join('\n'));
      log(etiquetas.length ? `- etiqueta en la forja: ${etiquetas.join(', ')}.` : `- etiqueta app:${id}: se crea al asignar la primera tarea (--app) o con la forja conectada.`);
      log("\nSiguiente: revisa con 'git status' y commitea (los cambios ya están en el índice; este comando no commitea).");
    }
    return 0;
  } finally { imp.borrarTmp(tmp); }
}

module.exports = { cli, validar, planDesdePlantilla, listaYaml, insertarEnLista, renombrarWorker, nombreRepo, NO_COPIAR };
