---
description: "Úsala para saber qué está terminado pero sin integrar y quién lo desbloquea — ramas sin PR y PRs abiertos a main esperando CI o revisión."
---

Ejecuta `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" pendientes` y presenta al usuario el panel de integración de forma clara:

1. **Ramas sin PR**: rama, responsable (autor) y resumen de commits — trabajo que no ha pedido entrar en `main`. Si es suya, propón `/faro:pr`; si es de otro, a quién preguntar.
2. **PRs abiertos a main**: número, autor, título y en qué está cada uno (esperando CI, CI en rojo, esperando revisión, auto-merge activado o no) — para saber qué entrará solo y qué está atascado y de quién depende.

Recuerda que no hay nada que "publicar" a mano: cada PR entra solo en `main` cuando el CI pasa (auto-merge) y, al integrarse, el CI publica la versión que marque su título. Si un PR está en rojo o sin revisor, eso es lo que hay que desbloquear (ver el detalle con `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" pr ver <n>`). Si no hay nada pendiente, dilo brevemente. Es una consulta de lectura, sin ceremonia.
