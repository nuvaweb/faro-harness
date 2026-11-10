---
description: "Úsala para adoptar o reenfocar un repo existente al harness FARO — re-mapea lo que hay al layout FARO sin perder contexto ni tocar el stack, y valida (rol adoptador-faro)."
argument-hint: "[carpeta/repo o instrucciones]"
---

Adopta el rol **adoptador-faro** (agente del plugin) y ejecútalo **TÚ en esta conversación (hilo principal)**, NO como subagente — así `AskUserQuestion` funciona y puedes preguntar al usuario con opciones. **Presenta el plan "de → a" y aplica solo con confirmación; no decidas en silencio lo dudoso (naturaleza, clasificación, re-mapeo): pregunta con opciones.**

Petición del usuario: $ARGUMENTS.

Contexto: normalmente se ejecuta DESPUÉS de `faro adoptar` (CLI, fase 1) que ya copió la base del harness y dejó las colisiones como `*.faro`. Aquí viene la parte inteligente: lee `${CLAUDE_PLUGIN_ROOT}/hooks/harness-manifest.json`, inventaría lo que ya hay (código, `faro/gestion/`, specs, `CLAUDE.md`, docs), lo **re-mapea** al layout FARO (mueve/funde con `git mv`, NUNCA borra), rellena `faro/config.json` (entidad/domain/concepto), y al final **valida con el harness** (`harness.js status`). El **stack (wrangler/package/código) es intocable**. Por carpeta: una a la vez (p. ej. `back` y `front`).

**Qué hace adoptar (spec, en orden) — el rol lo detalla; aquí el resumen contractual:**

1. **Analiza** la estructura Y el contenido: qué es el repo, su stack/naturaleza, y qué contienen sus ficheros (código, una `gestion/` propia, specs, `CLAUDE.md`, docs, README, un `ESTADO.md`). Todo lo de FARO acaba bajo `faro/`; si el repo ya era FARO con el layout antiguo (todo en la raíz), empieza por `harness.js migrar-layout --dry-run` y, con el OK, `migrar-layout`.
2. **Valida/ajusta el README** según el contexto REAL descubierto (propósito real + capa FARO), sin arrastrar texto genérico de plantilla.
3. **Reestructura a la taxonomía FARO de la plataforma** — **detecta la naturaleza** (doc / worker / app) y aplica el layout que le corresponde (`faro/documentos/`, `faro/gestion/cambios/`, `faro/notebooks/`, `faro/fuentes/`…); mueve/funde con `git mv`, nunca borra.
4. **Pregunta por los documentos sueltos** (AskUserQuestion): naturaleza, clasificación, destino y si un `.md` es spec o documento — no decide en silencio lo dudoso.
   Asegura también `.claude/worktrees/` en el `.gitignore` (`node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" worktrees --ignorar`).
5. **Aplica la nomenclatura** a cada documento (`doc_id` vía `docref`, nombre `<doc_id>-<slug>`, ubicación temática en `faro/documentos/`) y **valida con el harness** hasta 0 errores (sin dejar ningún `*.faro` suelto). El método técnico (faro/notebooks/tests/datos) va a la **capa técnica**, no a `faro/documentos/`, y el documento lo referencia.
