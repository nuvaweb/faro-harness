// lib/digestion.js — CICLO DE DIGESTION: fuentes/ -> funcional + requisitos + cambios (cierra el lazo de vuelta).
// Practica de industria: fuentes/ es el "project mandate" (PRINCE2) — la peticion en bruto que luego se
// formaliza; el registro de requisitos con estado + trazabilidad requisito<->cambio/tarea es la RTM
// (requirements traceability matrix, IEEE 29148 / Jama / DOORS) en version git-nativa y ligera.
// Tres piezas, todas recalculadas EN CADA ITERACION (session/validate/estado-json):
// 1) SEÑAL fuentes sin digerir: material en fuentes/ POSTERIOR a la ultima revision del funcional y de
//    ESTADO.md (espejo inverso de frescura.js: alli docs mas viejos que su fuente; aqui fuentes mas
//    nuevas que su digestion). NUNCA bloquea: dispara la DIRECTIVA para que el AGENTE orqueste.
// 2) REGISTRO DE REQUISITOS (gestion/requisitos.md): '## REQ-NN · <nombre>' + estado/origen — mismo
//    patron validable que kpis.md. El formato es ERROR (gate de validate); la trazabilidad es AVISO.
// 3) TRAZABILIDAD: requisito aceptado/en-cambio debe estar citado (REQ-NN) en un cambio spec-driven o
//    en una tarea de ESTADO.md — la red que evita que un requisito "se le escape" al gestor tecnico.
'use strict';
module.exports = function (ctx) {
  const { fs, path, ROOT, SP, NO_INSTANCIA, ESTADO_FILE, CHANGES_DIR, FUENTES, git, parseEstado, funcionalPath, walkFiles } = ctx;

  const REQS_FILE = `${SP}/requisitos.md`;
  const REQ_ESTADOS = ['propuesto', 'aceptado', 'en-cambio', 'entregado', 'descartado'];
  const REQ_FIELDS = ['estado', 'origen'];

  // ts (ms) del ultimo commit que toco una ruta; 0 = sin historia (misma tecnica que frescura.js).
  const commitTs = (rel) => {
    const out = git('log', '-1', '--format=%ct', '--', rel);
    return out ? Number(out) * 1000 : 0;
  };
  const dia = (ts) => new Date(ts).toISOString().slice(0, 10);

  // Fuente "legible" = texto que el agente puede digerir directo; el resto (pdf/docx/audio…) son
  // BINARIAS: se les pide UNA VEZ un extracto hermano '<fichero>.extracto.md' y desde entonces el
  // extracto las representa (las iteraciones siguientes leen el MD, no re-procesan el binario).
  const esLegible = (name) => /\.(md|markdown|txt)$/i.test(name);

  // Fuentes POSTERIORES a la ultima revision del funcional/ESTADO.md. Una fuente recien soltada
  // (aun sin commit) cuenta por su mtime: es justo el momento en que la señal mas importa.
  function fuentesSinDigerir() {
    if (NO_INSTANCIA) return [];
    const fun = funcionalPath();
    const baseTs = Math.max(fun ? commitTs(fun) : 0, commitTs(ESTADO_FILE));
    if (!baseTs) return []; // sin linea base en git no se inventa nada
    const files = walkFiles(FUENTES);
    const rutas = new Set(files.map((f) => f.rel));
    const out = [];
    for (const f of files) {
      if (rutas.has(`${f.rel}.extracto.md`)) continue; // binaria ya extractada: la representa su extracto
      const ts = commitTs(f.rel) || f.mtime.getTime();
      if (ts > baseTs) out.push({ rel: f.rel, ts, binaria: !esLegible(f.name) });
    }
    return out.sort((a, b) => b.ts - a.ts);
  }

  // Señal + directiva de sesion: el AGENTE orquesta la digestion (lee, extrae, confirma, reparte a
  // las carpetas correctas); el harness solo la detecta y luego la verifica en validate.
  function digestionLines(max = 5) {
    let pend;
    try { pend = fuentesSinDigerir(); } catch { return []; }
    if (!pend.length) return [];
    return [
      `FUENTES SIN DIGERIR (${pend.length}) — material en ${FUENTES}/ posterior a la ultima revision del funcional/${ESTADO_FILE} (señal, no bloquea):`,
      ...pend.slice(0, max).map((f) => `- ${f.rel} (${dia(f.ts)})`),
      ...(pend.length > max ? [`- (+${pend.length - max} mas)`] : []),
      'DIRECTIVA DE DIGESTION (la orquestas TU iterando con el usuario — o lanza el agente gestor-requisitos; el harness verifica): ' +
        '1) LEE lo nuevo y EXTRAE requisitos, decisiones, riesgos y fechas mencionadas; 2) presentaselo al usuario para CONFIRMAR; ' +
        `3) aplica en un gesto: requisitos al registro ${REQS_FILE} ('## REQ-NN · <nombre>' + estado/origen citando la fuente) · ` +
        'el funcional sube version citando la fuente · lo sustantivo abre cambio spec-driven (/faro:cambio) · riesgos al RAID (agente gestor-riesgos) · ' +
        `si cambian alcance/fechas: ${ESTADO_FILE} + ADR de una linea. La señal se apaga sola al committear el funcional/${ESTADO_FILE} DESPUES de la fuente.`,
      ...(pend.some((f) => f.binaria)
        ? [`FUENTES BINARIAS (pdf/docx/audio…): antes de digerirlas genera UNA VEZ su extracto hermano '<fichero>.extracto.md' (mismo directorio, resumen fiel + citas literales clave) y digiere el extracto — las proximas iteraciones leeran el MD sin re-procesar el binario (ahorro de recursos).`]
        : []),
    ];
  }

  // Registro de requisitos (gestion/requisitos.md) — mismo patron parseable que kpis.md.
  function parseRequisitos() {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, REQS_FILE), 'utf8'); } catch { return null; }
    const reqs = [];
    const re = /^##\s+(REQ-\d+)\s*[·:]\s*(.+)$/gm;
    let m;
    while ((m = re.exec(text))) reqs.push({ id: m[1], nombre: m[2].trim(), start: m.index });
    reqs.forEach((r, i) => {
      const seg = text.slice(r.start, i + 1 < reqs.length ? reqs[i + 1].start : text.length);
      r.campos = {};
      for (const f of REQ_FIELDS) {
        const mm = seg.match(new RegExp(`^[-*]\\s*${f}\\s*:\\s*(.+)$`, 'mi'));
        if (mm) r.campos[f] = mm[1].trim();
      }
    });
    return reqs;
  }

  // Errores de FORMATO (bloquean en validate); el registro es opcional: sin archivo no hay error.
  function requisitosIssues() {
    const reqs = parseRequisitos();
    if (reqs === null || !reqs.length) return [];
    const errs = [];
    const vistos = new Set();
    for (const r of reqs) {
      if (vistos.has(r.id)) errs.push(`${r.id} (${r.nombre}): id duplicado (debe ser unico).`);
      vistos.add(r.id);
      for (const f of REQ_FIELDS) if (!r.campos[f]) errs.push(`${r.id} (${r.nombre}): falta '${f}:'`);
      const e = (r.campos.estado || '').toLowerCase();
      if (e && !REQ_ESTADOS.includes(e)) errs.push(`${r.id} (${r.nombre}): estado '${r.campos.estado}' no reconocido (usa: ${REQ_ESTADOS.join('|')}).`);
    }
    return errs;
  }

  // Corpus donde un requisito puede estar CUBIERTO: tareas de ESTADO.md + cualquier .md de los
  // cambios spec-driven (proposal/tasks/deltas, activos y archivados).
  function corpusCobertura() {
    const partes = [];
    const ini = parseEstado();
    if (ini) partes.push(ini.fases.flatMap((f) => f.tareas.map((t) => t.text)).join('\n'));
    for (const f of walkFiles(CHANGES_DIR)) {
      if (!f.name.endsWith('.md')) continue;
      try { partes.push(fs.readFileSync(path.join(ROOT, f.rel), 'utf8')); } catch {}
    }
    return partes.join('\n');
  }

  // Trazabilidad (avisan, NO bloquean): la red del gestor tecnico.
  function trazabilidadWarns() {
    if (NO_INSTANCIA) return [];
    const reqs = parseRequisitos();
    if (reqs === null || !reqs.length) return [];
    const corpus = corpusCobertura();
    const warns = [];
    for (const r of reqs) {
      const e = (r.campos.estado || '').toLowerCase();
      if ((e === 'aceptado' || e === 'en-cambio') && !corpus.includes(r.id)) {
        warns.push(`${r.id} (${r.nombre}) esta '${e}' sin cambio ni tarea que lo cubra — abre el cambio (/faro:cambio), añade la tarea a la fase (citando ${r.id}) o replantea su estado.`);
      }
    }
    const ini = parseEstado();
    if (ini) {
      const abiertas = ini.fases.flatMap((f) => f.tareas).filter((t) => !t.done && !/REQ-\d+/.test(t.text));
      if (abiertas.length) warns.push(`${abiertas.length} tarea(s) abierta(s) en ${ESTADO_FILE} no citan ningun requisito (REQ-NN en el texto) — revisa si responden a un requisito registrado o son trabajo interno.`);
    }
    return warns;
  }

  // Resumen de sesion (espejo de kpiLines): estado del registro + requisitos sin cobertura.
  // opts.agregado (indice de sesion, #127): los requisitos sin cobertura en UNA linea con sus ids, en
  // vez de una linea casi identica por requisito (18 lineas = 3.600 caracteres en un repo real).
  function requisitosLines(opts = {}) {
    if (NO_INSTANCIA || !parseEstado()) return [];
    const reqs = parseRequisitos();
    if (reqs === null || !reqs.length) {
      // Arranque en un repo CON historia: las fuentes anteriores al funcional ya no señalan como
      // "sin digerir", pero sirven para rellenar el registro con lo YA acordado/entregado.
      const nFuentes = walkFiles(FUENTES).length;
      return [
        `Requisitos de negocio: sin registro (${REQS_FILE}) — al digerir fuentes, registra cada requisito como '## REQ-NN · <nombre>' con estado (${REQ_ESTADOS.join('|')}) y origen (la fuente que lo trajo). El harness valida el formato y avisa de aceptados sin cambio/tarea que los cubra.` +
          (nFuentes ? ` HAY ${nFuentes} fuente(s) historica(s) en ${FUENTES}/: ofrece al usuario una DIGESTION RETROSPECTIVA (agente gestor-requisitos) — leerlas junto al funcional/ESTADO, extraer los requisitos ya acordados con su estado REAL (entregado/aceptado/descartado) y rellenar el registro, para arrancar la trazabilidad con la historia completa.` : ''),
      ];
    }
    const por = {};
    for (const r of reqs) { const e = (r.campos.estado || '?').toLowerCase(); por[e] = (por[e] || 0) + 1; }
    const sinCob = trazabilidadWarns().filter((w) => /^REQ-/.test(w));
    if (opts.agregado) {
      const ids = sinCob.map((w) => w.split(' ')[0]);
      const MAX = 12;
      return [
        `Requisitos (${REQS_FILE}): ${reqs.length} — ${Object.entries(por).map(([e, n]) => `${e}: ${n}`).join(' · ')}.` +
          (ids.length ? ` TRAZABILIDAD: ${ids.length} sin cambio ni tarea que lo cubra: ${ids.slice(0, MAX).join(', ')}${ids.length > MAX ? ` (+${ids.length - MAX} mas)` : ''} — abre el cambio, cita el REQ en una tarea o replantea su estado (agente gestor-requisitos).` : ''),
      ];
    }
    return [
      `Requisitos (${REQS_FILE}): ${reqs.length} — ${Object.entries(por).map(([e, n]) => `${e}: ${n}`).join(' · ')}.` +
        (sinCob.length ? ` TRAZABILIDAD: ${sinCob.length} sin cobertura — atiendelos (agente gestor-requisitos):` : ''),
      ...sinCob.map((w) => `- ${w}`),
    ];
  }

  // Vista ESTRUCTURADA (estado-json): las mismas señales, como datos.
  function requisitosStats() {
    const reqs = parseRequisitos() || [];
    const por = {};
    for (const r of reqs) { const e = (r.campos.estado || '?').toLowerCase(); por[e] = (por[e] || 0) + 1; }
    return {
      total: reqs.length,
      por_estado: por,
      sin_cobertura: trazabilidadWarns().filter((w) => /^REQ-/.test(w)).map((w) => w.split(' ')[0]),
    };
  }

  return { fuentesSinDigerir, digestionLines, parseRequisitos, requisitosIssues, trazabilidadWarns, requisitosLines, requisitosStats };
};
