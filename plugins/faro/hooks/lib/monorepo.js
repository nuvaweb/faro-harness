// lib/monorepo.js — `harness.js monorepo init`: convertir un repo simple en monorepo (o nacer
// preparado) con un comando DETERMINISTA (#161).
//
// El usuario NO necesita saber de workspaces, tags por app ni git: la skill /faro:monorepo conversa
// con el (que es cada carpeta, rol, equipo) y guarda las respuestas en gestion/monorepo-plan.json;
// este modulo lo lee (o detecta las apps del workspace) y garantiza lo mecanico:
//   - DRY-RUN por defecto (muestra el plan y no toca nada); --confirmo lo aplica;
//   - falla CERRADO ante lo ambiguo (varias carpetas candidatas, app sin nombre ni rol);
//   - idempotente (un repo que ya es monorepo no cambia);
//   - git mv (historial conservado); la gestion de la raiz no se toca;
//   - escribe el bloque .faro.json > monorepo, workspace, package.json raiz, CLAUDE.md por app,
//     etiquetas app:<id> y (opcional) CODEOWNERS.
//
// SEGURIDAD: ids con patron estricto (monorepo-plan.validarId); git solo recibe rutas construidas
// aqui, siempre tras '--'; nunca shell; no se ejecuta nada del repo.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ap = require('./apps.js');
const mp = require('./monorepo-plan.js');
const mg = require('./monorepo-gestion.js');

const NO_ENTRAR = new Set(['node_modules', '.git', 'dist', 'build', '.wrangler', '.next', '.output', '.turbo', 'coverage']);
const NO_CANDIDATAS = new Set(['apps', 'packages', 'libs', 'gestion', 'documentos', 'fuentes', 'flujos', 'borrador', 'notebooks', 'scripts', 'plantillas']);
// Lo que pertenece a LA APP cuando un repo simple se convierte (lo demas es gestion o raiz y no se mueve).
const ES_DE_APP = [
  /^package\.json$/, /^wrangler\.(jsonc|json|toml)$/, /^tsconfig(\..+)?\.json$/,
  /^(vite|vitest|next|astro|tailwind|postcss)\.config\.[cm]?[jt]s$/,
  /^(src|tests|test|__tests__|e2e|public)$/, /^(CHANGELOG|ARCHITECTURE)\.md$/,
  /^worker-configuration\.d\.ts$/, /^\.dev\.vars\.example$/, /^index\.html$/,
];
const SCRIPTS_RAIZ = ['build', 'test', 'lint', 'typecheck', 'dev'];
const WORKSPACE_YAML = 'packages:\n  - "apps/*"\n  - "packages/*"\n';

const leer = (abs) => mg.leerSeguro(abs);
const existe = (abs) => { try { fs.lstatSync(abs); return true; } catch { return false; } };
const leerJson = (abs) => { const t = leer(abs); if (t == null) return null; try { return JSON.parse(t); } catch { return null; } };
const gitOut = (root, args) => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000, maxBuffer: 64 * 1024 * 1024 }); } catch { return null; }
};
const gitRun = (root, args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, maxBuffer: 64 * 1024 * 1024 });

