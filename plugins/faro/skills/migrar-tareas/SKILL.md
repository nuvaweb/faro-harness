---
description: "Úsala para migrar el histórico de tareas: crea los issues que faltan, rellena gestion/tareas/<N>.json (tarea migrar) y regenera las líneas de fase de ESTADO.md (estado-indice)."
argument-hint: "[opcional: numero de fase, si solo se procesa una]"
---

Ejecútalo **TÚ inline** (necesitas `AskUserQuestion`). Alcance: $ARGUMENTS — si viene vacío, **todas
las fases en orden, empezando por la 1**.

**No toques** documentos, decisiones, layout, `CLAUDE.md` ni README: eso es `/faro:adoptar`.

## 0. Sitúate

```
harness.js estado-json      # fases, estado de cada una, fase_actual
harness.js hito --all       # hitos que ya existen y su recuento de tareas
```

Si `estado-json` devuelve `fases: []`, para: no hay faseo que procesar.

## 1. Bucle por fase — de la 1 en adelante, una a una

> Solo GitHub: `tarea migrar` aún no está disponible en GitLab.

**No saltes a la siguiente hasta cerrar la actual.** Por cada fase:

### 1.1 ¿Qué issues tiene ya su hito?

```
harness.js hito verificar "<titulo-del-hito>"
```

Si la fase no tiene hito todavía, no lo crees a mano: lo creará el primer `asignar-tarea --hito`.

### 1.2 Cruza los checkboxes de la fase con esos issues

**AGRUPA ANTES DE CRUZAR — un issue es un ENTREGABLE DE VALOR, no un checkbox.** Una fase con 11
tareas normalmente son **2-4 issues amplios**, no 11. Antes de crear nada, agrupa los checkboxes por
bloque con sentido propio (p. ej. "identidad y marca" reúne el `wrangler.jsonc`, `brand.ts` y las
traducciones; "pantallas del informe" reúne Planta, Servicios y Evolución). Cada bloque es **un
issue**, y sus checkboxes van **dentro** con `--subtarea "<texto>"` (acumulable), no como issues
hermanos. Si dudas de la agrupación, **muéstrasela al usuario con AskUserQuestion antes de crear**.

Ante la duda, **agrupa**: un issue amplio se amplía después (`harness.js ampliar-tarea <N> --subtarea "…"` añade subtareas al que ya
existe); varios issues atomizados ya han ensuciado el hito y dejado ramas que nadie cierra.

Hecha la agrupación, para cada BLOQUE (no para cada checkbox):

| Situación | Acción |
|---|---|
| Bloque abierto, sin issue | **Crear** uno amplio con sus `--subtarea` (paso 1.3) |
| Bloque hecho (`[x]`), sin issue | **Verificar** (1.2b) y luego crear y cerrar — deja rastro en el hito |
| Parte del bloque ya tiene issue | **No dupliques ni crees hermanos.** AMPLÍA ese issue con las subtareas que faltan y enlaza los checkboxes a `#N` |
| Con issue, pero estados que no cuadran (`[x]` e issue abierto, o al revés) | **La forja manda**: issue cerrado → `[x]` (lo marca `consolidar`); `[x]` con el issue abierto → pregunta si se cierra o se desmarca |

### 1.2b Verifica lo que se da por hecho (si el repo tiene código)

Un `[x]` es una afirmación de alguien, no una prueba. Antes de cerrar su issue, **lanza un subagente
por fase** (solo lectura) que contraste cada tarea marcada como hecha contra la evidencia real:
commits, ficheros, PRs que la citen, tests que la cubran.

Que devuelva por cada tarea: **confirmada** (hay evidencia), **sin evidencia** (no se encuentra
rastro), o **contradicha** (la evidencia dice que no está hecha o se deshizo).

- **Confirmada** → crear y cerrar, como estaba previsto.
- **Sin evidencia / contradicha** → **no la cierres**. Enséñaselo al usuario y pregunta: se reabre
  como tarea pendiente de esa fase, o se cierra igualmente porque el trabajo existe fuera del repo.

Lánzalo en background mientras procesas la fase siguiente (`/faro:delegacion`) — no bloquees el
bucle esperándolo, pero **no cierres una fase sin su veredicto**.

Si el repo no tiene código (naturaleza documental), sáltate este paso: la evidencia son los propios
documentos, y el cruce con `gestion/` ya lo hace `validate`.

### 1.3 Crea los que falten

Determina por cada tarea:

- **`--tipo`**: del catálogo (`harness.js asignar-tarea` sin args). Si dudas entre dos, pregunta.
- **Responsable**: el `[resp: email]` o `@usuario` del checkbox. Si no hay, pregunta o déjala sin
  asignar. **Nunca inventes una persona.**
- **Cuerpo**: el texto de la tarea literal. No lo resumas.
- **Subtareas**: un `--subtarea "<texto literal del checkbox>"` por cada tarea del bloque. Así el
  issue amplio lleva su estructura dentro y se ve el avance sin trocearlo en issues sueltos.

Presenta la lista de esa fase y **confirma antes de crear nada**. Luego:

```
harness.js asignar-tarea "<titulo>" <login> "" "<cuerpo>" --tipo <tipo> --hito <N>
```

Para las que ya estaban hechas (`[x]`), ciérralas después de crearlas:

```
harness.js cerrar-tarea <N>
```

