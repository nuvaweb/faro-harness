// lib/campos-issue.js — CAMPOS DE ISSUE de la organizacion de GitHub (issue fields: Target date,
// Start date, Priority, Effort... o los que defina cada organizacion) (#215).
//
// Los campos son de la ORGANIZACION, no del repo, y cada una define los suyos: aqui no hay nombres
// fijos. Los atajos (--fecha-objetivo, --prioridad...) son ALIAS que se resuelven contra lo que la
// organizacion tenga; si no hay un campo que encaje, se dice cual hay.
//
// API: GET orgs/{org}/issue-fields (definiciones) · GET|POST repos/{o}/{r}/issues/{n}/issue-field-values
// ({issue_field_values:[{field_id, value}]}) · DELETE .../issue-field-values/{field_id}.
// OJO: un POST con el array VACIO borra todos los valores del issue — aqui nunca se manda vacio.
'use strict';

// Atajo -> nombres con los que puede aparecer el campo en la organizacion (minusculas) y data_type esperado.
const ALIAS = {
  'fecha-objetivo': { nombres: ['target date', 'due date', 'fecha objetivo', 'fecha limite', 'deadline'], tipo: 'date' },
  inicio: { nombres: ['start date', 'fecha inicio', 'fecha de inicio'], tipo: 'date' },
  prioridad: { nombres: ['priority', 'prioridad'], tipo: 'single_select' },
  esfuerzo: { nombres: ['effort', 'esfuerzo', 'size', 'tamano', 'tamaño'], tipo: 'single_select' },
};
const FLAGS = Object.keys(ALIAS);

/** Saca de argv los --campo "Nombre=valor" y los atajos. -> { pedidos:[{nombre|alias, valor}], resto, error? } */
function parsearArgs(raw) {
  const pedidos = [];
  const resto = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    let m = a.match(/^--campo(?:=(.*))?$/);
    if (m) {
      const v = m[1] !== undefined ? m[1] : raw[++i];
      const eq = String(v || '').indexOf('=');
      if (eq <= 0) return { pedidos, resto, error: `--campo espera "Nombre=valor" (p. ej. --campo "Target date=2026-11-30"); recibido: '${v || ''}'.` };
      pedidos.push({ nombre: v.slice(0, eq).trim(), valor: v.slice(eq + 1).trim() });
      continue;
    }
    m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m && FLAGS.includes(m[1])) {
      const v = m[2] !== undefined ? m[2] : raw[++i];
      pedidos.push({ alias: m[1], valor: String(v || '').trim() });
      continue;
    }
    resto.push(a);
  }
  return { pedidos, resto };
}

const norm = (s) => String(s || '').trim().toLowerCase();

/** Definicion de la organizacion que corresponde a un atajo, o null. */
function defDeAlias(defs, alias) {
  const a = ALIAS[alias];
  if (!a) return null;
  return defs.find((d) => a.nombres.includes(norm(d.name)) && (!a.tipo || d.data_type === a.tipo)) || null;
}

