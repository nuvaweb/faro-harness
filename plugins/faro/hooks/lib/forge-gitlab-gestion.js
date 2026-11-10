// lib/forge-gitlab-gestion.js — GESTION NATIVA de GitLab para el trabajo faseado: hitos (fase =
// milestone), tiempo (estimacion y consumo por incidencia, agregado por hito) y enlaces entre tareas.
// Separado de forge-gitlab.js por el criterio de atomicidad del motor (~400 lineas por modulo).
//
// DETERMINISTA: cada comando hace llamadas fijas, relee el recurso tras escribir y dice lo que quedo.
// PLANES: lo de aqui es GRATUITO salvo peso y enlaces de bloqueo (Premium/Ultimate). NO se gatea por
// plan: se intenta y se verifica el efecto real (GitLab responde 400/404/silencio segun version).
// Uso desde harness.js: hito · tiempo · enlazar, y los modificadores de asignar-tarea.
'use strict';

module.exports = function (g) {
  const { api, pid, f, SIN_TOKEN, invalidarResumen, fases, isDone } = g;
  const argv = () => process.argv.slice(3);
  const flag = (a, k) => { const i = a.indexOf(k); return i >= 0 ? (a[i + 1] || '') : null; };
  const sinFlags = (a) => { const out = []; for (let i = 0; i < a.length; i++) { if (/^--/.test(a[i])) { i++; continue; } out.push(a[i]); } return out; };
  const salir = (r) => { if (r && r.sinToken) { console.log(SIN_TOKEN()); process.exit(2); } };
  // Duracion valida para GitLab: 30m · 3h · 1d · 1w · 1mo, y combinaciones "1h 30m".
  const DUR_RE = /^(\d+(mo|w|d|h|m)\s*)+$/;
  const horas = (seg) => `${(Number(seg || 0) / 3600).toFixed(1)}h`;
  const PREMIUM = (que, r) => `ℹ ${que}: no aplicado (HTTP ${r.status}) — funcion de plan Premium/Ultimate, o sin permiso. El resto sigue.`;
  const tituloFase = (fs) => `Fase ${fs.num} — ${fs.nombre}`;

  // ---- HITOS ----
  async function hitos(state) {
    const r = await api(`projects/${pid()}/milestones?state=${state || 'all'}&per_page=100`);
    salir(r);
    return (r.ok && Array.isArray(r.body)) ? r.body : [];
  }
  const buscarHito = (lista, ref) => lista.find((m) => String(m.iid) === String(ref) || m.title.toLowerCase() === String(ref).toLowerCase()) || null;
  async function crearHito(titulo, extra = {}) {
    const ya = buscarHito(await hitos('all'), titulo);
    if (ya) return { hito: ya, creado: false };
    const r = await api(`projects/${pid()}/milestones`, { method: 'POST', body: { title: titulo, ...extra } });
    salir(r);
    return r.ok ? { hito: r.body, creado: true } : { error: r };
  }
  async function estadoHito(id, evento) {
    const r = await api(`projects/${pid()}/milestones/${id}`, { method: 'PUT', body: { state_event: evento } });
    salir(r);
    const v = await api(`projects/${pid()}/milestones/${id}`);   // relectura: el efecto real
    return v.ok && v.body ? v.body.state : null;
  }
  // Tiempo agregado por hito: suma de time_stats de sus incidencias (estimado vs consumido).
  async function tiempoPorHito() {
    const porHito = new Map();
    for (let page = 1; page <= 5; page++) {
      const r = await api(`projects/${pid()}/issues?state=all&per_page=100&page=${page}`);
      if (!r.ok || !Array.isArray(r.body) || !r.body.length) break;
      for (const i of r.body) {
        const k = i.milestone ? i.milestone.title : '(sin hito)';
        const t = porHito.get(k) || { est: 0, gastado: 0, abiertas: 0, cerradas: 0 };
        t.est += (i.time_stats && i.time_stats.time_estimate) || 0;
        t.gastado += (i.time_stats && i.time_stats.total_time_spent) || 0;
        if (i.state === 'closed') t.cerradas++; else t.abiertas++;
        porHito.set(k, t);
      }
      if (r.body.length < 100) break;
    }
    return porHito;
  }
  async function cmdHito() {
    const a = argv(); const sub = a[0] || 'listar';
    if (sub === 'listar' || sub === 'ver') {
      const lista = await hitos(a.includes('--all') ? 'all' : 'active');
      if (!lista.length) { console.log('Sin hitos. Crea uno por fase: harness.js hito crear "Fase 1 — <nombre>" [--vence AAAA-MM-DD]  ·  o sincroniza desde ESTADO.md: harness.js hito sync'); return; }
      const t = await tiempoPorHito();
      console.log(`Hitos de ${f().path} (${lista.length}):`);
      for (const m of lista) {
        const x = t.get(m.title) || { est: 0, gastado: 0, abiertas: 0, cerradas: 0 };
        console.log(`  %${m.iid} [${m.state}] ${m.title}${m.due_date ? ` · vence ${m.due_date}` : ''} · tareas ${x.cerradas}/${x.cerradas + x.abiertas} · estimado ${horas(x.est)} · consumido ${horas(x.gastado)}  ·  ${m.web_url}`);
      }
      return;
    }
    if (sub === 'crear') {
      const titulo = sinFlags(a.slice(1)).join(' ').trim();
      if (!titulo) { console.log('Uso: harness.js hito crear "<titulo>" [--vence AAAA-MM-DD] [--empieza AAAA-MM-DD] [--desc "<texto>"]'); process.exit(1); }
      const extra = {}; const v = flag(a, '--vence'), e = flag(a, '--empieza'), d = flag(a, '--desc');
      if (v) extra.due_date = v; if (e) extra.start_date = e; if (d) extra.description = d;
      const r = await crearHito(titulo, extra);
      if (r.error) { console.log(`No pude crear el hito (HTTP ${r.error.status})${r.error.body && r.error.body.message ? `: ${JSON.stringify(r.error.body.message)}` : ''}.`); return; }
      console.log(r.creado ? `✅ Hito creado: %${r.hito.iid} "${r.hito.title}" · ${r.hito.web_url}` : `Ya existia: %${r.hito.iid} "${r.hito.title}" (no se duplica).`);
      return;
    }
    if (sub === 'cerrar' || sub === 'reabrir') {
      const ref = a.slice(1).join(' ').trim();
      const m = buscarHito(await hitos('all'), ref);
      if (!m) { console.log(`No encuentro el hito '${ref}'. Lista: harness.js hito listar --all`); process.exit(1); }
      const st = await estadoHito(m.id, sub === 'cerrar' ? 'close' : 'activate');
      console.log(st === (sub === 'cerrar' ? 'closed' : 'active') ? `✅ Hito %${m.iid} "${m.title}" ${sub === 'cerrar' ? 'cerrado' : 'reabierto'}.` : `⚠ GitLab acepto la peticion pero el hito sigue en '${st}'.`);
      return;
    }
    if (sub === 'sync') {
      const out = await syncHitos();
      console.log(out.length ? `Hitos sincronizados con las fases de ESTADO.md:\n${out.join('\n')}` : 'ESTADO.md sin fases: nada que sincronizar.');
      return;
    }
    console.log('Uso: harness.js hito [listar [--all] | crear "<titulo>" [--vence F] | cerrar <hito> | reabrir <hito> | sync]'); process.exit(1);
  }
  // Fase de ESTADO.md -> hito: crea los que faltan, cierra los de fases terminadas, reabre los que no
  // lo estan. Idempotente. Devuelve lineas (lo usa 'hito sync' y tambien 'aprobar' al cerrar fases).
  async function syncHitos() {
      const lista = fases ? fases() : [];
      if (!lista.length) return [];
      const existentes = await hitos('all');
      const out = [];
      for (const fs of lista) {
        const titulo = tituloFase(fs);
        // FECHA OBJETIVO: misma regla que en GitHub (ESTADO.md manda), con el campo propio de
        // GitLab — 'due_date' en formato AAAA-MM-DD plano, no el ISO completo de GitHub.
        const vence = fs.objetivo || null;
        let m = buscarHito(existentes, titulo);
        if (!m) { const r = await crearHito(titulo, vence ? { due_date: vence } : {}); if (r.error) { out.push(`  ✗ ${titulo}: no se pudo crear (HTTP ${r.error.status})`); continue; } m = r.hito; out.push(`  + ${titulo}: creado (%${m.iid})${vence ? ` · vence ${vence}` : ''}`); }
        else if (vence && String(m.due_date || '') !== vence) {
          const pr = await api(`projects/${pid()}/milestones/${m.id}`, { method: 'PUT', body: { due_date: vence } });
          out.push(`  📅 ${titulo}: ${pr.ok ? `fecha objetivo actualizada a ${vence}` : `NO se pudo actualizar la fecha (HTTP ${pr.status})`}`);
        }
        const debeCerrado = isDone ? isDone(fs.estado) : false;
        // CIERRE FORZOSO (mismo principio que github-gestion.js): una fase 'done' no puede cerrar su
        // hito con tareas SUYAS abiertas dentro. GitLab, a diferencia de GitHub, NO trae el conteo
        // de abiertas en el objeto milestone -> UNA llamada extra, SOLO cuando toca cerrar (no en
        // cada sync), filtrando por milestone+opened (barato: la mayoria de hitos no pasan de 100).
        // ASIMETRIA CONOCIDA vs GitHub: un hito ya CERRADO al que le anaden issues despues no se
        // re-chequea aqui (evita una llamada extra por cada hito ya cerrado en cada sync). GitHub
        // si lo detecta porque open_issues viaja gratis en la misma respuesta de listar hitos.
        let abiertasEnHito = 0;
        if (debeCerrado && m.state !== 'closed') {
          const ri = await api(`projects/${pid()}/issues?milestone=${encodeURIComponent(m.title)}&state=opened&per_page=100`);
          abiertasEnHito = (ri.ok && Array.isArray(ri.body)) ? ri.body.length : 0;
        }
        if (debeCerrado && abiertasEnHito > 0) {
          out.push(`  ⚠ ${titulo}: NO se cierra — ${abiertasEnHito} tarea(s) abierta(s) en el hito. Ciérralas, muévelas a otra fase o descártalas antes de dar la fase por terminada.`);
        } else if (debeCerrado && m.state !== 'closed') { const st = await estadoHito(m.id, 'close'); out.push(`  ✓ ${titulo}: ${st === 'closed' ? 'cerrado (fase terminada)' : 'NO se pudo cerrar'}`); }
        else if (!debeCerrado && m.state === 'closed') { const st = await estadoHito(m.id, 'activate'); out.push(`  ↺ ${titulo}: ${st === 'active' ? 'reabierto (la fase no esta terminada)' : 'NO se pudo reabrir'}`); }
        else out.push(`  = ${titulo}: ya coherente (${m.state})`);
      }
      return out;
  }

  // ---- TIEMPO ----
  async function stats(n) { const r = await api(`projects/${pid()}/issues/${n}/time_stats`); salir(r); return r.ok ? r.body : null; }
  const fmtStats = (n, s) => `Tarea #${n}: estimado ${s.human_time_estimate || '0h'} · consumido ${s.human_total_time_spent || '0h'}${s.time_estimate ? ` (${Math.round(100 * (s.total_time_spent || 0) / s.time_estimate)}%)` : ''}`;
  async function cmdTiempo() {
    const a = argv();
    if (!a.length) {   // resumen del proyecto por hito
      const t = await tiempoPorHito();
      if (!t.size) { const r = await api('user'); salir(r); console.log('Sin incidencias con tiempo en este proyecto.'); return; }
      let est = 0, gas = 0;
      console.log(`Tiempo por hito en ${f().path}:`);
      for (const [k, x] of [...t.entries()].sort()) { est += x.est; gas += x.gastado; console.log(`  ${k}: estimado ${horas(x.est)} · consumido ${horas(x.gastado)} · tareas ${x.cerradas}/${x.cerradas + x.abiertas}`); }
      console.log(`  TOTAL: estimado ${horas(est)} · consumido ${horas(gas)}${est ? ` (${Math.round(100 * gas / est)}%)` : ''}`);
      return;
    }
    const n = a[0];
    if (!/^\d+$/.test(n)) { console.log('Uso: harness.js tiempo [<tarea> [<duracion> | --estimar <duracion> | --reset]]   (duracion: 30m · 2h · 1d · "1h 30m")'); process.exit(1); }
    if (a.includes('--reset')) {
      const r = await api(`projects/${pid()}/issues/${n}/reset_spent_time`, { method: 'POST' }); salir(r);
      console.log(r.ok ? `✅ Tiempo consumido de #${n} puesto a cero.` : `No pude resetear (HTTP ${r.status}).`); return;
    }
    const est = flag(a, '--estimar');
    if (est !== null) {
      if (!DUR_RE.test(est)) { console.log(`Duracion invalida '${est}'. Ejemplos: 30m · 2h · 1d · "1h 30m"`); process.exit(1); }
      const r = await api(`projects/${pid()}/issues/${n}/time_estimate`, { method: 'POST', body: { duration: est } }); salir(r);
      if (!r.ok) { console.log(`No pude estimar (HTTP ${r.status}).`); return; }
      console.log(`✅ ${fmtStats(n, r.body)}`); return;
    }
    if (a[1]) {
      if (!DUR_RE.test(a[1])) { console.log(`Duracion invalida '${a[1]}'. Ejemplos: 30m · 2h · 1d · "1h 30m"`); process.exit(1); }
      const nota = flag(a, '--nota');
      const r = await api(`projects/${pid()}/issues/${n}/add_spent_time`, { method: 'POST', body: { duration: a[1], ...(nota ? { summary: nota } : {}) } }); salir(r);
      if (!r.ok) { console.log(`No pude registrar tiempo (HTTP ${r.status}).`); return; }
      console.log(`✅ Registradas ${a[1]} en #${n}. ${fmtStats(n, r.body)}`); return;
    }
    const s = await stats(n);
    console.log(s ? fmtStats(n, s) : `No pude leer el tiempo de #${n}.`);
  }

  // ---- ENLACES entre tareas ----
  const TIPOS_ENLACE = { bloquea: 'blocks', 'bloqueada-por': 'is_blocked_by', relaciona: 'relates_to' };
  async function enlazar(n, tipo, m) {
    const link_type = TIPOS_ENLACE[tipo];
    const r = await api(`projects/${pid()}/issues/${n}/links`, { method: 'POST', body: { target_project_id: pid(), target_issue_iid: Number(m), link_type } });
    salir(r);
    if (!r.ok) return { ok: false, status: r.status };
    // Verificacion del efecto: en Free, un 'blocks' se guarda como 'relates_to' sin avisar.
    const v = await api(`projects/${pid()}/issues/${n}/links`);
    const real = (v.ok && Array.isArray(v.body) ? v.body : []).find((l) => String(l.iid) === String(m));
    return { ok: true, pedido: link_type, real: real ? real.link_type : null };
  }
  async function cmdEnlazar() {
    const [n, tipo, m] = argv();
    if (!/^\d+$/.test(n || '') || !TIPOS_ENLACE[tipo] || !/^\d+$/.test(m || '')) { console.log('Uso: harness.js enlazar <tarea> <bloquea|bloqueada-por|relaciona> <otra-tarea>'); process.exit(1); }
    const r = await enlazar(n, tipo, m);
    if (!r.ok) { console.log(`No pude enlazar (HTTP ${r.status}).`); return; }
    if (r.real === r.pedido) console.log(`✅ #${n} ${tipo} #${m} (enlace '${r.real}').`);
    else console.log(`⚠ Enlace creado como '${r.real}' y no como '${r.pedido}': los enlaces de BLOQUEO son Premium/Ultimate; en este plan queda como "relacionada con". #${n} ↔ #${m}.`);
  }

  // ---- Modificadores de asignar-tarea (los aplica forge-gitlab.js tras crear la incidencia) ----
  // Devuelve {body, despues}: campos que van en el POST y acciones posteriores con verificacion.
  async function opcionesTarea(o) {
    const body = {}; const avisos = [];
    if (o.hito) {
      // Mismos valores que en GitHub (#217): el numero de una fase de ESTADO.md, 'backlog' o el titulo de un hito.
      const fx = /^\d+$/.test(String(o.hito)) && fases ? (fases() || []).find((x) => x.num === Number(o.hito)) : null;
      if (fx) o.hito = tituloFase(fx);
      else if (String(o.hito).toLowerCase() === 'backlog') o.hito = 'Backlog';
      const m = buscarHito(await hitos('all'), o.hito); if (m) body.milestone_id = m.id; else avisos.push(`hito '${o.hito}' no existe (crealo: harness.js hito crear "${o.hito}")`); }
    if (o.vence) body.due_date = o.vence;
    if (o.peso != null) body.weight = Number(o.peso);   // Premium: se verifica al releer
    // Aviso, NUNCA bloqueo: la estimacion es flexible (se reajusta si cambia el alcance) y una tarea
    // que SURGE (bug/infra/pregunta) no estaba planificada, no tiene por que llegar estimada. Pero
    // una tarea de PLAN sin ella se olvida en silencio si nadie pasa el flag -- y sin estimacion no
    // hay forma de saber cuanto pesa el trabajo planificado hasta que alguien lo mira uno a uno.
    if (o.ciclo === 'plan' && !o.estimacion) {
      avisos.push('sin --estimacion (opcional, pero sin ella no se sabe cuanto pesa hasta que alguien la mire una a una; se reajusta libremente despues con harness.js tiempo)');
    }
    return { body, avisos };
  }
  async function trasCrearTarea(iid, o, creada) {
    const out = [];
    if (o.estimacion) {
      if (!DUR_RE.test(o.estimacion)) out.push(`estimacion '${o.estimacion}' invalida (ej. 2h, 1d): no aplicada`);
      else { const r = await api(`projects/${pid()}/issues/${iid}/time_estimate`, { method: 'POST', body: { duration: o.estimacion } }); out.push(r.ok ? `estimacion ${o.estimacion}` : `estimacion NO aplicada (HTTP ${r.status})`); }
    }
    if (o.peso != null) out.push(creada && creada.weight === Number(o.peso) ? `peso ${o.peso}` : PREMIUM(`peso ${o.peso}`, { status: 'silencio' }));
    if (o.bloqueadaPor) { const r = await enlazar(iid, 'bloqueada-por', o.bloqueadaPor); out.push(r.ok ? (r.real === 'is_blocked_by' ? `bloqueada por #${o.bloqueadaPor}` : `relacionada con #${o.bloqueadaPor} (bloqueo = Premium)`) : `enlace NO creado (HTTP ${r.status})`); }
    if (out.length) console.log(`   ${out.join(' · ')}`);
    invalidarResumen();
  }

  return { cmdHito, cmdTiempo, cmdEnlazar, syncHitos, opcionesTarea, trasCrearTarea, tiempoPorHito, tituloFase, hitos, buscarHito, crearHito };
};
