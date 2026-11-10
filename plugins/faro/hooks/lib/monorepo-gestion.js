// lib/monorepo-gestion.js — CONSOLIDAR la gestion FARO de una app en la raiz del monorepo (#161, #162).
//
// Caso real: dos repos, cada uno con su ESTADO.md, riesgos, requisitos y documentos,
// acaban como apps de UN repo con UNA gestion. Mecanica, determinista y con trazabilidad:
//   - riesgos (R-NN) y requisitos (REQ-NN) se renumeran con un desplazamiento por origen (+100,
//     +200…) y TODAS las referencias se reescriben (texto, specs, tareas y codigo);
//   - los documentos se mueven conservando su doc_id; si algo choca NO se pisa: es colision y es una
//     DECISION para el usuario (nunca se resuelve en silencio);
//   - el ESTADO.md original se archiva en gestion/historico/ESTADO-<CLAVE>-<app>.md; la fusion de los
//     faseos es siempre una decision, no se toca el ESTADO.md de la raiz;
//   - .gitignore, .node-version y allowBuilds se unifican en la raiz.
//
// SEGURIDAD: solo lee y escribe dentro de la raiz; no sigue enlaces simbolicos; no ejecuta nada del
// repo consolidado; los ids pasan por monorepo-plan.validarId antes de construir rutas; git solo
// recibe rutas construidas aqui, siempre tras '--'.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const mp = require('./monorepo-plan.js');

const CARPETAS = ['documentos', 'fuentes', 'flujos', 'notebooks', 'gestion'];
const NO_ENTRAR = new Set(['node_modules', '.git', 'dist', 'build', '.wrangler', '.next', '.output', '.turbo', 'coverage']);
const TEXTO = new Set(['.md', '.json', '.yml', '.yaml', '.txt', '.csv']);
const CODIGO = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.sh']);
const MAX_BYTES = 1024 * 1024;
const REF_RE = /(?<![\w-])(REQ|R)-(\d+)(?![\w-])/g;
const posix = (p) => String(p).replace(/\\/g, '/');

/**
 * UNICA lectura de ficheros del modulo. Solo devuelve el texto de un fichero REGULAR (lstat: ni
 * enlaces simbolicos ni nada raro), de tamano acotado, cuyo realpath sigue dentro de `raiz` (o, sin
 * raiz, cuyo directorio padre no es un enlace). Un origen con symlinks no puede hacernos leer lo que
 * hay fuera de el. Devuelve null ante cualquier duda; NUNCA vuelca contenido en mensajes.
 * `fsi` permite simular el sistema de ficheros en tests.
 */
function leerSeguro(abs, raiz = null, fsi = fs) {
  try {
    const st = fsi.lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_BYTES) return null;
    const n = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
    const real = n(fsi.realpathSync(abs));
    if (raiz) {
      const r = n(fsi.realpathSync(raiz));
      if (real !== r && !real.startsWith(`${r}/`)) return null;
    } else if (real.toLowerCase() !== `${n(fsi.realpathSync(path.dirname(abs)))}/${n(path.basename(abs))}`.toLowerCase()) return null;
    return fsi.readFileSync(abs, 'utf8');
  } catch { return null; }
}
const leer = (abs) => leerSeguro(abs);
const existe = (abs) => { try { fs.lstatSync(abs); return true; } catch { return false; } };

/** Ficheros regulares bajo una carpeta (relativos, con '/'); sin enlaces simbolicos ni carpetas generadas. */
function ficheros(absBase, rel = '', prof = 8) {
  if (prof < 0) return [];
  try { if (fs.lstatSync(path.join(absBase, rel)).isSymbolicLink()) return []; } catch { return []; }
  let ents = [];
  try { ents = fs.readdirSync(path.join(absBase, rel), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isSymbolicLink()) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!NO_ENTRAR.has(e.name)) out.push(...ficheros(absBase, r, prof - 1)); } else if (e.isFile()) out.push(r);
  }
  return out;
}

