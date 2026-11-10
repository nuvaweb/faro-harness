// lib/riesgos-ia.js — riesgos de IA frente al RIA y a ISO/IEC 42001 (#227). Solo lee ficheros locales.
//
// La iniciativa declara en el frontmatter de ESTADO.md si es (o usa) un sistema de IA:
//   ia: { riesgo: alto, rol: proveedor, iso42001: true }
// El RAID marca la obligacion que cubre cada fila con una etiqueta en cualquier celda: `RIA:art.14`.
// ISO/IEC 42001 vive en gestion/compliance/: iso42001-impacto.md (6.1.4) e iso42001-aplicabilidad.md
// (tabla control | aplica | justificacion). Clasificar el sistema es una decision humana y juridica:
// aqui solo se valida lo declarado.
'use strict';

const fs = require('fs');
const path = require('path');

const NIVELES = ['prohibido', 'alto', 'transparencia', 'minimo', 'no-aplica'];
// Calendario tras el Digital Omnibus (Reglamento (UE) 2026/1744).
const DESDE_ALTO = 'desde 2027-12-02 (anexo III) o 2028-08-02 (anexo I)';
const DESDE_ART50 = 'desde 2026-08-02';
const ALTO_RIESGO = [
  [9, 'gestion de riesgos'],
  [10, 'datos y gobernanza de datos'],
  [11, 'documentacion tecnica'],
  [12, 'registros (logs)'],
  [13, 'transparencia hacia el responsable del despliegue'],
  [14, 'supervision humana'],
  [15, 'precision, solidez y ciberseguridad'],
];

// Dependencias que delatan un sistema de IA (#232). Basta una para sugerir la declaracion.
const SDK_NPM = /^(@anthropic-ai\/|openai$|@azure\/openai$|@google\/(generative-ai|genai)$|@mistralai\/|cohere-ai$|groq-sdk$|ollama$|replicate$|ai$|@ai-sdk\/|langchain$|@langchain\/|llamaindex$|@huggingface\/|@aws-sdk\/client-bedrock|@tensorflow\/|onnxruntime)/;
const SDK_PY = /^(anthropic|openai|google-generativeai|google-genai|mistralai|cohere|groq|ollama|replicate|langchain[\w-]*|llama-index[\w-]*|transformers|torch|tensorflow|scikit-learn|onnxruntime|huggingface-hub)$/i;

// Solo nombres de paquete validos llegan al aviso: el texto lo lee el modelo (#234).
const NOMBRE_NPM = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const nombreNpm = (n) => n.length <= 100 && NOMBRE_NPM.test(n);

const leer = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const valor = (v) => String(v).trim().replace(/^['"]|['"]$/g, '');
const siONo = (v) => /^(true|si|sí|yes)$/i.test(valor(v || ''));

/** Declaracion IA del frontmatter de ESTADO.md -> { riesgo, rol, iso42001 } o null. */
function leerDeclaracion(texto) {
  const fm = (String(texto || '').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/) || [])[1];
  if (!fm) return null;
  const campos = {};
  const enLinea = fm.match(/^ia:\s*\{([^}]*)\}\s*$/m);
  if (enLinea) {
    for (const par of enLinea[1].split(',')) {
      const m = par.match(/^\s*([\w-]+)\s*:\s*(.*)$/);
      if (m) campos[m[1]] = valor(m[2]);
    }
  } else {
    const bloque = fm.match(/^ia:\s*\n((?:[ \t]+.*(?:\n|$))+)/m);
    if (!bloque) return null;
    for (const l of bloque[1].split('\n')) {
      const m = l.match(/^\s+([\w-]+)\s*:\s*(.*)$/);
      if (m) campos[m[1]] = valor(m[2]);
    }
  }
  if (!campos.riesgo) return null;
  return { riesgo: campos.riesgo.toLowerCase(), rol: campos.rol || null, iso42001: siONo(campos.iso42001) };
}

const articulosCubiertos = (raid) => new Set([...String(raid || '').matchAll(/\bRIA\s*:\s*art\.?\s*(\d+)/gi)].map((m) => Number(m[1])));

