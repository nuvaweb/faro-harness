// lib/tipos.js — tipologia: conciencia de QUE es esta instancia (tipo/clasificacion/metadato) (extraido de harness.js).
// Factory con CTX compartido: harness.js es el despachador; cada dominio vive en lib/<dominio>.js.
'use strict';
module.exports = function (ctx) {
  const { fs, path, ROOT, ESTADO_FILE, TIPOS, NO_INSTANCIA, parseEstado, faroSchema, dominiosValidos, docsControlados } = ctx;


// TIPO de la instancia: OPCIONAL. Fuentes (en orden): frontmatter 'tipo:' de ESTADO.md >
// metadato .faro.json ("tipo"). El NOMBRE del repo es AGNOSTICO (faro-<slug>) y NO clasifica.
// Si el tipo esta declarado, el harness ADAPTA sus exigencias (un servicio no se "cierra",
// un proyecto lleva fechas objetivo); si no, comportamiento generico sin pedirlo.
function tipoInfo() {
  const ini = parseEstado();
  const meta = templateMeta();
  const tipo = (ini && ini.fm.tipo) || meta.tipo || meta.type || null;
  return { tipo, fmTipo: tipo, def: (tipo && TIPOS[tipo]) || null };
}

// La clasificacion del repo vive en el METADATO: .faro.json + frontmatter de ESTADO.md,
// validada contra faro-schema.json.
const REPO_META = '.faro.json';
function templateMeta() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, REPO_META), 'utf8')); } catch {}
  return {};
}
// La clasificacion del repo se declara en el METADATO (.faro.json / ESTADO.md) por su
// DOMINIO (departamento) + el CONCEPTO que trabaja. La ENTIDAD (clase) ya NO la gestiona el harness:
// un documento puede corresponder a varias entidades -> se resuelve donde se usa, no aqui.
function clasificacion() {
  const meta = templateMeta();
  const ini = parseEstado();
  const fm = (ini && ini.fm) || {};
  const concepto = meta.concept || meta.concepto || fm.concept || fm.concepto || null;                     // a que CONCEPTO pertenece el trabajo
  const domain = meta.domain || fm.domain || fm.dominio || null;             // el DEPARTAMENTO (dominio) que lo gobierna
  const teams = Array.isArray(meta.teams) ? meta.teams : (Array.isArray(fm.teams) ? fm.teams : []);   // team(s) del REPO (para atribuir metricas), estampados por el wizard
  const fuente = (meta.concept || meta.concepto || meta.domain)
    ? REPO_META
    : (fm.concept || fm.concepto || fm.domain || fm.dominio) ? ESTADO_FILE : null;
  return { concepto, domain, teams, fuente };
}
// Clave de proyecto (doc_id CLAVE-TIPO-NNN): AVISO no bloqueante (no rompe validate) si no esta
// declarada explicitamente y el harness tuvo que DERIVARLA — pide al agente que PREGUNTE al
// usuario para fijarla en 'clave:' de ESTADO.md antes de que existan documentos con una clave
// derivada que luego no se pueda cambiar sin romper doc_id ya emitidos.
// COHERENCIA DE PERSONAS en ESTADO.md. Misma regla que en los documentos: quien LIDERA (owner)
// trabaja en el repo y se identifica por su login; quien PIDIO el trabajo (solicitante) suele ser
// de negocio, no tiene cuenta de GitHub, y su identificador es el CORREO CORPORATIVO. Ambos
// opcionales — pero si se declaran, tienen que identificar a alguien real: un placeholder aqui
// contamina despues el one-pager, el roadmap y todo el reporting, que leen estos campos.
function personasEstadoIssues() {
  const ini = parseEstado();
  if (!ini || !ini.fm) return [];
  const PLACEHOLDER = /^(equipo|team|tbd|pendiente|por definir|n\/?a|-+|desconocido)\b/i;
  const out = [];
  for (const rol of ['owner', 'solicitante']) {
    const v = ini.fm[rol];
    if (!v) continue;
    const s = String(v).trim();
    const esCorreo = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
    const esLogin = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(s);
    if (PLACEHOLDER.test(s) || (!esCorreo && !esLogin)) {
      out.push(`'${rol}: ${s}' en ${ESTADO_FILE} no identifica a una persona — login de GitHub (si trabaja en el repo) o correo corporativo (si es de negocio). Si no lo sabes, PREGUNTA al usuario; no lo rellenes.`);
    }
  }
  return out;
}

