// lib/tarea-sync.js — SINCRONIZACION de gestion/tareas/<N>.json con su issue en la forja (#149, parte 3).
//
//   harness.js tarea sync <N> [--comprobar]
//   harness.js tarea sync --todas [--comprobar]
//
// Refresca SOLO lo que la forja puede decir con autoridad (campos DERIVABLES):
//   - estado: issue cerrado -> hecha (o descartada si se cerro como 'not_planned'); un registro
//     hecha/descartada cuyo issue se reabrio vuelve a en_curso. Un issue abierto no pisa
//     pendiente/en_curso/bloqueada (eso lo decide la persona).
//   - prs: se UNEN los PR enlazados a los que ya tenia el registro (nunca se pierde uno).
//   - subtareas: checklist del issue + tasks.md de sus cambios (el mismo calculo que la migracion).
//   - fechas.creada (solo si estaba vacia) y fechas.cerrada (la del issue; null si esta abierto).
// NUNCA toca lo que edita la persona: titulo, objetivo, resultado, justificacion, requisitos, apps,
// responsable, fechas.inicio/objetivo, cambios, extensiones, origen.
//
// SEGURIDAD: todo lo que viene de la forja es dato no confiable. Al registro solo llegan ENTEROS (numeros
// de PR, recuentos), FECHAS con formato y calendario validos, y valores de un ENUM propio; ningun texto
// libre de la forja se copia. Los avisos que se imprimen son una linea, sin control y <= 200 caracteres.
// Fail-closed: sin forja (sin token, otra forja, sin red) o sin el issue, no se escribe nada. El id se
// valida (^\d+$) antes de formar ninguna ruta. Sin shell ni procesos: la forja entra por el transporte
// del motor (ghApi/ghRepo) que recibe quien llama.
'use strict';
const tareas = require('./tareas-json.js');
const tarea = require('./tarea.js');
const migracion = require('./tareas-migracion.js');
const validador = require('./validador-json.js');

const USO = 'uso: harness.js tarea sync <N> [--comprobar] | tarea sync --todas [--comprobar]';
const esEntero = (n) => Number.isInteger(n) && n > 0;
const dia = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(s) && validador.fechaValida(s.slice(0, 10)) ? s.slice(0, 10) : null);
const ls = (t) => tareas.lineaSegura(t, 200);
const copia = (o) => JSON.parse(JSON.stringify(o));
const sinActualizada = (r) => { const c = copia(r); if (c.fechas) delete c.fechas.actualizada; return JSON.stringify(tareas.ordenar(c)); };
const mismoArray = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Lo derivable de la forja aplicado a una COPIA del registro.
 * -> {nuevo, cambios:[descripcion corta], avisos:[texto seguro]}
 */
function derivar(registro, issue, enlaces, cambiosRepo) {
  const n = Number(registro.issue);
  const nuevo = copia(registro);
  nuevo.fechas = nuevo.fechas && typeof nuevo.fechas === 'object' ? nuevo.fechas : {};
  const cambios = [];
  const avisos = [];

  // estado y fecha de cierre
  const cerrado = issue.state === 'closed';
  let estado = registro.estado;
  if (cerrado) estado = issue.state_reason === 'not_planned' ? 'descartada' : 'hecha';
  else if (registro.estado === 'hecha' || registro.estado === 'descartada') estado = 'en_curso';
  if (estado !== registro.estado) { nuevo.estado = estado; cambios.push(`estado ${registro.estado} -> ${estado}`); }

  if (cerrado) {
    const cerrada = dia(issue.closed_at);
    if (!cerrada) avisos.push('fechas.cerrada: la forja no da una fecha de cierre legible; se deja como estaba');
    else if (cerrada !== registro.fechas.cerrada) { nuevo.fechas.cerrada = cerrada; cambios.push(`fechas.cerrada ${registro.fechas.cerrada || '-'} -> ${cerrada}`); }
  } else if (registro.fechas.cerrada) { nuevo.fechas.cerrada = null; cambios.push('fechas.cerrada -> -'); }
  if (!registro.fechas.creada) {
    const creada = dia(issue.created_at);
    if (creada) { nuevo.fechas.creada = creada; cambios.push(`fechas.creada -> ${creada}`); }
  }

  // PR enlazados: union (un PR ya anotado no se pierde)
  const previos = Array.isArray(registro.prs) ? registro.prs.filter(esEntero) : [];
  const enlazados = (enlaces || []).filter((e) => e.issues.has(n)).map((e) => e.number);
  const todos = [...new Set([...previos, ...enlazados])].sort((a, b) => a - b);
  if (!mismoArray(todos, previos)) { nuevo.prs = todos; cambios.push(`prs ${previos.length} -> ${todos.length}`); }

  // subtareas calculadas: checklist del issue + tasks.md de los cambios del issue
  let hechas = 0; let total = 0; const fuente = [];
  const delIssue = migracion.subtareasDeCuerpo(issue.body);
  if (delIssue.total) { hechas += delIssue.hechas; total += delIssue.total; fuente.push('issue'); }
  for (const c of cambiosRepo) if (c.issue === n && c.tareas) { hechas += c.tareas.hechas; total += c.tareas.total; fuente.push(`tasks:${c.slug}`); }
  const s = registro.subtareas || {};
  if (s.hechas !== hechas || s.total !== total || !mismoArray(Array.isArray(s.fuente) ? s.fuente : [], fuente)) {
    nuevo.subtareas = { hechas, total, fuente };
    cambios.push(`subtareas ${s.hechas}/${s.total} -> ${hechas}/${total}`);
  }

  if (estado === 'hecha' && (typeof nuevo.resultado !== 'string' || !nuevo.resultado.trim())) avisos.push('resultado: la tarea esta hecha y falta el resultado — escribelo con: harness.js tarea set <N> resultado "..."');
  if (estado === 'descartada' && (typeof nuevo.justificacion !== 'string' || !nuevo.justificacion.trim())) avisos.push('justificacion: la tarea esta descartada y falta la justificacion — escribela con: harness.js tarea set <N> justificacion "..."');
  return { nuevo, cambios, avisos: avisos.map(ls) };
}

