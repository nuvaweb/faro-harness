---
description: "Úsala cuando pregunten qué tienen pendiente, qué les han asignado o en qué trabajar — sus issues abiertos en toda la organización, con el repo de cada uno."
argument-hint: "[--todas detalle de otras repos · --all incluye cerradas · --repo solo esta repo]"
---

Las Tareas de FARO son **Issues en GitHub e incidencias en GitLab**: el comando funciona igual en las dos, el harness elige el adaptador por el remoto. Solo si `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" forge` dice `desconocida` no aplica: dilo en llano y para.

Ejecuta `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" mis-tareas` y presenta el resultado con claridad.

Una **Tarea** en FARO es un **Issue de GitHub** (no un bug: es la unidad de trabajo asignable).

**Manda la repo actual.** El listado detalla las tareas de ESTA repo — las que se pueden trabajar aquí
y ahora — y de las demás da solo el recuento por repo. Es deliberado: el harness gobierna la carpeta
en la que estás, así que tocar otro proyecto desde aquí lleva a trabajar fuera de su gobierno.

- `--todas` despliega también el detalle de las otras repos (solo para consultar, no para trabajarlas).
- `--all` incluye las cerradas (repasar lo hecho).
- `--repo` fuerza a mirar únicamente esta repo.

## Cómo presentarlo

- Primero las de esta repo, que son las accionables. Si no hay, dilo claro.
- De las otras repos, respeta el resumen: **no las conviertas en un plan de trabajo**. Si el usuario
  quiere una, indícale que abra ESA repo en su propia sesión — no empieces a tocarla desde aquí.
- Si no hay ninguna en ningún sitio, dilo en una línea y no adornes.
- Si responde `SIN_TOKEN`, el usuario no está conectado a la API: explícale que la conexión es
  necesaria para leer los Issues (aunque use SSH: la SSH mueve el código, la API necesita token) y
  ofrécele `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" auth`, que da un código de 6 dígitos.

## Qué NO es

- **No** son las ramas pendientes de promover o aprobar → eso es `/faro:pendientes`.
- **No** son la planificación externa (proyecto, épicas): si hay planificador declarado, esa se ve con `harness.js planificacion`.

Si el usuario quiere ver el panel completo del proyecto, encadena con `/faro:estado`. Para asignar
trabajo a alguien: `harness.js asignar-tarea "<título>" <login> [<slug-change>] ["<cuerpo>"] --tipo <tipo> [--hito <N|backlog|titulo>]`
(le llega aviso de GitHub). **El `--tipo` es OBLIGATORIO** — todo issue lleva un label. Ejecuta
`harness.js asignar-tarea` sin argumentos para ver el catálogo con descripciones, y **si dudas entre dos
tipos, pregunta al usuario con AskUserQuestion**; no adivines. Un modificador transversal
(`urgente`, `riesgo`, `compliance`, `seguridad`) se añade aparte con `--extra <slug>`, no sustituye al tipo.
En un **monorepo**, añade `--app <app>` (de qué app es: etiqueta `app:<app>`, que decide sus gates y
revisores; `harness.js apps` lista las válidas). Si no la pones, el harness avisa y propone una. Un
**bug** nace con su plantilla: Comportamiento actual / Comportamiento esperado / Lo que NO debe cambiar /
Pasos para reproducir. Para pasar un issue a un subagente que lo implemente, dale su ficha:
`harness.js ficha <N>` (issue, app, cambio vinculado y rutas, en menos de 2.000 tokens).

