---
description: "Úsala para saber qué está terminado pero sin integrar y quién lo desbloquea — ramas sin llegar a develop y lo de develop pendiente de publicar a main."
---

Ejecuta `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" pendientes` y presenta al usuario el panel de promoción de forma clara:

1. **Features sin integrar en develop**: rama, responsable (autor) y resumen de commits — para saber qué está en vuelo y de quién.
2. **Develop pendiente de publicar a main**: nº de commits por autor con sus mensajes — para que quien puede publicar sepa qué entra y a quién preguntar dudas.

Si hay algo pendiente de publicar, recuerda que se publica con `/faro:publicar` (lo decide quien tiene permiso, no Claude) y sugiere validar antes con `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" validate`. Si no hay nada pendiente, dilo brevemente. Es una consulta de lectura, sin ceremonia.
