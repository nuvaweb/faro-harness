---
description: "Úsala ante una idea difusa, un encargo nuevo o una implementación en cliente — aterriza requisitos, fasea y retoma proyectos con enfoque AI FDE, orientado a entregar."
---

# Directiva de gestión FARO — enfoque Forward Deployed AI Engineer

El modelo de referencia es el **AI FDE** (Forward Deployed AI Engineer): el profesional se integra
donde está el problema y **entrega sistemas y resultados funcionando, no informes**. Los pilotos de
IA fallan mayoritariamente por despliegue y encaje en el flujo real, no por la tecnología — por eso
FARO gobierna el proceso completo: contexto → requerimientos → entrega → valor medido. El agente es
el copiloto de esa entrega: guía, pregunta, estructura y deja rastro. La documentación (guías y
runbooks incluidos) **se prepara si hace falta para que el resultado opere y perdure** — nunca es el fin.

## Etapas (PMI adaptado al ciclo FDE) y su encaje FARO

| Etapa | Qué se hace (con quién está el problema) | Dónde queda en FARO |
|---|---|---|
| **1. Iniciación / discovery** | Aterrizar la idea: problema, para quién, valor esperado, stakeholders, qué hay ya | Onboarding → `ESTADO.md` + brief (BRF); material recibido → `fuentes/` |
| **2. Requerimientos** (elicitación BABOK) | Sacar lo que NO está escrito: entrevistas, observación del flujo real, workshops; requisitos verificables (DEBE + escenario); alcance y fuera-de-alcance explícitos | Funcional (FUN) + historias (HU); registro `gestion/requisitos.md` (REQ-NN + estado + origen, agente `gestor-requisitos`); cambios → `gestion/cambios/` |
| **3. Planificación** | Fases con **entregable observable** y gate objetivo cada una; riesgos y asunciones desde el día 1; KPIs con línea base | `ESTADO.md` (fases+tareas+owner) · `risks.md` · `kpis.md` |
| **4. Ejecución (piloto → producción)** | Entregar funcionando DENTRO del flujo del usuario/cliente; iterar con feedback real; decisiones estructurales registradas | Cambios spec-driven aplicados · ADRs · rama→develop→main |
| **5. Seguimiento y control** | Estado con EVIDENCIA (tareas, KPIs medidos contra fuente, riesgos revisados); nada de reporting de memoria | Informes datados · presentación viva · `harness.js validate` |
| **6. Cierre / operación** | El resultado queda operando: guías y runbooks SI HACEN FALTA para que otros lo usen/operen; medición final de valor; lecciones | GUI/RUN/PRO/SLA en `documentos/operaciones/` · informe de fase + tag |

Las etapas son iterativas y se solapan (PMI moderno): se puede estar pilotando una parte mientras se
eliciten requerimientos de otra. Lo que NO se salta son los **gates**: fase cerrada = entregable +
informe + tag; cambio aplicado = spec aprobada antes.

## Cómo guiar (reglas del copiloto FDE)

- **Aterriza antes de escribir**: ante una idea difusa, pregunta problema/usuario/éxito-medible/qué
  existe. Eso es la fase 0 del cambio o el onboarding — decántalo en la proposal o el brief, nunca
  en notas sueltas.
- **Eliciting, no order-taking**: los requerimientos se sacan preguntando por VALOR y observando el
  flujo real, no transcribiendo la lista de features que llega. Mucho requisito vive en la cabeza de
  la gente: entrevista, reformula, confirma.
- **Digestión de fuentes (ciclo de vuelta)**: todo material que llega (transcripción, brief, funcional
  de cliente, pdf) entra por `fuentes/`; el harness señala lo que queda SIN DIGERIR (posterior al
  funcional/ESTADO) y el agente `gestor-requisitos` lo digiere: extrae requisitos → registro
  `gestion/requisitos.md` (REQ-NN + estado + origen), decisiones → ADR, riesgos → RAID, y lo
  sustantivo abre cambio spec-driven. Un requisito `aceptado` sin cambio/tarea que lo cubra es un
  hueco de trazabilidad que `validate` avisa — esa es la red para que nada se escape.
- **Resultado medible o no cuenta**: todo proyecto tiene KPIs con línea base y fuente (`kpis.md`);
  "entregado" = funcionando en el flujo real Y medido, no "documentado".
- **Riesgos como disciplina continua (PMBOK)**: identificar → analizar (probabilidad×impacto) →
  responder (evitar/mitigar/transferir/aceptar, con dueño) → revisar en cada fase. Viven en
  `gestion/risks.md` (RAID: riesgos, asunciones, impedimentos, dependencias) y los relevantes se
  citan en cada informe. Un riesgo sin dueño ni respuesta no está gestionado, está apuntado.
- **Las tareas viven en la forja** (Issues en GitHub, incidencias en GitLab; `harness.js forge` dice cuál,
  y solo si es `desconocida` se llevan únicamente en `ESTADO.md`): una tarea = un Issue (no un bug), con label del contrato
  (`faro-schema.json > enums.labels`) y ASIGNACIÓN a persona (`harness.js asignar-tarea "<titulo>"
  <login>` — le llega email; lo asignado a ti: `harness.js mis-tareas`). El checkbox de `ESTADO.md`
  y el issue se referencian mutuamente; el estado se actualiza donde se trabaja, no de memoria.
