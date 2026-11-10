// lib/ir-cli.js — `harness.js ir <ref> [--campo a.b] [--json]` y `harness.js refs <ref> [--json]` (#157).
//
//   ir <ref>              tipo, ruta, estado, resumen (1-3 lineas) y relacionados; <= 20 lineas
//   ir <ref> --campo a.b  UNA linea con ese valor (del registro; cae a ruta/estado/...)
//   ir <ref> --json       el resultado entero, para integraciones
//   refs <ref>            quien cita esa referencia (tareas, cambios, documentos, ESTADO.md)
//
// Referencia desconocida, mal formada o ambigua -> mensaje claro y exit 1.
// Se despacha al principio de harness.js, antes de cargar el motor (como `tarea`).
'use strict';
const tareas = require('./tareas-json.js');
const nav = require('./navegacion.js');

const err = (m) => { console.error(m); return 1; };
const MAX_LINEAS = 20;
const MAX_REL = 14;

function parsear(argv) {
  const o = { ref: null, campo: null, json: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--campo') { o.campo = argv[++i]; if (!o.campo) o.error = '--campo necesita un valor (ej. --campo fechas.objetivo)'; }
    else if (a.startsWith('--')) o.error = `opción desconocida '${a.slice(0, 30)}'`;
    else if (o.ref == null) o.ref = a;
    else o.error = 'solo se admite una referencia';
  }
  return o;
}

function texto(r) {
  const rel = r.relacionados.length > MAX_REL ? `${r.relacionados.slice(0, MAX_REL).join(' · ')} · (+${r.relacionados.length - MAX_REL} más)` : r.relacionados.join(' · ');
  const l = [
    `${r.tipo} ${r.ref}`,
    `ruta: ${r.ruta}`,
    `estado: ${r.estado}`,
    ...r.resumen.slice(0, 3),
    ...(rel ? [`relacionados: ${rel}`] : []),
  ];
  return l.slice(0, MAX_LINEAS).join('\n');
}

function ir(root, argv) {
  const o = parsear(argv);
  if (o.error) return err(`uso: harness.js ir <ref> [--campo a.b] [--json] — ${o.error}`);
  if (!o.ref) return err('uso: harness.js ir <ref> [--campo a.b] [--json] — ej. ir #149 · ir REQ-136 · ir cambio:mi-cambio · ir fase:2 · ir app:api · ir ACME-FUN-001');
  let r;
  try { r = nav.resolver(root, o.ref); } catch (e) { return err(e.message); }
  if (o.campo) {
    for (const base of [r, r.datos]) {
      try { console.log(tareas.campoALinea(tareas.obtenerCampo(base, o.campo))); return 0; } catch { /* siguiente */ }
    }
    return err(`el campo '${String(o.campo).slice(0, 60)}' no existe en ${r.ref} (prueba: tipo, ruta, estado, resumen, relacionados, o un campo del registro)`);
  }
  if (o.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
  console.log(texto(r));
  return 0;
}

function refs(root, argv) {
  const o = parsear(argv);
  if (o.error || !o.ref || o.campo) return err(`uso: harness.js refs <ref> [--json]${o.error ? ` — ${o.error}` : ''}`);
  let lista;
  try { lista = nav.citas(root, o.ref); } catch (e) { return err(e.message); }
  if (o.json) { console.log(JSON.stringify({ ref: o.ref, citas: lista }, null, 2)); return 0; }
  if (!lista.length) { console.log(`Nadie cita ${o.ref}.`); return 0; }
  console.log(`${o.ref} la citan ${lista.length}:`);
  for (const c of lista.slice(0, MAX_REL)) console.log(`  ${c.tipo.padEnd(7)} ${c.ruta}`);
  if (lista.length > MAX_REL) console.log(`  … y ${lista.length - MAX_REL} más (--json para todas)`);
  return 0;
}

function cli(cmd, root, argv) { return cmd === 'ir' ? ir(root, argv) : refs(root, argv); }

module.exports = { cli, ir, refs };