/**
 * ids: ['7', ...] o null (= todos los registros numericos). gh: {ghApi, ghRepo}.
 * -> {resultados:[{id, accion:'actualizar'|'igual'|'omitir', cambios, avisos, motivo?}]}
 * Lanza Error (sin escribir nada) si no hay forja o si un id no es valido.
 */
async function sincronizar(root, ids, { gh = null, ahora = new Date(), comprobar = false } = {}) {
  const explicitos = Array.isArray(ids);
  const lista = explicitos ? ids : tareas.listar(root).filter((i) => /^\d+$/.test(i));
  for (const id of lista) {
    if (/^L-\d+$/.test(id)) throw new Error(`${id} es una tarea local sin issue: no hay nada que sincronizar con la forja`);
    if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new Error(`id de tarea no valido '${String(id).slice(0, 40)}': usa un numero (7)`);
  }
  if (!lista.length) return { resultados: [] };
  let forja = null;
  try { forja = await migracion.leerForja(gh); } catch { forja = null; }
  if (!forja) throw new Error('no se pudo leer la forja (sin token, otra forja o sin red): no se sincroniza nada');
  const issues = new Map();
  for (const i of forja.issues || []) if (i && esEntero(i.number) && !i.pull_request && !issues.has(String(i.number))) issues.set(String(i.number), i);
  const cambiosRepo = migracion.leerCambios(root);
  // issuesDePr UNA vez por PR (no por registro): el texto del PR es dato no confiable y puede ser enorme
  const enlaces = (forja.prs || []).filter((p) => p && esEntero(p.number)).map((p) => ({ number: p.number, issues: tarea.issuesDePr(p) }));

  const resultados = [];
  for (const id of lista) {
    const registro = tareas.leer(root, id);
    if (!registro || typeof registro !== 'object' || Array.isArray(registro)) { resultados.push({ id, accion: 'omitir', cambios: [], avisos: [], motivo: `no hay registro legible (${tareas.DIR_REL}/${id}.json)` }); continue; }
    const issue = issues.get(id);
    if (!issue) { resultados.push({ id, accion: 'omitir', cambios: [], avisos: [], motivo: 'el issue no existe en la forja' }); continue; }
    const malo = tareas.validarEstructura(registro);
    if (malo.length) { resultados.push({ id, accion: 'omitir', cambios: [], avisos: [], motivo: `registro no valido, se salta: ${ls(malo[0], 100)}` }); continue; }
    if (String(registro.issue) !== id) { resultados.push({ id, accion: 'omitir', cambios: [], avisos: [], motivo: 'el campo issue del registro no coincide con su nombre de fichero' }); continue; }
    const { nuevo, cambios, avisos } = derivar(registro, issue, enlaces, cambiosRepo);
    if (sinActualizada(nuevo) === sinActualizada(registro)) { resultados.push({ id, accion: 'igual', cambios: [], avisos }); continue; }
    const errores = tareas.validarEstructura(nuevo);
    if (errores.length) { resultados.push({ id, accion: 'omitir', cambios: [], avisos, motivo: `el resultado no cumple el esquema: ${ls(errores[0])}` }); continue; }
    if (!comprobar) tareas.escribir(root, id, nuevo, { ahora });
    resultados.push({ id, accion: 'actualizar', cambios, avisos });
  }
  return { resultados };
}

/** CLI: argv son los argumentos tras 'tarea sync'. -> codigo de salida. */
async function cli(root, argv, { gh = null, ahora = new Date() } = {}) {
  const comprobar = argv.includes('--comprobar');
  const todas = argv.includes('--todas');
  const resto = argv.filter((a) => a !== '--comprobar' && a !== '--todas');
  if ((todas && resto.length) || (!todas && resto.length !== 1) || resto.some((a) => a.startsWith('--'))) { console.error(USO); return 1; }
  let r;
  try { r = await sincronizar(root, todas ? null : [resto[0]], { gh, ahora, comprobar }); } catch (e) { console.error(ls(e.message)); return 1; }
  let deriva = 0; let fallos = 0;
  for (const x of r.resultados) {
    if (x.accion === 'actualizar') { deriva += 1; console.log(`#${x.id}: ${comprobar ? 'deriva' : 'actualizada'} — ${x.cambios.join('; ')}`); }
    else if (x.accion === 'omitir') { if (!todas) fallos += 1; console.log(`#${x.id}: omitida — ${x.motivo}`); }
    for (const a of x.avisos) console.log(`  #${x.id} aviso: ${a}`);
  }
  if (!deriva && !fallos) console.log(r.resultados.length ? 'Sin deriva: los registros coinciden con la forja.' : 'No hay registros numericos que sincronizar.');
  else if (comprobar) console.log(`${deriva} registro(s) con deriva respecto a la forja. Para refrescarlos: harness.js tarea sync ${todas ? '--todas' : resto[0]}`);
  else if (deriva) console.log(`${deriva} registro(s) sincronizado(s). Regenera el indice si cambio el estado: harness.js estado-indice --escribir`);
  if (fallos) return 1;
  return comprobar && deriva ? 1 : 0;
}

module.exports = { derivar, sincronizar, cli };
