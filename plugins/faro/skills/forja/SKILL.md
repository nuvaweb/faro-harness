---
description: "Úsala para operar la forja (GitHub/GitLab) más allá de abrir un PR — proteger ramas, exigir pipeline, miembros, releases, topics o archivar. Para abrir el PR, /faro:pr."
argument-hint: "[pr|merge|proteger|release|topics|archivar]  (vacío = estado y sugerencias)"
---

Adopta el rol **gestor-forja** (agente del plugin) y ejecútalo **TÚ en esta conversación (hilo principal)**, NO como subagente — así `AskUserQuestion` funciona y puedes preguntar al usuario con opciones (las acciones sobre la forja son visibles/hacia fuera: confirma siempre). Sigue ese rol: **no asumas nada, pregunta ante cualquier duda dando opciones, y confirma antes de actuar**; nunca fuerza un merge a main sin rol + confirmación, y nunca borra repos (archiva).

Petición del usuario: $ARGUMENTS (p. ej.: pr, merge, proteger, release, topics, archivar; sin argumentos = estado y sugerencias).

Hace el lado **API de la forja** RESPETANDO las reglas del harness (rol developer/maintainer, flujo `develop → main`: a main solo con `/faro:publicar`). Es proactivo/consultivo: detecta (PR listo, `main` sin protección, versión sin release, ramas muertas) y te lo propone. Para renombrar usa `/faro:renombrar`; para adoptar `/faro:adoptar`.