Si una tarea abierta ya no tiene sentido en esa fase, pregunta: pasa a una fase posterior,
`--hito backlog`, o `harness.js descartar-tarea <N> "<motivo>"`.

### 1.4 Valida el hito contra la realidad

```
harness.js hito --all
```

El recuento cerradas/total del hito debe coincidir con los checkboxes de esa fase, **y con el
veredicto del paso 1.2b**: nada cerrado sin evidencia. Si no cuadra, resuélvelo antes de seguir —
no arrastres el desajuste a la fase siguiente.

### 1.5 Registros de tarea y línea de la fase (los genera el motor)

Cada issue de la fase tiene su registro `gestion/tareas/<N>.json` (objetivo, resultado, fechas, apps,
subtareas…) y **la línea de ESTADO.md se GENERA desde él**: no se escribe a mano. Con los issues de la
fase ya cuadrados con la forja (pasos 1.1-1.4):

```
harness.js tarea migrar               # solo enseña el plan: cuántos registros y cuáles son dudosos
harness.js tarea migrar --confirmo    # escribe gestion/tareas/<N>.json (idempotente; no pisa lo editado a mano)
harness.js tarea validar              # lista los campos «pendientes de revisar» de lo migrado
harness.js estado-indice --escribir   # regenera las líneas de tarea de cada fase en ESTADO.md
```

- `tarea migrar` **no inventa**: lo que no se puede deducir (objetivo, resultado de una tarea hecha,
  justificación de una descartada, fechas, apps en un monorepo) queda en `origen.revisar`. **Repásalos
  con el usuario**, campo a campo, y corrígelos con `harness.js tarea set <N> <campo> <valor>` o editando
  el JSON; al quedar sin pendientes el registro ya cuenta como revisado. `--incluir-cerradas` añade los
  issues cerrados de la forja que ESTADO.md no cita. Sin token o sin forja trabaja offline (solo
  ESTADO.md y los cambios), con más campos por revisar.
- `estado-indice` deja cada línea como `- [ ] #N · título — @quién` (`[x]` si la tarea está hecha o
  descartada), conserva marcadores como `[cu:…]` y **no toca nada más** de ESTADO.md (frontmatter,
  descripción, `Objetivo:`, criterios). `--comprobar` sale con 1 si el índice está desactualizado y
  `validate` lo avisa.
- Las líneas **sin `#N`** (tareas históricas que nunca tuvieron issue) reciben un id local `L-<n>`
  (`gestion/tareas/L-<n>.json`): se numeran en el orden de ESTADO.md y **no cambian** aunque marques la
  casilla, añadas líneas o repitas la migración; el registro guarda de dónde viene en
  `extensiones['migracion.origen']`. `estado-indice --escribir` las rotula (`- [x] L-3 · título`).
  Consúltalas con `harness.js tarea L-3` o `harness.js ir L-3`. Si más adelante creas el issue, anota su
  `#N` en la línea y migra de nuevo.
- Para **mantener al día** un registro con su issue: `harness.js tarea sync <N>` (o `--todas`) refresca solo
  lo que la forja sabe (abierta/cerrada, PR enlazados, subtareas hechas/total, fecha de cierre) y **nunca**
  pisa lo que escribes tú (objetivo, resultado, justificación, extensiones). `--comprobar` solo informa de
  la deriva. Si cierra una tarea sin `resultado`, te lo avisa: ponlo con `harness.js tarea set <N> resultado "..."`.
- La **descripción** de la fase y el **`Objetivo:` con fecha** siguen siendo obligatorios en las fases
  abiertas y los escribes tú en ESTADO.md: son la capa de gestión.

**No sustituyas las líneas por `Tareas: ver hito de esta fase`.** Una fase abierta sin casillas no
pasa `validate` (`Fase N: no declara ninguna tarea`): el faseo se contabiliza y se cruza con la
forja a partir de esas líneas.

Ajusta el `<estado>` de la fase si la realidad del hito lo contradice (todas cerradas y la fase seguía
`in_progress`, o quedan abiertas y figuraba `done`). El cierre forzoso impide cerrar un hito con
tareas abiertas dentro: si la fase debe quedar `done`, resuelve esas tareas primero.

Única excepción: una tarea hecha que **no** llegó a tener issue (trabajo anterior a la migración que
se decidió no migrar) se queda como `- [x] <título>`, sin `#N`, porque la forja no la conoce: no tiene
registro y `estado-indice` la respeta. Solo cabe en fases `done`: en una fase abierta, créala y ciérrala
(paso 1.3) para que tenga su `#N`.

**Ahora sí, pasa a la fase siguiente.**

## 2. Cierre

Cuando no queden fases por procesar:

```
harness.js resumen     # las migradas ya no cuentan como plan_sin_hito
harness.js validate    # sin huecos de faseo: cada línea con su #N y su @quién, [x] = issue cerrado
harness.js estado-indice --comprobar   # el índice de ESTADO.md cuadra con gestion/tareas/
```

Commitea con el recuento por fase: cuántas creadas, cuántas cerradas, cuántas enlazadas a issues
previos, cuántas descartadas.

## Si el volumen es alto

Los pasos 0 y 1.1-1.2 son de solo lectura: **delega a un subagente** el cruce checkbox↔issue de
todas las fases de una vez (`/faro:delegacion`) y trabaja luego sobre esa tabla. La confirmación y
la creación se quedan en el hilo principal.
