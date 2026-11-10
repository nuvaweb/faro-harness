// lib/resumen-json.js — gestion/resumen.json: CONTRATO PUBLICO DE LECTURA (#149).
//
// Lo generan los registros de gestion/tareas/*.json y lo leen las integraciones (una app superior,
// ClickUp...) en un solo sentido: repo -> app. Nadie escribe de vuelta en el.
//
// DETERMINISTA: orden estable y ningun instante "de ahora". `generado` es el MAXIMO de
// fechas.actualizada de los registros, asi dos ejecuciones sin cambios dan el mismo fichero byte a
// byte y `--comprobar` puede decidir si esta desactualizado comparando texto.
//
// Forma (v: 1):
//   {v, repo, generado,
//    fases:[{num, nombre, estado, fechas:{inicio, objetivo}, conteos}],
//    apps:[{id, conteos}],
//    entregables:[{id, titulo, fase, apps, estado, fechas:{objetivo}, subtareas:{hechas,total}}]}
//   conteos = {total, pendiente, en_curso, hecha, descartada, bloqueada}
'use strict';
const fs = require('fs');
const path = require('path');
const tareas = require('./tareas-json.js');
const fasesLite = require('./fases-lite.js');

const ESTADOS = ['pendiente', 'en_curso', 'hecha', 'descartada', 'bloqueada'];
const FICHERO_REL = 'gestion/resumen.json';   // relativa al layout antiguo; la real, ficheroRel(root) (#293)
const ficheroRel = (root) => `${require('./paths.js')(root).dir('gestion')}/resumen.json`;
const rutaResumen = (root) => path.join(root, ...ficheroRel(root).split('/'));

const conteoVacio = () => ({ total: 0, ...Object.fromEntries(ESTADOS.map((e) => [e, 0])) });
function contar(c, estado) { c.total += 1; if (ESTADOS.includes(estado)) c[estado] += 1; }

function construir(root) {
  const registros = tareas.listar(root).map((id) => ({ id, r: tareas.leerValido(root, id) })).filter((x) => x.r);   // lo que no valida no entra en el contrato publico
  const declaradas = fasesLite.leerFases(root);

  const fases = new Map(declaradas.map((f) => [f.num, { num: f.num, nombre: f.nombre, estado: f.estado, fechas: { inicio: f.inicio, objetivo: f.objetivo }, conteos: conteoVacio() }]));
  const apps = new Map();
  try {
    const a = require('./apps.js');
    if (a.esMonorepo(root)) for (const x of a.apps(root)) apps.set(x.id, conteoVacio());
  } catch { /* sin apps.js legible */ }

  const entregables = [];
  let generado = null;
  for (const { id, r } of registros) {
    const num = Number.isInteger(r.fase) ? r.fase : null;
    if (num != null) {
      if (!fases.has(num)) fases.set(num, { num, nombre: null, estado: null, fechas: { inicio: null, objetivo: null }, conteos: conteoVacio() });
      contar(fases.get(num).conteos, r.estado);
    }
    const misApps = Array.isArray(r.apps) ? [...r.apps].sort() : [];
    for (const a of misApps) { if (!apps.has(a)) apps.set(a, conteoVacio()); contar(apps.get(a), r.estado); }
    const act = r.fechas && r.fechas.actualizada;
    if (typeof act === 'string' && (generado === null || act > generado)) generado = act;
    const s = r.subtareas || {};
    entregables.push({
      id, titulo: r.titulo, fase: num, apps: misApps, estado: r.estado,
      fechas: { objetivo: (r.fechas && r.fechas.objetivo) || null },
      subtareas: { hechas: Number.isInteger(s.hechas) ? s.hechas : 0, total: Number.isInteger(s.total) ? s.total : 0 },
    });
  }
  return {
    v: 1,
    repo: fasesLite.cabecera(root).nombre || path.basename(root),
    generado,
    fases: [...fases.values()].sort((a, b) => a.num - b.num),
    apps: [...apps.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id, conteos]) => ({ id, conteos })),
    entregables,
  };
}

const serializar = (obj) => JSON.stringify(obj, null, 2) + '\n';

/** Escribe gestion/resumen.json (atomico). Devuelve {ruta, cambio:boolean}. */
function escribir(root) {
  const ruta = rutaResumen(root);
  const texto = serializar(construir(root));
  let previo = null;
  try { previo = fs.readFileSync(ruta, 'utf8'); } catch { /* aun no existe */ }
  if (previo === texto) return { ruta, cambio: false };
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const tmp = `${ruta}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, texto); fs.renameSync(tmp, ruta); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ya no esta */ } throw e; }
  return { ruta, cambio: true };
}

/** ¿Esta resumen.json al dia con los registros? -> {ok, motivo}. */
function comprobar(root) {
  let previo;
  try { previo = fs.readFileSync(rutaResumen(root), 'utf8'); } catch { return { ok: false, motivo: `falta ${ficheroRel(root)}` }; }
  return serializar(construir(root)) === previo ? { ok: true, motivo: null } : { ok: false, motivo: `${ficheroRel(root)} esta desactualizado` };
}

/** Aviso para `validate`: null si no hay tareas, o esta al dia. */
function aviso(root) {
  if (!tareas.hayTareas(root) || tareas.listar(root).length === 0) return null;
  const c = comprobar(root);
  return c.ok ? null : `${c.motivo}: regeneralo con 'harness.js resumen-json'.`;
}

function cli(root, argv) {
  if (argv.includes('--comprobar')) {
    const c = comprobar(root);
    if (c.ok) { console.log(`${ficheroRel(root)} al dia.`); return 0; }
    console.error(`${c.motivo}. Regeneralo con: harness.js resumen-json`);
    return 1;
  }
  const r = escribir(root);
  console.log(r.cambio ? `${ficheroRel(root)} generado.` : `${ficheroRel(root)} sin cambios.`);
  return 0;
}

module.exports = { FICHERO_REL, ficheroRel, ESTADOS, construir, serializar, escribir, comprobar, aviso, cli };
