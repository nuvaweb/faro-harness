#!/usr/bin/env node
// specs.js — motor SPEC-DRIVEN NATIVO de FARO (MODULO SEPARADO; motor PROPIO, sin dependencias ni herramienta externa).
// Implementa el modelo completo de specs con RIGOR: specs VIVAS + DELTAS por cambio + ESCENARIOS verificables,
// Bilingue (ingles Y español) y sin dependencias: el vocabulario y las reglas son de FARO.
//
// MODELO:
//   specdriven/specs/<capacidad>/spec.md            <- spec VIVA (verdad actual): ## Purpose|Proposito +
//                                                    ## Requirements|Requisitos con bloques "### Requirement|Requisito: X"
//                                                    (texto normativo SHALL/MUST/DEBE) y ≥1 "#### Scenario|Escenario:".
//   specdriven/changes/<id>/specs/<cap>/spec.md     <- DELTAS del cambio: secciones "## ADDED|MODIFIED|REMOVED|RENAMED
//                                                    Requirements" (o AÑADIDOS|MODIFICADOS|ELIMINADOS|RENOMBRADOS).
//   archivar = aplicar deltas a las specs vivas (RENAMED -> REMOVED -> MODIFIED -> ADDED) + mover a changes/archive/.
//
// POLITICA DE GATE (progresiva, no rompe lo legado):
//   - change SIN specs/ (formato FARO legado proposal+tasks) -> AVISO (no bloquea); los cambios NUEVOS deben traer deltas.
//   - change CON specs/ -> se valida ESTRICTO (errores bloquean): texto normativo + ≥1 escenario + sin duplicados/conflictos.
'use strict';
const fs = require('fs');
const path = require('path');

