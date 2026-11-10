// lib/estado.js — iniciativa / faseo (ESTADO.md: parseo, funcional y validacion) (extraido de harness.js).
// Factory con CTX compartido: harness.js es el despachador; cada dominio vive en lib/<dominio>.js.
'use strict';
// MARCADOR DE GESTOR DE PROYECTOS (#72): '[cu:ID]' (historico, ClickUp), '[pm:ID]' y
// '[pm:<sistema>:ID]'. UN solo reconocedor para todos los sitios que leen o escriben el faseo: con
// uno por sitio, un '[pm:...]' hacia desaparecer la fase entera en silencio y se colaba en el nombre
// de la tarjeta (duplicandola). MARCA_PM_NC es la misma sin grupo, para meterla dentro de otras.
const MARCA_PM_NC = '\\[(?:cu|pm)(?::[a-z]\\w*)?:[\\w-]+\\]';
const MARCA_PM = '\\[(?:cu|pm)(?::[a-z]\\w*)?:([\\w-]+)\\]';
const RE_MARCA_PM = new RegExp(MARCA_PM);
const sinMarcaPm = (s) => String(s).replace(new RegExp(`\\s*${MARCA_PM_NC}\\s*`, 'g'), ' ').trim();
module.exports = function (ctx) {
  const { fs, path, ROOT, ESTADO_FILE, DOCS, REPORTING, TIPOS, VALID_STATES, ACTIVE_STATES, isDone, isActive, normEstado, listFiles, docsControlados } = ctx;


function parseFrontmatter(text) {
  const fm = {};
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      // Claves con guion ('superseded-by'): con \w+ se descartaban en silencio y validate avisaba en falso
      // de ADR sustituidas "sin superseded-by" que si lo declaraban (#110).
      const mm = line.match(/^([\w-]+):\s*(.*)\s*$/);
      // Quita comillas envolventes (' o ") — este parser es regex simple, no YAML: sin esto
      // clickup_list: "901524640938" se guardaria con las comillas y rompe la URL (/list/"123" -> invalid).
      if (mm) fm[mm[1]] = mm[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    }
  }
  return fm;
}

function informeExists(faseNum) {
  return listFiles(`${REPORTING}/informes`).some((f) => f.name.endsWith(`fase-${faseNum}-informe.md`));
}

let _ini;
// La cache es PRIVADA de este modulo: quien edite ESTADO.md en disco (el hook doc-check) necesita una
// via EXPLICITA para tirarla, o validaria la version anterior al cambio. Antes se hacia asignando
// `_ini = undefined` desde harness.js, que al moverse el codigo aqui dejo de existir alli (ReferenceError).
function invalidarEstado() { _ini = undefined; }
function parseEstado() {
  if (_ini !== undefined) return _ini;
  let text;
  try { text = fs.readFileSync(path.join(ROOT, ESTADO_FILE), 'utf8'); } catch { return (_ini = null); }

  const fm = parseFrontmatter(text);
  // Adaptativo: 'nombre:' es alias universal de 'iniciativa:' (un servicio Core no es una "iniciativa").
  if (!fm.iniciativa && fm.nombre) fm.iniciativa = fm.nombre;
  // Nomenclatura GENERICA del gestor (#72): 'pm_sistema' + 'pm_epica'. Mientras el unico adaptador sea
  // ClickUp, 'pm_epica' de un sistema clickup (o sin sistema declarado) es su 'clickup_epica': asi
  // todos los que leen la cabecera la entienden sin tocarlos. 'clickup_epica' sigue valiendo.
  if (fm.pm_epica && !fm.clickup_epica && (!fm.pm_sistema || /^clickup$/i.test(fm.pm_sistema))) fm.clickup_epica = fm.pm_epica;
  const fases = [];
  const re = new RegExp(`^###\\s+Fase\\s+(\\d+)\\s*[·:]\\s*(.+?)\\s*(?:—|--|-)\\s*(\\w+)\\s*(?:${MARCA_PM})?\\s*$`, 'gm');
  let m;
  while ((m = re.exec(text))) {
    fases.push({ num: Number(m[1]), nombre: m[2].trim(), estado: normEstado(m[3]), cuid: m[4] || null, start: m.index });
  }
  fases.forEach((f, i) => {
    const end = i + 1 < fases.length ? fases[i + 1].start : text.length;
    const seg = text.slice(f.start, end);
    // Fecha objetivo de la fase: una linea 'Objetivo: AAAA-MM-DD' (o '**Objetivo:** ...'). El parseo
    // en si no exige nada (solo lee lo que haya); la OBLIGATORIEDAD de que exista vive en
    // huecosDeFase (lib/ciclo.js), que audita el formato — aqui solo se extrae el dato.
    const om = seg.match(/^\**\s*Objetivo\**\s*:\**\s*(\d{4}-\d{2}-\d{2})/mi);
    f.objetivo = om ? om[1] : null;
    // DESCRIPCION de la fase: la prosa entre la cabecera y la primera tarea/subseccion. Es lo que
    // dice QUE TRAE la fase; sin ella la fase es un titulo y nadie sabe que se pretende.
    f.descripcion = seg.split('\n').slice(1)
      .filter((l) => !/^\s*-\s\[[ xX]\]/.test(l) && !/^#{1,4}\s/.test(l) && !/^\**\s*(Objetivo|Tareas|Hito)\**\s*:/i.test(l))
      .join('\n').trim();
    f.tareas = [];
    const tre = /^[ \t]*-\s\[( |x|X)\]\s+(.+)$/gm;
    let tm;
    while ((tm = tre.exec(seg))) {
      const raw = tm[2].trim();
      const cm = raw.match(RE_MARCA_PM); // marcador de enlace con el gestor (id de tarea): [cu:]/[pm:]
      const bm = raw.match(/\[bloq(?:ueada)?:\s*([^\]]+)\]/i); // marcador de BLOQUEO con motivo/riesgo
      const rm = raw.match(/\[resp:\s*([^\]]+)\]/i); // marcador de RESPONSABLE (git email) — alimenta metricas de gestion
      const txt = sinMarcaPm(raw)
        .replace(/\s*\[bloq(?:ueada)?:[^\]]+\]\s*/i, ' ')
        .replace(/\s*\[resp:[^\]]+\]\s*/i, ' ')
        .trim();
      const om = txt.match(/@([\w.-]+)/);
      // resp SOLO es valido si parece un email (algo@algo.tld); '[resp: pendiente]' u otro texto => SIN responsable.
      const respRaw = rm ? rm[1].trim() : null;
      const resp = respRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(respRaw) ? respRaw : null;
      f.tareas.push({ done: tm[1] !== ' ', text: txt, owner: om ? om[1] : null, resp, cuid: cm ? cm[1] : null, bloq: bm ? bm[1].trim() : null });
    }
    f.done = f.tareas.filter((t) => t.done).length;
    f.open = f.tareas.length - f.done;
    // DELEGA EN EL HITO: formato de /faro:migrar-tareas anterior a 0.52.1 — la fase sustituia sus
    // checkboxes por 'Tareas: ver hito...' (o 'Hito: #3'). Se sigue reconociendo para no romper las
    // fases CERRADAS que ya se migraron asi (validateEstado) y para ClickUp; en fases abiertas ya no
    // basta: el formato vigente es una linea '- [ ] #N · titulo — @quien' por issue.
    f.delegaEnHito = /^\s*(?:tareas\s*:.*\bhito\b|hito\s*:)/im.test(seg);
  });

  return (_ini = { fm, fases });
}