function claveIssues() {
  const ini = parseEstado();
  if (!ini || !ini.fm) return [];
  const { fm } = ini;
  const declarada = String(fm.clave || fm.key || '').trim();
  if (declarada) {
    // Formato: 4-10, empieza por letra (mismo contrato que CLAVE_RE en github.js). Con menos de 4 las
    // siglas chocan entre proyectos de la org (CP, API, GUI) y no se entienden en un doc_id suelto.
    const ok = /^[A-Za-z][A-Za-z0-9]{3,9}$/.test(declarada);
    if (!ok) return [
      `La 'clave: ${declarada}' de ${ESTADO_FILE} NO cumple el formato (4-10 caracteres, empieza por letra, solo A-Z0-9). ` +
      'Corrigela con `harness.js clave <CLAVE>` (comprueba ademas que no la use otro repo de la org) ANTES de emitir mas doc_id.',
    ];
    return [];
  }
  const hayDocs = docsControlados().length > 0;
  return [
    `Sin 'clave:' declarada en ${ESTADO_FILE} — el doc_id se está DERIVANDO del nombre (siglas). ` +
    `${hayDocs ? 'Ya hay documentos emitidos con esa clave derivada: ' : ''}` +
    "PREGUNTA al usuario (AskUserQuestion) qué clave corta (4-10 letras, estilo Jira) quiere fijar. Fijala con `harness.js clave <CLAVE>`, que ADEMAS comprueba que no la use otro repo: la clave es UNA POR REPO — si dos repos la comparten, ambos emiten los MISMOS doc_id (CLAVE-TIPO-001) y colisionan al juntar la documentacion. " +
    'Hazlo ANTES de generar mas documentos — cambiarla despues no reescribe los doc_id ya emitidos.',
  ];
}
function clasificacionIssues() {
  const s = faroSchema();
  if (!s || !s.enums) return [];
  const c = clasificacion();
  const errs = [];
  // El DOMINIO (departamento) del REPO es LISTA CERRADA del contrato (enums.dominios: areas + subareas).
  // Un departamento nuevo se anade PRIMERO al schema (cambio gobernado), nunca como texto libre en el
  // metadato. El domain de cada DOCUMENTO sigue libre (un repo puede albergar docs de varios dominios).
  const _doms = dominiosValidos();
  if (c.domain && _doms && !_doms.includes(String(c.domain).toLowerCase())) {
    errs.push(
      `domain '${c.domain}' no esta en el contrato (faro-schema.json > enums.dominios). ` +
      `Validos: ${_doms.join(', ')}. Un departamento nuevo se anade primero al schema, no al metadato.`,
    );
  }
  return errs;
}

// Contexto de sesion: clasificacion desde el metadato (dominio + concepto) + metadatos propios
// (clave de proyecto). Cada aviso es INDEPENDIENTE: la ausencia de uno no debe silenciar el otro.
function tipoLines() {
  if (NO_INSTANCIA) return [];
  if (!parseEstado()) return [];
  const c = clasificacion();
  const lines = [];
  // El TIPO es OPCIONAL y nunca se exige: si esta declarado y el catalogo lo conoce, el harness
  // ADAPTA sus exigencias; si no (valores antiguos o ausencia), comportamiento generico EN SILENCIO.
  if (!c.domain && !c.concepto) {
    lines.push(`Clasificacion SIN declarar: anade el 'domain' (DEPARTAMENTO que lo crea) al metadato (.faro.json o frontmatter de ${ESTADO_FILE}).`);
  } else {
    lines.push(`CLASIFICACION: ${c.domain ? `departamento ${c.domain}` : '(sin departamento)'}${c.concepto ? ` · concepto ${c.concepto}` : ''}${c.fuente ? ` (fuente: ${c.fuente})` : ''}`);
    lines.push(...clasificacionIssues().map((e) => `INCOHERENCIA: ${e}`));
  }
  lines.push(...claveIssues().map((e) => `METADATO: ${e}`));
  lines.push(...personasEstadoIssues().map((e) => `PERSONAS: ${e}`));
  return lines;
}


  return { tipoInfo, templateMeta, clasificacion, personasEstadoIssues, claveIssues, clasificacionIssues, tipoLines };
};