**Campos de issue de la organización** (GitHub, #215): fecha objetivo, inicio, prioridad, esfuerzo… o los que
defina la organización. Al crear: `--fecha-objetivo AAAA-MM-DD`, `--inicio AAAA-MM-DD`, `--prioridad <opción>`,
`--esfuerzo <opción>` o, para cualquier otro, `--campo "Nombre=valor"` (repetible). Se validan antes de crear nada.
Sin `--fecha-objetivo`, el issue **hereda la fecha de su hito** (fase, versión o el que sea) si la tiene, y al
`mover-tarea` esa fecha heredada sigue al hito nuevo; una fecha puesta a mano no se toca. Después:
`harness.js campos-tarea` (campos de la organización), `campos-tarea <N>` (valores del issue),
`campos-tarea <N> --campo "Nombre=valor"` o `--quitar <campo>`.

**`--hito` ancla el issue a su hito** — la fase N de faro/ESTADO.md, `backlog` o el título de un hito que ya exista (un hito no siempre es una fase; `--fase` se acepta como alias con aviso): OBLIGATORIO en un tipo que PLANIFICA
(requerimiento/mejora/tarea/documentacion/investigacion/diseno/datos) — no puede quedar suelto de
un ciclo —, OPCIONAL en uno que SURGE (bug/infra/pregunta) — no tiene que fingir que estaba
planificado. `--hito backlog` para lo ya aceptado pero sin fecha decidida. Si necesitas documentar de
qué fase VIENE un hallazgo sin colgarlo de ella (p. ej. un bug de la Fase 1 encontrado en la Fase 3,
y la Fase 1 ya está cerrada), usa `--origen-fase <N>` — es independiente de `--hito`.

Es una consulta de LECTURA: sin ceremonia, sin confirmaciones, sin escribir nada.


## Un issue es un ENTREGABLE DE VALOR — no atomices

**La jerarquía es fase → issue → subtarea**, y equivale a la de siempre (épica → historia → subtarea):

| Nivel | Qué es | Dura | ¿Rama propia? |
|---|---|---|---|
| **Fase** | hito de la forja | meses | no |
| **Issue** | entregable con sentido propio | días | **sí — 1 rama, 1 PR** |
| **Subtarea** | checkbox dentro del issue o del `tasks.md` | horas | no |

Un issue **agrupa** todo lo necesario para entregar algo:

- ✅ *"Personalización e identidad del portal"* → marca, colores, traducciones, favicon dentro.
- ❌ *"Renombrar la marca"* + *"Traducir el subtítulo"* + *"Poner el favicon"* como tres issues.

**Regla práctica:** si se hace en un rato y no entrega valor por sí solo, es SUBTAREA. Si necesita su
propia rama y su PR para tener sentido, es ISSUE. **Ante la duda, agrupa** — un issue amplio se amplía
luego; tres issues atomizados ya han ensuciado el hito y dejado ramas que nadie cierra.

**Si el trabajo encaja en un issue ya abierto, AMPLÍA ese** (añade la subtarea a su cuerpo) en lugar de
crear otro. Vale especialmente cuando lo único que cambia es **quién** lo hace: reasignar o repartir
no justifica un issue nuevo.

### Estructura del issue: AUTOCONTENIDO

Un issue lo coge una persona **o un agente**, y **un agente no pregunta**: lee lo que hay y rellena
los huecos suponiendo. Así que el issue debe poder ejecutarse sin reconstruir contexto. Mismo
esqueleto para **bug, feature y tarea** — solo cambia el acento:

```markdown
## Objetivo
Qué se consigue, en una frase.
  · bug → qué falla y por qué importa   · feature → qué problema resuelve y a quién sirve

## Contexto
Qué leer primero: ficheros, spec, decisión previa.
  · bug → pasos para reproducir · esperado vs. real · entorno

## Alcance            → qué entra
## Fuera de alcance   → qué NO entra (evita que se amplíe solo — crítico con agentes)
## Subtareas          → el desglose (`--subtarea`, acumulable)
## Criterios de aceptación
- [ ] Observable desde fuera: al hacer X ocurre Y. NUNCA detalle de implementación.
```

Los **criterios de aceptación son la Definition of Done**: si no se puede comprobar desde fuera, no
es un criterio. El harness avisa al crear la tarea si el cuerpo no cumple la estructura (avisa, no
bloquea: a veces se crea primero y se detalla después — pero complétalo **antes** de que alguien la
empiece).

Los **bugs quedan fuera de esta jerarquía**: `--hito` es opcional en los tipos que SURGEN
(bug/infra/pregunta) porque no estaban planificados, y `--origen-fase <N>` documenta de dónde vienen
sin colgarlos de esa fase.


## El Backlog es la SALA DE ESPERA — y solo se sale a una fase

Ahí aterriza lo aceptado sin decidir cuándo se hace (`--hito backlog`): visible y contado como
cualquier hito, no perdido.

```
harness.js mover-tarea --listar backlog        # qué espera, y hace cuánto
harness.js mover-tarea <N> --hito <M> ["<motivo>"]   # sácala a su fase
```

`mover-tarea` sirve también entre fases cuando cambia el alcance, y **siempre deja constancia en el
issue** (de dónde viene, a dónde va, por qué): mover trabajo es una decisión de gestión, no un ajuste
silencioso.

**Regla dura**: una tarea **NO se cierra como completada desde el Backlog**. Si se hizo, pertenecía a
alguna fase — muévela primero y ciérrala después. `harness.js cerrar-tarea <N>` lo exige. Lo que no
se va a hacer no es un cierre por completado: eso es `descartar-tarea <N> "<motivo>"`.


## Hitos, cierre forzoso, tiempo y enlaces

- **Fase = hito, en las DOS forjas.** `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" hito` lista los hitos con tareas
  cerradas/total (y horas estimadas/consumidas en GitLab); `hito sync` crea uno por fase de faro/ESTADO.md ("Fase N — nombre")
  y cierra los de fases terminadas — disparado también por `/faro:publicar`.
- **Cierre FORZOSO: una fase terminada no cierra su hito con tareas suyas abiertas dentro.** El harness
  DETECTA y avisa cuántas quedan (nunca las mueve ni las cierra por su cuenta — mover una tarea de fase
  es una decisión de gestión, no del motor). Resuélvelas antes de dar la fase por cerrada: ciérralas,
  muévelas a otra fase (`asignar-tarea --hito`) o descártalas (`descartar-tarea`).
- **`hito auditar`: barrido de TODO el trabajo abierto, no solo lo que crea el harness.** Dos
  secciones, un mismo principio — una tarea se debe CERRAR, no olvidarse:
  - **Huérfanos** (sin hito): un issue abierto desde la web, por un bot o por integración externa
    no pasa por `--hito`/`--issue`. `mover-tarea <N> --hito <M|backlog>` para anclarlo.
  - **Olvidados** (con hito, pero sin tocarse ≥30 días): bien anclado no basta si nadie lo cierra
    nunca. `cerrar-tarea <N>` si está hecho, `descartar-tarea <N> "<motivo>"` si no se hará.
  Ambas listas salen ordenadas de menor a mayor número. Los de tipo cierre (duplicado/descartado)
  no cuentan como huérfanos: cerrar no es planificar. Úsalo periódicamente, no solo cuando algo falla.
- **`hito verificar <titulo>`: ¿el cierre de ESE hito fue adecuado?** Distinto de `auditar` (que mira
  todos): contrasta cada tarea del hito contra evidencia (un PR fusionado que la referencie) y dicta
  si el cierre fue correcto o quedó algo colgando, tanto si lo cerró el harness como si fue a mano.
- **En el arranque** ves cuántas tareas de plan quedaron sin fase (y cuántas llevan >30 días sin tocarse),
  sin coste: lo calcula el refresco de fondo. `harness.js resumen` lo dice siempre, aunque sea 0.

### Solo en GitLab (gestión nativa adicional)

- **Horas reales, no a mano.** `harness.js tiempo <tarea> 2h` registra consumo; `tiempo <tarea> --estimar 1d` estima;
  `tiempo <tarea>` muestra ambos; `tiempo` sin argumentos agrega por hito (estimado vs consumido: la base del informe de fase).
  Duraciones: `30m` · `2h` · `1d` · `"1h 30m"`.
- **Dependencias.** `harness.js enlazar <t> bloquea <t2>` (o `bloqueada-por`, `relaciona`). El bloqueo real es
  Premium/Ultimate: en Free queda como "relacionada con" y el comando te lo dice.
- **Al crear:** `asignar-tarea … --hito "Fase 2 — Piloto" --estimacion 4h --vence 2026-10-01 [--peso 3] [--bloqueada-por 12]`.

## Issues sin estructura (el detalle vive AHÍ)

En FARO el detalle del trabajo —contexto, alcance, subtareas, criterios de aceptación—
vive **en el issue**; `faro/ESTADO.md` solo lleva el checkbox de una línea, que **se genera** desde el registro `faro/gestion/tareas/<N>.json` (`harness.js estado-indice --escribir`; el histórico se rellena con `harness.js tarea migrar`, ver `/faro:migrar-tareas`). Un issue sin
estructura deja el trabajo sin definir en el único sitio donde debería estarlo, y quien
lo coja (persona o **agente**) rellenará los huecos suponiendo.

```bash
harness.js reparar-tarea              # audita: qué issues abiertos no cumplen
harness.js reparar-tarea <N>          # muestra cómo quedaría (no escribe)
harness.js reparar-tarea <N> --confirmo
```

La reparación **conserva lo que hubiera** (pasa a `Contexto`) y añade las secciones que
falten con marcadores `<...>`. Pone el esqueleto: **no inventa el contenido**.

**Si hay varios issues rotos, o hay que reconstruir qué pretendían**, lanza el agente
**`sanador-issues`**: investiga el repo (el change spec-driven asociado, la rama, el PR,
los comentarios, el hito) para reconstruir cada cuerpo con fundamento, y detecta los que
no deberían seguir abiertos — ya entregados (cerrar), abandonados (descartar) o sin
decidir cuándo (mover a `Backlog`). Propone uno por uno; decides tú.