/**
 * Suma `n` al numero de cada REQ-NN y R-NN (conserva el relleno: REQ-01 +100 -> REQ-101). No toca
 * identificadores compuestos (OBS-REQ-01, XR-01) ni doc_id. { soloRequisitos } deja los riesgos (codigo).
 */
function desplazar(texto, n, { soloRequisitos = false } = {}) {
  if (!n) return texto;
  return String(texto).replace(REF_RE, (m, pref, num) => {
    if (soloRequisitos && pref !== 'REQ') return m;
    return `${pref}-${String(Number(num) + n).padStart(num.length, '0')}`;
  });
}

// '#7' -> 'org/repo#7' (solo si va tras blanco/parentesis/corchete y tiene 1-5 digitos: no toca colores ni anclas).
function calificarIssues(texto, origen) {
  if (!origen || !origen.org || !origen.repo) return texto;
  return String(texto).replace(/(^|[\s(\[])#(\d{1,5})(?![\w-])/gm, (m, pre, num) => `${pre}${origen.org}/${origen.repo}#${num}`);
}

function frontmatter(txt) {
  const m = String(txt || '').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  const fm = {};
  if (m) for (const l of m[1].split('\n')) { const k = l.match(/^([A-Za-z_][\w-]*):\s*(.*)$/); if (k) fm[k[1]] = k[2].trim().replace(/^["']|["']$/g, ''); }
  return fm;
}

/** doc_id de todos los .md de documentos/ y gestion/ bajo `base` -> [{id, rel}] (rel relativo a `base`). */
function docsDe(base) {
  const out = [];
  for (const c of ['documentos', 'gestion']) {
    for (const f of ficheros(base, c)) {
      if (!f.endsWith('.md')) continue;
      const t = leer(path.join(base, f));
      if (t == null || t.length > MAX_BYTES) continue;
      const id = frontmatter(t).doc_id;
      if (id) out.push({ id, rel: f });
    }
  }
  return out;
}

const claveDe = (docs) => {
  const cuenta = new Map();
  for (const d of docs) {
    const m = d.id.match(/^([A-Z0-9]+(?:-[A-Z0-9]+)*?)-([A-Z]{2,6})-(\d+)$/);
    if (m) cuenta.set(m[1], (cuenta.get(m[1]) || 0) + 1);
  }
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map((x) => x[0])[0] || null;
};

/** Lectura determinista de la gestion que trae una carpeta (la raiz de un origen o apps/<id>). */
function leerGestion(base) {
  const estadoTxt = leer(path.join(base, 'ESTADO.md'));
  const carpetas = CARPETAS.filter((c) => { try { return fs.lstatSync(path.join(base, c)).isDirectory(); } catch { return false; } });
  const fases = [];
  if (estadoTxt) {
    for (const l of estadoTxt.replace(/\r\n/g, '\n').split('\n')) {
      const m = l.match(/^###\s+Fase\s+(\d+)\s*·\s*(.+?)\s+[—–-]\s+(\w+)\s*$/);
      if (m) fases.push({ n: Number(m[1]), titulo: m[2], estado: m[3] });
    }
  }
  const risks = leer(path.join(base, 'gestion', 'risks.md')) || '';
  const reqs = leer(path.join(base, 'gestion', 'requisitos.md')) || '';
  const riesgos = [...risks.matchAll(/^\|\s*(R-\d+)\s*\|/gm)].map((m) => m[1]);
  const requisitos = [...reqs.matchAll(/^##\s+(REQ-\d+)\b/gm)].map((m) => m[1]);
  const docs = docsDe(base);
  const clave = claveDe(docs) || (estadoTxt ? (frontmatter(estadoTxt).clave || null) : null);
  return { tiene: estadoTxt != null || carpetas.length > 0, estado: estadoTxt != null, fm: estadoTxt ? frontmatter(estadoTxt) : {}, fases, riesgos, requisitos, docs, clave, carpetas };
}

/** 100, 200… : el siguiente desplazamiento libre dado los ya usados. */
const siguienteDesplazamiento = (usados) => (Math.max(0, ...(usados || [])) || 0) + 100;

// ---------- unificar .gitignore / .node-version / allowBuilds ----------

const lineasGitignore = (t) => String(t || '').replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l && !l.startsWith('#'));
function anclar(linea, id) {
  const neg = linea.startsWith('!');
  const cuerpo = neg ? linea.slice(1) : linea;
  return cuerpo.startsWith('/') ? `${neg ? '!' : ''}/apps/${id}${cuerpo}` : linea;
}
function allowBuildsDe(yaml) {
  const out = {};
  const ls = String(yaml || '').replace(/\r\n/g, '\n').split('\n');
  const i = ls.findIndex((l) => /^allowBuilds:\s*$/.test(l));
  if (i < 0) return out;
  for (let j = i + 1; j < ls.length && /^\s+\S/.test(ls[j]); j++) { const m = ls[j].match(/^\s+['"]?([^\s:'"]+)['"]?:\s*(true|false)\s*$/); if (m) out[m[1]] = m[2]; }
  return out;
}
function insertarAllowBuilds(yaml, claves) {
  const ls = String(yaml || '').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const nuevas = claves.map((k) => `  ${k}: true`);
  const i = ls.findIndex((l) => /^allowBuilds:\s*$/.test(l));
  if (i < 0) return `${ls.join('\n')}\n\nallowBuilds:\n${nuevas.join('\n')}\n`;
  let j = i + 1;
  while (j < ls.length && /^\s+\S/.test(ls[j])) j++;
  ls.splice(j, 0, ...nuevas);
  return `${ls.join('\n')}\n`;
}

// ---------- el plan ----------

/**
 * Plan de consolidacion de apps/<id> en la raiz. NO escribe. -> {
 *   app, base, clave, desplazamiento, yaConsolidado, historico:{de,a}, movimientos:[{de,a}],
 *   renumeraciones:{requisitos:[{de,a}], riesgos:[{de,a}]}, colisiones:[{rel,motivo}],
 *   decisiones:[{id,pregunta,opciones,defecto}], avisos:[], unificar:{gitignore,nodeVersion,allowBuilds,borrar}, origen }
 */
function planConsolidar(root, id, { desplazamiento, clave, origen = null, plan = null, leerDe = null } = {}) {
  if (!mp.validarId(id)) throw new Error(`id de app inválido: ${id}`);
  const baseRel = `apps/${id}`;
  const base = leerDe || path.join(root, baseRel);
  const g = leerGestion(base);
  const dz = Number.isInteger(desplazamiento) ? desplazamiento : 100;
  const claveApp = clave || g.clave || id.toUpperCase().replace(/-/g, '');
  const historicoA = `gestion/historico/ESTADO-${claveApp}-${id}.md`;
  const p = {
    app: id, base: baseRel, clave: claveApp, desplazamiento: dz, origen,
    yaConsolidado: existe(path.join(root, historicoA)),
    historico: g.estado ? { de: `${baseRel}/ESTADO.md`, a: historicoA } : null,
    fases: g.fases,
    movimientos: [], colisiones: [], decisiones: [], avisos: [],
    renumeraciones: {
      requisitos: g.requisitos.map((r) => ({ de: r, a: desplazar(r, dz) })),
      riesgos: g.riesgos.map((r) => ({ de: r, a: desplazar(r, dz) })),
    },
    unificar: { gitignore: [], nodeVersion: null, allowBuilds: [], borrar: [] },
  };
  const decidir = (d) => { if (mp.respuesta(plan, d.id) === null) p.decisiones.push(d); };
  if (p.yaConsolidado) return p;

  // documentos conocidos de la raiz (para no duplicar doc_id)
  const rootDocs = new Map(docsDe(root).filter((d) => !d.rel.startsWith('apps/')).map((d) => [d.id, d.rel]));
  const destinos = new Set();
  for (const c of CARPETAS) {
    for (const rel of ficheros(base, c)) {
      if (c === 'gestion' && (rel === 'gestion/risks.md' || rel === 'gestion/requisitos.md')) continue;
      if (c === 'gestion' && rel.startsWith('gestion/tareas/')) continue;
      const a = rel;
      let motivo = null;
      if (existe(path.join(root, a)) || destinos.has(a)) motivo = 'ya existe en la raíz';
      else if (rel.endsWith('.md')) {
        const t = leer(path.join(base, rel));
        const did = t && t.length <= MAX_BYTES ? frontmatter(t).doc_id : null;
        if (did && rootDocs.has(did)) motivo = `doc_id ${did} ya usado en ${rootDocs.get(did)}`;
      }
      if (motivo) {
        p.colisiones.push({ rel: a, motivo });
        decidir({ id: `duplicado:${a}`, pregunta: `El documento '${a}' de la app ${id} choca con la raíz (${motivo}). ¿Se conserva el de la raíz, el de la app o los dos?`, opciones: ['raiz', 'app', 'ambos'], defecto: 'raiz' });
      } else { destinos.add(a); p.movimientos.push({ de: `${baseRel}/${rel}`, a }); }
    }
  }
  if (existe(path.join(base, 'gestion', 'tareas'))) p.avisos.push(`gestion/tareas de ${id} NO se mueve: los números de issue de otro repositorio chocarían con los de la raíz (sus referencias pasan a org/repo#N).`);
  if (existe(path.join(base, 'pnpm-lock.yaml'))) p.avisos.push(`apps/${id}/pnpm-lock.yaml se deja en su sitio: tras consolidar ejecuta 'pnpm install' en la raíz para generar el único lockfile y bórralo de la app.`);
  if (g.estado) decidir({ id: `fusion-faseo:${id}`, pregunta: `¿Cómo se fusionan las fases abiertas de ${id} en el faseo de la raíz? (el ESTADO original queda archivado en ${historicoA})`, opciones: ['manual', 'omitir'], defecto: 'manual' });
  const claveRaiz = claveDe([...rootDocs.keys()].map((i) => ({ id: i })));
  if (g.clave && claveRaiz && g.clave !== claveRaiz) decidir({ id: `clave-documental:${id}`, pregunta: `La app ${id} usa la clave documental ${g.clave} y la raíz ${claveRaiz}. ¿Cuál gana? (los doc_id existentes NO se renombran)`, opciones: ['raiz', 'app'], defecto: 'raiz' });

  // unificar
  const gi = leer(path.join(base, '.gitignore'));
  if (gi != null) {
    const raizLineas = new Set(lineasGitignore(leer(path.join(root, '.gitignore'))));
    const nuevas = [];
    for (const l of lineasGitignore(gi).map((x) => anclar(x, id))) if (!raizLineas.has(l) && !nuevas.includes(l)) nuevas.push(l);
    p.unificar.gitignore = nuevas;
    p.unificar.borrar.push(`${baseRel}/.gitignore`);
  }
  const nvApp = leer(path.join(base, '.node-version'));
  if (nvApp != null) {
    const nvRaiz = leer(path.join(root, '.node-version'));
    if (nvRaiz == null) p.unificar.nodeVersion = 'mover';
    else if (nvRaiz.trim() === nvApp.trim()) { p.unificar.nodeVersion = 'quitar'; p.unificar.borrar.push(`${baseRel}/.node-version`); }
    else { p.unificar.nodeVersion = 'conflicto'; decidir({ id: 'node-version', pregunta: `${id} usa Node ${nvApp.trim()} y la raíz ${nvRaiz.trim()}. ¿Qué versión rige en todo el monorepo?`, opciones: ['raiz', 'app'], defecto: 'raiz' }); }
  }
  const wsApp = leer(path.join(base, 'pnpm-workspace.yaml'));
  if (wsApp != null) {
    const raiz = allowBuildsDe(leer(path.join(root, 'pnpm-workspace.yaml')));
    p.unificar.allowBuilds = Object.entries(allowBuildsDe(wsApp)).filter(([k, v]) => v === 'true' && !(k in raiz)).map(([k]) => k);
    if (/^packages:/m.test(wsApp)) p.avisos.push(`apps/${id}/pnpm-workspace.yaml declara 'packages:': es un workspace anidado; revísalo a mano.`);
    else p.unificar.borrar.push(`${baseRel}/pnpm-workspace.yaml`);
  }
  return p;
}

// ---------- aplicar ----------

function gitOp(root, ...args) { execFileSync('git', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }); }

function operaciones(root, usarGit) {
  const dentro = (rel) => {
    const abs = path.resolve(root, rel);
    const r = path.relative(path.resolve(root), abs);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new Error(`ruta fuera de la raíz: ${rel}`);
    // el padre REAL (primer ancestro existente) tampoco puede escapar: un enlace de carpeta no es un atajo
    let anc = path.dirname(abs);
    while (!existe(anc) && anc !== path.dirname(anc)) anc = path.dirname(anc);
    let real; let rr;
    try { real = fs.realpathSync(anc); rr = fs.realpathSync(root); } catch { throw new Error(`ruta fuera de la raíz: ${rel}`); }
    if (real !== rr && !real.startsWith(rr.endsWith(path.sep) ? rr : rr + path.sep)) throw new Error(`ruta fuera de la raíz: ${rel}`);
    return abs;
  };
  return {
    dentro,
    mover(de, a) {
      const dAbs = dentro(de); const aAbs = dentro(a);
      fs.mkdirSync(path.dirname(aAbs), { recursive: true });
      if (usarGit) { try { gitOp(root, 'mv', '--', de, a); return; } catch { /* sin trackear: cae a rename */ } }
      fs.renameSync(dAbs, aAbs);
    },
    borrar(rel) {
      const abs = dentro(rel);
      if (!existe(abs)) return;
      if (usarGit) { try { gitOp(root, 'rm', '-q', '-f', '--', rel); return; } catch { /* sin trackear */ } }
      fs.rmSync(abs, { force: true });
    },
    escribir(rel, txt) { const abs = dentro(rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, txt); },
  };
}

function reescribirFichero(abs, plan) {
  const ext = path.extname(abs).toLowerCase();
  const esCodigo = CODIGO.has(ext);
  if (!esCodigo && !TEXTO.has(ext)) return false;
  let st; try { st = fs.lstatSync(abs); } catch { return false; }
  if (!st.isFile() || st.size > MAX_BYTES) return false;
  const t = leer(abs); if (t == null) return false;
  let n = desplazar(t, plan.desplazamiento, { soloRequisitos: esCodigo });
  if (!esCodigo) n = calificarIssues(n, plan.origen);
  if (n === t) return false;
  fs.writeFileSync(abs, n);
  return true;
}

function filasRiesgo(txt) {
  const ls = String(txt || '').replace(/\r\n/g, '\n').split('\n');
  const filas = ls.filter((l) => /^\|\s*R-\d+\s*\|/.test(l));
  const i = ls.findIndex((l) => /^\|\s*R-\d+\s*\|/.test(l));
  const cab = i >= 2 && /^\|/.test(ls[i - 1]) && /^\|/.test(ls[i - 2]) ? [ls[i - 2], ls[i - 1]] : null;
  return { filas, cab };
}

function fusionarRiesgos(rootTxt, origenTxt) {
  const { filas, cab } = filasRiesgo(origenTxt);
  if (!filas.length) return rootTxt;
  if (rootTxt == null) return `# Riesgos (RAID)\n\n${cab ? `${cab.join('\n')}\n` : ''}${filas.join('\n')}\n`;
  const ls = rootTxt.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  let ultimo = -1;
  ls.forEach((l, i) => { if (/^\|/.test(l)) ultimo = i; });
  if (ultimo < 0) return `${ls.join('\n')}\n\n${cab ? `${cab.join('\n')}\n` : ''}${filas.join('\n')}\n`;
  ls.splice(ultimo + 1, 0, ...filas);
  return `${ls.join('\n')}\n`;
}

function seccionesRequisitos(txt) {
  const t = String(txt || '').replace(/\r\n/g, '\n');
  const i = t.search(/^##\s+REQ-\d+/m);
  return i < 0 ? '' : t.slice(i).replace(/\n+$/, '\n');
}

function resumenFases(p) {
  if (!p.fases || !p.fases.length) return '- (sin fases)';
  return p.fases.map((f) => (f.estado === 'done'
    ? `- Fase ${f.n} · ${f.titulo} — ${f.estado} (cerrada)`
    : `- Fase ${f.n} · ${f.titulo} — ${f.estado} (abierta: pendiente de fusionar en el faseo raíz, decisión fusion-faseo:${p.app})`)).join('\n');
}

/**
 * Ejecuta un plan de planConsolidar. { git: true } usa 'git mv'/'git rm' (conserva el historial);
 * false trabaja solo sobre el disco. -> { hechos:[...], errores:[...] }
 */
function aplicarConsolidar(root, plan, { git = true } = {}) {
  const res = { hechos: [], errores: [] };
  if (plan.yaConsolidado) { res.hechos.push(`${plan.app}: ya consolidada (existe ${plan.historico && plan.historico.a}); nada que hacer.`); return res; }
  const op = operaciones(root, git);
  const base = plan.base;
  try {
    // 1. fusionar requisitos y riesgos (se leen ANTES de mover nada)
    const reqApp = leer(path.join(root, base, 'gestion', 'requisitos.md'));
    if (reqApp != null && plan.renumeraciones.requisitos.length) {
      const sec = calificarIssues(desplazar(seccionesRequisitos(reqApp), plan.desplazamiento), plan.origen);
      const actual = leer(path.join(root, 'gestion', 'requisitos.md'));
      op.escribir('gestion/requisitos.md', `${(actual == null ? '# Registro de requisitos\n' : actual.replace(/\r\n/g, '\n').replace(/\n+$/, '\n'))}\n${sec}`);
      res.hechos.push(`requisitos: ${plan.renumeraciones.requisitos.length} fusionados (+${plan.desplazamiento}).`);
    }
    const riesgosApp = leer(path.join(root, base, 'gestion', 'risks.md'));
    if (riesgosApp != null && plan.renumeraciones.riesgos.length) {
      const nuevo = fusionarRiesgos(leer(path.join(root, 'gestion', 'risks.md')), calificarIssues(desplazar(riesgosApp, plan.desplazamiento), plan.origen));
      op.escribir('gestion/risks.md', nuevo);
      res.hechos.push(`riesgos: ${plan.renumeraciones.riesgos.length} fusionados (+${plan.desplazamiento}).`);
    }
    for (const f of ['gestion/requisitos.md', 'gestion/risks.md']) if (existe(path.join(root, base, f))) op.borrar(`${base}/${f}`);

    // 2. ESTADO original -> historico
    if (plan.historico) {
      const orig = leer(path.join(root, plan.historico.de)) || '';
      const cab = [
        `> FARO · histórico — ESTADO.md original de la app \`${plan.app}\`, archivado al consolidar su gestión en la raíz. Solo lectura: lo vivo está en el ESTADO.md de la raíz.`,
        `> Renumeración aplicada: REQ y R +${plan.desplazamiento}.${plan.origen && plan.origen.org ? ` Los issues \`#N\` pasan a \`${plan.origen.org}/${plan.origen.repo}#N\`.` : ''}`,
        '', '## Fases del origen', resumenFases(plan), '', '---', '',
      ].join('\n');
      op.escribir(plan.historico.a, cab + calificarIssues(desplazar(orig.replace(/\r\n/g, '\n'), plan.desplazamiento), plan.origen));
      op.borrar(plan.historico.de);
      res.hechos.push(`ESTADO archivado en ${plan.historico.a}.`);
    }

    // 3. mover el resto conservando nombres (y doc_id) y reescribir sus referencias
    for (const m of plan.movimientos) {
      op.mover(m.de, m.a);
      reescribirFichero(op.dentro(m.a), plan);
    }
    res.hechos.push(`${plan.movimientos.length} fichero(s) movido(s) a la raíz.`);
    if (plan.colisiones.length) res.hechos.push(`${plan.colisiones.length} colisión(es) sin mover (decisiones pendientes).`);

    // 4. lo que se queda en la app (codigo, tareas…) tambien debe apuntar a los ids nuevos
    let reescritos = 0;
    for (const rel of ficheros(path.join(root, base))) if (reescribirFichero(path.join(root, base, rel), plan)) reescritos++;
    if (reescritos) res.hechos.push(`${reescritos} fichero(s) de la app con referencias reescritas.`);

    // 5. unificar
    const u = plan.unificar;
    if (u.gitignore.length) {
      const actual = leer(path.join(root, '.gitignore'));
      op.escribir('.gitignore', `${actual == null ? '' : actual.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')}${u.gitignore.join('\n')}\n`);
      res.hechos.push(`.gitignore: +${u.gitignore.length} línea(s).`);
    }
    if (u.nodeVersion === 'mover') { op.mover(`${base}/.node-version`, '.node-version'); res.hechos.push('.node-version movido a la raíz.'); }
    if (u.allowBuilds.length) {
      op.escribir('pnpm-workspace.yaml', insertarAllowBuilds(leer(path.join(root, 'pnpm-workspace.yaml')) || 'packages:\n  - "apps/*"\n', u.allowBuilds));
      res.hechos.push(`allowBuilds: +${u.allowBuilds.join(', ')}.`);
    }
    for (const b of u.borrar) op.borrar(b);
  } catch (e) {
    res.errores.push(`consolidar ${plan.app}: ${e.message}`);
  }
  return res;
}

/** REQ-NN / R-NN citados en los .md/.json/.txt de `carpetas` que NO estan definidos en gestion/requisitos.md ni gestion/risks.md. */
function referenciasColgantes(root, carpetas) {
  const defs = new Set();
  for (const m of (leer(path.join(root, 'gestion', 'requisitos.md')) || '').matchAll(/^##\s+(REQ-\d+)\b/gm)) defs.add(m[1]);
  for (const m of (leer(path.join(root, 'gestion', 'risks.md')) || '').matchAll(/^\|\s*(R-\d+)\s*\|/gm)) defs.add(m[1]);
  const colgantes = new Set();
  for (const c of carpetas) {
    for (const rel of ficheros(root, c)) {
      if (!TEXTO.has(path.extname(rel).toLowerCase())) continue;
      const t = leer(path.join(root, rel));
      if (t == null || t.length > MAX_BYTES) continue;
      for (const m of t.matchAll(REF_RE)) { const id = `${m[1]}-${m[2]}`; if (!defs.has(id)) colgantes.add(id); }
    }
  }
  return [...colgantes];
}

module.exports = {
  desplazar, calificarIssues, leerGestion, siguienteDesplazamiento, planConsolidar, aplicarConsolidar, referenciasColgantes,
  leerSeguro, ficheros, frontmatter, operaciones, allowBuildsDe, insertarAllowBuilds,
};