function fechaValida(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Valida y normaliza un valor para su definicion. -> { value } | { error } */
function valorPara(def, valor) {
  const t = def.data_type;
  if (t === 'date') return fechaValida(valor) ? { value: valor } : { error: `'${def.name}' es una fecha: usa AAAA-MM-DD (recibido '${valor}').` };
  if (t === 'number') { const n = Number(valor); return valor !== '' && Number.isFinite(n) ? { value: n } : { error: `'${def.name}' es un numero (recibido '${valor}').` }; }
  if (t === 'single_select') {
    const ops = (def.options || []).map((o) => o.name);
    const o = ops.find((x) => norm(x) === norm(valor));
    return o ? { value: o } : { error: `'${valor}' no es una opcion de '${def.name}'. Opciones: ${ops.join(' · ') || '(ninguna)'}.` };
  }
  if (t === 'multi_select') {
    const ops = (def.options || []).map((o) => o.name);
    const pedidas = String(valor).split(',').map((x) => x.trim()).filter(Boolean);
    const malas = pedidas.filter((p) => !ops.some((x) => norm(x) === norm(p)));
    if (malas.length || !pedidas.length) return { error: `'${malas.join(', ') || valor}' no son opciones de '${def.name}'. Opciones: ${ops.join(' · ') || '(ninguna)'}.` };
    return { value: pedidas.map((p) => ops.find((x) => norm(x) === norm(p))) };
  }
  return valor ? { value: valor } : { error: `'${def.name}' necesita un valor.` };
}

/** Resuelve los pedidos contra las definiciones. -> { valores:[{field_id, value, nombre}] } | { error } */
function resolver(defs, pedidos) {
  const valores = [];
  for (const p of pedidos) {
    const def = p.alias ? defDeAlias(defs, p.alias) : defs.find((d) => norm(d.name) === norm(p.nombre));
    if (!def) {
      const que = p.alias ? `--${p.alias}` : `el campo '${p.nombre}'`;
      return { error: `La organizacion no tiene ${que}. Campos disponibles: ${listar(defs)}.` };
    }
    const v = valorPara(def, p.valor);
    if (v.error) return { error: v.error };
    const i = valores.findIndex((x) => x.field_id === def.id);
    if (i >= 0) valores.splice(i, 1);
    valores.push({ field_id: def.id, value: v.value, nombre: def.name });
  }
  return { valores };
}

const listar = (defs) => defs.map((d) => `${d.name} (${d.data_type}${d.options && d.options.length ? `: ${d.options.map((o) => o.name).join('/')}` : ''})`).join(' · ') || '(ninguno)';

/** Fecha (AAAA-MM-DD) de un hito de la forja, o null. Vale para CUALQUIER hito: fase, version, sprint... */
const fechaDeHito = (m) => (m && m.due_on ? String(m.due_on).slice(0, 10) : null);

/** Cuerpo de la API (sin el 'nombre' interno). Nunca vacio: un array vacio BORRARIA todos los valores. */
const cuerpoApi = (valores) => ({ issue_field_values: valores.map((v) => ({ field_id: v.field_id, value: v.value })) });

/** Texto legible de un valor leido de la API. */
function textoValor(v) {
  if (v.single_select_option) return v.single_select_option.name;
  if (Array.isArray(v.multi_select_options) && v.multi_select_options.length) return v.multi_select_options.map((o) => o.name).join(', ');
  return v.value == null ? '' : String(v.value);
}

/** Id del campo al que pertenece un valor leido (la API lo da como issue_field_id). */
const idDeValor = (v) => (v && (v.issue_field_id != null ? v.issue_field_id : v.field_id != null ? v.field_id : v.issue_field && v.issue_field.id));

/**
 * Que hacer con la fecha objetivo al cambiar de hito (decision pura).
 * Se considera HEREDADA si esta vacia o coincide con la del hito de origen: entonces sigue al hito
 * nuevo (o se quita si el nuevo no tiene fecha). Una fecha puesta a mano no se toca.
 * -> { accion: 'poner', fecha } | { accion: 'quitar' } | { accion: 'nada' }
 */
function planFechaAlMover(actual, fechaOrigen, fechaDestino) {
  const heredada = !actual || (fechaOrigen && actual === fechaOrigen);
  if (!heredada) return { accion: 'nada' };
  if (fechaDestino) return actual === fechaDestino ? { accion: 'nada' } : { accion: 'poner', fecha: fechaDestino };
  return actual ? { accion: 'quitar' } : { accion: 'nada' };
}

/** Acceso a la forja (inyectado ghApi): definiciones cacheadas por organizacion, lectura y escritura. */
function crear(ghApi) {
  const cache = new Map();
  async function defsOrg(org) {
    if (!cache.has(org)) {
      const r = await ghApi(`orgs/${org}/issue-fields`);
      cache.set(org, r.ok && Array.isArray(r.body) ? r.body : null);
    }
    return cache.get(org);   // null o [] = la organizacion no tiene campos (o es un usuario)
  }
  async function leer(org, repo, num) {
    const r = await ghApi(`repos/${org}/${repo}/issues/${num}/issue-field-values?per_page=100`);
    return r.ok && Array.isArray(r.body) ? r.body : [];
  }
  async function escribir(org, repo, num, valores) {
    if (!valores.length) return { ok: true, status: 0 };
    return ghApi(`repos/${org}/${repo}/issues/${num}/issue-field-values`, { method: 'POST', body: cuerpoApi(valores) });
  }
  async function borrar(org, repo, num, fieldId) {
    return ghApi(`repos/${org}/${repo}/issues/${num}/issue-field-values/${fieldId}`, { method: 'DELETE' });
  }
  async function fechaHitoNumero(org, repo, numero) {
    if (numero == null) return null;
    const r = await ghApi(`repos/${org}/${repo}/milestones/${numero}`);
    return r.ok ? fechaDeHito(r.body) : null;
  }

  /** mover-tarea: la fecha objetivo HEREDADA sigue al hito nuevo. Devuelve la linea a reportar, o null. */
  async function seguirHito(org, repo, num, hitoOrigen, numeroDestino) {
    const defs = await defsOrg(org);
    const def = defs && defs.length ? defDeAlias(defs, 'fecha-objetivo') : null;
    if (!def) return null;
    const v = (await leer(org, repo, num)).find((x) => idDeValor(x) === def.id);
    const actual = v ? textoValor(v).slice(0, 10) : null;
    const plan = planFechaAlMover(actual, fechaDeHito(hitoOrigen), await fechaHitoNumero(org, repo, numeroDestino));
    if (plan.accion === 'poner') {
      const r = await escribir(org, repo, num, [{ field_id: def.id, value: plan.fecha }]);
      return r.ok ? `   ${def.name}: ${plan.fecha} (la del hito nuevo; antes ${actual || 'sin fecha'}).` : `   ⚠ No pude pasar '${def.name}' a ${plan.fecha} (HTTP ${r.status}).`;
    }
    if (plan.accion === 'quitar') {
      const r = await borrar(org, repo, num, def.id);
      return r.ok ? `   ${def.name}: quitada (era la del hito anterior y el nuevo no tiene fecha).` : `   ⚠ No pude quitar '${def.name}' (HTTP ${r.status}).`;
    }
    return null;
  }

  return { defsOrg, leer, escribir, borrar, fechaHitoNumero, seguirHito };
}

/**
 * harness.js campos-tarea [<numero>] [--campo "Nombre=valor" | --fecha-objetivo AAAA-MM-DD ...] [--quitar <campo>]
 *   sin numero: los campos que define la organizacion · con numero: sus valores · con --campo: los fija.
 */
async function cmdCamposTarea({ ghApi, ghRepo }, argv) {
  const uso = 'Uso: harness.js campos-tarea                      (campos de la organizacion)\n     harness.js campos-tarea <numero>             (valores del issue)\n     harness.js campos-tarea <numero> --campo "Nombre=valor" [--fecha-objetivo AAAA-MM-DD] [--inicio AAAA-MM-DD] [--prioridad <opcion>] [--esfuerzo <opcion>]\n     harness.js campos-tarea <numero> --quitar "<Nombre|atajo>"';
  const pa = parsearArgs(argv);
  if (pa.error) { console.log(`${pa.error}\n${uso}`); process.exit(1); }
  const quitar = [];
  let num = null;
  for (let i = 0; i < pa.resto.length; i++) {
    const a = pa.resto[i];
    if (a === '--quitar') { quitar.push(String(pa.resto[++i] || '').trim()); continue; }
    const m = a.match(/^--quitar=(.*)$/); if (m) { quitar.push(m[1].trim()); continue; }
    if (/^#?\d+$/.test(a) && !num) { num = a.replace(/^#/, ''); continue; }
    console.log(`Argumento no reconocido: '${a}'.\n${uso}`); process.exit(1);
  }
  const R = ghRepo();
  if (!R) { console.log('No detecto el repo remoto (origin).'); return; }
  const acc = crear(ghApi);
  const defs = await acc.defsOrg(R.org);
  if (!defs || !defs.length) {
    console.log(`La organizacion ${R.org} no tiene campos de issue definidos (se crean en la configuracion de la organizacion de GitHub, no desde FARO).`);
    if (pa.pedidos.length || quitar.length) process.exit(1);
    return;
  }
  if (!num) {
    if (pa.pedidos.length || quitar.length) { console.log(`Falta el numero del issue.\n${uso}`); process.exit(1); }
    console.log(`Campos de issue de ${R.org}:`);
    for (const d of defs) console.log(`  · ${d.name} (${d.data_type})${d.options && d.options.length ? ` — ${d.options.map((o) => o.name).join(' · ')}` : ''}`);
    console.log(`Atajos: ${Object.keys(ALIAS).map((a) => { const d = defDeAlias(defs, a); return `--${a}${d ? ` -> ${d.name}` : ' (sin campo)'}`; }).join(' · ')}`);
    return;
  }
  const res = resolver(defs, pa.pedidos);
  if (res.error) { console.log(res.error); process.exit(1); }
  const quitarDefs = [];
  for (const q of quitar) {
    const d = ALIAS[q.replace(/^--/, '')] ? defDeAlias(defs, q.replace(/^--/, '')) : defs.find((x) => norm(x.name) === norm(q));
    if (!d) { console.log(`La organizacion no tiene el campo '${q}'. Campos disponibles: ${listar(defs)}.`); process.exit(1); }
    quitarDefs.push(d);
  }
  if (res.valores.length) {
    const r = await acc.escribir(R.org, R.repo, num, res.valores);
    if (r.sinToken) { console.log('SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth.'); return; }
    if (!r.ok) { console.log(`No pude fijar los campos de #${num} (HTTP ${r.status})${r.body && r.body.message ? `: ${r.body.message}` : ''}.`); process.exit(1); }
    console.log(`✅ #${num}: ${res.valores.map((v) => `${v.nombre} = ${Array.isArray(v.value) ? v.value.join(', ') : v.value}`).join(' · ')}.`);
  }
  for (const d of quitarDefs) {
    const r = await acc.borrar(R.org, R.repo, num, d.id);
    if (r.ok || r.status === 404) console.log(`✅ #${num}: '${d.name}' sin valor.`);
    else console.log(`⚠ No pude quitar '${d.name}' de #${num} (HTTP ${r.status}).`);
  }
  if (res.valores.length || quitarDefs.length) return;
  const valores = await acc.leer(R.org, R.repo, num);
  if (!valores.length) { console.log(`#${num} no tiene campos con valor. Fijalos con: harness.js campos-tarea ${num} --campo "Nombre=valor".`); return; }
  console.log(`Campos de #${num}:`);
  for (const v of valores) {
    const d = defs.find((x) => x.id === idDeValor(v));
    console.log(`  · ${d ? d.name : `campo ${idDeValor(v)}`}: ${textoValor(v)}`);
  }
}

module.exports = { ALIAS, parsearArgs, resolver, defDeAlias, valorPara, fechaValida, fechaDeHito, cuerpoApi, textoValor, idDeValor, planFechaAlMover, listar, crear, cmdCamposTarea };
