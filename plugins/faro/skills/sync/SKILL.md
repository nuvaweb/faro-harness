---
description: "Úsala para volcar a las specs vivas los deltas de un cambio que sigue ABIERTO, sin archivarlo. Para cerrarlo, /faro:archivar. No es /faro:sincronizar (git)."
argument-hint: "[cambio]"
---

Sincroniza las **specs vivas** desde los deltas de un cambio **que sigue activo** (larga vida). Ejecútalo **TÚ inline**. Cambio: $ARGUMENTS (ambiguo → lista `faro/gestion/cambios/changes/` y pregunta).

1. **Simula**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" specs sync <cambio> --dry-run` — enseña qué requisitos se añadirían/modificarían/eliminarían en `faro/gestion/cambios/specs/`.
2. **Confirma con el usuario** y aplica: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" specs sync <cambio>` — los deltas se vuelcan a las specs vivas y el cambio **sigue activo** (no se mueve a archive/).
3. **Commitea** las specs vivas actualizadas.

Cuándo usarlo: el cambio evoluciona durante semanas y otros equipos necesitan la **verdad actual** en `faro/gestion/cambios/specs/` antes del cierre. Para cerrar del todo: `/faro:archivar`. Si el cambio no tiene deltas (formato legado), no hay nada que sincronizar — sugiere añadirlos (`/faro:cambio`).
