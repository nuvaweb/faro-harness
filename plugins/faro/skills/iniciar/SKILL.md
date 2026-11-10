---
description: "Úsala para arrancar un trabajo nuevo — entrevista guiada que crea ESTADO.md, clave, brief (BRF), fuentes y RAID, y valida."
argument-hint: "[nombre o idea del trabajo, opcional]"
---

Eres el director del **arranque de un trabajo FARO**. Ejecútalo **TÚ inline** (usa `AskUserQuestion`
para entrevistar) y **adopta TÚ los roles del plugin** que piden datos al usuario — el arranque es
orquestación, no un formulario. Delegar a subagente aquí solo vale para **lectura** (barrer
`fuentes/`, inventariar): lo que pregunta, no se delega. Idea/nombre aportado: $ARGUMENTS

**Si ya existe `ESTADO.md`**: este comando no es para re-iniciar — di qué existe y deriva a
`/faro:estado` (o a la digestión si hay fuentes nuevas). No pises nada.

## Secuencia (iterativa, confirmando cada paso)

1. **Aterriza la idea** (directiva `faro:gestion-proyectos`, enfoque FDE): entrevista con
   `AskUserQuestion` — (a) qué trabajo es y qué se quiere conseguir (objetivo medible), (b) fases y
   nombre de cada una, (c) tareas/hitos de la fase inicial, (d) riesgos y dependencias conocidos.
2. **Material de partida a `fuentes/`**: pregunta si hay transcripciones, briefs, funcionales de
   cliente o pdfs; que se suban ANTES de redactar nada. Si los hay, lanza el agente
   **`gestor-requisitos`** para la digestión (extraer requisitos → `gestion/requisitos.md`,
   decisiones, riesgos, fechas) — es su flujo, no lo hagas a mano.
3. **Crea `ESTADO.md`** con el formato estándar (frontmatter completo + secciones de fase con
   checkboxes) y **fija la CLAVE** documental (`harness.js clave --sugerir "<nombre>"` → confirma →
   `harness.js clave <CLAVE>`).
   **Cada checkbox es un ENTREGABLE DE VALOR, no un paso suelto — no atomices.** Es la semilla de los
   issues: si nacen atomizados, el hito se llena de tareas de un rato que generan ramas que nadie
   cierra. Agrupa («personalización e identidad» reúne marca, colores, traducciones y favicon en una
   sola) y deja el desglose fino como subtareas dentro. Ante la duda, **agrupa**: una tarea amplia se
   amplía después; varias atomizadas ya han hecho el destrozo.
4. **Brief (BRF)**: lanza el agente **`redactor-documento`** para redactarlo desde la entrevista y
   las fuentes (id con `harness.js docref BRF`); declara `funcional:` en ESTADO.md cuando exista el
   documento del que partir.
5. **RAID inicial**: los riesgos detectados en la entrevista/fuentes van a `gestion/risks.md` con
   dueño — deriva al agente **`gestor-riesgos`** si hay más de un par o exigen análisis.
6. **¿Lo organiza un planificador externo?** Si el proyecto y sus épicas los lleva otra herramienta,
   no FARO, esa herramienta deja en la forja lo justo: el proyecto en la propiedad `<prefijo>_id` del
   repo (topic `<prefijo>-PRJ-x` en GitLab) y la épica de cada milestone en su descripción
   (`<prefijo>:epica=EPI-n · título`). Decláralo en `.faro.json` (o en `~/.faro.json`):
   `"planificacion": { "prefijo": "<prefijo>", "nombre": "<Nombre>" }`. FARO solo lo lee:
   `harness.js planificacion` enseña la relación. Si no hay planificador, sigue sin él.
7. **Ciclo git**: crea `develop` y la rama de trabajo (`git switch -c develop && git push -u origin
   develop`, luego `<tipo>/<slug>`); recuerda que main/develop quedan protegidas por el harness.
   Asegura también `.claude/worktrees/` en el `.gitignore` (`node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" worktrees --ignorar`): los agentes aislados crean ahí sus worktrees y no deben salir como cambios sin seguimiento.
8. **Verifica**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" validate` y presenta al usuario el
   resumen del arranque (qué quedó creado, qué falta, siguiente paso sugerido).

## Qué se puede delegar aquí (y qué no)

**Arrancar es una ENTREVISTA, y eso no se delega.** Los pasos 2 (digestión), 4 (BRF), 5 (RAID) y 6
(épica) los llevan `gestor-requisitos`, `redactor-documento`, `gestor-riesgos` —
roles que **preguntan**, y
`AskUserQuestion` **no existe dentro de un subagente** (Claude Code la filtra siempre, aunque el
agente la declare en sus `tools`). Lanzados en paralelo no podrían preguntarte nada: adivinarían el
alcance, los requisitos y los riesgos del trabajo que acabas de arrancar. **Adopta esos roles TÚ, en
el hilo principal.**

Lo que SÍ se delega es la **lectura**: barrer `fuentes/` para ver qué hay, inventariar el repo,
localizar material previo. Eso son subagentes de solo lectura que devuelven un informe, y ahí sí
puedes lanzar varios en una tanda. Con ese material delante haces la entrevista una vez, y luego
rellenas los artefactos sin volver a preguntar lo mismo.
