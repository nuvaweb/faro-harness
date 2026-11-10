---
description: "Úsala para proponer un CAMBIO spec-driven — proposal.md (qué y por qué) + deltas con requisitos normativos y escenarios verificables."
argument-hint: "<nombre-del-cambio o tema>"
---

Crea un **cambio spec-driven FARO** (motor nativo, sin librerías). Ejecútalo **TÚ inline** (puedes preguntar con `AskUserQuestion`). Todo cambio es **HIPÓTESIS hasta validarla**: analiza, LEE el código/documentos afectados, valida con fuentes (WebSearch/MCP), **pregunta lo que no sepas** — no inventes.

Estructura a crear en `gestion/cambios/changes/<slug>/`:

1. **`proposal.md`** — el QUÉ, con el **frontmatter FIJO del change** (estándar PROPIO del harness — NO inventes campos ni cojas el formato de documentos; **NUNCA pongas `doc_id`**: eso es solo de documentos controlados, y el harness lo rechaza). La identidad del change es su **carpeta (slug)**, no un id:
   ```yaml
   ---
   titulo: <título claro y corto del cambio>
   descripcion: <una línea: qué resuelve>
   estado: borrador            # borrador | aprobada | implementada
   fase: <N | transversal>
   decision: <AAAA-MM-DD-<slug>.md>   # OBLIGATORIA si el cambio toca código (ver abajo)
   issue: <N>                  # la tarea de la forja que lo ejecuta (la escribe `asignar-tarea <slug>`)
   owner: <usuario git que LIDERA el cambio>
   responsable: <email o @usuario que lo EJECUTA>
   tareas: ["<fragmento exacto de la tarea de ESTADO.md que cubre>"]
   aprobada_por:               # usuario git; obligatorio si estado != borrador
   ---
   ```
   Cuerpo: **## Por qué** (el problema/motivo, ≥3 frases con contexto real) y **## Qué cambia** (alcance en items). Marca las dudas con `[CLARIFICAR: ...]` — el gate impide planificar con dudas abiertas. (El harness valida este frontmatter al escribir: si falta un campo o aparece `doc_id`, avisa.)
   **`decision:` — el POR QUÉ técnico (OBLIGATORIA si el cambio toca código).** El `proposal.md` dice
   el **QUÉ**; el ADR de `gestion/decisions/AAAA-MM-DD-<slug>.md` dice **qué enfoque se eligió y contra
   cuáles**. Sin ese enlace el razonamiento se pierde, y quien retome el trabajo —persona o agente—
   reinventa el enfoque o lo contradice sin saberlo. `validate` lo exige y comprueba que el ADR existe.
   Puedes citarlo corto (`usar-tanstack`) si no es ambiguo. Un cambio documental/organizativo (o con
   `sin_spec: true`) no la necesita: no toda edición arrastra una decisión de arquitectura.

2. **DELTAS de spec** (el RIGOR — **OBLIGATORIO SIEMPRE**, en TODO cambio): `gestion/cambios/changes/<slug>/specs/<capacidad>/spec.md` con secciones. En este repo documental, la "spec" describe **requisitos/capacidades del sistema documental** (no código): el disparador es "todo cambio que añada/modifique una capacidad o requisito del sistema". **Única excepción:** un cambio puramente editorial menor que no toca ninguna capacidad → declara `sin_spec: true` en el frontmatter de `proposal.md` (el harness lo exime; si no, BLOQUEA por falta de spec, incluso en borrador).

   **QUÉ MERECE SER UN REQUISITO — no infles la spec.** El gate empuja a escribir specs, y la tentación
   es convertir cada cambio en un requisito para cumplir el trámite. Una spec inflada de requisitos que
   nadie demuestra es peor que una corta: oculta los que sí importan.

   | ES un requisito | NO lo es |
   |---|---|
   | Comportamiento **observable** que alguien podría romper sin darse cuenta | Detalle de implementación (qué librería, cómo se estructuró el fichero) |
   | Una garantía que el sistema promete y hay que sostener en el tiempo | Un refactor que no cambia lo que el sistema hace |
   | Algo que, si deja de cumplirse, **alguien se queja** | Ajuste de texto, formato, orden de opciones |

   **La prueba del algodón:** si no sabrías escribir el test que lo demuestra, probablemente no es un
   requisito — es una tarea. Cada requisito de una spec viva debe declarar su evidencia
   (`Evidencia: test/<fichero>`); audítalo con `harness.js specs evidencia`.
   ```markdown
   ## Requisitos AÑADIDOS        (o MODIFICADOS / ELIMINADOS / RENOMBRADOS)

   ### Requisito: <nombre claro>
   El sistema DEBE <comportamiento concreto y comprobable>.

   #### Escenario: <caso concreto>
   - CUANDO <contexto/acción>
   - ENTONCES <resultado esperado observable>
   ```
   Reglas (las valida `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" specs validar`): texto **NORMATIVO** (DEBE/SHALL/MUST) · **≥1 escenario** por requisito · sin duplicados ni conflictos entre secciones. Un escenario ≈ un test.

   **La CONDICIÓN va DELANTE (sintaxis EARS).** Ser normativo no basta: si el "cuando" o el "si" quedan escondidos detrás del DEBE, el requisito no dice cuándo aplica y su escenario no se puede derivar. Un requisito toma **una** de estas cinco formas:

   | Forma | Plantilla | Cuándo |
   |---|---|---|
   | Ubicua | `El <sistema> DEBE <respuesta>` | siempre activo, sin condición |
   | Evento | `CUANDO <disparador>, el <sistema> DEBE <respuesta>` | reacciona a algo que ocurre |
   | Estado | `MIENTRAS <estado>, el <sistema> DEBE <respuesta>` | vale durante una situación |
   | Opcional | `DONDE <característica> esté incluida, el <sistema> DEBE <respuesta>` | solo si esa parte existe |
   | No deseada | `SI <condición no deseada>, ENTONCES el <sistema> DEBE <respuesta>` | errores y fallos |

   Mal: *"El harness DEBE rechazar el commit si contiene un secreto"* — la condición va detrás.
   Bien: *"SI el commit contiene un secreto, ENTONCES el harness DEBE rechazarlo"*.
   El harness lo **avisa** por defecto; un repo que lo quiera como gate duro pone `enums.ears.modo: "gate"` en su `faro-schema.json`. (Una pregunta indirecta — *"DEBE comprobar si la rama está integrada"* — no es una condición y no se avisa.)
