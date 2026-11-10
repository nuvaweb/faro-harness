---
description: "Úsala cuando un cambio spec-driven está COMPLETADO — aplica sus deltas a las specs vivas y lo mueve a archive/. Si sigue abierto, /faro:sync."
argument-hint: "[cambio]"
---

Cierra un **cambio spec-driven FARO** completado. Ejecútalo **TÚ inline**. Cambio: $ARGUMENTS (si es ambiguo, lista `faro/gestion/cambios/changes/` y pregunta).

1. **El harness lo fuerza (gate determinista, no cortesía)**: `specs archivar` ABORTA si el ciclo está abierto — proposal en `estado: implementada` con `aprobada_por`, `tasks.md` con TODOS los checkboxes `- [x]`, y sin `[CLARIFICAR]`. Si algo falta, el motor dice QUÉ cerrar y no archiva. (Caso larga vida: `specs sync` publica specs sin cerrar.)
2. **Simula primero**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" specs archivar <cambio> --dry-run` — enseña al usuario QUÉ va a pasar con las specs vivas (requisitos añadidos/modificados/eliminados/renombrados).
3. **Confirma y archiva**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" specs archivar <cambio>` — el motor nativo aplica los deltas a `faro/gestion/cambios/specs/<capacidad>/spec.md` (orden RENAMED→REMOVED→MODIFIED→ADDED; una spec nueva solo admite AÑADIDOS) y mueve el cambio a `faro/gestion/cambios/changes/archive/<cambio>/` (slug limpio, SIN fecha — convención OpenSpec; el histórico temporal vive en el frontmatter y en git).
4. Si el cambio **no tiene deltas** (formato legado proposal+tasks): archívalo moviéndolo a `archive/` a mano y sugiere que los próximos cambios incluyan deltas (`/faro:cambio`).
5. **Commitea** el resultado (specs vivas actualizadas + cambio archivado) y refleja la tarea cubierta en `faro/ESTADO.md` si procede.

Caso especial — cambio de larga vida que quiere publicar specs SIN cerrar: usa `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" specs sync <cambio>` (aplica los deltas y el cambio sigue activo).