// Funcional FLEXIBLE (sin carpeta obligatoria). Resolucion en cascada:
// 1) frontmatter `funcional: <ruta>` de ESTADO.md (manda siempre);
// 2) cualquier DOCUMENTO CONTROLADO de tipo FUN (doc_id ...-FUN-NNN), este donde este en documentos/;
// 3) legado: primer .md de documentos/funcional/ (compatibilidad con repos antiguos).
function funcionalPath() {
  const ini = parseEstado();
  if (ini && ini.fm.funcional) return ini.fm.funcional;
  const fun = docsControlados().find((d) => /-FUN-\d+$/i.test(String(d.id)));
  if (fun) return fun.rel;
  const mds = listFiles(`${DOCS}/funcional`).filter((f) => f.name.endsWith('.md'));
  return mds.length ? mds[0].rel : null;
}
const funcionalExists = () => {
  const fp = funcionalPath();
  return Boolean(fp && fs.existsSync(path.join(ROOT, fp)));
};

function validateEstado() {
  const ini = parseEstado();
  const errs = [];
  if (!ini) {
    errs.push(
      `No existe ${ESTADO_FILE} — el faseo es OBLIGATORIO: crea ${ESTADO_FILE} con frontmatter ` +
      "(iniciativa, estado, fases_total, fase_actual, funcional) y una seccion '### Fase N · <nombre> — <estado>' " +
      'por fase, con tareas checkbox.',
    );
    return { ini: null, errs };
  }
  const { fm, fases } = ini;

  // El tipo es OPCIONAL y NUNCA bloquea: si esta declarado y el catalogo lo conoce, adapta las
  // exigencias; si no lo conoce (valores antiguos), se IGNORA en silencio — no se obliga a nadie
  // a cambiar su metadato ni el nombre del repo (agnostico: faro-<slug>).
  // dominio (departamento) del repo: LISTA CERRADA — se valida en clasificacionIssues() contra
  // faro-schema.json > enums.dominios (gate de sesion y de validate). El domain de cada DOCUMENTO
  // sigue libre (un repo puede albergar documentos de varios dominios).
  if (!fases.length) errs.push("Sin fases declaradas: anade al menos '### Fase 1 · <nombre> — pending'.");
  const total = Number.parseInt(fm.fases_total, 10);
  if (Number.isNaN(total)) errs.push('Falta fases_total en el frontmatter.');
  else if (total !== fases.length) errs.push(`fases_total=${fm.fases_total} pero hay ${fases.length} fase(s) declaradas.`);

  fases.forEach((f, i) => {
    if (f.num !== i + 1) errs.push(`Numeracion no secuencial: se esperaba Fase ${i + 1} y aparece Fase ${f.num}.`);
    if (!VALID_STATES.includes(f.estado)) errs.push(`Fase ${f.num}: estado '${f.estado}' invalido (usa ${VALID_STATES.join(' | ')}).`);
    // Cada fase lleva sus tareas como checkboxes, una linea por issue ('- [ ] #N · titulo — @quien'),
    // cuadrada con el hito: de ahi salen la contabilidad y el cruce con la forja (huecosDeFase,
    // contabilidadFase). 'Tareas: ver hito...' solo se tolera en fases CERRADAS — historico de
    // migraciones anteriores a 0.52.1, que no se reescribe. En una fase abierta no vale.
    if (f.done + f.open === 0 && !(f.delegaEnHito && isDone(f.estado))) errs.push(`Fase ${f.num} sin tareas: anade una linea por issue del hito de la fase en la forja ('- [ ] #N · titulo — @quien', '[x]' si esta cerrado) — ver /faro:migrar-tareas.`);
    if (isDone(f.estado) && f.open > 0) errs.push(`Fase ${f.num} esta 'done' pero tiene ${f.open} tarea(s) abiertas.`);
    if (isDone(f.estado) && !informeExists(f.num)) {
      errs.push(`Fase ${f.num} 'done' SIN informe: crea ${REPORTING}/informes/AAAA-MM-DD-fase-${f.num}-informe.md antes de cerrarla.`);
    }
  });

  const activas = fases.filter((f) => isActive(f.estado));
  if (activas.length > 1) errs.push(`Hay ${activas.length} fases activas (${ACTIVE_STATES.join('/')}); solo puede haber UNA.`);
  const fa = Number.parseInt(fm.fase_actual, 10);
  if (activas.length === 1 && fa !== activas[0].num) {
    errs.push(`fase_actual=${fm.fase_actual} no coincide con la fase activa (Fase ${activas[0].num}).`);
  }

  return { ini, errs };
}


  return { parseFrontmatter, informeExists, parseEstado, invalidarEstado, funcionalPath, funcionalExists, validateEstado, cerrarFaseEnTexto };
};

