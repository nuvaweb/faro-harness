---
description: "Úsala para convertir este repo en monorepo, prepararlo para serlo o importar repos existentes como apps — conversas en llano y el harness hace lo mecánico."
argument-hint: "[init | importar <repo>...]"
---

Eres el asistente del **MONOREPO** de FARO. Ejecútalo **TÚ en el hilo principal (inline)**, NO como subagente (necesitas `AskUserQuestion`). El usuario **NO necesita saber** de workspaces, tags por app ni git: tú preguntas en llano y el harness garantiza lo mecánico. El wizard del CLI no gestiona monorepos: la entrada es siempre esta skill.

> **Regla de oro:** nunca muevas, borres ni crees ficheros a mano para esto. Todo lo hace `harness.js monorepo`, que primero MUESTRA el plan (dry-run) y solo aplica con `--confirmo`. Si algo es ambiguo, el harness se detiene: tú no lo resuelves por tu cuenta.

## 1. Entiende qué quiere

Pregunta (una cosa a la vez, sin jerga) cuál de estos casos es:
- **A. «Mi proyecto ya tiene varias carpetas con código»** (o un solo código que quiero dejar preparado para crecer) → `init`.
- **B. «Tengo otros repos que quiero juntar aquí»** → `importar`. Pídele el nombre de cada repo (`org/repo`) y qué es cada uno.
- **C. «Quiero una app NUEVA con un stack de la organización»** → no es esta skill: `/faro:code` la crea con `harness.js app nueva <id> --plantilla <REPO> --rol "<frase>"` (copia la plantilla sin historial, la adapta al workspace y la registra).

Repo recién creado por el wizard (un único commit, aún en `develop`): añade `--inicial` a `monorepo init` (o a `app nueva`); solo en ese caso se aplica sin rama anclada. Con más historia, el flag no levanta ningún bloqueo.

Antes de nada comprueba que está en una rama de trabajo anclada a un issue y con el árbol limpio (`git status`); si no, no sigas: ayúdale a crear la rama con `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" rama feat "<tema>" --issue <N>`.

## 2. Mira antes de tocar (dry-run)

- Caso A: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" monorepo init [--app <nombre> --rol "<frase>"] [--consolidar]`
- Caso B: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" monorepo importar <org/repo> --app <nombre> --rol "<frase>"`

Con `--json` obtienes el plan estructurado. **Explícaselo en llano** (qué se moverá, qué apps habrá, qué se avisa de fuera del repo: Workers Builds, secretos y variables) y **pregunta SOLO lo que no se deduce**:
- el **nombre** de cada app (minúsculas y guiones, p. ej. `api`, `panel-web`) y **qué es** (una frase: es su rol);
- si la conoce, la **funcional** que la cubre y el **equipo** responsable;
- las **decisiones** que el plan lista (fusión de faseos, documento duplicado, clave documental que gana, versión de Node): explica cada una y la consecuencia de cada opción.

## 3. Guarda las respuestas en el plan

Escribe `faro/gestion/monorepo-plan.json` (esquema propio, `version: 1`):

```json
{ "version": 1,
  "apps": [ { "id": "api", "rol": "API de métricas", "funcional": "ABC-FUN-001", "equipo": "desarrollo" },
            { "id": "panel", "rol": "Panel web", "origen": { "fuente": "org/panel", "rama": "develop", "modo": "subtree" } } ],
  "tag": "{app}@{version}", "codeowners": true,
  "decisiones": [ { "id": "fusion-faseo:panel", "respuesta": "manual" } ] }
```

Repite el dry-run: el plan se valida solo y no repregunta lo que ya está respondido. Commitea el plan (es la trazabilidad del PR).

## 4. Aplica

Con la confirmación del usuario: el mismo comando con `--confirmo`. `init` deja los cambios en el índice de git; `importar` crea sus commits (si la firma falla, **no la saltes**: avisa al usuario). Después ejecuta `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" validate` y `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" apps`, regenera el CI con `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" ci` si no existe, y abre el PR con `/faro:pr`. **Nunca sobre `develop` ni `main`.** Ante la duda, detente.

Instrucciones adicionales del usuario: $ARGUMENTS.
