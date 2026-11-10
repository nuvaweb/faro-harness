---
description: "Úsala cuando se acumulen ramas y no sepas cuáles están integradas — distingue muertas (aunque fuera squash) de vivas y borra solo las muertas, con tu confirmación."
---

Normaliza las ramas del repo con `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" ramas` (petición del usuario: $ARGUMENTS).

Por defecto **solo informa** (read-only): ejecuta `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" ramas` y presenta el resultado — **☠ MUERTAS** (integradas en la base develop/main, incluye squash/rebase con el contenido ya en base) vs **● VIVAS** (trabajo NO integrado, con aviso de *posible abandono* si llevan mucho sin tocar). Protege SIEMPRE la rama actual, `main`/`master` y la base.

Si el usuario pide **limpiar / purgar**:
- Muestra primero el informe y **pide confirmación** (se van a borrar ramas locales).
- Con el OK, ejecuta `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" ramas --purge` (añade `--remotes` si quiere podar también `origin`). Borra SOLO las muertas; **las vivas NUNCA se tocan**.
- No borres ramas a mano: deja que el script decida (`-d` para mergeadas, `-D` solo para las squash ya integradas). Ajusta el umbral de abandono con `--stale <dias>` si lo pide.

**Worktrees de agentes.** Las ramas no son lo único que se acumula: los agentes aislados dejan worktrees en `.claude/worktrees/`. FARO ya borra solo los limpios e integrados al arrancar la sesión y al terminar cada agente; para verlos o forzar el barrido ejecuta `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" worktrees` (lista) o `... worktrees --limpiar` (borra solo los **limpios con su rama integrada**; un worktree con cambios sin guardar o rama sin integrar NUNCA se borra: se cita por nombre y decide el usuario). Hazlo antes de `--purge`: al quitar el worktree, su rama pasa a poder borrarse como muerta.

Presenta: cuántas muertas se borraron, qué vivas se mantienen (y si alguna lleva demasiado sin actividad → decisión del usuario), y si podaste remotas.