// --- lexico bilingue ---
const RE_REQ_HEADER = /^###\s+(?:Requirement|Requisito)\s*:\s*(.+?)\s*$/;
const RE_SCEN_HEADER = /^####\s+(?:Scenario|Escenario)\s*:\s*(.+?)\s*$/;
const RE_NORMATIVE = /\b(SHALL|MUST|DEBE(?:RA|RÁ)?N?|OBLIGATORIO)\b/i;
const SECTION_ALIASES = {
  ADDED: /^##\s+(?:ADDED\s+Requirements|Requisitos\s+A(?:NADIDOS|ÑADIDOS))\s*$/i,
  MODIFIED: /^##\s+(?:MODIFIED\s+Requirements|Requisitos\s+MODIFICADOS)\s*$/i,
  REMOVED: /^##\s+(?:REMOVED\s+Requirements|Requisitos\s+ELIMINADOS)\s*$/i,
  RENAMED: /^##\s+(?:RENAMED\s+Requirements|Requisitos\s+RENOMBRADOS)\s*$/i,
};
const RE_PURPOSE = /^##\s+(?:Purpose|Prop(?:o|ó)sito)\s*$/i;
const RE_REQS_SECTION = /^##\s+(?:Requirements|Requisitos)\s*$/i;
const RE_RENAME_FROM = /^\s*-?\s*(?:FROM|DE)\s*:\s*`?###\s*(?:Requirement|Requisito)\s*:\s*(.+?)`?\s*$/i;
const RE_RENAME_TO = /^\s*-?\s*(?:TO|A)\s*:\s*`?###\s*(?:Requirement|Requisito)\s*:\s*(.+?)`?\s*$/i;
const RE_REMOVED_BULLET = /^\s*-\s*`?###\s*(?:Requirement|Requisito)\s*:\s*(.+?)`?\s*$/i;
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Mascara de code-fences (``` / ~~~): los encabezados dentro de un bloque de codigo NO cuentan.
function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (!open) { if (m) { open = { ch: m[1][0], len: m[1].length }; mask[i] = true; } continue; }
    mask[i] = true;
    const c = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
    if (c && c[1][0] === open.ch && c[1].length >= open.len) open = null;
  }
  return mask;
}

// Parsea un fichero de DELTAS: devuelve { added:[{name,text,scenarios}], modified:[...], removed:[nombres], renamed:[{from,to}], sections:{...} }.
function parseDeltaSpec(content) {
  // BOM UTF-8 (comun en editores Windows) rompe los regex de seccion anclados a inicio de linea (^##...).
  const lines = String(content).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const mask = fenceMask(lines);
  const out = { added: [], modified: [], removed: [], renamed: [], sections: { ADDED: false, MODIFIED: false, REMOVED: false, RENAMED: false } };
  let section = null;      // ADDED | MODIFIED | REMOVED | RENAMED | null
  let block = null;        // bloque de requirement en curso (para ADDED/MODIFIED)
  let renamePair = {};
  const closeBlock = () => { if (block && section && (section === 'ADDED' || section === 'MODIFIED')) out[section.toLowerCase()].push(block); block = null; };
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) { if (block) block.body.push(lines[i]); continue; }
    const line = lines[i];
    const sec = Object.keys(SECTION_ALIASES).find((k) => SECTION_ALIASES[k].test(line));
    if (sec) { closeBlock(); section = sec; out.sections[sec] = true; renamePair = {}; continue; }
    if (/^##\s+/.test(line)) { closeBlock(); section = null; continue; }   // otra seccion nivel-2 cualquiera
    if (!section) continue;
    if (section === 'REMOVED') { const b = line.match(RE_REMOVED_BULLET) || line.match(RE_REQ_HEADER); if (b) out.removed.push(b[1].trim()); continue; }
    if (section === 'RENAMED') {
      const f = line.match(RE_RENAME_FROM); const t = line.match(RE_RENAME_TO);
      if (f) renamePair.from = f[1].trim();
      else if (t) { renamePair.to = t[1].trim(); if (renamePair.from && renamePair.to) { out.renamed.push({ from: renamePair.from, to: renamePair.to }); renamePair = {}; } }
      continue;
    }
    // ADDED / MODIFIED: bloques "### Requirement: X" con cuerpo + escenarios
    const rh = line.match(RE_REQ_HEADER);
    if (rh) { closeBlock(); block = { name: rh[1].trim(), body: [], scenarios: 0 }; continue; }
    if (block) { if (RE_SCEN_HEADER.test(line)) block.scenarios++; block.body.push(line); }
  }
  closeBlock();
  for (const k of ['added', 'modified']) for (const b of out[k]) {
    // texto normativo = primeras lineas del cuerpo ANTES del primer escenario
    const upto = []; for (const l of b.body) { if (RE_SCEN_HEADER.test(l)) break; upto.push(l); }
    b.text = upto.join('\n').trim();
  }
  return out;
}

// Parsea una spec VIVA: { purpose, requirements: [{name, text, scenarios}] } o {error}.
function parseLivingSpec(content) {
  // BOM UTF-8 (comun en editores Windows) rompe los regex de seccion anclados a inicio de linea (^##...).
  const lines = String(content).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const mask = fenceMask(lines);
  let purpose = null, inPurpose = false, inReqs = false;
  const requirements = []; let block = null; const pl = [];
  const close = () => { if (block) { const upto = []; for (const l of block.body) { if (RE_SCEN_HEADER.test(l)) break; upto.push(l); } block.text = upto.join('\n').trim(); requirements.push(block); block = null; } };
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) { if (block) block.body.push(lines[i]); else if (inPurpose) pl.push(lines[i]); continue; }
    const line = lines[i];
    if (RE_PURPOSE.test(line)) { inPurpose = true; inReqs = false; continue; }
    if (RE_REQS_SECTION.test(line)) { inPurpose = false; inReqs = true; continue; }
    if (/^##\s+/.test(line)) { close(); inPurpose = false; inReqs = false; continue; }
    if (inPurpose) { pl.push(line); continue; }
    if (!inReqs) continue;
    const rh = line.match(RE_REQ_HEADER);
    if (rh) { close(); block = { name: rh[1].trim(), body: [], scenarios: 0 }; continue; }
    if (block) { if (RE_SCEN_HEADER.test(line)) block.scenarios++; block.body.push(line); }
  }
  close();
  purpose = pl.join('\n').trim();
  return { purpose, requirements };
}

module.exports = function (ctx) {
  const { ROOT, specBase } = ctx;
  // EARS: gramatica fija de la CONDICION del requisito. Carga perezosa para no pagarla cuando el
  // repo no tiene deltas que validar.
  let _ears;
  const earsMod = () => (_ears || (_ears = require('./ears.js')({ faroSchema: ctx.faroSchema || (() => null) })));
  // FUENTE DE RUTA UNICA: la base la manda paths.js via harness.js (specBase = 'gestion/cambios').
  // El motor NO la autodetecta; solo cae a un fallback (misma cascada que paths.js) si no se la pasan
  // (p. ej. invocacion suelta en tests). Asi motor y harness miran SIEMPRE la misma carpeta.
  const BASE = specBase
    || (fs.existsSync(path.join(ROOT, 'gestion/cambios')) ? 'gestion/cambios'
      : (fs.existsSync(path.join(ROOT, 'specdriven')) ? 'specdriven'
        : (fs.existsSync(path.join(ROOT, 'openspec')) ? 'openspec' : 'gestion/cambios')));
  const CHANGES = path.join(ROOT, BASE, 'changes');
  const SPECS = path.join(ROOT, BASE, 'specs');

  const listChanges = () => { try { return fs.readdirSync(CHANGES, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'archive').map((e) => e.name); } catch { return []; } };
  const deltaFiles = (id) => {
    const dir = path.join(CHANGES, id, 'specs'); const out = [];
    try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (!e.isDirectory()) continue; const f = path.join(dir, e.name, 'spec.md'); if (fs.existsSync(f)) out.push({ cap: e.name, file: f }); } } catch {}
    return out;
  };

  // Validacion ESTRICTA de los deltas de UN change (reglas de FARO, con lexico español e ingles).
  function validateChangeDeltas(id) {
    const errs = [], warns = [];
    const files = deltaFiles(id);
    if (!files.length) return { errs, warns, hasDeltas: false };
    let total = 0;
    for (const { cap, file } of files) {
      const p = parseDeltaSpec(fs.readFileSync(file, 'utf8'));
      const where = `${id}/specs/${cap}`;
      const seen = { ADDED: new Set(), MODIFIED: new Set(), REMOVED: new Set() };
      for (const kind of ['ADDED', 'MODIFIED']) {
        for (const b of p[kind.toLowerCase()]) {
          total++;
          const key = norm(b.name);
          if (seen[kind].has(key)) errs.push(`${where}: requisito duplicado en ${kind}: "${b.name}"`);
          seen[kind].add(key);
          if (!b.text) errs.push(`${where}: ${kind} "${b.name}" sin texto normativo (que DEBE hacer el sistema)`);
          else if (!RE_NORMATIVE.test(b.text)) errs.push(`${where}: ${kind} "${b.name}" — el texto debe ser NORMATIVO (usa DEBE/SHALL/MUST)`);
          else {
            // EARS: la condicion va DELANTE, con palabra fija. Ser normativo no basta — un requisito
            // que esconde el "si..." o el "cuando..." detras del DEBE no dice cuando aplica, y
            // entonces su escenario no se puede derivar. AVISA por defecto (adopcion gradual);
            // un repo puede exigirlo declarando enums.ears.modo = "gate" en su faro-schema.json.
            const ev = earsMod().clasificar(b.text);
            if (!ev.ok) {
              const linea = `${where}: ${kind} "${b.name}" — ${ev.motivo}${ev.sugerencia ? `. Forma EARS: ${ev.sugerencia}` : ''}`;
              (earsMod().modo() === 'gate' ? errs : warns).push(linea);
            }
          }
          if (b.scenarios < 1) errs.push(`${where}: ${kind} "${b.name}" necesita al menos un "#### Escenario:" (criterio verificable CUANDO/ENTONCES)`);
        }
      }
      for (const n of p.removed) { total++; const k = norm(n); if (seen.REMOVED.has(k)) errs.push(`${where}: duplicado en REMOVED: "${n}"`); seen.REMOVED.add(k); }
      for (const r of p.renamed) { total++; if (!r.from || !r.to) errs.push(`${where}: RENAMED incompleto (faltan DE:/A:)`); }
      // conflictos entre secciones (mismo requisito en dos operaciones)
      for (const k of seen.MODIFIED) { if (seen.REMOVED.has(k)) errs.push(`${where}: requisito en MODIFIED y REMOVED a la vez`); if (seen.ADDED.has(k)) errs.push(`${where}: requisito en ADDED y MODIFIED a la vez`); }
      for (const k of seen.ADDED) if (seen.REMOVED.has(k)) errs.push(`${where}: requisito en ADDED y REMOVED a la vez`);
      const hasSections = Object.values(p.sections).some(Boolean);
      if (hasSections && !(p.added.length + p.modified.length + p.removed.length + p.renamed.length)) warns.push(`${where}: secciones de delta declaradas pero VACIAS`);
      if (!hasSections) warns.push(`${where}: spec.md sin secciones de delta (## Requisitos AÑADIDOS / ## ADDED Requirements...)`);
    }
    if (total > 10) warns.push(`${id}: ${total} deltas — considera trocear el cambio (recomendado ≤10)`);
    if (!total) errs.push(`${id}: specs/ presente pero SIN deltas parseables — usa "### Requisito: <nombre>" + "#### Escenario:" bajo "## Requisitos AÑADIDOS" (o equivalentes en ingles)`);
    return { errs, warns, hasDeltas: total > 0 };
  }

  // Validacion de las specs VIVAS (specdriven/specs/*/spec.md).
  function validateLivingSpecs() {
    const errs = [];
    let dirs = [];
    try { dirs = fs.readdirSync(SPECS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return errs; }
    for (const cap of dirs) {
      const f = path.join(SPECS, cap, 'spec.md');
      if (!fs.existsSync(f)) continue;
      const s = parseLivingSpec(fs.readFileSync(f, 'utf8'));
      if (!s.purpose) errs.push(`specs/${cap}: falta "## Proposito" (o "## Purpose")`);
      if (!s.requirements.length) errs.push(`specs/${cap}: sin requisitos ("### Requisito: ...")`);
      for (const r of s.requirements) {
        if (!r.text || !RE_NORMATIVE.test(r.text)) errs.push(`specs/${cap}: "${r.name}" sin texto normativo (DEBE/SHALL/MUST)`);
        if (r.scenarios < 1) errs.push(`specs/${cap}: "${r.name}" sin escenarios`);
      }
    }
    return errs;
  }

  // Validacion GLOBAL para el gate `validate` del harness. RIGOR 100%:
  // - donde HAY deltas -> validacion estricta (texto normativo + escenario + sin conflictos);
  // - SIN specs = ERROR para todo cambio ya APROBADO (borrador aun se redacta -> solo aviso).
  // ¿el change declara EXENCION de spec? frontmatter 'sin_spec: true' (para cambios puramente
  // editoriales/organizativos que no tocan ninguna capacidad ni requisito del sistema).
  function exentoDeSpec(fm) {
    if (!fm) return false;
    const v = String(fm.sin_spec != null ? fm.sin_spec : (fm.sin_specs != null ? fm.sin_specs : '')).trim().toLowerCase();
    return v === 'true' || v === 'si' || v === 'sí' || v === 'yes';
  }

  function validateAll() {
    const errs = [], warns = [];
    for (const id of listChanges()) {
      const r = validateChangeDeltas(id);
      errs.push(...r.errs); warns.push(...r.warns);
      if (!r.hasDeltas && !r.errs.length) {
        const p = proposalFm(id);
        const fm = p && p.fm ? p.fm : null;
        const estado = fm ? fm.estado : null;
        if (exentoDeSpec(fm)) {
          // EXENTO: cambio marcado sin_spec (editorial/organizativo). Solo se avisa, no bloquea.
          warns.push(`${id}: sin deltas de spec, pero marcado 'sin_spec: true' (cambio editorial/organizativo) — OK, exento.`);
        } else if (estado && estado !== 'borrador') {
          errs.push(`${id}: cambio en estado '${estado}' SIN deltas de spec — todo cambio aprobado DEBE incluir ${BASE}/changes/${id}/specs/<capacidad>/spec.md con requisitos (DEBE...) y "#### Escenario:".`);
        } else {
          // SPEC SIEMPRE (endurecido): incluso en BORRADOR se exige el delta. Si el cambio de verdad no
          // toca ninguna capacidad (editorial/organizativo), marcalo con 'sin_spec: true' en el proposal.
          errs.push(`${id}: cambio SIN deltas de spec — TODO cambio debe traer su spec: crea ${BASE}/changes/${id}/specs/<capacidad>/spec.md con "### Requisito: ..." (texto DEBE/SHALL/MUST) y "#### Escenario:". Si es un cambio puramente editorial/organizativo que no toca ninguna capacidad, declara 'sin_spec: true' en el frontmatter de proposal.md.`);
        }
      }
    }
    errs.push(...validateLivingSpecs());
    return { errs, warns };
  }

  // Frontmatter minimo del proposal.md (estado / aprobada_por del ciclo de vida FARO).
  function proposalFm(id) {
    try {
      const t = fs.readFileSync(path.join(CHANGES, id, 'proposal.md'), 'utf8');
      const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/); const fm = {};
      if (m) for (const l of m[1].split(/\r?\n/)) { const mm = l.match(/^(\w+):\s*(.*)\s*$/); if (mm) fm[mm[1]] = mm[2].trim(); }
      return { fm, text: t };
    } catch { return null; }
  }
  // Estado de tasks.md del change: existe / total / hechas / marcadores [CLARIFICAR] pendientes.
  function tasksState(id) {
    let text; try { text = fs.readFileSync(path.join(CHANGES, id, 'tasks.md'), 'utf8'); } catch { return { exists: false, total: 0, done: 0 }; }
    const done = (text.match(/- \[x\]/gi) || []).length;
    const open = (text.match(/- \[ \]/g) || []).length;
    return { exists: true, total: done + open, done, open };
  }
  const clarifyIn = (id, file) => { try { return (fs.readFileSync(path.join(CHANGES, id, file), 'utf8').match(/\[(CLARIFICAR|NEEDS CLARIFICATION)\b/gi) || []).length; } catch { return 0; } };

  // Aplica los deltas de un change a las specs vivas (orden: RENAMED -> REMOVED -> MODIFIED -> ADDED) y archiva.
  // opts: dryRun (solo simula) · keep (SYNC: aplica los deltas a las specs vivas pero NO archiva el cambio).
  function archiveChange(id, { dryRun, keep } = {}) {
    const dir = path.join(CHANGES, id);
    if (!fs.existsSync(dir)) return { ok: false, msg: `No existe el cambio '${id}'.` };
    const v = validateChangeDeltas(id);
    if (v.errs.length) return { ok: false, msg: `Deltas con errores — arregla antes de archivar:\n- ${v.errs.join('\n- ')}` };
    // GATE DE CICLO DE VIDA (100% aplicado): no se archiva un cambio con el ciclo abierto.
    // Se salta con keep=SYNC (publicar specs sin cerrar) solo para el caso de larga vida.
    if (!keep) {
      const gate = [];
      const p = proposalFm(id);
      if (!p) gate.push(`falta proposal.md (el QUE del cambio)`);
      else {
        if (p.fm.estado !== 'implementada') gate.push(`la proposal esta en estado '${p.fm.estado || 'sin estado'}' — debe ser 'implementada' para cerrar`);
        if (!p.fm.aprobada_por) gate.push(`la proposal no tiene 'aprobada_por' (la identidad de quien aprobo)`);
      }
      const ts = tasksState(id);
      if (!ts.exists) gate.push(`no existe tasks.md (el plan) — un cambio sin tareas no se cierra`);
      else if (ts.total === 0) gate.push(`tasks.md sin tareas (checkboxes '- [ ]')`);
      else if (ts.done < ts.total) gate.push(`tasks.md incompleto: ${ts.done}/${ts.total} tareas hechas`);
      const clar = clarifyIn(id, 'proposal.md') + clarifyIn(id, 'tasks.md');
      if (clar) gate.push(`quedan ${clar} marcador(es) [CLARIFICAR] sin resolver`);
      if (gate.length) return { ok: false, msg: `CICLO ABIERTO — no se puede archivar '${id}':\n- ${gate.join('\n- ')}\nCierra el ciclo antes de archivar (o usa 'specs sync' para publicar specs sin cerrar).` };
    }
    const log = [];
    for (const { cap, file } of deltaFiles(id)) {
      const p = parseDeltaSpec(fs.readFileSync(file, 'utf8'));
      const liveFile = path.join(SPECS, cap, 'spec.md');
      const exists = fs.existsSync(liveFile);
      if (!exists && (p.modified.length || p.renamed.length)) return { ok: false, msg: `specs/${cap} no existe: una spec NUEVA solo admite requisitos AÑADIDOS (no MODIFIED/RENAMED).` };
      let live = exists ? parseLivingSpec(fs.readFileSync(liveFile, 'utf8')) : { purpose: '', requirements: [] };
      const find = (name) => live.requirements.findIndex((r) => norm(r.name) === norm(name));
      for (const r of p.renamed) { const i = find(r.from); if (i < 0) return { ok: false, msg: `specs/${cap}: RENAMED no encuentra "${r.from}".` }; if (find(r.to) >= 0) return { ok: false, msg: `specs/${cap}: RENAMED destino "${r.to}" ya existe.` }; live.requirements[i].name = r.to; log.push(`${cap}: renombrado "${r.from}" -> "${r.to}"`); }
      for (const n of p.removed) { const i = find(n); if (i < 0) { log.push(`${cap}: REMOVED "${n}" no existia (ignorado)`); continue; } live.requirements.splice(i, 1); log.push(`${cap}: eliminado "${n}"`); }
      for (const b of p.modified) { const i = find(b.name); if (i < 0) return { ok: false, msg: `specs/${cap}: MODIFIED no encuentra "${b.name}".` }; live.requirements[i] = { name: b.name, body: b.body, text: b.text, scenarios: b.scenarios }; log.push(`${cap}: modificado "${b.name}"`); }
      for (const b of p.added) { if (find(b.name) >= 0) return { ok: false, msg: `specs/${cap}: ADDED "${b.name}" ya existe (usa MODIFIED).` }; live.requirements.push({ name: b.name, body: b.body, text: b.text, scenarios: b.scenarios }); log.push(`${cap}: añadido "${b.name}"`); }
      if (!dryRun) {
        const purpose = live.purpose || `Spec de ${cap} (consolidada por FARO al archivar '${id}').`;
        const md = [`# ${cap}`, '', '## Proposito', '', purpose, '', '## Requisitos', '', ...live.requirements.flatMap((r) => [`### Requisito: ${r.name}`, ...(r.body || [r.text]), ''])].join('\n').replace(/\n{3,}/g, '\n\n');
        fs.mkdirSync(path.dirname(liveFile), { recursive: true });
        fs.writeFileSync(liveFile, md, 'utf8');
      }
    }
    if (!dryRun && !keep) {
      const archDir = path.join(CHANGES, 'archive');
      fs.mkdirSync(archDir, { recursive: true });
      // Convencion OpenSpec pura: changes/<slug>/ -> changes/archive/<slug>/ (SIN prefijo de fecha;
      // el historico temporal vive en el frontmatter del proposal y en git, no en el nombre de carpeta).
      // MOVIMIENTO ROBUSTO (Windows): renameSync sobre una carpeta falla con EPERM si algo la tiene
      // bloqueada (antivirus/indexador/handle abierto) y dejaba el archivado A MEDIAS (deltas aplicados,
      // carpeta sin mover). Reintentos cortos y, si persiste, copia+borrado (mismo resultado, sin lock).
      const dst = path.join(archDir, id);
      let movido = false, lastErr = null;
      for (let i = 0; i < 4 && !movido; i++) {
        try { fs.renameSync(dir, dst); movido = true; } catch (e) {
          lastErr = e;
          if (e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) {
            const hasta = Date.now() + 150 * (i + 1); while (Date.now() < hasta) { /* espera breve al lock */ }
          } else break;
        }
      }
      if (!movido) {
        try { fs.cpSync(dir, dst, { recursive: true, errorOnExist: false, force: true }); fs.rmSync(dir, { recursive: true, force: true }); movido = true; }
        catch (e) { throw lastErr || e; }
      }
      log.push(`cambio '${id}' archivado en ${BASE}/changes/archive/`);
    } else if (keep && !dryRun) log.push(`SYNC: deltas de '${id}' aplicados a las specs vivas; el cambio sigue ACTIVO.`);
    return { ok: true, msg: log.length ? log.join('\n') : 'Sin deltas que aplicar; cambio archivado.', log };
  }

  // Estado resumido para sesion / CLI `harness.js specs`.
  function resumen() {
    const lines = [];
    const changes = listChanges();
    const con = [], sin = [];
    for (const id of changes) (deltaFiles(id).length ? con : sin).push(id);
    lines.push(`Specs nativas FARO: ${changes.length} cambio(s) activo(s) — ${con.length} con deltas, ${sin.length} formato legado.`);
    if (sin.length) lines.push(`Sin deltas (añadelos en changes/<id>/specs/<capacidad>/spec.md): ${sin.join(', ')}`);
    let vivas = 0; try { vivas = fs.readdirSync(SPECS, { withFileTypes: true }).filter((e) => e.isDirectory()).length; } catch {}
    lines.push(`Specs vivas (${BASE}/specs/): ${vivas} capacidad(es).`);
    // Trazabilidad a la vista SIN bloquear: un requisito que nadie demuestra se olvida en silencio,
    // y el recuento es lo que mantiene la presion. El detalle, en 'specs evidencia'.
    const ev = contarEvidencia();
    if (ev.total) {
      lines.push(`Requisitos: ${ev.total} · demostrados ${ev.total - ev.sin.length}${ev.sin.length ? ` · ${ev.sin.length} SIN evidencia declarada (detalle: harness.js specs evidencia)` : ' (todos)'}.`);
    }
    return lines;
  }

  // Requisitos de las specs vivas y cuales no declaran (o rompen) su evidencia. Lo comparten el
  // resumen de sesion y el comando: una sola lectura de disco, un solo criterio.
  function contarEvidencia() {
    let dirs = [];
    try { dirs = fs.readdirSync(SPECS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
    const requisitos = [];
    for (const cap of dirs) {
      const f = path.join(SPECS, cap, 'spec.md');
      if (!fs.existsSync(f)) continue;
      try {
        for (const r of parseLivingSpec(fs.readFileSync(f, 'utf8')).requirements || []) {
          // 'body' (el bloque ENTERO), no 'text' (que parseLivingSpec corta en el primer
          // '#### Escenario:'). La linea 'Evidencia:' se escribe de forma natural DESPUES de los
          // escenarios —al final del requisito— y con 'text' no se veia nunca: el comando decia "sin
          // evidencia" con la evidencia escrita delante. Es la causa mas probable de que el propio
          // motor diera 47/47 sin demostrar teniendo los tests escritos.
          requisitos.push({ capacidad: cap, name: r.name, evidencia: require('./ciclo.js').evidenciaDeclarada((r.body || [r.text]).join('\n')) });
        }
      } catch {}
    }
    const sin = require('./ciclo.js').requisitosSinEvidencia(requisitos, (f) => fs.existsSync(path.join(ROOT, f)));
    return { total: requisitos.length, requisitos, sin };
  }

  function cmdSpecs() {
    const sub = process.argv[3];
    if (sub === 'archivar' || sub === 'archive' || sub === 'sync') {
      const id = process.argv[4];
      if (!id) { console.log(`Uso: harness.js specs ${sub} <cambio> [--dry-run]`); process.exit(1); }
      const r = archiveChange(id, { dryRun: process.argv.includes('--dry-run'), keep: sub === 'sync' });
      console.log(r.msg); if (!r.ok) process.exit(1);
      return;
    }
    // 'specs evidencia': ¿esta DEMOSTRADO lo que las specs vivas declaran? El resto de validaciones
    // miran que los documentos cuadren entre si; esta mira contra el CODIGO. Un requisito que ningun
    // test cita no esta demostrado — y nadie se entera hasta que se rompe.
    // Va aparte de 'validate' a proposito: un repo con specs maduras y sin tests aun veria su CI roto
    // de golpe, y eso empuja a borrar requisitos en vez de escribir tests.
    if (sub === 'evidencia') {
      const { total, sin } = contarEvidencia();
      if (!total) { console.log('Sin requisitos en las specs vivas: nada que demostrar todavia.'); return; }
      console.log(`Requisitos en specs vivas: ${total} · demostrados: ${total - sin.length}`);
      if (!sin.length) { console.log('✅ Todos los requisitos declaran evidencia y esa evidencia existe.'); return; }
      console.log(`\n⚠ ${sin.length}/${total} requisito(s) sin demostrar:`);
      for (const m of sin) console.log(`  - ${m}`);
      console.log(`\nDeclara la evidencia bajo el requisito, en su spec:  Evidencia: test/<fichero que lo demuestra>`);
      process.exit(1);
    }
    if (sub === 'ver' || sub === 'show') {
      const id = process.argv[4];
      if (!id) { console.log('Uso: harness.js specs ver <cambio> [--json]'); process.exit(1); }
      const files = deltaFiles(id);
      const model = { cambio: id, capacidades: files.map(({ cap, file }) => ({ capacidad: cap, ...parseDeltaSpec(fs.readFileSync(file, 'utf8')) })), validacion: validateChangeDeltas(id) };
      if (process.argv.includes('--json')) { console.log(JSON.stringify(model, null, 2)); return; }
      if (!files.length) { console.log(`'${id}': sin deltas de spec (formato legado proposal+tasks).`); return; }
      for (const c of model.capacidades) {
        console.log(`\n${c.capacidad}:`);
        for (const b of c.added) console.log(`  + AÑADIDO   ${b.name}  (${b.scenarios} escenario/s)`);
        for (const b of c.modified) console.log(`  ~ MODIFICADO ${b.name}  (${b.scenarios} escenario/s)`);
        for (const n of c.removed) console.log(`  - ELIMINADO ${n}`);
        for (const r of c.renamed) console.log(`  » RENOMBRADO ${r.from} -> ${r.to}`);
      }
      if (model.validacion.errs.length) { console.log('\nERRORES:\n- ' + model.validacion.errs.join('\n- ')); }
      return;
    }
    if (sub === 'validar' || sub === 'validate') {
      const { errs, warns } = validateAll();
      if (warns.length) console.log('Avisos:\n- ' + warns.join('\n- '));
      if (errs.length) { console.log('ERRORES:\n- ' + errs.join('\n- ')); process.exit(1); }
      console.log('Specs OK (rigor nativo FARO).');
      return;
    }
    console.log(resumen().join('\n'));
    console.log('\nSubcomandos: specs validar · specs ver <cambio> [--json] · specs archivar <cambio> [--dry-run] · specs sync <cambio>');
  }

  return { parseDeltaSpec, parseLivingSpec, validateChangeDeltas, validateLivingSpecs, validateAll, archiveChange, resumen, contarEvidencia, cmdSpecs };
};
