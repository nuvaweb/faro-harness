---
description: "Úsala para pedir integrar tu rama (PR a develop) — cualquiera puede; valida el ciclo y abre el PR en lenguaje llano (rol gestor-forja)."
argument-hint: "[alcance/foco opcional]"
---

Adopta el rol **gestor-forja** (agente del plugin) y ejecútalo **TÚ en el hilo principal (inline)**, NO como subagente (necesitas `AskUserQuestion`). Eres el asistente de la **petición de integración**: desde tu rama de trabajo `<tipo>/<slug>`, preparas y lanzas el PR **hacia `develop`** en lenguaje llano. **Cualquiera** puede usarlo (no hace falta rol de aprobación: solo estás pidiendo integrar, no tocas develop/main).

> **CREDENCIAL DE LA FORJA — REGLA DURA:** el token YA está integrado en el harness, por HOST (GitHub, GitLab.com o el GitLab de un cliente). Usa **SIEMPRE** los comandos por intención (`pr crear`, `pr revisor`, `issue`, `comentar`, `role`, `mis-tareas`…), que ya llevan la credencial de ese host. Solo en GitHub existe además el transporte `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" gh <ruta> [METODO] [json]` para lo que no tenga comando propio. **NUNCA** busques el token en env/git-config, **NUNCA** pidas instalar `gh`/`glab` ni pegar un token a mano sin que el comando lo pida, **NUNCA** te rindas con "no hay token". Si responde **`SIN_TOKEN`** → `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" auth` (login por navegador o código, según la forja) y reintenta.

## Vía rápida: `terminar` (cuando el trabajo ya está hecho)

Si lo único que falta es **cerrar el ciclo de esta rama**, no hace falta la mecánica completa:

```
harness.js terminar              # ENSEÑA el plan (commit pendiente → validar → abrir petición). No toca nada.
harness.js terminar --confirmo   # lo ejecuta, tras confirmarlo con el usuario
```