3. **`tasks.md` NO todavía**: el plan (CÓMO, checkboxes) llega **tras aprobar** la proposal (gate spec→plan del harness), con el formato de `/faro:aplicar`: historias `US-n` que citan el issue, `[P]` en lo paralelizable, el test que debe fallar antes como primera tarea y un checkpoint por historia.
4. **Aprobación — según QUIÉN propone** (comprueba tu rol con `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" role`):
   - **Si TÚ puedes aprobar** (admin/owner/maintainer) y es tu propio cambio: **autoaprueba sin ceremonia** — pon directamente `estado: aprobada` + `aprobada_por: <tu usuario>`. No hay un paso "borrador→aprobada" vacío cuando propones y apruebas tú (alineado con OpenSpec solo-dev: el gate es "revisar antes de codificar", y ya lo has hecho).
   - **Si NO puedes aprobar** (developer): deja `estado: borrador`. Un admin lo revisa y lo aprueba (o lo **descarta**). Mientras esté en borrador, el gate impide planificar/implementar.
5. **Repartir el trabajo (tarea en la forja)**: cuando el cambio está listo para ejecutarse, si defines `responsable:`, crea una **tarea** (issue en GitHub, incidencia en GitLab) asignada a esa persona para que le **llegue aviso**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" asignar-tarea "<titulo>" <login> <slug-del-change> "<descripcion>" --tipo <tipo> [--hito <N|backlog|titulo>] [--app <app>[,<app>]] [--estimacion 2h] [--vence AAAA-MM-DD]` (valida que el login esté en el equipo; en un monorepo, `--app` pone la etiqueta `app:<app>`, una por app si son varias). **El `--tipo` es OBLIGATORIO** (todo issue lleva un label): elige el que mejor encaje del catálogo (`requerimiento`, `bug`, `mejora`, `tarea`, `documentacion`, `investigacion`, `diseno`, `seguridad`, `infra`, `datos`, `pregunta`, `compliance`, `riesgo`, `duplicado`, `descartado`, `urgente` — lista completa con descripciones: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" asignar-tarea` sin args). **`--hito` es OBLIGATORIO en un tipo que PLANIFICA** (requerimiento/mejora/tarea/documentacion/investigacion/diseno/datos) y OPCIONAL en uno que SURGE (bug/infra/pregunta) — un requerimiento no puede quedar suelto de una fase; usa `--hito backlog` si ya se acepta pero aún no se decide cuándo. **Si dudas entre dos tipos, PREGUNTA al usuario con AskUserQuestion** mostrando las opciones; no adivines. El harness reutiliza el label nativo de GitHub equivalente (bug/enhancement/question/...) o crea `faro:<tipo>` si no hay nativo. **Una tarea = una TAREA normal** (no un bug). Al abrir la petición con `harness.js pr crear`, el **`Closes #N` lo pone el harness** (lo saca del nombre de la rama `<tipo>/<N>-<slug>`) → la forja la cierra sola al mergear; si la rama no está anclada a ninguna tarea, te avisa de que ese PR no cerrará nada. Separación industria: **assignee** = quien la HACE · **reviewer** = quien la APRUEBA (en el PR). Si el cambio se descarta (no aprobado): `harness.js descartar-tarea <N> "<motivo>"`. **La tarea nace DENTRO del hito de su fase en las dos forjas**: con `--hito <N>` (la fase N; en GitHub crea el hito si falta; en GitLab, más su estimación con `--estimacion`) — así el progreso de la fase se lee de la forja, no de un documento a mano. Al cerrar la fase (`hito sync`, disparado por `/faro:publicar`), un hito con tareas SUYAS todavía abiertas **no se cierra**: el harness avisa cuántas quedan en vez de darlas por perdidas.

Al terminar: valida con `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" specs validar`, enseña el cambio al usuario. Si tú apruebas, autoaprueba (paso 4); si no, dilo que queda pendiente de un admin. Tema del usuario: $ARGUMENTS
