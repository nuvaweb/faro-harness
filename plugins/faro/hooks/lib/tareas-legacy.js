// lib/tareas-legacy.js — detector de tareas escritas a mano en ESTADO.md que aun NO viven como
// issues de la forja (0.31.2). Puramente local (solo mira las fases YA PARSEADAS de ESTADO.md, sin
// red): un repo que actualiza el plugin no se entera de que 'asignar-tarea --hito' existe hasta que
// alguien tropieza con el bloqueo al crear una tarea nueva. Este aviso adelanta ese momento al
// arranque de sesion, en el mismo sitio donde ya se avisa de ESTADO.md ausente (onboardingDirective).
//
// Criterio DETERMINISTA, no heuristica de contenido: una tarea es "detalle operativo real" si su
// texto supera un largo minimo (referencias a documentos, responsables, decisiones no caben en una
// linea corta). Una fase con tareas placeholder ("- [ ] algo") no dispara el aviso: no hay evidencia
// de que sea trabajo real sin migrar, y avisar sin evidencia entrena a ignorar el aviso.
'use strict';

const LARGO_MINIMO = 60;       // caracteres: por debajo, se trata como placeholder/nota, no tarea real
const MIN_TAREAS_LARGAS = 2;   // 1 tarea larga aislada no basta para sugerir migrar un fichero entero

function tareasLegacySinMigrar(fases) {
  if (!Array.isArray(fases) || !fases.length) return [];
  const conDetalle = [];
  for (const f of fases) {
    const tareas = Array.isArray(f.tareas) ? f.tareas : [];
    const abiertasLargas = tareas.filter((t) => !t.done && typeof t.text === 'string' && t.text.length >= LARGO_MINIMO);
    if (abiertasLargas.length >= MIN_TAREAS_LARGAS) conDetalle.push({ num: f.num, nombre: f.nombre, n: abiertasLargas.length });
  }
  if (!conDetalle.length) return [];
  const detalle = conDetalle.map((f) => `Fase ${f.num} (${f.nombre}): ${f.n} tarea(s)`).join(' · ');
  return [
    `TAREAS SIN MIGRAR a la forja — ${detalle}. Estas tareas viven solo como texto en ESTADO.md: no ` +
    `cuentan para la vigilancia de tareas de plan ni se anclan a ningun hito, y una fase con ellas ` +
    `dentro no se puede cerrar con el criterio nuevo (cierre forzoso). Considera /faro:migrar-tareas.`,
  ];
}

module.exports = { tareasLegacySinMigrar, LARGO_MINIMO, MIN_TAREAS_LARGAS };
