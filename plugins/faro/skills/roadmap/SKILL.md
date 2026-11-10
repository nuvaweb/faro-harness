---
description: "Úsala para una hoja de ruta visual que responde «dónde estamos» — carril de fases, posición según el avance real, fases sin cerrar y obstáculos. Para cliente y equipo."
argument-hint: "[foco opcional]"
---

> **Rama de trabajo (obligatorio antes de generar):** el roadmap se ESCRIBE. Si estás en `main`/`master`/`develop`, NO generes aquí — abre primero una rama `docs/<tema>` (`node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" rama docs "<tema>"`), genera ahí y entra por PR a develop (`/faro:pr`). El harness lo bloquea si lo intentas en rama protegida.

Genera la **hoja de ruta visual** del trabajo: A4 **horizontal**, pensada para que alguien que no sigue el proyecto a diario entienda en diez segundos dónde está, qué queda y qué lo frena.

**No lo confundas con `/faro:onepager`**: ese responde *"¿qué decido?"* (denso, RAG + KPIs + decisiones, para comité de dirección). Este responde *"¿dónde estamos?"* (visual, para **cliente y equipo**). Misma verdad, lectura distinta. Si el usuario pide "algo para presentar a dirección", es el one-pager.

## Mecánica

1. **Genera** con `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" roadmap` — deriva TODO de `faro/ESTADO.md` + `faro/gestion/risks.md` (no inventa nada) y escribe `faro/gestion/reporting/presentaciones/roadmap-AAAA-MM-DD.html`. **Datado como todo el reporting**: misma fecha → ACTUALIZA ese fichero; fecha nueva → snapshot nuevo. No hay "roadmap vivo": el vigente es el de fecha más reciente.

2. **Interpreta la salida** y explícasela al usuario en llano. El comando ya resume avance, fase, motivo, fases sin cerrar y nº de obstáculos.

3. **Avisa de lo que resta valor** (sin asumir, preguntando):
   - **Fases sin `Objetivo: AAAA-MM-DD`** en `faro/ESTADO.md` → el carril sale sin fechas y no se puede juzgar el plazo. Es lo que más empobrece el resultado; ofrece añadirlas.
   - **Sin riesgos en `faro/gestion/risks.md`** → el bloque "qué nos frena" sale vacío. Pregunta si de verdad no hay ninguno o es que no están registrados.
   - **Fases marcadas "sin cerrar"** (se saltaron: quedaron abiertas y el trabajo ya va por una posterior) → señálalo, es una señal de gestión real: o se cierran, o se replantea el faseo.

## Qué dibuja, y de dónde sale

Es un **milestone chart** estándar, no una metáfora: el lector no tiene que aprender una leyenda nueva.

- **Marcador "HOY"**: línea vertical + etiqueta sobre el carril, posicionada por `avance.pct` (fases cerradas + progreso de la fase en curso, así que avanza de forma continua). Es lo que responde *"dónde estamos"* de un vistazo.
- **Semáforo por hito**: verde cerrada · ámbar vence en ≤15 días · rojo retrasada o sin cerrar · gris pendiente.
- **Rombo** para los hitos que son puerta de decisión (fin de fase con fecha objetivo); punto para el resto.
- **Fase sin cerrar**: quedó abierta y el trabajo ya va por una posterior — se marca en rojo. Es una señal de gestión: o se cierra, o se replantea el faseo.
- **Obstáculos**: los riesgos abiertos más severos, anclados a la fase en curso.

Foco opcional del usuario: $ARGUMENTS. **No inventes cifras ni fechas**: lo que falta, se dice que falta.

Recuérdale: **Imprimir → PDF** (sale en A4 horizontal) para compartirlo. Si estás en `develop`/`feature`, commitea el HTML generado.