- **GRANULARIDAD — una tarea es un ENTREGABLE DE VALOR, no un paso suelto. NO ATOMICES.** Igual que
  una fase entrega algo observable, una tarea también: agrupa todo lo necesario para entregarlo y
  mete el desglose fino **dentro** como subtareas (`asignar-tarea ... --subtarea "<texto>"`,
  acumulable), no como tareas hermanas. Una fase de 11 pasos suele ser **2-4 tareas**, no 11:
  «Personalización e identidad» (marca + colores + traducciones + favicon) es UNA. Regla práctica: si
  se hace en un rato y no entrega valor por sí solo, es **subtarea**; si necesita su propia rama y su
  petición de integración para tener sentido, es **tarea**. Ante la duda, **agrupa** — una tarea
  amplia se amplía luego; varias atomizadas ya han ensuciado el hito y dejado ramas que nadie cierra.
  Si el trabajo nuevo encaja en una tarea ABIERTA, **amplía esa** en vez de crear otra, sobre todo
  cuando lo único que cambia es quién la hace.
- **Pregunta antes de asumir** — con opciones concretas, en el idioma del usuario, sin jerga (el
  usuario no tiene que saber qué es un RAID, una spec ni un FDE).
- **NOMBRES DE PERSONA: NUNCA los inventes (regla dura).** Todo campo que identifique a alguien
  (`author`, `owner`, `responsable`, `deciders`, `aprobada_por`, Owner de un riesgo, autor de un
  informe…) se rellena SIEMPRE con el **login de la forja del usuario** (GitHub o GitLab) — la fuente es
  `harness.js identity` (cuenta autenticada) o `harness.js equipo` / `approvers` para terceros.
  Orden: **login de la forja primero**; si no está disponible, el usuario de git (`user.name`); si
  tampoco, **PREGUNTA** (AskUserQuestion). Jamás pongas un nombre plausible, un placeholder tipo
  "Equipo FARO"/el nombre de la organización, ni deduzcas la persona del contexto o del nombre del repo. Aplica a
  documentos, `ESTADO.md`, ADRs, risks, informes y presentaciones: un nombre inventado es un dato
  falso en un documento controlado, y firma a alguien que no ha firmado.
- **Una conversación, un destino**: lo valioso de cada sesión queda en su sitio del estándar (la
  skill `documentacion` decide dónde). Lo que no queda escrito no existe.
- **Fit-for-purpose**: el método se adapta al proyecto — un encargo corto no necesita el pack
  completo; una implementación en cliente sí (incl. guías de operación). Si un paso no aporta,
  propón saltarlo y registra la decisión: el estándar sirve al proyecto, no al revés.
- **Retomar = reconstruir contexto primero**: ESTADO.md → cambios activos → riesgos → último
  informe; resume al usuario antes de tocar nada. Repo fuera de FARO → propone `faro adoptar`.


## Fases ↔ hitos de la forja (GitHub y GitLab)

Las fases de ESTADO.md tienen su reflejo NATIVO como hitos en las dos forjas: `harness.js hito sync` crea un hito por
fase ("Fase N — nombre"), cierra los de fases `done` y reabre los que no lo estén; `/faro:publicar` lo hace solo al
cerrar ciclo. Las tareas de un tipo que PLANIFICA se crean SIEMPRE dentro del hito de su fase — con
`asignar-tarea --hito <N>` en las dos forjas (en GitHub crea el hito si falta; `--hito backlog` si aún no se decide cuándo; en GitLab, más su estimación con `--estimacion`); las horas se registran con `harness.js tiempo` (solo GitLab). El informe
de cierre de fase debe leer estimado vs consumido de `harness.js tiempo` (agregado por hito) donde exista, no de
cifras escritas a mano.

**Fecha objetivo OBLIGATORIA, estimación por tarea solo AVISADA**: toda fase abierta (también `draft`) debe traer
una línea `Objetivo: AAAA-MM-DD` — el harness la exige (`huecosDeFase`, bloquea `validate`) porque sin ella el
`due_on` del hito de la forja se queda vacío en silencio. La fecha NO es rígida en su VALOR: se reajusta libremente
si cambia el alcance (`hito sync` actualiza el hito cuando `Objetivo:` difiere del `due_on` real) — lo único que no
se acepta es que falte. La estimación por tarea (`--estimacion` en GitLab) es distinta: sigue siendo 100% opcional
y flexible — el harness solo AVISA (nunca bloquea) cuando una tarea de tipo PLAN nace sin ella, porque una tarea
que SURGE (bug/infra/pregunta) no estaba planificada y no tiene por qué llegar estimada.

**Cierre forzoso**: una fase `done` NO cierra su hito si le quedan tareas SUYAS abiertas — el harness avisa cuántas
en vez de darlas por perdidas (nunca las mueve ni las cierra por su cuenta: eso es una decisión de gestión).
Resuélvelas antes de dar la fase por cerrada.

**`draft` (onboarding, antes de que exista el hito)**: el faseo inicial se escribe SIN #N (el onboarding lo pide
así explícitamente — las fases aún no son hitos hasta que esa rama se integre y corra `hito sync`). Mientras no
tengan id, declara la fase como `— draft`: el harness exime #N/@usuario del formato rígido (no pueden existir
todavía) pero sigue exigiendo descripción, al menos una tarea, y `Objetivo:` (la fecha no depende del hito, la
decide el equipo antes de que exista). Al correr `hito sync` → `asignar-tarea --hito <N>`, pasa el estado de esa
fase a `pending` en el mismo commit — desde ahí #N vuelve a ser obligatorio.
