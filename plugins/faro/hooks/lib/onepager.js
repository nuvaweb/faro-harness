// lib/onepager.js — One-pager ejecutivo + Roadmap visual (extraido de harness.js).
// Factory con dependencias inyectadas (patron de modulos del motor: github.js, code.js...):
// el harness pasa sus utilidades compartidas; este modulo solo aporta la logica de la capacidad.
'use strict';
module.exports = function ({ fs, path, ROOT, SP, PRESENTACIONES, parseEstado, clasificacion, tipoInfo, parseKpis, plantillaMarca }) {

// Genera una PAGINA UNICA de decision (plantilla neutra FARO) desde ESTADO.md + risks.md + kpis.md.
// Estandar industria: RAG (semaforo) + A3 (una hoja) + OKR/Scorecard (KPIs con objetivo) + bloque
// "Decisiones para direccion". Adaptativo por tipo. NO inventa: lo que falta se marca pendiente.

// Parseo best-effort de la tabla RAID de gestion/risks.md (| Rn | Riesgo | Prob | Impacto | Mitig | Estado |).
function parseRisks() {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, `${SP}/risks.md`), 'utf8'); } catch { return null; }
  const risks = [];
  for (const ln of text.split(/\r?\n/)) {
    const t = ln.trim();
    if (!/^\|\s*R\d+\s*\|/.test(t)) continue;                      // solo filas de riesgo
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());  // sin bordes
    if (cells.length < 3) continue;
    const id = cells[0];
    const estado = (cells[cells.length - 1] || '').toLowerCase();
    // impacto = la celda MAS CORTA (a partir de la 3a) que sea muy alto/alto/medio/bajo (evita la prosa del riesgo)
    let impacto = '', best = 1e9;
    cells.forEach((c, i) => { if (i < 2) return; const mm = c.toLowerCase().match(/muy alto|alto|medio|bajo/); if (mm && c.length < best) { impacto = mm[0]; best = c.length; } });
    risks.push({ id, riesgo: cells[1] || '', impacto, mitig: cells.length >= 5 ? cells[cells.length - 2] : '', estado, raw: t });
  }
  return risks;
}
function _rank(s) { s = String(s || ''); return /muy alto/.test(s) ? 4 : /alto/.test(s) ? 3 : /medio/.test(s) ? 2 : /bajo/.test(s) ? 1 : 0; }
function _riskText(s, max) { max = max || 130; let t = String(s || '').replace(/\*\*/g, '').replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim(); const dot = t.indexOf('. '); if (dot > 20 && dot < max) t = t.slice(0, dot); if (t.length > max) t = t.slice(0, max - 1).trim() + '…'; return t; }
function _riskTag(r) { const s = (r.riesgo + ' ' + r.estado + ' ' + r.mitig).toLowerCase(); if (/ai act|cumplimiento|gdpr|rgpd|\bpii\b|legal|art\.?\s*5/.test(s)) return 'cumplimiento'; if (/bloquea|bloqueado/.test((r.estado || '').toLowerCase())) return 'bloqueado'; if (/muy alto/.test(r.impacto)) return 'muy alto'; if (/alto/.test(r.impacto)) return 'alto'; return r.impacto || 'riesgo'; }
function _riskWho(r) { const m = (r.raw || '').match(/resp:\s*([^\]]+)\]/i) || (r.raw || '').match(/\(([A-ZÁÉÍÓÑ][a-záéíóñ]+\s+[A-ZÁÉÍÓÑ][a-záéíóñ]+)[^)]*\)/); return m ? m[1].trim() : ''; }
function _decisionesManual() {
  let text; try { text = fs.readFileSync(path.join(ROOT, `${SP}/risks.md`), 'utf8'); } catch { return []; }
  const m = text.match(/^##+\s*Decisiones[^\n]*\n([\s\S]*?)(?=\n##?\s|$)/mi);
  if (!m) return [];
  const items = []; const re = /^[-*]\s+(.+)$/gm; let x;
  while ((x = re.exec(m[1]))) items.push({ q: x[1].replace(/\*\*/g, '').trim(), m: '', who: '' });
  return items.slice(0, 4);
}

function buildOnepagerModel() {
  const ini = parseEstado();
  if (!ini) return null;
  const fm = ini.fm, fases = ini.fases;
  const clas = clasificacion(), ti = tipoInfo();
  const tipo = fm.tipo || ti.tipo || 'trabajo';
  const entidad = tipo;   // "alcance" del one-pager = el tipo/nomenclatura (fm.tipo), no una clase del metadato
  const hoy = new Date(), fecha = hoy.toISOString().slice(0, 10);
  const daysTo = (d) => Math.round((new Date(d) - hoy) / 86400000);
  const faseActual = Number(fm.fase_actual) || ((fases.find((f) => f.estado === 'in_progress') || {}).num) || null;
  const fasesTotal = Number(fm.fases_total) || fases.length || null;
  const cur = fases.find((f) => f.num === faseActual) || null;

  const done = fases.filter((f) => f.estado === 'done').length;
  const totT = fases.reduce((a, f) => a + f.tareas.length, 0);
  const doneT = fases.reduce((a, f) => a + f.done, 0);
  let pct = fasesTotal ? Math.round((done / fasesTotal) * 100) : 0;
  if (cur && cur.tareas.length && fasesTotal) pct = Math.min(99, Math.round(((done + cur.done / cur.tareas.length) / fasesTotal) * 100));
  const avance = {
    pct, nota: `${done} de ${fasesTotal || '?'} fases cerradas` + (cur ? ` · Fase ${cur.num} en ${cur.estado === 'in_progress' ? 'curso' : cur.estado}` : ''),
    fases: fases.map((f) => ({ n: f.num, nombre: f.nombre, estado: f.estado === 'done' ? 'done' : (f.num === faseActual ? 'now' : 'todo') })),
  };

  const hitos = fases.filter((f) => f.objetivo).map((f) => ({ fecha: f.objetivo, txt: `Fin Fase ${f.num} · ${f.nombre}`, hot: daysTo(f.objetivo) <= 30 }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  const kpisRaw = parseKpis();
  let kpis;
  if (!kpisRaw || !kpisRaw.length) {
    kpis = { definidos: false, pendienteMsg: 'El trabajo aún no tiene KPIs de valor en gestion/kpis.md. Defínelos (definición, línea base, objetivo, fuente); el agente analista-kpis los valida contra la evidencia.', items: [], derivados: [] };
  } else {
    const now = hoy.getTime();
    kpis = { definidos: true, pendienteMsg: '', items: kpisRaw.map((k) => {
      const last = k.mediciones.length ? k.mediciones[k.mediciones.length - 1] : null;
      const stale = last ? Math.round((now - new Date(last.fecha)) / 86400000) : null;
      return { id: k.id, nombre: k.nombre, obj: k.campos.objetivo || '?', actual: last ? last.valor : 'sin medir', estado: !last ? 'sin medición' : stale > 30 ? `hace ${stale}d` : last.fecha };
    }), derivados: [] };
  }
  kpis.derivados = [
    { v: pct + '%', n: 'avance por fases' },
    { v: `${done}/${fasesTotal || '?'}`, n: 'fases cerradas' },
    { v: totT ? `${doneT}/${totT}` : '—', n: 'tareas completadas' },
  ];

  const rk = parseRisks();
  const riesgos = { abiertos: 0, total: 0, top: [] };
  const isOpen = (e) => !/^mitigad|^cerrad|^resuelt|^descartad/.test(e);
  if (rk && rk.length) {
    const open = rk.filter((r) => isOpen(r.estado));
    riesgos.total = rk.length; riesgos.abiertos = open.length;
    riesgos.top = open.slice().sort((a, b) => _rank(b.impacto) - _rank(a.impacto)).slice(0, 4)
      .map((r) => ({ id: r.id, txt: _riskText(r.riesgo), sev: _rank(r.impacto) >= 3 ? 'hi' : 'md', tag: _riskTag(r) }));
  }

  let decisiones = _decisionesManual();
  if (!decisiones.length && rk) {
    const needs = (r) => isOpen(r.estado) && /decisi[oó]n|bloquea|pendiente de|a cuantificar|por resolver|sin resolver/i.test(r.estado + ' ' + r.mitig);
    decisiones = rk.filter(needs).sort((a, b) => _rank(b.impacto) - _rank(a.impacto)).slice(0, 3)
      .map((r) => ({ q: _riskText(r.riesgo, 72), m: `Decisión pendiente (${r.id}) · ${_riskTag(r)}.`, who: _riskWho(r) }));
  }

  const openHi = riesgos.top.filter((t) => t.sev === 'hi').length;
  const muyAlto = rk ? rk.some((r) => isOpen(r.estado) && /muy alto/.test(r.impacto)) : false;
  const plazoVencido = !!(cur && cur.objetivo && new Date(cur.objetivo) < hoy && cur.estado !== 'done');
  let nivel = 'verde';
  if (muyAlto || plazoVencido) nivel = 'rojo';
  else if (openHi || !kpis.definidos || decisiones.length) nivel = 'ambar';
  const label = { verde: 'VERDE', ambar: 'ÁMBAR', rojo: 'ROJO' }[nivel];
  const frase = nivel === 'rojo' ? 'Requiere atención' + (muyAlto ? ': riesgo crítico abierto' : '') + (plazoVencido ? ' · fase fuera de plazo' : '')
    : nivel === 'ambar' ? 'En marcha con decisiones/riesgos abiertos' + (!kpis.definidos ? ' · KPIs sin definir' : '')
    : 'Al día en plazo, riesgos y KPIs';

  const costeWarn = rk && rk.some((r) => isOpen(r.estado) && /coste|latencia|presupuesto/i.test(r.riesgo));
  const dims = [
    { k: 'Alcance', sig: 'ok', nota: String(entidad) },
    { k: 'Plazo', sig: plazoVencido ? 'crit' : (cur && cur.objetivo ? (daysTo(cur.objetivo) <= 15 ? 'warn' : 'ok') : 'ok'), nota: cur && cur.objetivo ? `Fase ${cur.num} objetivo ${cur.objetivo}` : 'sin fecha objetivo' },
    { k: 'Coste', sig: costeWarn ? 'warn' : 'ok', nota: costeWarn ? 'riesgos de coste/latencia abiertos' : 'sin alertas de coste' },
    { k: 'Riesgo', sig: muyAlto ? 'crit' : (openHi ? 'warn' : 'ok'), nota: `${riesgos.abiertos} abiertos de ${riesgos.total}` },
  ];

  const codeMode = fs.existsSync(path.join(ROOT, '.claude/hooks/code.js'));
  const modo = codeMode ? 'codigo' : /iniciativa/i.test(tipo) ? 'iniciativa' : 'proyecto';
  const notaPie = 'Adaptativo por tipo: proyecto → fases · RAID · KPIs; worker/app → gates · tests · despliegue · endpoints; iniciativa → OKRs · discovery.';

  return {
    meta: { nombre: fm.iniciativa || fm.nombre || path.basename(ROOT), tipo, entidad, domain: clas.domain || null, owner: fm.owner || null, faseActual, fasesTotal, faseNombre: cur ? cur.nombre : null, fecha, objetivo: fm.objetivo || null },
    rag: { nivel, label, frase }, dims, avance, hitos, kpis, riesgos, decisiones,
    adaptativo: { tipoLabel: tipo, notaPie }, modo,
  };
}

// ROADMAP: la MISMA verdad que el one-pager, contada como un viaje. El one-pager responde "que
// decido" (denso, para direccion); este responde "donde estamos" (visual, para cliente y equipo).
// No inventa nada: deriva TODO de buildOnepagerModel (ESTADO.md + risks.md + kpis.md).
//
// DISENO alineado con la practica estandar de milestone charts (revisado 2026-08-05), no con una
// metafora decorativa. Un primer intento uso un "cochecito" con caras segun el animo: se descarto
// porque el estado se leia en la CARA de un icono en vez de en el codigo de color que el lector ya
// conoce, y ante cliente restaba seriedad. Lo que la industria usa y aqui se aplica:
//   - MARCADOR "HOY": linea vertical + etiqueta sobre el carril. Es el elemento que responde "donde
//     estamos" de un vistazo; se posiciona por avance.pct (fases cerradas + progreso de la actual).
//   - SEMAFORO POR HITO: verde hecho · ambar en riesgo · rojo retrasado. Estandar reconocible: el
//     lector no tiene que aprender una leyenda nueva.
//   - ROMBO (diamond) para los hitos que son PUERTA DE DECISION (fin de fase con objetivo): la
//     convencion de milestone charts distingue asi un checkpoint de una parada cualquiera.
//   - FASE SIN CERRAR: el trabajo avanzo dejandola abierta. Se marca en rojo y con aviso porque es
//     justo la senal de gestion que un carril comunica mejor que un parrafo.
// Regla de oro de la fuente: o el estado se entiende en segundos, o el grafico no sirve.
function buildRoadmapModel() {
  const m = buildOnepagerModel();
  if (!m) return null;
  const hoy = new Date();
  const daysTo = (d) => Math.round((new Date(d) - hoy) / 86400000);
  const faseActual = m.meta.faseActual;
  const plazoDim = (m.dims || []).find((d) => d.k === 'Plazo') || {};
  const riesgoDim = (m.dims || []).find((d) => d.k === 'Riesgo') || {};
  const vencido = plazoDim.sig === 'crit';
  const critico = riesgoDim.sig === 'crit';
  const alerta = plazoDim.sig === 'warn' || riesgoDim.sig === 'warn';

  // Hitos del carril. Tres datos por fase, que son los que el lector necesita distinguir:
  //   sig    SEMAFORO (verde/ambar/rojo/gris): se interpreta sin leyenda.
  //   gate   puerta de decision (fin de fase con fecha objetivo) -> rombo, no punto.
  //   flujo  BLOQUEANTE vs COLA. Es la distincion que faltaba y la que mas confunde en un informe:
  //          una fase con una tarea pendiente NO bloqueante no para el trabajo — el equipo ya esta
  //          en la siguiente. Pintarla igual que una fase parada da una foto FALSA ("seguimos en la
  //          2" cuando en realidad se avanza). El dato ya existe en ESTADO.md: '[bloq: motivo]' en
  //          la tarea. Sin ese marcador, una tarea abierta es COLA, no bloqueo.
  const fasesRaw = (parseEstado() || {}).fases || [];
  const paradas = (m.avance.fases || []).map((f) => {
    const hito = (m.hitos || []).find((h) => new RegExp(`Fase ${f.n}\\b`).test(h.txt));
    const obj = hito ? hito.fecha : null;
    const d = obj ? daysTo(obj) : null;
    const raw = fasesRaw.find((x) => x.num === f.n) || { tareas: [] };
    const abiertasT = (raw.tareas || []).filter((t) => !t.done);
    const bloqueos = abiertasT.filter((t) => t.bloq);
    // Fase NO cerrada mientras el trabajo ya va por una posterior.
    const rezagada = f.estado !== 'done' && faseActual && f.n < faseActual;
    const retrasada = !!(obj && d < 0 && f.estado !== 'done');
    // Ambar = objetivo a <=15 dias (ventana estandar de aviso: da margen a reaccionar).
    const enRiesgo = !!(obj && d !== null && d >= 0 && d <= 15 && f.estado !== 'done');
    // Rojo SOLO si de verdad para: hay bloqueo declarado, o esta retrasada. Una fase rezagada con
    // tareas en cola es AMBAR: hay que cerrarla, pero no esta deteniendo nada.
    const bloqueada = bloqueos.length > 0;
    // JERARQUIA visual. La fase EN CURSO es 'now' y se dibuja siempre destacada, aunque no tenga
    // alerta: si cae en gris (como pasaba cuando su objetivo estaba lejos) el lector no encuentra
    // donde estamos, que es la unica pregunta que este grafico responde.
    // Y una fase RETRASADA que no bloquea es AMBAR, no roja: rojo se reserva a lo que detiene el
    // avance. Antes salia roja mientras la tarjeta decia "nada detiene el trabajo" — se contradecian.
    const sig = f.estado === 'done' ? 'ok'
      : bloqueada ? 'crit'
      : f.estado === 'now' ? 'now'
      : (rezagada || retrasada || enRiesgo) ? 'warn' : 'todo';
    return {
      n: f.n, nombre: f.nombre,
      estado: f.estado,                                   // done | now | todo
      sig, gate: !!obj, objetivo: obj, dias: d,
      retrasada, enRiesgo, rezagada, bloqueada,
      flujo: bloqueada ? 'bloqueada' : (rezagada || retrasada) ? 'cola' : 'normal',
      // Progreso REAL de la fase: "14 tareas abiertas" no dice nada sin saber de cuantas. Con
      // hechas/total el lector ve si una fase esta al 90% o recien empezada — es lo que convierte
      // el carril en informacion util en vez de una fila de puntos de colores.
      pendientes: abiertasT.length,
      hechas: (raw.tareas || []).length - abiertasT.length,
      total: (raw.tareas || []).length,
      pct: (raw.tareas || []).length ? Math.round(((raw.tareas.length - abiertasT.length) / raw.tareas.length) * 100) : null,
      motivos: bloqueos.map((t) => t.bloq),
    };
  });

  // Obstaculos = riesgos abiertos top. Se anclan a la fase EN CURSO (es donde muerden ahora); si no
  // hay fase en curso, quedan sueltos al final del carril.
  const obstaculos = (m.riesgos.top || []).map((r) => ({
    txt: r.txt || r.nombre || String(r), sev: r.sev || 'md', fase: faseActual || null,
  }));

  return {
    meta: { ...m.meta },
    rag: m.rag,
    // Marcador HOY: donde estamos y por que. 'sig' colorea la etiqueta con el mismo codigo que los
    // hitos, para que el lector no interprete dos escalas distintas en el mismo grafico.
    hoy: {
      pct: m.avance.pct, fase: faseActual, fecha: m.meta.fecha,
      sig: (vencido || critico) ? 'crit' : alerta ? 'warn' : 'ok',
      motivo: vencido ? 'plazo vencido' : critico ? 'riesgo crítico' : alerta ? 'requiere atención' : 'al día',
    },
    avance: m.avance,
    paradas, obstaculos,
    // Las tres cifras que el lector busca, separadas a proposito: 'bloqueadas' PARA el trabajo,
    // 'enCola' solo queda por cerrar. Mezclarlas es lo que daba la foto falsa.
    bloqueadas: paradas.filter((p) => p.bloqueada).map((p) => p.n),
    enCola: paradas.filter((p) => p.flujo === 'cola').map((p) => p.n),
    retrasadas: paradas.filter((p) => p.retrasada).map((p) => p.n),
    kpis: m.kpis,
  };
}

function cmdRoadmap() {
  const model = buildRoadmapModel();
  if (!model) { console.log('No hay ESTADO.md — el roadmap necesita el faseo. Crea ESTADO.md primero (o estás en modo template).'); process.exit(1); }
  const p = plantillaMarca('faro-roadmap.html');
  if (!p) { console.log('Falta la plantilla faro-roadmap.html (ni en el repo ni en el plugin) — reinstala el plugin.'); process.exit(1); }
  let tpl;
  try { tpl = fs.readFileSync(p.ruta, 'utf8'); } catch { console.log(`No pude leer la plantilla (${p.ruta}).`); process.exit(1); }
  const out = tpl.replace('window.__ROADMAP__ = null; /*__DATA__*/', 'window.__ROADMAP__ = ' + JSON.stringify(model) + ';');
  const dir = path.join(ROOT, PRESENTACIONES);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  // Datado como TODO el reporting: misma fecha ACTUALIZA, fecha nueva = snapshot. No hay "vivo".
  const file = path.join(dir, `roadmap-${model.meta.fecha}.html`);
  fs.writeFileSync(file, out, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  console.log(`Roadmap visual generado: ${rel}`);
  console.log(`  ${model.avance.pct}% · fase ${model.meta.faseActual || '?'}/${model.meta.fasesTotal || '?'} · ${model.hoy.motivo}` +
    (model.bloqueadas.length ? ` · BLOQUEA: fase ${model.bloqueadas.join(', ')}` : '') +
    (model.enCola.length ? ` · por cerrar (no bloquea): ${model.enCola.join(', ')}` : '') +
    (model.retrasadas.length ? ` · fuera de plazo: ${model.retrasadas.join(', ')}` : '') +
    (model.obstaculos.length ? ` · ${model.obstaculos.length} obstáculo(s)` : ''));
  console.log('  Ábrelo en el navegador (Imprimir → PDF, A3 horizontal).');
}

function cmdOnepager() {
  const model = buildOnepagerModel();
  if (!model) { console.log('No hay ESTADO.md — el one-pager necesita el faseo. Crea ESTADO.md primero (o estás en modo template).'); process.exit(1); }
  const p = plantillaMarca('faro-onepager.html');
  if (!p) { console.log('Falta la plantilla faro-onepager.html (ni en el repo ni en el plugin) — reinstala el plugin.'); process.exit(1); }
  let tpl;
  try { tpl = fs.readFileSync(p.ruta, 'utf8'); } catch { console.log(`No pude leer la plantilla (${p.ruta}).`); process.exit(1); }
  const out = tpl.replace('window.__ONEPAGER__ = null; /*__DATA__*/', 'window.__ONEPAGER__ = ' + JSON.stringify(model) + ';');
  const dir = path.join(ROOT, PRESENTACIONES);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const file = path.join(dir, `onepager-${model.meta.fecha}.html`);
  fs.writeFileSync(file, out, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  console.log(`One-pager ejecutivo generado: ${rel}`);
  console.log(`  ${model.rag.label} · avance ${model.avance.pct}% · ${model.riesgos.abiertos}/${model.riesgos.total} riesgos abiertos · ${model.decisiones.length} decisiones · KPIs ${model.kpis.definidos ? 'definidos' : 'SIN definir'}`);
  console.log('  Ábrelo en el navegador (Imprimir → PDF para compartir a dirección).');
}


  return { buildOnepagerModel, buildRoadmapModel, cmdOnepager, cmdRoadmap };
};