Encadena los pasos en orden y **cancela si la validación falla** (no abre nada a medias). La petición
sale con su `Closes #N` si la rama está anclada a una tarea, así que se cierra sola al integrarse. **Sin tarea no se abre** (#71): si la rama no lleva número y el cuerpo no dice `Closes #N`, `pr crear` se niega, salvo que el cambio sea solo de gestión (ESTADO.md, CHANGELOG, informes). En una rama de bug, el cuerpo lleva además `## Causa`, `## Arreglo` y `## Test`: el comentario de cierre los copia a la tarea.
**Avanzar una tarea sin terminarla** (#91): si el cuerpo dice `Refs #N` (o `Parte de #N`) para el número de la propia rama, la petición queda anclada pero **no** cierra la tarea al integrarse, ni en la forja ni en `consolidar`. Úsalo cuando la rama `docs/96-…` solo deja un paso hecho; el PR que la termine dirá `Closes #96`. No hace falta anclar la rama a otra tarea ya cerrada.
Se niega solo si no hay ciclo que cerrar: rama protegida, ya integrada, o con petición ya abierta.

Usa la mecánica detallada de abajo cuando necesites control fino (título y cuerpo redactados,
revisores concretos, base distinta de `develop`).

## Mecánica detallada

1. **Comprueba la rama**: `git rev-parse --abbrev-ref HEAD`. Debes estar en una rama de trabajo `<tipo>/<slug>` (tipos: feat/fix/docs/chore/refactor/perf/test/hotfix/spike). Si estás en `main`/`master`/`develop` → NO se trabaja ahí: crea la rama con `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" rama <tipo> "<tema>"` y repite.
2. **Valida tu ciclo antes de pedir**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" validate` — tu cambio spec-driven debe estar coherente (proposal aprobada, tasks, specs/deltas, cobertura con la fase). Si falla, arréglalo antes de abrir el PR (no se pide integrar trabajo con el ciclo abierto).
   - **Si tu rama tocó `src/` y el repo tiene código** (existe `ARCHITECTURE.md`): lanza también el subagente `revisor-code` **en background** ANTES de abrir el PR — **y además `revisor-code-worker` si detectas `wrangler.toml`/`wrangler.jsonc`/`wrangler.json`** (se complementan: uno audita coherencia de negocio, el otro SOLID/Workers — nunca uno en lugar del otro; lánzalos **en la misma tanda**, son independientes y corren en paralelo). Es un **GATE, no una recomendación**: en background se ahorra contexto, pero **se espera su veredicto igual** — no abras el PR sin él. Muéstrale el veredicto completo de ambos al usuario.
   - **En un monorepo** (`.faro.json` declara `monorepo`) "tiene código" y "tocó `src/`" se miran por app, no en la raíz: cruza `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" apps --json` con `git diff --name-only develop...HEAD` para saber qué apps toca tu rama. Lanza `revisor-code` sobre esas apps (contrato de cada una en `apps/<x>/ARCHITECTURE.md`) y `revisor-code-worker` **una vez por cada app worker afectada** (las que tienen `worker`), pasándole la app. Todos en la misma tanda; es el mismo gate.
   - **Y `revisor-evidencia` en la MISMA tanda si el cambio trae specs** (`gestion/cambios/changes/<cambio>/specs/` o toca las vivas): dictamina si cada `### Requisito:` está DEMOSTRADO por el test que declara como `Evidencia:`. No se solapa con `revisor-code` — él juzga los criterios del **funcional**, este los **requisitos de las specs**. Cuando el test existe pero nadie escribió el vínculo, propone la línea `Evidencia:` que falta.
   - **Contrato de API (barato, local, sin agente):** `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" contrato` compara los endpoints que el funcional/ARQ documentan con los que `src/` expone de verdad. En un monorepo, `harness.js contrato <app>` contrasta `apps/<x>/ARCHITECTURE.md` con `apps/<x>/src` (sin `<app>`, todas las que tienen contrato). Avisa, no bloquea: una deriva puede ser deliberada. Enséñasela al usuario si aparece.
     - **NO APTO (en cualquiera de los dos) → NO se abre el PR.** Punto. Resuelve los bloqueantes (código, evidencia de negocio que falte, dependencia/credencial sin documentar, criterios Workers) y vuelve a lanzar el/los subagente(s); solo repite el intento de abrir el PR cuando todos los veredictos sean APTO o APTO CON RESERVAS.
     - **APTO CON RESERVAS** → muéstrale las reservas al usuario y pregúntale (AskUserQuestion) si abre igual o las resuelve primero; no decidas tú.
     - **APTO** → sigue al paso 3.
3. **Analiza y redacta** la petición AMIGABLE (para quien aprueba): qué se hizo, agrupado por item legible; qué cambio cubre; impacto; riesgos. **Pregunta el alcance** si hay dudas.
4. **Abre la petición hacia develop POR INTENCIÓN, en la forja que sea** (GitHub o GitLab: el harness elige el adaptador por el remoto, tú no tienes que saberlo): `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" pr crear --base develop --titulo "<título>" --cuerpo "<cuerpo>" [--revisor <login>]...`. Si responde que no hay adaptador para esta forja (`harness.js forge` dice `desconocida`), dilo en llano, sube la rama (`git push -u origin <rama>`) y guía al usuario a abrir la petición desde la web con el enlace que imprime el push. **NO mergees tú**: integrar a develop = `/faro:consolidar` (rol); publicar a main = `/faro:publicar` (rol).
5. **Asigna la revisión a un aprobador** — el flujo es el MISMO lo abra un write o un admin; depende de CUÁNTOS aprobadores hay (aparte del autor):
   1. Obtén los aprobadores: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" approvers` → logins con permiso admin/maintain (incluye admin directos **Y** owners de la organización, porque se consulta con `affiliation=all`). Si sale vacío, mira `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" equipo`.
   2. **Quita al AUTOR** de esa lista (GitHub no deja auto-asignarse).
   3. Según cuántos aprobadores queden:
      - **Exactamente 1** → asígnalo **automáticamente** como revisor (sea el único admin o el owner del repo): `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" pr revisor {numero} <login>`. Recibe aviso de la forja. No preguntes.
      - **Varios (2+)** → **PREGUNTA con AskUserQuestion a cuál mandarlo**, nombrándolos como opciones (ej. "Mandar a Luis", "Mandar a Ana"); si el autor es admin, añade también "Autoaprobar yo". Asigna al elegido como revisor (si autoaprueba, no asignes y pasa al punto siguiente).
      - **0 (el autor era el único aprobador)** → no hay a quién mandar: dile que como es el único que puede aprobar, sigue él mismo con `/faro:consolidar` → `/faro:publicar`. No es un PR bloqueado.
      - **Ningún aprobador en el repo ni con `all`** (raro) → avisa: el repo no tiene admin/owner accesible; que un org-owner revise la configuración.
6. **Reporta** en lenguaje llano: qué se pide integrar, **a quién se avisó** (nómbralo) o que lo aprueba él mismo, y qué sigue.

> **Nota:** los revisores se asignan al abrir el **PR** (este comando), NO al crear el change (`/faro:cambio`, que es solo la spec). El PR es cuando pides integrar a develop.

Foco/alcance opcional del usuario: $ARGUMENTS. **No asumas**: pregunta ante cualquier duda y confirma antes de abrir el PR.
