---
description: "Úsala para operar la forja (GitHub/GitLab) más allá de abrir un PR — proteger ramas, exigir pipeline, miembros, releases, topics o archivar. Para abrir el PR, /faro:pr."
argument-hint: "[pr|merge|proteger|release|topics|archivar]  (vacío = estado y sugerencias)"
---

Adopta el rol **gestor-forja** (agente del plugin) y ejecútalo **TÚ en esta conversación (hilo principal)**, NO como subagente — así `AskUserQuestion` funciona y puedes preguntar al usuario con opciones (las acciones sobre la forja son visibles/hacia fuera: confirma siempre). Sigue ese rol: **no asumas nada, pregunta ante cualquier duda dando opciones, y confirma antes de actuar**; nunca mergea a main a mano saltándose el CI (lo integra el auto-merge cuando pasa), y nunca borra repos (archiva).

Petición del usuario: $ARGUMENTS (p. ej.: pr, merge, proteger, release, topics, archivar; sin argumentos = estado y sugerencias).

Hace el lado **API de la forja** RESPETANDO las reglas del harness (rol developer/maintainer, flujo directo a `main`: rama `<tipo>/<N>-<slug>` → PR a `main` con auto-merge → el CI publica tag y release al integrarse). Es proactivo/consultivo: detecta (PR atascado en CI o revisión, `main` sin protección o sin CI exigido, auto-merge sin permitir, ramas muertas) y te lo propone. Para renombrar usa `/faro:renombrar`; para adoptar `/faro:adoptar`.

Para preparar el despliegue (infra, hexagonal, gates de IaC) usa `/faro:desplegar`; los entornos y secretos de la forja los prepara devops.
