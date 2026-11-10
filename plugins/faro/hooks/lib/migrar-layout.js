// lib/migrar-layout.js — MIGRACION DEL LAYOUT (#293): pasa un repo con FARO en la raiz (gestion/, documentos/,
// ESTADO.md, .faro.json...) al layout vigente, todo bajo faro/. Lo que se mueve lo dice lib/paths.js (MIGRACION):
// aqui no se repite la taxonomia.
//
// REGLAS.
//  - Nunca a medias: si un destino ya existe, o hay cambios sin guardar, no se mueve NADA y se dice por que.
//  - Con git: `git mv` para lo versionado (el historial sigue a cada fichero); lo no versionado se renombra.
//  - .metrics/ se quita (ya no se usa).
//  - Referencias: los enlaces markdown relativos se recalculan para que apunten a lo MISMO desde el sitio
//    nuevo; las rutas citadas entre comillas invertidas (`gestion/risks.md`), las lineas del .gitignore y los
//    permisos de .claude/settings.json se pasan a faro/. Las URLs y lo del producto (src/, scripts/) no se tocan.
//  - No commitea: deja todo preparado (staged) para que la migracion vaya en su propio commit.
//
// SEGURIDAD: git con argumentos fijos (execFile, sin shell); solo se tocan rutas dentro del repo.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const paths = require('./paths.js');

const { BASE, MIGRACION } = paths;
const QUITAR = ['.metrics'];
const P = path.posix;