/** Evidencias de uso de IA en el repo (raiz, apps/*, packages/*): ['<fichero>: <dependencia>']. Solo lee ficheros. */
function detectarUsoIA(raiz) {
  const dirs = [''];
  for (const g of ['apps', 'packages']) {
    try { for (const d of fs.readdirSync(path.join(raiz, g), { withFileTypes: true })) if (d.isDirectory()) dirs.push(`${g}/${d.name}`); } catch { /* sin carpeta */ }
  }
  const ev = [];
  for (const d of dirs) {
    const rel = (f) => (d ? `${d}/${f}` : f);
    const pkg = leer(path.join(raiz, d, 'package.json'));
    if (pkg) {
      try {
        const j = JSON.parse(pkg);
        for (const n of Object.keys({ ...j.dependencies, ...j.devDependencies, ...j.peerDependencies })) if (nombreNpm(n) && SDK_NPM.test(n)) ev.push(`${rel('package.json')}: ${n}`);
      } catch { /* package.json roto: no es asunto de este aviso */ }
    }
    for (const f of ['requirements.txt', 'pyproject.toml']) {
      const t = leer(path.join(raiz, d, f));
      if (!t) continue;
      for (const m of t.matchAll(/(?:^|["'\s])([A-Za-z][\w.-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=~!]=?|["',]|$)/gm)) if (m[1].length <= 100 && SDK_PY.test(m[1])) ev.push(`${rel(f)}: ${m[1]}`);
    }
    for (const f of ['wrangler.toml', 'wrangler.jsonc', 'wrangler.json']) {
      const t = leer(path.join(raiz, d, f));
      if (t && (/^\s*\[ai\]/m.test(t) || /"ai"\s*:\s*\{/.test(t))) ev.push(`${rel(f)}: Workers AI`);
    }
  }
  return [...new Set(ev)];
}

/** Controles del anexo A marcados como excluidos sin justificacion. */
function excluidosSinJustificar(tabla) {
  const fuera = [];
  for (const l of String(tabla || '').split(/\r?\n/)) {
    const c = l.split('|').slice(1, -1).map((x) => x.trim());
    if (c.length < 2 || !/^A\.\d+(\.\d+)*$/.test(c[0])) continue;
    if (/^(no|excluido)$/i.test(c[1]) && !c[2]) fuera.push(c[0]);
  }
  return fuera;
}

/**
 * -> { errores, avisos }. rutas: estado (ESTADO.md), riesgos (gestion/risks.md), compliance (gestion/compliance).
 * raiz: si no hay declaracion, se busca uso de IA en las dependencias para sugerirla.
 * modo 'gate' (faro-schema enums.ria.modo) convierte los avisos en errores. `prohibido` es siempre error.
 */
function revisar({ estado, riesgos, compliance, raiz, modo = 'aviso' }) {
  const errores = [];
  const avisos = [];
  const decl = leerDeclaracion(leer(estado));
  if (!decl) {
    const ev = raiz ? detectarUsoIA(raiz) : [];
    if (ev.length) avisos.push(`El proyecto usa IA (${ev.slice(0, 3).join(', ')}${ev.length > 3 ? ', ...' : ''}) y ESTADO.md no declara 'ia:': lanza /faro:cumplimiento-ia para clasificarlo frente al RIA (o declara 'ia: { riesgo: no-aplica }').`);
    return { errores, avisos };
  }
  if (decl.riesgo === 'no-aplica') return { errores, avisos };
  if (!NIVELES.includes(decl.riesgo)) {
    avisos.push(`ESTADO.md declara 'ia.riesgo: ${decl.riesgo}', que no es un nivel del RIA: usa ${NIVELES.join(' | ')}.`);
  } else if (decl.riesgo === 'prohibido') {
    errores.push('ESTADO.md declara el sistema de IA como practica PROHIBIDA (RIA art. 5, aplica desde 2025-02-02): no puede desplegarse en la UE. Rediseña el sistema o revisa la clasificacion con asesoria juridica.');
  } else {
    const cubiertos = articulosCubiertos(leer(riesgos));
    if (decl.riesgo === 'alto') {
      for (const [n, que] of ALTO_RIESGO) {
        if (!cubiertos.has(n)) avisos.push(`Alto riesgo: falta en el RAID la ${que} (RIA art. ${n}, ${DESDE_ALTO}). Registra la fila con la etiqueta RIA:art.${n}.`);
      }
    }
    if (decl.riesgo === 'transparencia' && !cubiertos.has(50)) {
      avisos.push(`Transparencia: falta en el RAID la obligacion de informar de la interaccion con IA y marcar el contenido generado (RIA art. 50, ${DESDE_ART50}). Registra la fila con la etiqueta RIA:art.50.`);
    }
  }
  if (decl.iso42001 && compliance) {
    const impacto = path.join(compliance, 'iso42001-impacto.md');
    const aplic = path.join(compliance, 'iso42001-aplicabilidad.md');
    if (leer(impacto) === null) avisos.push(`ISO/IEC 42001: falta la evaluacion de impacto del sistema de IA (6.1.4) en ${path.basename(path.dirname(impacto))}/iso42001-impacto.md.`);
    const tabla = leer(aplic);
    if (tabla === null) avisos.push(`ISO/IEC 42001: falta la declaracion de aplicabilidad de los controles del anexo A en ${path.basename(path.dirname(aplic))}/iso42001-aplicabilidad.md (control | aplica | justificacion).`);
    else for (const id of excluidosSinJustificar(tabla)) avisos.push(`ISO/IEC 42001: el control ${id} esta excluido sin justificacion en iso42001-aplicabilidad.md.`);
  }
  if (modo === 'gate') return { errores: [...errores, ...avisos], avisos: [] };
  return { errores, avisos };
}

module.exports = { leerDeclaracion, detectarUsoIA, revisar, NIVELES };
