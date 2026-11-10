---
description: "Úsala cuando pregunten «¿cómo va esto?», «¿por dónde vamos?», «¿qué falta?» o al retomar un trabajo — foto ejecutiva: fase, avance, tareas, validación y git."
---

Ejecuta `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" validate` y `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" stats`, lee faro/ESTADO.md y faro/gestion/risks.md, y presenta al usuario un resumen ejecutivo breve: fase en curso y progreso, validación (verde/errores), riesgos e impedimentos destacados, actividad git reciente y referente por área. Sin ceremonias: es una consulta de lectura.

Si necesitas el detalle que el arranque de sesión ya no inyecta (es un índice: convenciones, inventario de documentos, requisitos uno a uno, código, planes), pídelo con `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" estado`.
