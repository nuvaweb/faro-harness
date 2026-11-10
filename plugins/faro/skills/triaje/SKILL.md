---
description: "Úsala para triar lo que llega de fuera (reportes, peticiones, ideas) — juzga si merece hacerse y por qué, citando lo escrito, y publica el motivo en el issue."
argument-hint: "[<N> | --criterio]"
---

**Triar no es clasificar.** Etiquetar algo como bug/idea/sugerencia no decide nada. La pregunta cara
es la segunda: **¿merece la pena hacerlo, y por qué sí o por qué no?** Sin esa respuesta escrita, el
Backlog solo crece — descartar sin motivo se siente arbitrario, así que nadie descarta, y un backlog
que solo crece deja de leerse.

Ejecútalo **TÚ en el hilo principal (inline)**, no como subagente: necesitas `AskUserQuestion`.

## La regla que no se rompe

El veredicto se justifica **contra algo escrito**, nunca contra tu opinión. Lo escrito es, por orden
de fuerza:

1. el **fuera de alcance** del funcional — la única exclusión deliberada;
2. los **requisitos** (`gestion/requisitos.md`, REQ-NN con estado);
3. las **decisiones** (`gestion/decisions/`, ADR con status).

Si nada de eso aplica, el veredicto **no es «no aplica»**: es **«falta decidir»**. Esa tercera salida
existe justo para que no inventes un criterio con tal de no quedarte callado.

## Antes de triar nada: ¿hay criterio?

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" triaje --criterio
```

Devuelve cuánto criterio hay y qué falta. **Si `listo` es `false`, no empieces a triar**: solo podrás
responder «falta decidir» a todo, y quien reportó se llevará la impresión de que el triaje no sirve.

Enséñale los huecos al usuario y **pregunta** (`AskUserQuestion`) con las preguntas que trae cada uno.
Con sus respuestas:

- **`funcional` / `fuera-de-alcance`** → escribe el apartado `## Fuera de alcance` en el funcional.
  Tres líneas bastan. Es lo que más veredictos justifica.
- **`decisiones`** → crea los ADR en `gestion/decisions/<AAAA-MM-DD>-<slug>.md` con la plantilla
  (`${CLAUDE_PLUGIN_ROOT}/docs/plantilla-adr.md`).
- **`requisitos`** → regístralos en `gestion/requisitos.md` con estado y origen.

En un repo que **adopta FARO con historia previa** esto es lo normal: las decisiones se tomaron —el
código las demuestra— pero nunca se escribieron. Sembrar el criterio es el trabajo, no un trámite
previo.

> **Nunca rellenes tú el criterio.** Un fuera de alcance o un ADR dicen qué se decidió y por qué, y
> eso solo lo sabe quien estuvo. Si lo inventas, el triaje acabará citando como decisión algo que
> nadie decidió — peor que no tener criterio, porque parece que lo hay.

## Lo que llega de un canal de feedback

**FARO no construye el canal.** El widget del producto, el formulario, el Worker que recibe y abre el
issue — eso es automatización del producto, no del harness.
FARO empieza **cuando el issue ya está en la bandeja de entrada**: abierto, **sin
hito**, normalmente etiquetado `reporte` y con un tipo **sugerido** (`bug`, `enhancement`).

**Empieza por recuperar la bandeja** — no dependas de que alguien te pase el número:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" triaje --bandeja
```

Lista lo que espera triaje, la más antigua primero, con tipo sugerido, origen, votos y si viene de
fuera. Sale todo lo abierto sin hito, más lo etiquetado `reporte`: lo que manda el canal y lo que
alguien creó a mano en la web.

Un issue con esa etiqueta significa *"viene de fuera y nadie ha decidido nada"*: **no es trabajo
aceptado**, no tiene `#N` de fase, ni owner, ni criterios — y no debe tenerlos, porque exigírselos lo
convertiría en trabajo antes de decidir si merece hacerse.

**Trae el issue entero, no solo el título.** El triaje lee lo que el canal haya puesto en el cuerpo
(`url`, `pantalla`, `frecuencia`, `afecta a`, captura) y las señales del propio issue:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" issue <N>
```

**Lee también lo que lleva adjunto** (capturas, PDF, logs, hojas de cálculo), del cuerpo y de los
comentarios. Muchas veces es la mejor evidencia: en un bug visual, la captura; en una revisión de
textos, el PDF con cada pantalla y su «original → propuesto». El texto solo dice que existe:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" triaje adjuntos <N>          # o <org>/<repo>#<N>
```

Descarga cada adjunto (con el token, que en repos privados hace falta) y dice cómo abrirlo (campo
`leer`): imágenes y PDF con Read; texto, log, csv y json, Read tal cual; docx y xlsx, con su skill.
**Ábrelos antes de dar el veredicto** y cuenta lo que ves en la explicación del issue. Si alguno trae
`motivo` (no se pudo descargar, pesa demasiado...), dilo: *"hay un adjunto que no he podido abrir"*.
Nunca lo calles.

De ahí salen los dos datos que más cambian el veredicto, y son **hechos, no lecturas del tono**:

- **votos (👍) y comentarios** → si dos personas distintas lo respaldan, **no es un caso individual**
  por muy en primera persona que esté escrito.
- **`author_association`** → si lo abre alguien del equipo o alguien de fuera.

Y un canal de feedback no trae solo bugs: trae **bugs, ideas y sugerencias** mezclados, y cada uno se
juzga contra una pregunta distinta. Descartar una idea *"porque no está en la spec"* es correcto;
descartar un **bug** por lo mismo sería absurdo — un fallo no necesita estar planificado para serlo.

## Triar un reporte

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" triaje '{"titulo":"…","cuerpo":"…"}'
```

Devuelve el veredicto, el motivo y el `comentario` listo para publicar. Los veredictos:

| Veredicto | Qué significa | Qué haces |
|---|---|---|
| `aplica` | Lo respalda un requisito vivo | Propón a qué fase va, citando el REQ-NN |
| `no-aplica` | Lo excluye algo escrito | Publica el motivo **con la cita** |
| `sin-criterio` | Nadie lo ha decidido | Lleva la decisión al usuario, no lo descartes |
| `falta-criterio-adr` | El ADR que tocaría citar está incompleto | **Para y pregunta** (abajo) |

### `falta-criterio-adr`: pregunta antes de juzgar

Pasa cuando el reporte toca terreno de un ADR que no declara alternativas. Sin esa sección no se
puede saber si lo que piden **se valoró y se descartó** o si **nadie lo pensó** — son opuestos, y
emitir un veredicto sin saberlo sería inventarlo.

El campo `pedir` trae el ADR y la pregunta. Pregúntala (`AskUserQuestion`), **completa el ADR con la
respuesta del usuario** y vuelve a triar: ahora sí habrá criterio, y el próximo reporte parecido ya
no preguntará.

### La señal `individual`

Marca reportes redactados como necesidad de quien los pide («en mi caso», «nos vendría bien»). FARO
aplica **estándares**, no casos particulares — pero es una **señal, no un veredicto**: si un requisito
aceptado lo respalda, aplica igual aunque esté mal redactado. Enséñasela al usuario; no descartes por
ella sola.

## Publicar el resultado

Con el veredicto confirmado por el usuario, publica el comentario en el issue:

```
node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" comentar <N> "…"
```

**Publica también los «no aplica»** — sobre todo esos. Un reporte que se cierra sin explicación enseña
a la gente a no reportar; uno que se cierra con el motivo y con qué haría falta para cambiarlo,
enseña a reportar mejor.

## Después del veredicto

- **Aplica** → quita `reporte`, confirma o corrige el **tipo** (el del canal es una pista),
  completa la plantilla de su tipo **sin reescribir lo que trajo** (`harness.js reparar-tarea <N> --confirmo`
  conserva las secciones del canal y solo añade las que faltan) y dale **hito**:
  `harness.js mover-tarea <N> --hito <K|backlog>` — un bug a la fase activa; una mejora a su fase, o
  al Backlog si está aceptada sin fecha. `mover-tarea` exige el formato del tipo al salir de la bandeja
  y fija el **tipo de GitHub** (Bug/Feature/Task) según la etiqueta: corrige la etiqueta antes de mover.
  Todo issue lleva tipo de GitHub, sin excepciones (un `reporte` nace como Task); los que falten los
  lista `harness.js reparar-tarea` y los arregla `reparar-tarea <N> --confirmo`.
- **No aplica** → publica el motivo y ciérralo como `not_planned` (`harness.js descartar-tarea <N> "<motivo>"`).
- **Falta decidir** → se queda en la bandeja; lleva la decisión al usuario.

## Lo que confirma el usuario

Tú **propones**, el usuario **confirma**, y entonces ejecutas. Nunca cierres un issue ni escribas en
la forja por tu cuenta: enseña los veredictos agrupados, con sus motivos, y pide el visto bueno de una
vez para todos los que estén claros.

**Cuenta cada issue antes de preguntar: no des por hecho que el usuario lo conoce** (#96). Quien
confirma no tiene por qué haberlo leído: puede llevar semanas en la bandeja o venir de fuera. Si la
pregunta solo trae `#N` y un veredicto, el usuario tiene que abrir la forja para responder, o confirma
a ciegas. Antes de cualquier `AskUserQuestion`, por cada issue, en texto:

- **Qué es**, en una frase llana (el problema o la petición, no el título copiado), y **de dónde viene**:
  quién lo abrió (del equipo o de fuera), hace cuánto, votos y comentarios.
- **Qué has comprobado**: si sigue pasando o no, con la evidencia (la salida, el fichero y la línea).
- **El veredicto que propones** y lo escrito que lo respalda, o por qué falta criterio.
- **Qué pasa con cada opción**: a qué hito va, qué se publica en el issue, qué se cierra o se crea.

Y en la propia pregunta, cada opción lleva en su `description` la **consecuencia concreta**
(«se queda en la bandeja», «se cierra como no se hará con este motivo», «va al hito 0.56»), no solo
el nombre del veredicto.
