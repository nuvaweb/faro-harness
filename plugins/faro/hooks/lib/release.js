// lib/release.js — TAG de version tras aprobar (0.9.4). El CHANGELOG registra la fecha de una
// version publicada, pero sin un tag de git nadie puede ir directo al commit exacto de esa release
// (cierra el ciclo descrito en skills/changelog/SKILL.md: ahora tambien determinista aqui, no solo
// confiado a que la skill se acuerde). Se invoca desde cmdPublicar tras el merge develop -> main.
'use strict';
const fs = require('fs');
const path = require('path');
const appsLib = require('./apps.js');
const ciclo = require('./ciclo.js');

// Encabezado de VERSION en el CHANGELOG, en cualquiera de las formas habituales: '## 0.7.0',
// '## [0.7.0]' (Keep a Changelog), '## v0.7.0', '## [v0.7.0]'. Solo se aceptaba la primera y
// publicar cancelaba en repos con el formato estandar (#68). La version tiene que acabar ahi:
// '0.7.01', '0.7.0-beta' o '10.7.0' no son la 0.7.0.
function reEncabezadoVersion(version) {
  const esc = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^##[ \\t]+\\[?v?${esc}(?![\\w.-])\\]?`, 'm');
}

// SemVer minimo para ordenar tags: '1.10.0' > '1.9.0' (el orden de 'git tag -l' es alfabetico).
const partesVersion = (v) => String(v || '').replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
const cmpVersion = (a, b) => { const x = partesVersion(a); const y = partesVersion(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const versionValida = (v) => /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(String(v || ''));
const tagValido = (t) => typeof t === 'string' && /^[A-Za-z0-9._@/][A-Za-z0-9._@/-]*$/.test(t) && !t.includes('..');
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = function (ctx) {
  const { ROOT, git } = ctx;

  // ---------- RELEASE POR APP (#131) ----------
  // En un monorepo (.faro.json > monorepo, ver lib/apps.js) cada app tiene SU version (package.json),
  // SU CHANGELOG.md y SU tag ('{app}@{version}' por defecto). Las funciones de abajo aceptan un
  // argumento 'app' opcional (id o el objeto App de lib/apps.js): sin el, se comportan EXACTAMENTE
  // como antes (raiz del repo, tag 'v<version>'), que es lo que usan el repo simple y el motor.
  const appDe = (app) => {
    if (!app) return null;
    if (typeof app === 'object') return app;
    return appsLib.apps(ROOT).find((a) => a.id === app) || null;
  };
  const changelogRel = (a) => (a ? `${a.ruta}/CHANGELOG.md` : 'CHANGELOG.md');
  const leerChangelog = (a) => {
    if (a && !a.ruta) return null;
    try { return fs.readFileSync(path.join(ROOT, changelogRel(a)), 'utf8'); } catch { return null; }
  };
  // SEGURIDAD (revision de #140): la version y la plantilla del tag son datos del REPO y el tag va como
  // argumento posicional a 'git tag'. Un valor que empiece por '-' git lo tomaria como OPCION
  // ('--force'). Sin shell no es inyeccion de comandos, pero si de argumentos: se valida antes y, si
  // no pasa, no se llama a git. Vale para el repo simple ('v<version>') y para las apps.
  const tagDeVersion = (version, a) => {
    if (!versionValida(version)) return null;
    const tag = a ? appsLib.tagDe(ROOT, a.id, version) : `v${version}`;
    return tagValido(tag) ? tag : null;
  };
  const motivoTagInvalido = (version, a) => (!versionValida(version)
    ? `La version '${version}'${a ? ` de '${a.id}' (${a.ruta}/package.json)` : ''} no es SemVer (X.Y.Z) — no se tagea; corrigela.`
    : `El tag que sale de la plantilla de .faro.json > monorepo.tag para '${a ? a.id : 'la raiz'}' no es un nombre de tag valido (solo [A-Za-z0-9._@/-], sin empezar por '-') — no se tagea; corrige la plantilla.`);

  // Version publicada: package.json (CLI/paquete npm) manda; si no existe, .claude-plugin/plugin.json
  // en la RAIZ (repo de un solo plugin). Si ninguno existe, puede ser un repo MARKETPLACE (el plugin
  // vive anidado en plugins/<nombre>/.claude-plugin/plugin.json, p. ej. este mismo repo) — se busca
  // ahi como ultimo recurso, y solo si hay EXACTAMENTE UNO (con varios, cual tagear es ambiguo: se
  // devuelve null en vez de adivinar).
  function versionActual(app) {
    if (app) { const a = appDe(app); return (a && a.version) || null; }
    for (const rel of ['package.json', path.join('.claude-plugin', 'plugin.json')]) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        if (j.version) return j.version;
      } catch { /* sigue con el siguiente candidato */ }
    }
    try {
      const pluginsDir = path.join(ROOT, 'plugins');
      const subs = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      const versiones = [];
      for (const d of subs) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(pluginsDir, d.name, '.claude-plugin', 'plugin.json'), 'utf8'));
          if (j.version) versiones.push(j.version);
        } catch { /* este subdirectorio no es un plugin con manifest */ }
      }
      if (versiones.length === 1) return versiones[0];
    } catch { /* no hay carpeta plugins/ */ }
    return null;
  }

  // Crea (o confirma) el tag vX.Y.Z sobre HEAD. NUNCA reescribe un tag existente que apunte a
  // OTRO commit — eso rompe a quien ya lo referencia; se avisa para que el usuario decida.
  // 'ref': QUE se etiqueta. publicar pasa la rama principal (#78): etiquetar HEAD dejaba el tag sobre la
  // rama a la que se volvia, no sobre lo publicado.
  // 'app' (opcional, #131): tagea la version de ESA app con la plantilla del monorepo.
  function tagVersionSiProcede(ref = 'HEAD', app) {
    const a = appDe(app);
    if (app && !a) return { ok: false, msg: `No existe la app '${app}' en el monorepo — nada que tagear.` };
    const version = versionActual(a);
    if (!version) return { ok: false, msg: a ? `La app '${a.id}' no declara version en ${a.ruta}/package.json — nada que tagear.` : 'No se encontro version en package.json, .claude-plugin/plugin.json, ni de forma no ambigua en plugins/*/.claude-plugin/plugin.json — nada que tagear.' };
    const tag = tagDeVersion(version, a);
    if (!tag) return { ok: false, tag: null, version, msg: motivoTagInvalido(version, a) };
    const existe = git('tag', '-l', tag);
    if (existe) {
      const tagCommit = git('rev-list', '-n', '1', tag);
      const head = git('rev-parse', ref);
      if (tagCommit === head) return { ok: true, tag, version, msg: `El tag ${tag} ya existe y apunta a este mismo commit — nada que hacer.` };
      return { ok: false, tag, version, msg: `El tag ${tag} ya existe y apunta a OTRO commit (${tagCommit ? tagCommit.slice(0, 7) : '?'}) — no lo reescribo. Si es un error de un release anterior, bórralo a mano (git tag -d ${tag} && git push origin :refs/tags/${tag}) y reintenta; si no, confirma con el usuario antes de forzarlo.` };
    }
    git('tag', '-a', tag, '-m', version, ref);
    return { ok: true, tag, version, msg: `Tag ${tag} creado sobre ${git('rev-parse', '--short', ref)}${ref !== 'HEAD' ? ` (${ref})` : ''}.` };
  }

  // Coherencia CHANGELOG <-> version, ANTES de aprobar (0.29.0): sin esto, 'aprobar' tageaba
  // la version que hubiera en package.json/plugin.json aunque el CHANGELOG no dijera nada de
  // ella — el tag, la version y el CHANGELOG dejaban de describir el mismo cambio (justo lo que
  // skills/changelog/SKILL.md pide evitar, pero solo como instruccion, no como gate). Se comprueba
  // ANTES del merge develop -> main en cmdPublicar: si falta, se cancela sin tocar main.
  function changelogTieneVersion(app) {
    const a = appDe(app);
    const version = versionActual(a);
    // POR APP (#131): la version de la app, en el CHANGELOG de la app. Sin version, no aplica.
    if (a) {
      if (!version) return { ok: true, version: null, msg: `La app '${a.id}' no declara version: la coherencia CHANGELOG<->version no aplica, y no se creara tag.` };
      const cl = leerChangelog(a);
      if (!cl) return { ok: false, version, msg: `No hay ${changelogRel(a)} — falta la entrada de la version ${version} de '${a.id}' antes de publicar (corre /faro:changelog para esa app).` };
      if (!reEncabezadoVersion(version).test(cl)) return { ok: false, version, msg: `${changelogRel(a)} no tiene una entrada '## ${version}' — corre /faro:changelog para '${a.id}' antes de publicar (la version y el CHANGELOG de la app deben decir lo mismo).` };
      return { ok: true, version };
    }
    // SIN VERSION el chequeo NO APLICA, no bloquea: un repo de GESTION/DOCUMENTACION (la raiz
    // autonoma de un trabajo, sin package.json ni plugin.json porque no es un paquete ni un plugin)
    // no publica ninguna version, asi que no puede haber incoherencia entre una version y el
    // CHANGELOG. Antes se devolvia ok:false con el mensaje "nada que comprobar", que se contradecia
    // a si mismo y CANCELABA la aprobacion entera de esos repos. tagVersionSiProcede ya trataba bien
    // este caso (no tagea); el gate no.
    if (!version) return { ok: true, version: null, msg: 'Sin version en el repo (no es un paquete ni un plugin): la coherencia CHANGELOG<->version no aplica, y no se creara tag.' };
    let changelog = null;
    try { changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'); } catch {}
    if (!changelog) return { ok: false, version, msg: `No hay CHANGELOG.md en el repo — falta la entrada de la version ${version} antes de aprobar (corre /faro:changelog).` };
    if (!reEncabezadoVersion(version).test(changelog)) return { ok: false, version, msg: `CHANGELOG.md no tiene una entrada '## ${version}' — corre /faro:changelog antes de aprobar (la version y el CHANGELOG deben decir lo mismo).` };
    return { ok: true, version };
  }

  // notasDeVersion: el bloque del CHANGELOG de UNA version, sin arrastrar la siguiente. Es la fuente
  // de las notas del Release en la forja: la MISMA entrada que el gate de coherencia ya exigio, asi
  // que el Release no puede divergir del CHANGELOG (no hay dos fuentes que mantener).
  // 'app' (opcional, #131): del CHANGELOG de esa app, no del de la raiz.
  function notasDeVersion(version, app) {
    if (!version) return null;
    const a = app ? appDe(app) : null;
    if (app && !a) return null;
    const changelog = leerChangelog(a);
    if (!changelog) return null;
    const ini = changelog.search(reEncabezadoVersion(version));
    if (ini < 0) return null;
    const resto = changelog.slice(ini);
    const finRel = resto.slice(1).search(/^##\s+/m);   // slice(1): no encontrarse a si misma
    const bloque = finRel < 0 ? resto : resto.slice(0, finRel + 1);
    // Fuera la cabecera '## <version> — <fecha>': el Release ya muestra version y fecha por su cuenta.
    // \r?\n: el CHANGELOG de un repo en Windows viene con CRLF, y '.*\n' NO casa ahi — la cabecera
    // se colaba en las notas del Release (visto al publicar la 0.34.0).
    return bloque.replace(/^##\s+.*\r?\n/, '').trim() || null;
  }

  // agruparCambios: clasificacion DURA a partir de los commits del rango (el CHANGELOG cuenta el POR
  // QUE, que lo escribe una persona; los prefijos convencionales dicen QUE CLASE de cambio es). Se
  // excluye el ruido de proceso: el commit de release y los merges de integracion no son cambios.
  function agruparCambios(tagAnterior) {
    const rango = tagAnterior ? `${tagAnterior}..HEAD` : 'HEAD';
    const crudo = git('log', '--format=%s%n%b', rango) || '';
    const out = { features: [], correcciones: [], otros: [] };
    for (const linea of crudo.split('\n')) {
      const s = linea.trim();
      if (!s) continue;
      if (/^(chore\(release\)|merge )/i.test(s)) continue;          // ruido de proceso
      const m = s.match(/^(feat|fix|docs|refactor|perf|test|chore|build|ci)(\([^)]*\))?!?:\s*(.+)$/i);
      if (!m) continue;
      const texto = m[3].trim();
      const tipo = m[1].toLowerCase();
      if (tipo === 'feat') out.features.push(texto);
      else if (tipo === 'fix') out.correcciones.push(texto);
      else out.otros.push(texto);
    }
    return out;
  }

  // tareasCerradas: los issues que el trabajo de este rango referencia ('Closes #42', '(#42)'). Es el
  // MISMO dato que cierra el issue en la forja, asi que las notas dicen que tareas entraron sin que
  // nadie las liste a mano. Solo cuenta '#<numero>': un '30 segundos' no es una referencia.
  function tareasCerradas(tagAnterior) {
    const rango = tagAnterior ? `${tagAnterior}..HEAD` : 'HEAD';
    const crudo = git('log', '--format=%s%n%b', rango) || '';
    const vistos = new Set();
    for (const m of crudo.matchAll(/#(\d+)\b/g)) vistos.add(Number(m[1]));
    return [...vistos];
  }

  // Tags de UNA app segun la plantilla de .faro.json > monorepo.tag: [{tag, version}] de mayor a menor.
  function tagsDeApp(app) {
    const a = appDe(app);
    if (!a) return [];
    const MARCA = '\u0000';
    const plantilla = appsLib.tagDe(ROOT, a.id, MARCA);
    if (!plantilla) return [];
    const [pre, post = ''] = plantilla.split(MARCA);
    const re = new RegExp(`^${escRe(pre)}(\\d+\\.\\d+\\.\\d+[0-9A-Za-z.+-]*)${escRe(post)}$`);
    const out = [];
    for (const t of (git('tag', '-l') || '').split('\n').map((x) => x.trim()).filter(Boolean)) {
      const m = t.match(re);
      // tagValido: el tag acaba como inicio del rango '<tag>..<ref>' de git log; solo nombres seguros.
      if (m && tagValido(t)) out.push({ tag: t, version: m[1] });
    }
    return out.sort((x, y) => cmpVersion(y.version, x.version));
  }
  function ultimoTagDeApp(app) { return tagsDeApp(app)[0] || null; }

  // Commits que tocan la carpeta de la app desde SU ultimo tag hasta 'ref'. Los tags se crean en el
  // merge de main (#116), y ese merge alcanza todos los commits de develop que entraron en el: asi
  // 'tag..develop' (o 'tag..main' tras el merge) excluye lo ya publicado. Sin tag previo, todo lo que
  // haya tocado la app.
  function cambiosDeApp(app, ref = 'HEAD') {
    const a = appDe(app);
    if (!a || !a.ruta) return [];
    const ult = ultimoTagDeApp(a);
    const rango = ult ? `${ult.tag}..${ref}` : ref;
    const log = git('log', rango, '--no-merges', '--pretty=%s', '--', a.ruta) || '';
    return log.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  // PLAN de release por app: que app cambio, desde que tag, que version toca y si esta lista.
  // estado: 'sin-cambios' (no se toca) · 'sin-version' (su package.json no tiene version: no se tagea)
  //       · 'ya-tageada' (hay cambios pero su version ya tiene tag: falta subirla) · 'sin-changelog'
  //       (la version no esta en SU CHANGELOG: bloquea) · 'lista' (se tagea y se publica su Release).
  // Repo simple (sin .faro.json > monorepo): [] — nada cambia para el.
  function planApps(ref = 'HEAD') {
    if (!appsLib.esMonorepo(ROOT)) return [];
    const out = [];
    for (const a of appsLib.apps(ROOT)) {
      if (!a.existe || !a.ruta) continue;
      const ult = ultimoTagDeApp(a);
      const commits = cambiosDeApp(a, ref);
      const acumulado = ciclo.leerUnreleased(leerChangelog(a) || '');
      const tag = a.version ? tagDeVersion(a.version, a) : null;
      let estado;
      if (!commits.length) estado = 'sin-cambios';
      else if (!a.version) estado = 'sin-version';
      else if (!tag) estado = 'version-invalida';   // version no SemVer o plantilla que no da un tag valido: nunca llega a git
      else if (git('tag', '-l', tag)) estado = 'ya-tageada';
      else if (!changelogTieneVersion(a).ok) estado = 'sin-changelog';
      else estado = 'lista';
      // Version propuesta: la declarada si aun no tiene tag; si no, el salto por contenido (#69).
      const an = commits.length ? ciclo.analizarRelease({ ultimoTag: ult ? ult.version : null, commits, unreleased: acumulado, versionActual: a.version || '0.0.0' }) : null;
      out.push({
        app: a, estado, version: a.version, tag, desde: ult ? ult.tag : null, commits,
        sugerida: an ? an.sugerida : null, razon: an ? an.razon : null, acumulado,
      });
    }
    return out;
  }

  // Coherencia version <-> CHANGELOG <-> tag POR APP, antes del merge a main. 'errores' cancela la
  // publicacion (igual que en la raiz: no se tagea una version sin documentar); 'avisos', no.
  function coherenciaApps(ref = 'HEAD') {
    const errores = [];
    const avisos = [];
    for (const p of planApps(ref)) {
      if (p.estado === 'sin-changelog') errores.push(changelogTieneVersion(p.app).msg);
      else if (p.estado === 'version-invalida') errores.push(motivoTagInvalido(p.version, p.app));
      else if (p.estado === 'ya-tageada') avisos.push(`${p.app.id}: ${p.commits.length} cambio(s) desde ${p.desde || 'el inicio'} pero su version ${p.version} ya esta tageada (${p.tag}) — no se publica; sube su version (sugerida ${p.sugerida}) con /faro:changelog.`);
      else if (p.estado === 'sin-version') avisos.push(`${p.app.id}: ${p.commits.length} cambio(s) pero ${p.app.ruta}/package.json no declara version — no se tagea.`);
    }
    return { ok: errores.length === 0, errores, avisos };
  }

  // Tras el merge a main: un tag por app LISTA, sobre 'ref'. Las apps sin cambios no se tocan.
  function tagearApps(ref = 'HEAD') {
    return planApps(ref).filter((p) => p.estado === 'lista').map((p) => ({ app: p.app, ...tagVersionSiProcede(ref, p.app) }));
  }

  // Tags 'v<version>' en un monorepo cuya raiz NO declara version: son de antes del modo monorepo y
  // no identifican ninguna app. Se informan (ambiguos) y se ignoran para la release por app; no se borran.
  function tagsHeredados() {
    if (!appsLib.esMonorepo(ROOT) || versionActual()) return [];
    return (git('tag', '-l', 'v[0-9]*') || '').split('\n').map((t) => t.trim()).filter(Boolean).sort(cmpVersion);
  }

  return { versionActual, tagVersionSiProcede, changelogTieneVersion, notasDeVersion, agruparCambios, tareasCerradas, tagsDeApp, ultimoTagDeApp, cambiosDeApp, planApps, coherenciaApps, tagearApps, tagsHeredados };
};
