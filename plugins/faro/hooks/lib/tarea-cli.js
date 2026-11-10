// lib/tarea-cli.js — `harness.js tarea ...` y `harness.js resumen-json ...`.
//
//   tarea <id>                      resumen de <= 12 lineas del registro
//   tarea <id> --campo a.b.c        UNA linea con el valor (el modelo recibe el dato, no el fichero)
//   tarea <id> --json               el registro entero
//   tarea validar [<id>]            valida todos (o uno); exit 1 si hay errores
//   tarea set <id> <campo> <valor>  cambia un campo simple con validacion previa
//   resumen-json [--comprobar]           genera gestion/resumen.json (o comprueba que esta al dia)
//   estado-indice [--comprobar|--escribir]  regenera las lineas de tarea de ESTADO.md desde los JSON
//   (tarea migrar y tarea sync los atiende harness.js: necesitan la forja; ver lib/tareas-migracion.js y lib/tarea-sync.js)
//
// Se despacha al principio de harness.js, antes de cargar el motor (como tdd.js).
'use strict';
const tareas = require('./tareas-json.js');

const err = (m) => { console.error(m); return 1; };

function resumenCorto(id, r) {
  const f = r.fechas || {};
  const s = r.subtareas || {};
  const ls = tareas.lineaSegura;   // el contenido del JSON es dato, no instruccion: una linea, sin control, recortado
  const lineas = [
    `${tareas.etiqueta(id)} · ${ls(r.titulo)} — ${ls(r.estado, 30)}`,
    `Fase ${ls(r.fase, 10)}${Array.isArray(r.apps) && r.apps.length ? ` · apps: ${ls(r.apps.join(', '))}` : ''}${r.responsable ? ` · responsable: @${ls(r.responsable, 40)}` : ''}`,
    `Objetivo: ${ls(r.objetivo)}`,
    `Resultado: ${r.resultado == null ? '(sin resultado)' : ls(r.resultado)}`,
    `Fechas: creada ${f.creada || '-'} · inicio ${f.inicio || '-'} · objetivo ${f.objetivo || '-'} · cerrada ${f.cerrada || '-'}`,
    `Subtareas: ${s.hechas}/${s.total}`,
  ];
  if (Array.isArray(r.cambios) && r.cambios.length) lineas.push(`Cambios: ${r.cambios.map((c) => `${c.slug} (${c.estado})`).join(', ')}`.slice(0, 200));
  if (Array.isArray(r.requisitos) && r.requisitos.length) lineas.push(`Requisitos: ${r.requisitos.join(', ')}`);
  if (Array.isArray(r.prs) && r.prs.length) lineas.push(`PRs: ${r.prs.map((p) => `#${p}`).join(', ')}`);
  if (r.justificacion) lineas.push(`Justificacion: ${ls(r.justificacion)}`);
  if (r.origen && Array.isArray(r.origen.revisar) && r.origen.revisar.length) lineas.push(`A revisar (migrada): ${r.origen.revisar.join(', ')}`);
  return lineas.slice(0, 12);
}

function cmdValidar(root, id) {
  if (id != null && !tareas.esIdValido(id)) return err(`id de tarea no valido '${String(id).slice(0, 40)}'`);
  const { total, problemas } = tareas.validarTodo(root, id ? { id } : {});
  // Migrados con campos por revisar: informativo, no cuenta como error.
  for (const p of tareas.pendientesDeRevisar(root).filter((x) => !id || x.id === id)) console.log(`${tareas.etiqueta(p.id)} [revisar] pendiente de revisar (migrada): ${p.revisar.join(', ')}`);
  if (!problemas.length) { console.log(`${total} registro(s) de tarea validos.`); return 0; }
  for (const p of problemas) console.log(`${tareas.etiqueta(p.id)} [${p.tipo}] ${p.mensaje}`);
  console.error(`${problemas.length} problema(s) en ${total} registro(s).`);
  return 1;
}

function cli(cmd, root, argv) {
  if (cmd === 'resumen-json') return require('./resumen-json.js').cli(root, argv);
  if (cmd === 'estado-indice') return require('./estado-indice.js').cli(root, argv);
  const [primero, ...resto] = argv;
  if (primero === 'validar') return cmdValidar(root, resto[0]);
  if (primero === 'set') {
    const [id, campo, ...valor] = resto;
    if (!id || !campo || valor.length === 0) return err('uso: harness.js tarea set <id> <campo> <valor>');
    try {
      tareas.establecer(root, id, campo, valor.join(' '));
      console.log(`${tareas.etiqueta(id)}: ${campo} actualizado.`);
      return 0;
    } catch (e) { return err(e.message); }
  }
  if (!primero) return err('uso: harness.js tarea <id> [--campo a.b.c] [--json] | tarea validar [<id>] | tarea set <id> <campo> <valor> | tarea migrar [--dry-run] [--confirmo] [--incluir-cerradas] | tarea sync <N>|--todas [--comprobar]');
  if (!tareas.esIdValido(primero)) return err(`id de tarea no valido '${String(primero).slice(0, 40)}': usa un numero (7) o L-<n>`);
  const r = tareas.leer(root, primero);
  if (!r) return err(`no hay registro legible para la tarea ${primero} (${tareas.dirRel(root)}/${primero}.json)`);
  const i = resto.indexOf('--campo');
  if (i >= 0) {
    if (!resto[i + 1]) return err('--campo necesita un valor, p. ej. fechas.objetivo');
    try { console.log(tareas.campoALinea(tareas.obtenerCampo(r, resto[i + 1]))); return 0; } catch (e) { return err(e.message); }
  }
  if (resto.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  console.log(resumenCorto(primero, r).join('\n'));
  return 0;
}

module.exports = { cli, resumenCorto };