const git = (cwd, args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
const esGit = (root) => { try { return git(root, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { return false; } };
const existe = (root, rel) => fs.existsSync(path.join(root, rel));
/** true si ALGUN segmento existente de rel es un enlace simbolico (.claude/ o faro/ enlazados sacarian la escritura del repo). */
const conEnlace = (root, rel) => {
  const segs = String(rel).split(/[\\/]/).filter(Boolean);
  for (let i = 1; i <= segs.length; i++) {
    try { if (fs.lstatSync(path.join(root, ...segs.slice(0, i))).isSymbolicLink()) return true; } catch { return false; }
  }
  return false;
};
const posix = (p) => p.replace(/\\/g, '/');

/** Ruta antigua (relativa a la raiz) -> ruta nueva segun los movimientos del plan. */
function traductor(mover) {
  return (rel) => {
    const r = P.normalize(posix(rel)).replace(/^\.\//, '');
    for (const { de, a } of mover) {
      if (r === de) return a;
      if (r.startsWith(`${de}/`)) return `${a}${r.slice(de.length)}`;
    }
    return r;
  };
}

// ───────────────────────── reescritura de referencias ─────────────────────────
const RE_ESQUEMA = /^[a-z][a-z0-9+.-]*:/i;
// Historial: lo que registra como ERA algo (cambios archivados, ADR, informes, CHANGELOG). Sus citas no se reescriben.
const RE_HISTORIAL = /(^|\/)(changes\/archive\/|decisions\/|reporting\/|CHANGELOG\.md$)/;

/** Enlaces markdown relativos de un fichero que pasa de `viejo` a `nuevo`: que sigan apuntando a lo mismo. */
function reescribirEnlaces(txt, viejo, nuevo, traducir) {
  const dirV = P.dirname(viejo); const dirN = P.dirname(nuevo);
  return txt.replace(/(\]\()([^)\s]+)(\))/g, (todo, a, destino, c) => {
    if (RE_ESQUEMA.test(destino) || destino.startsWith('#') || destino.startsWith('/')) return todo;
    const m = destino.match(/^([^#?]*)(.*)$/);
    const ruta = m[1]; const cola = m[2];
    if (!ruta) return todo;
    const objetivoV = P.normalize(P.join(dirV, ruta));
    if (objetivoV.startsWith('..')) return todo;                       // fuera del repo: no es nuestro
    const objetivoN = traducir(objetivoV);
    if (P.normalize(P.join(dirN, ruta)) === objetivoN) return todo;    // ya apunta bien desde el sitio nuevo
    let rel = P.relative(dirN, objetivoN) || '.';
    if (ruta.endsWith('/') && !rel.endsWith('/')) rel += '/';
    return `${a}${rel}${cola}${c}`;
  });
}

/** Una ruta citada (`gestion/x`, `ESTADO.md`, `.faro.json`) -> la nueva; si no es de las que se mueven, null. */
function rutaCitada(token, traducir, mover) {
  const t = token.replace(/^\.\//, '');
  if (!mover.some(({ de }) => t === de || t.startsWith(`${de}/`))) return null;
  const n = traducir(t.replace(/\/$/, ''));
  return t.endsWith('/') ? `${n}/` : n;
}

function reescribirCitas(txt, traducir, mover) {
  return txt.replace(/`([^`\n]+)`/g, (todo, dentro) => {
    const n = rutaCitada(dentro, traducir, mover);
    return n ? `\`${n}\`` : todo;
  });
}

function reescribirGitignore(txt, traducir, mover, quitar) {
  const eol = txt.includes('\r\n') ? '\r\n' : '\n';
  const fuera = new Set(quitar.flatMap((q) => [q, `${q}/`, `/${q}`, `/${q}/`]));
  return txt.split(/\r?\n/).filter((l) => !fuera.has(l.trim())).map((l) => {
    const m = l.match(/^(!?)(\/?)(\S.*)$/);
    if (!m || l.startsWith('#')) return l;
    const n = rutaCitada(m[3], traducir, mover);
    return n ? `${m[1]}${m[2]}${n}` : l;
  }).join(eol);
}

const HERRAMIENTAS_RUTA = /^(Write|Edit|MultiEdit|Read|NotebookEdit)\((.+)\)$/;
function reescribirSettings(txt, traducir, mover) {
  let j; try { j = JSON.parse(txt); } catch { return txt; }
  const perm = j && j.permissions;
  if (!perm) return txt;
  let cambio = false;
  for (const k of ['allow', 'deny', 'ask']) {
    if (!Array.isArray(perm[k])) continue;
    perm[k] = perm[k].map((r) => {
      const m = typeof r === 'string' && r.match(HERRAMIENTAS_RUTA);
      const n = m && rutaCitada(m[2], traducir, mover);
      if (!n) return r;
      cambio = true;
      return `${m[1]}(${n})`;
    });
  }
  if (!cambio) return txt;
  const eol = txt.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(j, null, 2).replace(/\n/g, eol) + eol;
}

/** Ficheros markdown bajo una ruta (fichero o carpeta), en rutas relativas posix. */
function markdowns(root, rel) {
  const abs = path.join(root, rel);
  // lstat: un enlace simbolico no se sigue (podria apuntar fuera del repo); git mv mueve el enlace, no su destino
  let st; try { st = fs.lstatSync(abs); } catch { return []; }
  if (st.isSymbolicLink()) return [];
  if (st.isFile()) return /\.md$/i.test(rel) ? [rel] : [];
  return fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
    .flatMap((e) => markdowns(root, P.join(rel, e.name)));
}

/** Contenido nuevo de cada fichero afectado, calculado ANTES de mover: [{ viejo, nuevo, txt }]. */
function reescrituras(root, mover, quitar) {
  const traducir = traductor(mover);
  const movidos = mover.flatMap(({ de }) => markdowns(root, de));
  const raiz = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.md$/i.test(e.name) && !mover.some(({ de }) => de === e.name))
    .map((e) => e.name);
  const out = [];
  const anotar = (viejo, nuevo, fn) => {
    // nunca se reescribe a traves de un enlace simbolico (.gitignore, settings o un .md): escribiria fuera del repo
    if (conEnlace(root, viejo) || conEnlace(root, nuevo)) return;
    let txt; try { txt = fs.readFileSync(path.join(root, viejo), 'utf8'); } catch { return; }
    const n = fn(txt);
    if (n !== txt) out.push({ viejo, nuevo, txt: n });
  };
  for (const f of [...raiz, ...movidos]) {
    // el historial (cambios archivados) conserva sus citas tal cual: solo se recalculan sus enlaces, que si se romperian
    const historial = RE_HISTORIAL.test(f);
    anotar(f, traducir(f), (t) => {
      const e = reescribirEnlaces(t, f, traducir(f), traducir);
      return historial ? e : reescribirCitas(e, traducir, mover);
    });
  }
  anotar('.gitignore', '.gitignore', (t) => reescribirGitignore(t, traducir, mover, quitar));
  anotar(P.join('.claude', 'settings.json'), '.claude/settings.json', (t) => reescribirSettings(t, traducir, mover));
  return out;
}

// ───────────────────────── plan y aplicacion ─────────────────────────
/**
 * Que haria la migracion, sin tocar nada.
 * @returns {{ motivo: string|null, mover: {de,a}[], quitar: string[], reescribir: string[], choques: string[], avisos: string[] }}
 */
function plan(root) {
  const vacio = { mover: [], quitar: [], reescribir: [], choques: [], avisos: [] };
  if (paths.detectarLayout(root) === 'faro') {
    const yaFaro = ['ESTADO.md', 'config.json', 'gestion'].some((f) => existe(root, `${BASE}/${f}`));
    return { ...vacio, motivo: yaFaro ? `el repo ya tiene lo de FARO en ${BASE}/` : 'no hay nada de FARO en la raíz que migrar' };
  }
  const avisos = []; const choques = []; const mover = [];
  for (const [de, a] of MIGRACION) {
    if (!existe(root, de)) continue;
    if (de === 'INICIATIVA.md' && existe(root, 'ESTADO.md')) {
      avisos.push(`INICIATIVA.md y ESTADO.md conviven: se migra ESTADO.md y INICIATIVA.md se queda en la raíz (revísalo y bórralo si sobra).`);
      continue;
    }
    if (existe(root, a)) choques.push(a);
    mover.push({ de, a });
  }
  const quitar = QUITAR.filter((q) => existe(root, q));
  const reescribir = reescrituras(root, mover, quitar).map((r) => r.nuevo);
  const motivo = conEnlace(root, BASE) ? `${BASE}/ es un enlace simbólico: la migración escribiría fuera del repo; sustitúyelo por una carpeta real`
    : choques.length ? `ya existe ${choques.join(', ')}: muévelo o bórralo antes (no se migra a medias)` : null;
  return { motivo, mover, quitar, reescribir, choques, avisos };
}

/** Migra de verdad. Devuelve { ok, motivo, nada?, mover, quitar, reescribir, avisos }. */
function aplicar(root) {
  const p = plan(root);
  if (!p.mover.length && !p.choques.length) return { ok: true, nada: true, ...p };
  if (p.motivo) return { ok: false, ...p };
  const conGit = esGit(root);
  if (conGit) {
    let sucio = ''; try { sucio = git(root, ['status', '--porcelain']).trim(); } catch {}
    if (sucio) return { ok: false, ...p, motivo: 'hay cambios sin guardar: guárdalos (commit) antes, para que la migración vaya en su propio commit' };
  }
  const nuevos = reescrituras(root, p.mover, p.quitar);   // antes de mover: se leen las rutas viejas
  fs.mkdirSync(path.join(root, BASE), { recursive: true });
  const versionado = (rel) => { try { return git(root, ['ls-files', '--', rel]).trim() !== ''; } catch { return false; } };
  for (const { de, a } of p.mover) {
    fs.mkdirSync(path.dirname(path.join(root, a)), { recursive: true });
    if (conGit && versionado(de)) git(root, ['mv', '--', de, a]);
    else fs.renameSync(path.join(root, de), path.join(root, a));
  }
  for (const q of p.quitar) {
    if (conGit && versionado(q)) git(root, ['rm', '-r', '-q', '-f', '--', q]);
    fs.rmSync(path.join(root, q), { recursive: true, force: true });
  }
  for (const r of nuevos) if (!conEnlace(root, r.nuevo)) fs.writeFileSync(path.join(root, r.nuevo), r.txt);
  if (conGit && nuevos.length) {
    const versionados = nuevos.map((r) => r.nuevo).filter((f) => versionado(f));
    if (versionados.length) git(root, ['add', '--', ...versionados]);
  }
  return { ok: true, ...p };
}

// ───────────────────────── comando `harness.js migrar-layout` ─────────────────────────
function cli(argv, { root, out = (t) => console.log(t) } = {}) {
  const seco = argv.includes('--dry-run') || argv.includes('--plan');
  const p = seco ? plan(root) : aplicar(root);
  if (!p.mover.length && !p.choques.length) { out(`Nada que migrar: ${p.motivo}.`); return 0; }
  const ancho = Math.max(...p.mover.map((m) => m.de.length));
  const l = [seco ? `Plan para pasar FARO a ${BASE}/ (no se ha tocado nada):` : (p.ok ? `FARO pasado a ${BASE}/:` : `No se ha migrado nada: ${p.motivo}.`)];
  if (seco || p.ok) {
    for (const m of p.mover) l.push(`  ${m.de.padEnd(ancho)}  →  ${m.a}`);
    for (const q of p.quitar) l.push(`  ${q}  (se quita: ya no se usa)`);
    if (p.reescribir.length) {
      const muestra = p.reescribir.slice(0, 8).join(', ');
      l.push(`  Referencias reescritas en ${p.reescribir.length} fichero(s): ${muestra}${p.reescribir.length > 8 ? ', …' : ''}`);
    }
  }
  for (const a of p.avisos) l.push(`  ⚠ ${a}`);
  if (seco && p.motivo) l.push(`  ✖ ${p.motivo}.`);
  if (seco && !p.motivo) l.push('Si cuadra: node harness.js migrar-layout');
  if (!seco && p.ok) l.push('Revisa el cambio (git status) y guárdalo en su propio commit; el motor ya lee el layout nuevo.');
  out(l.join('\n'));
  return seco || p.ok ? 0 : 1;
}

module.exports = { plan, aplicar, cli, reescribirEnlaces, reescribirCitas, reescribirGitignore, reescribirSettings };
