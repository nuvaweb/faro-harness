---
description: "Úsala para renombrar o re-terminar un repo FARO — forja con redirecciones, concepto con alias, metadatos y referencias; el slug no cambia (renombrador-faro)."
disable-model-invocation: true
argument-hint: "[nombre o término nuevo]"
---

Adopta el rol **renombrador-faro** (agente del plugin) y ejecútalo **TÚ en esta conversación (hilo principal)**, NO como subagente — así `AskUserQuestion` funciona y puedes preguntar al usuario con opciones. El renombrado toca varias cosas: **presenta el plan "de → a" y el impacto, no asumas, pregunta y confirma antes de tocar nada**.

Petición del usuario: $ARGUMENTS (el nombre/término nuevo).

Re-termina el repo SIN romper nada: renombra en GitHub vía API (con **redirecciones automáticas**), actualiza el `origin` local, pone el nombre nuevo al `concepto` y el viejo como **alias** (el `slug` NO cambia = el ancla), estampa metadato + topic `antes-<slug>`, y actualiza referencias en docs con criterio. Valida con `harness.js status` + `git fetch`.