/** Estado git del repo: {git, rama, sucio:[lineas], protegida, anclada}. El plan guardado por la skill no ensucia. */
function estadoGit(root) {
  if (!existe(path.join(root, '.git'))) return { git: false, rama: null, sucio: [], protegida: false, anclada: false };
  const rama = (gitOut(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim() || null;
  const por = gitOut(root, ['status', '--porcelain', '--untracked-files=all']) || '';
  const sucio = por.split('\n').filter(Boolean).filter((l) => l.slice(3).replace(/"/g, '') !== mp.PLAN_FILE);
  return {
    git: true, rama, sucio,
    protegida: !rama || ['main', 'master', 'develop', 'HEAD'].includes(rama),
    anclada: !!rama && /^[a-z]+\/(\d+|L-\d+)(?:-|$)/.test(rama),
  };
}

function rastreados(root) {
  const out = gitOut(root, ['ls-files', '-z']);
  if (out == null) return null;
  return new Set(out.split('\0').filter(Boolean).map((f) => f.split('/')[0]));
}

/** Entradas de la raiz que son de la app (solo las versionadas si hay git). */
function entradasDeApp(root) {
  const tracked = rastreados(root);
  let nombres = [];
  try { nombres = fs.readdirSync(root); } catch { return []; }
  return nombres.filter((n) => ES_DE_APP.some((re) => re.test(n)) && (!tracked || tracked.has(n))).sort();
}

/** Carpetas (1 o 2 niveles) con package.json o wrangler.* que no son estructura de FARO: candidatas a app. */
function carpetasCandidatas(root) {
  const out = [];
  const tiene = (dir) => existe(path.join(dir, 'package.json')) || ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((f) => existe(path.join(dir, f)));
  let l1 = [];
  try { l1 = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of l1) {
    if (!e.isDirectory() || e.name.startsWith('.') || NO_ENTRAR.has(e.name) || NO_CANDIDATAS.has(e.name)) continue;
    const d1 = path.join(root, e.name);
    if (tiene(d1)) { out.push(e.name); continue; }
    let l2 = [];
    try { l2 = fs.readdirSync(d1, { withFileTypes: true }); } catch { continue; }
    for (const e2 of l2) if (e2.isDirectory() && !NO_ENTRAR.has(e2.name) && tiene(path.join(d1, e2.name))) out.push(`${e.name}/${e2.name}`);
  }
  return out.sort();
}

/** {org, repo} del origen para calificar sus issues (#N -> org/repo#N), o null si no se sabe (ruta local sin remote de GitHub). */
function origenDeIssues(fuente, org) {
  const f = mp.parseFuente(fuente, { org });
  if (!f.ok) return null;
  if (f.tipo === 'repo') return { org: f.org, repo: f.repo };
  const url = (gitOut(f.ruta, ['remote', 'get-url', 'origin']) || '').trim();
  const m = url.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? { org: m[1], repo: m[2] } : null;
}

const nombreNpmSeguro = (n, id) => (typeof n === 'string' && /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(n) ? n : id);
const unaLinea = (t) => String(t || '').replace(/[\r\n\u0000]+/g, ' ').trim();
const claudeMd = (id, rol, nombrePaquete) => [
  `# ${id}`, '', unaLinea(rol), '',
  `> App del monorepo (\`apps/${id}\`). La gestión FARO (ESTADO, riesgos, requisitos, documentos) vive en la **raíz** del repo; aquí solo el código de esta app.`, '',
  '## Cómo se trabaja aquí', '',
  `- Comandos: \`pnpm --filter ${nombreNpmSeguro(nombrePaquete, id)} <script>\` desde la raíz, o \`pnpm <script>\` dentro de esta carpeta.`,
  `- Tag de release: \`${id}@<versión>\`; el CHANGELOG de la app es el de esta carpeta.`,
  '- Los issues de esta app llevan la etiqueta `app:' + id + '`.', '',
].join('\n');

function nombreRaiz(root) {
  const base = path.basename(path.resolve(root)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  return `${base}-monorepo`;
}

/**
 * Plan de `monorepo init`. NO escribe. Opciones: { app, rol, funcional, equipo, tag, codeowners,
 * consolidar, schema, org, plan }. -> objeto plan (ver `aplicable` y `nada`).
 */
function planInit(root, o = {}) {
  const p = {
    modo: null, apps: [], acciones: [], movimientos: [], etiquetas: [], avisos: [], externos: [], decisiones: [],
    bloqueos: [], errores: [], consolidacion: [], aplicable: false, nada: false, codeowners: false, cfg: null,
    archivos: { workspace: false, packageRaiz: null, claudeMd: [], esqueletos: [] },
  };
  const fin = () => {
    p.aplicable = !p.errores.length && !p.bloqueos.length && !p.decisiones.some((d) => d.bloquea) && !p.nada;
    return p;
  };
  if (o.app !== undefined && !mp.validarId(o.app)) { p.errores.push(`--app inválido '${String(o.app).slice(0, 40)}': minúsculas, dígitos y guiones (hasta 40, sin '/' ni '..').`); return fin(); }
  const lp = mp.leerPlan(root, { org: o.org });
  if (lp && lp.errores.length) { p.errores.push(...lp.errores); return fin(); }
  const plan = o.plan || (lp && lp.plan) || null;
  const cfgFaro = leerJson(path.join(root, '.faro.json')) || {};
  const monExist = ap.leerConfig(root) || {};
  const declExist = (monExist.apps && typeof monExist.apps === 'object') ? monExist.apps : {};
  const ws = ap.descubrir(root, { schema: o.schema });
  const wsApps = ws.filter((a) => a.tipo === 'app');

  // ---- apps deseadas: plan ∪ --app ∪ workspace
  const deseadas = [];
  const poner = (d) => { const i = deseadas.findIndex((x) => x.id === d.id); if (i >= 0) deseadas[i] = { ...deseadas[i], ...d }; else deseadas.push(d); };
  if (plan) for (const a of plan.apps) {
    if (a.origen && !existe(path.join(root, mp.rutaDeApp(a.id)))) { p.avisos.push(`${a.id}: viene de ${a.origen.fuente}; se crea con 'harness.js monorepo importar' (init no importa).`); continue; }
    poner({ id: a.id, rol: a.rol, funcional: a.funcional, equipo: a.equipo, desplazamiento: a.desplazamiento, clave: a.clave, origen: a.origen ? origenDeIssues(a.origen.fuente, o.org) : null });
  }
  if (o.app) poner({ id: o.app, ...(o.rol ? { rol: o.rol } : {}), ...(o.funcional ? { funcional: o.funcional } : {}), ...(o.equipo ? { equipo: o.equipo } : {}) });
  for (const a of wsApps) if (!deseadas.some((d) => d.id === a.id)) poner({ id: a.id });
  for (const [campo, valor, ok] of [['--rol', o.rol, mp.validarLinea], ['--funcional', o.funcional, mp.validarLinea], ['--equipo', o.equipo, mp.validarEquipo]]) {
    if (valor !== undefined && !ok(valor)) p.errores.push(`${campo} inválido: una sola línea sin saltos de línea${campo === '--equipo' ? ' (team, @usuario o @org/team)' : ' (hasta 200 caracteres)'}.`);
  }
  if (p.errores.length) return fin();
  for (const d of deseadas) {
    const ex = declExist[d.id] && typeof declExist[d.id] === 'object' ? declExist[d.id] : {};
    d.rol = d.rol || ex.rol || null; d.funcional = d.funcional || ex.funcional; d.equipo = d.equipo || ex.equipo;
    if ((d.rol && !mp.validarLinea(d.rol)) || (d.funcional && !mp.validarLinea(d.funcional)) || (d.equipo && !mp.validarEquipo(d.equipo))) p.errores.push(`${d.id}: rol/funcional/equipo con forma no permitida (una sola línea; equipo: team, @usuario o @org/team).`);
    if (!d.rol) p.decisiones.push({ id: `rol:${d.id}`, bloquea: true, pregunta: `Falta el rol de la app ${d.id}: ¿qué es y para qué sirve? (una frase)`, opciones: [], defecto: null });
  }
  if (!deseadas.length) {
    p.errores.push('No sé qué app crear: indica --app <nombre> (y --rol "<una frase>") o crea gestion/monorepo-plan.json con /faro:monorepo.');
    return fin();
  }
  p.apps = deseadas.map((d) => ({ id: d.id, ruta: mp.rutaDeApp(d.id), rol: d.rol, funcional: d.funcional || null, equipo: d.equipo || null, existe: existe(path.join(root, mp.rutaDeApp(d.id))) }));
  const teams = Array.isArray(cfgFaro.teams) ? cfgFaro.teams : [];
  for (const d of deseadas) if (d.equipo && teams.length && !teams.includes(d.equipo)) p.avisos.push(`el equipo '${d.equipo}' de ${d.id} no está en 'teams' de .faro.json (${teams.join(', ')}).`);

  // ---- modo
  const todasExisten = deseadas.every((d) => existe(path.join(root, mp.rutaDeApp(d.id))));
  let movs = [];
  if (wsApps.length || todasExisten || ap.esMonorepo(root)) p.modo = ap.esMonorepo(root) && todasExisten ? 'ya-monorepo' : 'declarar';
  else {
    const cands = carpetasCandidatas(root);
    movs = entradasDeApp(root);
    if (cands.length && (movs.length || cands.length > 1)) {
      p.errores.push(`Hay más de una app candidata (${[...(movs.length ? ['la raíz'] : []), ...cands].join(', ')}): no convierto a ciegas. Declara el workspace (pnpm-workspace.yaml) o indica en gestion/monorepo-plan.json qué es cada carpeta.`);
      return fin();
    }
    if (movs.length && deseadas.length !== 1) { p.errores.push(`El código está en la raíz (una sola app) pero el plan declara ${deseadas.length}: usa --app <nombre> o ajusta el plan.`); return fin(); }
    p.modo = movs.length ? 'conversion' : 'preparado';
  }

  // ---- acciones
  if (p.modo === 'conversion') {
    const id = deseadas[0].id;
    for (const n of movs) p.movimientos.push({ de: n, a: `apps/${id}/${n}` });
    p.acciones.push({ tipo: 'mover', texto: `Mover a apps/${id}/: ${movs.join(', ')} (git mv: se conserva el historial).` });
    const pkgViejo = leerJson(path.join(root, 'package.json')) || {};
    p.archivos.packageRaiz = { name: nombreRaiz(root), private: true, ...(pkgViejo.packageManager ? { packageManager: pkgViejo.packageManager } : {}), scripts: Object.fromEntries(SCRIPTS_RAIZ.map((k) => [k, `pnpm -r --if-present run ${k}`])) };
    p.acciones.push({ tipo: 'crear', texto: 'Crear package.json de la raíz con scripts recursivos (pnpm -r).' });
  }
  if (!existe(path.join(root, 'pnpm-workspace.yaml')) && !(leerJson(path.join(root, 'package.json')) || {}).workspaces) {
    p.archivos.workspace = true;
    p.acciones.push({ tipo: 'crear', texto: 'Crear pnpm-workspace.yaml (apps/*, packages/*).' });
  } else if (existe(path.join(root, 'pnpm-workspace.yaml')) && !ap.workspace(root).globs.some((g) => /^(\.\/)?apps\/\*/.test(g))) {
    p.avisos.push("pnpm-workspace.yaml no incluye 'apps/*': añádelo para que pnpm vea las apps.");
  }
  if ((p.modo === 'declarar' || p.modo === 'ya-monorepo') && o.crearPackageRaiz && !existe(path.join(root, 'package.json'))) {
    p.archivos.packageRaiz = { name: nombreRaiz(root), private: true, scripts: Object.fromEntries(SCRIPTS_RAIZ.map((k) => [k, `pnpm -r --if-present run ${k}`])) };
    p.acciones.push({ tipo: 'crear', texto: 'Crear package.json de la raíz con scripts recursivos (pnpm -r).' });
  }
  if (p.modo === 'preparado') {
    if (!existe(path.join(root, 'package.json'))) {
      p.archivos.packageRaiz = { name: nombreRaiz(root), private: true, scripts: Object.fromEntries(SCRIPTS_RAIZ.map((k) => [k, `pnpm -r --if-present run ${k}`])) };
      p.acciones.push({ tipo: 'crear', texto: 'Crear package.json de la raíz con scripts recursivos (pnpm -r).' });
    }
    for (const d of deseadas) if (!existe(path.join(root, mp.rutaDeApp(d.id)))) {
      p.archivos.esqueletos.push(d.id);
      p.acciones.push({ tipo: 'crear', texto: `Crear apps/${d.id}/package.json mínimo (la app nace preparada).` });
    }
  }
  for (const d of deseadas) {
    const hayClaude = existe(path.join(root, mp.rutaDeApp(d.id), 'CLAUDE.md'));
    if (!hayClaude && d.rol) {
      p.archivos.claudeMd.push(d.id);
      p.acciones.push({ tipo: 'crear', texto: `Crear apps/${d.id}/CLAUDE.md (rol: ${d.rol}).` });
    }
  }
  // bloque monorepo
  const apps = { ...declExist };
  for (const d of deseadas) {
    if (!d.rol) continue;
    const prev = declExist[d.id] && typeof declExist[d.id] === 'object' ? declExist[d.id] : {};
    apps[d.id] = { ...prev, rol: d.rol, ...(d.funcional ? { funcional: d.funcional } : {}), ...(d.equipo ? { equipo: d.equipo } : {}) };
  }
  const tag = o.tag || (plan && plan.tag) || monExist.tag;
  const nuevo = { ...monExist, apps, ...(tag ? { tag } : {}) };
  if (JSON.stringify(nuevo) !== JSON.stringify(monExist) && !deseadas.some((d) => !d.rol)) {
    p.cfg = { ...cfgFaro, monorepo: nuevo };
    p.acciones.push({ tipo: 'editar', texto: `Declarar en .faro.json > monorepo: ${deseadas.map((d) => d.id).join(', ')}${tag ? ` (tag '${tag}')` : ''}.` });
  }
  p.etiquetas = deseadas.filter((d) => d.rol).map((d) => `app:${d.id}`);
  p.codeowners = o.codeowners === true || (plan && plan.codeowners === true) || false;
  if (p.codeowners) p.acciones.push({ tipo: 'codeowners', texto: 'Generar .github/CODEOWNERS y .github/labeler.yml por app (harness.js codeowners).' });

  // ---- consolidar la gestion de apps que ya estan dentro
  if (o.consolidar) {
    const usados = [];
    for (const d of deseadas) {
      const g = mg.leerGestion(path.join(root, mp.rutaDeApp(d.id)));
      if (!g.tiene) continue;
      const dz = Number.isInteger(d.desplazamiento) ? d.desplazamiento : mg.siguienteDesplazamiento(usados);
      usados.push(dz);
      const c = mg.planConsolidar(root, d.id, { desplazamiento: dz, clave: d.clave, plan, origen: d.origen || null });
      p.consolidacion.push(c);
      p.decisiones.push(...c.decisiones);
      p.avisos.push(...c.avisos);
      if (!c.yaConsolidado) p.acciones.push({ tipo: 'consolidar', texto: `Consolidar la gestión de ${d.id} en la raíz (desplazamiento +${dz}).` });
    }
    if (!p.consolidacion.length) p.avisos.push('--consolidar: ninguna app trae gestión propia (ESTADO.md, gestion/, documentos/…).');
  }

  // ---- avisos de lo externo
  const tags = (gitOut(root, ['tag', '--list', 'v[0-9]*']) || '').split('\n').map((t) => t.trim()).filter((t) => /^v\d+\.\d+\.\d+/.test(t));
  if (tags.length && p.acciones.length) p.avisos.push(`Tags heredados (${tags.slice(0, 3).join(', ')}${tags.length > 3 ? '…' : ''}): quedan como tags de la raíz y NO se reescriben. Desde ahora, el tag por app es '${tag || ap.TAG_DEFECTO}' (p. ej. ${deseadas[0].id}@<versión>).`);
  for (const d of deseadas) {
    const ruta = mp.rutaDeApp(d.id);
    const worker = p.modo === 'conversion' ? (movs.some((n) => /^wrangler\./.test(n)) ? { nombre: d.id } : null) : ap.rasgos(root, ruta).worker;
    if (worker && p.acciones.length) p.externos.push(`Workers Builds de ${d.id}: directorio raíz '${ruta}' y rutas de vigilancia '${ruta}/*'; revisa también sus secretos y variables (FUERA del repo: aquí no se tocan).`);
  }
  if (p.modo === 'conversion') p.avisos.push("Tras convertir, el CI de la raíz usa pnpm -r: regenera con 'harness.js ci' si no existe y 'harness.js codeowners' si activas CODEOWNERS.");

  // ---- idempotencia
  const consolidables = p.consolidacion.filter((c) => !c.yaConsolidado);
  p.nada = !p.errores.length && !p.acciones.length && !consolidables.length && !p.decisiones.some((d) => d.bloquea);
  if (p.nada) p.modo = 'ya-monorepo';

  // ---- condiciones de seguridad (bloquean --confirmo, no el dry-run). saltarGates: quien llama
  // (app nueva) ya los comprobo ANTES de escribir y ahora el arbol esta sucio por su propia copia.
  if (!p.nada && !o.saltarGates) p.bloqueos.push(...bloqueosGit(root, { inicial: o.inicial }));
  return fin();
}

/**
 * Gate git comun de monorepo init y app nueva. -> [bloqueos] ([] = se puede aplicar).
 * inicial (#216): el repo RECIEN CREADO por el wizard (un unico commit en su historia) se acepta en
 * cualquier rama (develop incluida), sin anclar y con cambios sin commitear. Con mas historia, el flag
 * no levanta nada.
 */
function bloqueosGit(root, { inicial = false, verbo = 'convertir' } = {}) {
  const g = estadoGit(root);
  if (!g.git) return ['El directorio no es un repositorio git.'];
  if (inicial && (gitOut(root, ['rev-list', '--count', 'HEAD']) || '').trim() === '1') return [];
  const b = [];
  if (g.protegida) b.push(`Estás en '${g.rama}': trabaja en una rama de trabajo anclada a un issue (feat/<N>-<slug>); nunca en main ni develop.`);
  else if (!g.anclada) b.push(`La rama '${g.rama}' no está anclada a un issue (feat/<N>-<slug>): crea la rama con 'harness.js rama feat "<tema>" --issue <N>'.`);
  if (g.sucio.length) b.push(`El árbol no está limpio (${g.sucio.length} cambio(s) o fichero(s) sin versionar, p. ej. ${g.sucio[0].trim()}): commitea o descarta antes de ${verbo}.`);
  return b;
}

/**
 * Aplica un plan de planInit. { git:true } usa git mv/add. { codeownersFn } genera CODEOWNERS.
 * -> { hechos:[], errores:[], etiquetas:[] }
 */
function aplicarInit(root, p, { git = true, codeownersFn = null } = {}) {
  const res = { hechos: [], errores: [], etiquetas: p.etiquetas || [] };
  if (!p.aplicable) { res.errores.push('el plan no es aplicable (hay errores, bloqueos o decisiones pendientes).'); return res; }
  const op = mg.operaciones(root, git);
  try {
    for (const m of p.movimientos) op.mover(m.de, m.a);
    if (p.movimientos.length) res.hechos.push(`${p.movimientos.length} elemento(s) movido(s) a apps/ con git mv.`);
    if (p.archivos.workspace) { op.escribir('pnpm-workspace.yaml', WORKSPACE_YAML); res.hechos.push('pnpm-workspace.yaml creado.'); }
    if (p.archivos.packageRaiz) { op.escribir('package.json', JSON.stringify(p.archivos.packageRaiz, null, 2) + '\n'); res.hechos.push('package.json de la raíz creado (scripts pnpm -r).'); }
    for (const id of p.archivos.esqueletos) op.escribir(`apps/${id}/package.json`, JSON.stringify({ name: id, version: '0.0.0', private: true }, null, 2) + '\n');
    for (const id of p.archivos.claudeMd) {
      const a = p.apps.find((x) => x.id === id);
      op.escribir(`apps/${id}/CLAUDE.md`, claudeMd(id, a.rol, (leerJson(path.join(root, 'apps', id, 'package.json')) || {}).name));
    }
    if (p.archivos.claudeMd.length) res.hechos.push(`CLAUDE.md creado en: ${p.archivos.claudeMd.map((i) => `apps/${i}`).join(', ')}.`);
    if (p.cfg) { op.escribir('.faro.json', JSON.stringify(p.cfg, null, 2) + '\n'); res.hechos.push('.faro.json: bloque monorepo escrito.'); }
    for (const c of p.consolidacion) {
      const r = mg.aplicarConsolidar(root, c, { git });
      res.hechos.push(...r.hechos); res.errores.push(...r.errores);
    }
    if (p.codeowners && codeownersFn) { const code = codeownersFn(); if (code) res.errores.push('codeowners terminó con error.'); else res.hechos.push('CODEOWNERS y labeler generados.'); }
    if (git && !res.errores.length) gitRun(root, ['add', '-A']);
  } catch (e) {
    res.errores.push(e.message);
  }
  return res;
}

// ---------- presentacion ----------

/** Lineas legibles del plan de consolidacion de una app (renumeraciones, movimientos, colisiones). */
function lineasConsolidacion(c) {
  const L = [];
  if (c.yaConsolidado) return ['', `Consolidación de ${c.app}: ya hecha.`];
  L.push('', `Consolidación de ${c.app} (clave ${c.clave}, desplazamiento +${c.desplazamiento}):`);
  for (const x of c.renumeraciones.requisitos) L.push(`- requisito ${x.de} → ${x.a}`);
  for (const x of c.renumeraciones.riesgos) L.push(`- riesgo ${x.de} → ${x.a}`);
  if (c.historico) L.push(`- ESTADO: ${c.historico.de} → ${c.historico.a}`);
  L.push(`- ${c.movimientos.length} fichero(s) a la raíz${c.colisiones.length ? `; ${c.colisiones.length} colisión(es): ${c.colisiones.map((x) => x.rel).join(', ')}` : ''}.`);
  const u = c.unificar;
  if (u.gitignore.length || u.allowBuilds.length || u.nodeVersion) L.push(`- unificar: .gitignore +${u.gitignore.length}, allowBuilds +${u.allowBuilds.length}${u.nodeVersion ? `, .node-version (${u.nodeVersion})` : ''}.`);
  return L;
}

function renderPlan(p, { aplicado = null } = {}) {
  const L = [];
  const cab = { conversion: 'convertir el repo simple en monorepo', preparado: 'preparar el repo para monorepo (nace con su app)', declarar: 'declarar las apps del workspace', 'ya-monorepo': 'ya es un monorepo' }[p.modo] || 'monorepo init';
  L.push(`MONOREPO INIT — ${cab}${aplicado ? ' · APLICADO' : ' · DRY-RUN (no se ha tocado nada)'}`);
  if (p.errores.length) { L.push('', 'NO PUEDO CONTINUAR:', ...p.errores.map((e) => `- ${e}`)); return L.join('\n'); }
  if (p.nada) { L.push('', 'Este repo ya es un monorepo y está declarado: nada que hacer.'); return L.join('\n'); }
  L.push('', 'Apps:', ...p.apps.map((a) => `- ${a.id} (${a.ruta}) — ${a.rol || 'ROL SIN DECLARAR'}${a.equipo ? ` · equipo ${a.equipo}` : ''}`));
  if (p.movimientos.length) { L.push('', 'Movimientos (git mv):', ...p.movimientos.map((m) => `- ${m.de} → ${m.a}`)); }
  const otras = p.acciones.filter((a) => a.tipo !== 'mover');
  if (otras.length) L.push('', 'Cambios:', ...otras.map((a) => `- ${a.texto}`));
  for (const c of p.consolidacion) L.push(...lineasConsolidacion(c));
  if (p.etiquetas.length) L.push('', `Etiquetas de la forja: ${p.etiquetas.join(', ')}.`);
  if (p.decisiones.length) { L.push('', 'DECISIONES que requieren criterio (nunca se resuelven en silencio):', ...p.decisiones.map((d) => `- [${d.id}] ${d.pregunta}${d.opciones && d.opciones.length ? ` (${d.opciones.join(' | ')}; por defecto ${d.defecto})` : ''}`)); }
  if (p.avisos.length) L.push('', 'Avisos:', ...p.avisos.map((a) => `- ${a}`));
  if (p.externos.length) L.push('', 'Fuera del repo (solo aviso):', ...p.externos.map((a) => `- ${a}`));
  if (p.bloqueos.length) L.push('', 'BLOQUEOS para aplicar:', ...p.bloqueos.map((b) => `- ${b}`));
  if (!aplicado) L.push('', p.aplicable ? "Para aplicarlo en esta rama: añade --confirmo (queda en el índice de git para que lo revises y commitees)." : 'Resuelve lo anterior y repite; con --confirmo se aplica.');
  return L.join('\n');
}

// ---------- linea de comandos ----------

function parseArgs(argv) {
  const o = { flags: new Set(), valores: {}, posicionales: [], apps: [] };
  const CON_VALOR = new Set(['--app', '--rol', '--funcional', '--equipo', '--tag', '--rama', '--modo']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (CON_VALOR.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) { o.error = `${a} necesita un valor`; break; }
      i++;
      if (a === '--app') o.apps.push(v); else o.valores[a.slice(2)] = v;
    } else if (a.startsWith('--')) o.flags.add(a);
    else o.posicionales.push(a);
  }
  return o;
}

/**
 * Despacha `harness.js monorepo <init|importar> ...`. ctx = { root, schema, org, log, codeownersFn, ensureLabels }.
 * -> codigo de salida (0 ok).
 */
async function cli(argv, ctx) {
  const log = ctx.log || console.log;
  const sub = argv[0];
  const o = parseArgs(argv.slice(1));
  if (o.error) { log(o.error); return 2; }
  if (o.flags.has('--confirmo') && o.flags.has('--dry-run')) { log('--confirmo y --dry-run se contradicen: elige uno.'); return 2; }
  if (sub === 'importar') return require('./monorepo-importar.js').cli(o, ctx);
  if (sub !== 'init') { log('Uso: harness.js monorepo init [--app <id> --rol "<frase>" --funcional <doc_id> --equipo <team>] [--consolidar] [--codeowners] [--tag "{app}@{version}"] [--inicial] [--dry-run|--confirmo] [--json]\n     harness.js monorepo importar <org/repo|url|ruta> --app <id> [--rama <r>] [--modo subtree|copia] [--actualizar] [--dry-run|--confirmo] [--json]\n     --inicial: repo recién creado (un solo commit): aplica aunque sea develop o la rama no esté anclada.'); return 2; }
  const p = planInit(ctx.root, {
    app: o.apps[0], rol: o.valores.rol, funcional: o.valores.funcional, equipo: o.valores.equipo, tag: o.valores.tag,
    codeowners: o.flags.has('--codeowners') || undefined, consolidar: o.flags.has('--consolidar'), schema: ctx.schema, org: ctx.org,
    inicial: o.flags.has('--inicial'),
  });
  const confirmo = o.flags.has('--confirmo');
  if (o.apps.length > 1) p.errores.push('init acepta una sola --app (para varias, usa gestion/monorepo-plan.json).');
  if (!confirmo || p.nada || p.errores.length) {
    if (o.flags.has('--json')) log(JSON.stringify(p, null, 2)); else log(renderPlan(p));
    if (p.errores.length) return 1;
    return 0;
  }
  if (!p.aplicable) {
    log(renderPlan(p));
    log('\nNo aplico: hay bloqueos o decisiones pendientes (arriba).');
    return 1;
  }
  const res = aplicarInit(ctx.root, p, { git: true, codeownersFn: ctx.codeownersFn });
  let etiquetas = [];
  if (!res.errores.length && ctx.ensureLabels) { try { etiquetas = await ctx.ensureLabels(p.apps.filter((a) => a.rol)); } catch { etiquetas = []; } }
  if (o.flags.has('--json')) log(JSON.stringify({ ...p, aplicado: res, etiquetasCreadas: etiquetas }, null, 2));
  else {
    log(renderPlan(p, { aplicado: true }));
    log('', '\nHecho:'); res.hechos.forEach((h) => log(`- ${h}`));
    if (etiquetas.length) log(`- etiquetas creadas/aseguradas en la forja: ${etiquetas.join(', ')}.`);
    else if (p.etiquetas.length) log(`- etiquetas ${p.etiquetas.join(', ')}: se crean al asignar la primera tarea (--app) o con la forja conectada.`);
    if (res.errores.length) { log('\nErrores:'); res.errores.forEach((e) => log(`- ${e}`)); } else log("\nSiguiente: revisa con 'git status', ejecuta 'harness.js validate' y commitea (los cambios ya están en el índice).");
  }
  return res.errores.length ? 1 : 0;
}

module.exports = { lineasConsolidacion, origenDeIssues, gitOut, gitRun, planInit, aplicarInit, renderPlan, estadoGit, bloqueosGit, entradasDeApp, carpetasCandidatas, parseArgs, cli, claudeMd, WORKSPACE_YAML };