// ESCRITURA de ESTADO.md: cerrar una fase. Es lo PRIMERO que escribe el faseo — hasta ahora el
// harness solo leia (solo el onboarding lo creaba). Y ESTADO.md es la fuente de verdad del trabajo:
// una reescritura torpe (perder una tarea, romper el frontmatter) destruye el gobierno entero.
//
// Por eso se hace por LINEAS y se toca lo minimo: la cabecera de la fase y 'fase_actual'. Todo lo
// demas —tareas, checkbox, resumenes, descripciones, objetivos, el resto del frontmatter— se copia
// byte a byte. Es una funcion PURA sobre el texto para poder fijarla con tests; quien la llama se
// encarga de escribir en disco e invalidar la cache.
//
// 'siguiente' es el numero de la proxima fase abierta, o null si esta era la ultima: en ese caso
// 'fase_actual' se deja como estaba, no se inventa un numero que no existe.
function cerrarFaseEnTexto(texto, num, siguiente) {
  const lineas = String(texto).split('\n');
  // La cabecera admite '·' o ':', tres guiones distintos como separador, y un marcador de gestor
  // opcional al final ('[cu:...]' o '[pm:...]') que NO se puede perder (es el id de esa fase).
  const reCab = new RegExp(`^(###\\s+Fase\\s+${num}\\s*[·:]\\s*.+?\\s*(?:—|--|-)\\s*)(\\w+)(\\s*(?:${MARCA_PM_NC})?\\s*)$`);
  let encontrada = false;
  for (let i = 0; i < lineas.length; i++) {
    const m = lineas[i].match(reCab);
    if (!m) continue;
    lineas[i] = `${m[1]}done${m[3]}`;
    encontrada = true;
    break;   // solo la primera: dos fases con el mismo numero ya las rechaza validateEstado
  }
  if (!encontrada) return texto;   // fase inexistente: no se toca nada
  if (siguiente != null) {
    for (let i = 0; i < lineas.length; i++) {
      if (/^---\s*$/.test(lineas[i]) && i > 0) break;   // fin del frontmatter: fase_actual vive dentro
      const m = lineas[i].match(/^(fase_actual:\s*).*$/);
      if (m) { lineas[i] = `${m[1]}${siguiente}`; break; }
    }
  }
  return lineas.join('\n');
}
module.exports.cerrarFaseEnTexto = cerrarFaseEnTexto;
module.exports.RE_MARCA_PM = RE_MARCA_PM;
module.exports.MARCA_PM_NC = MARCA_PM_NC;
module.exports.sinMarcaPm = sinMarcaPm;
