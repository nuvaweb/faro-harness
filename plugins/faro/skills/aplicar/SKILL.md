---
description: "Úsala para implementar un cambio spec-driven APROBADO — genera y ejecuta su tasks.md contra la proposal y los deltas, marcando checkboxes."
argument-hint: "[cambio]"
---

Implementa un **cambio spec-driven FARO** aprobado. Ejecútalo **TÚ inline**. Cambio objetivo: $ARGUMENTS (si es ambiguo, lista `gestion/cambios/changes/` y pregunta con `AskUserQuestion`).

1. **Verifica el gate** (lo refuerza el harness): la `proposal.md` debe estar `estado: aprobada` (con `aprobada_por`) y **sin `[CLARIFICAR:]`** pendientes. Si no → PARA y dilo (la aprobación es humana).
2. **Si no existe `tasks.md`**: genéralo AHORA desde la proposal y sus **deltas** (`specs/<capacidad>/spec.md`) con el formato de abajo: cada requisito/escenario debe quedar cubierto por al menos una tarea (los escenarios son los criterios de aceptación → tests). Checkboxes `- [ ]`, con `[resp: <email>]` si hay responsable.
3. **Implementa contra tasks.md**: una tarea → su código/documento → su verificación (test que cubre el escenario) → marca `- [x]` → siguiente. **No te salgas del alcance de la spec**; si aparece alcance nuevo, créalo como OTRO cambio (`/faro:cambio`).
4. En repos de código: los **gates** deben quedar verdes (`node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" gates`) — "hecho" = verde. En un monorepo corren los de las apps que toca el cambio (y sus dependientes); `--app <id>` o `--todas` para forzar.
5. Al completar todas las tareas: sugiere cerrar con `/faro:archivar <cambio>` (aplica los deltas a las specs vivas y archiva) y pon `estado: implementada`.

Nada "a la ligera": si una tarea revela que la spec estaba mal, **corrige primero la spec** (con el usuario) y luego el código.

## Formato de tasks.md

La jerarquía no cambia: **fase = hito · issue = entregable de valor (su rama y su PR) · tareas = las
líneas de este tasks.md**. Una tarea nunca es un issue aparte. Agrupa las tareas por **historia**
(`US-n`): un trozo del entregable que se puede enseñar y probar solo. Un issue pequeño tiene una
sola historia. Marcas de cada línea:

- `T001`…: identificador correlativo, para citar la tarea en commits y en el PR.
- `[P]`: **paralelizable**. Toca ficheros distintos y no depende de ninguna tarea sin terminar, así
  que se puede dar a otro subagente a la vez. Sin `[P]`, va en orden.
- `[US-n]`: la historia a la que sirve. La cabecera de cada historia cita el issue (`#N`).
- **Test que debe fallar antes**: la primera tarea de cada historia es su test, sacado del
  escenario del delta. Se ejecuta y **tiene que fallar por la razón correcta** antes de implementar.
  Un test que pasa sin el código no demuestra nada.
- **Checkpoint**: la última línea de cada historia. Sus tests pasan y la historia funciona sola. No
  se empieza la siguiente sin él.

```markdown
# Tareas — <cambio> (issue #N)

## US-1 · <lo que se puede hacer al acabar esta historia> (#N)
- [ ] T001 [US-1] Test que debe FALLAR antes: <escenario del delta> en test/<fichero>
- [ ] T002 [US-1] <implementación mínima que lo pone en verde> en <ruta>
- [ ] T003 [P] [US-1] <tarea independiente: otro fichero, sin depender de T002>
- [ ] T004 [US-1] Checkpoint US-1: tests de la historia en verde y la historia se puede enseñar sola

## US-2 · <siguiente historia> (#N)
- [ ] T005 [US-2] Test que debe FALLAR antes: <escenario> en test/<fichero>
- [ ] T006 [US-2] <implementación>
- [ ] T007 [US-2] Checkpoint US-2: tests en verde
```

Cada línea empieza por `- [ ]`, así que el progreso y el gate de archivar la cuentan igual que antes.
Las marcas van **después** del checkbox, nunca dentro de él.

**Delegar una tarea `[P]` a un subagente:** pásale la ficha del issue
(`node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" ficha <N>`, menos de 2.000 tokens: issue, app y sus
rasgos, cambio vinculado y rutas) junto con las líneas de la tarea. Así no tiene que reconstruir el
contexto.
