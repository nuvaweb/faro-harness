# Plantilla de ADR (decisión de arquitectura)

Un ADR registra **una decisión** y por qué se tomó. Vive en `gestion/decisions/<AAAA-MM-DD>-<slug>.md`.

Estándar: **MADR** (Markdown Any Decision Records). MADR define 9 secciones; FARO exige **4** y deja
las otras 5 preparadas como opcionales.

## Por qué estas cuatro

Las tres primeras son las obligatorias de MADR. La cuarta la añade FARO:

| Sección | Qué responde | Por qué no es opcional aquí |
|---|---|---|
| Contexto y problema | Por qué hubo que decidir algo | Sin esto, dentro de un año nadie sabe qué presionaba |
| **Alternativas consideradas** | Qué más se valoró y por qué se descartó | Distingue *«se valoró y se descartó»* de *«nadie lo pensó»* — son opuestos, y es la pregunta que vuelve cada vez que alguien reabre el tema |
| Decisión | Qué se eligió | El registro en sí |
| **Consecuencias** | Con qué se carga a cambio | Distingue un fallo de un precio aceptado a sabiendas. Sin esto, cada limitación se reabre como si fuera un bug |

Las dos marcadas son las que usa el **triaje** para responder a lo que llega de fuera. Un ADR sin
ellas no se puede citar: el triaje tendrá que pararse y preguntar.

## Las 4 obligatorias

```markdown
---
status: propuesta          # propuesta | aceptada | rechazada | sustituida
date: AAAA-MM-DD
deciders: '@usuario'       # quien decide (login de GitHub, no texto libre)
consulted: '@otro'         # opcional (MADR): a quien se consultó
informed: '@equipo'        # opcional (MADR): a quien se informa
---

# Título corto: el problema y la solución en una línea

## Contexto y problema

Qué situación había y qué había que resolver. Los hechos, no la solución.

## Alternativas consideradas

- **Opción A** — descartada porque <motivo concreto>
- **Opción B** — descartada porque <motivo concreto>
- **Opción C** — elegida

Si solo hubo una opción real, dilo y explica por qué no había más. «No se valoró nada más»
también es información: evita que alguien crea que se estudió y se rechazó.

## Decisión

Qué se eligió y por qué esa y no otra.

## Consecuencias

Lo bueno y lo malo que trae. Lo malo sobre todo: es el precio que se aceptó a sabiendas, y es lo
que evita que alguien lo reporte como fallo dentro de seis meses.
```

## Las 5 opcionales de MADR

Están para cuando la decisión las pida. No se exigen porque un ADR de 9 secciones cuesta media hora,
y a la tercera decisión nadie los escribe — un ADR pobre se mejora, uno que nunca se escribió no
deja rastro.

```markdown
## Decision drivers
Las fuerzas que empujaban: coste, plazo, riesgo, una restricción externa.

## Confirmación
Cómo se verifica que la decisión se cumple (test, revisión, métrica).

## Pros y contras de las opciones
El desglose detallado de cada alternativa. Útil en decisiones grandes de arquitectura.

## Más información
Enlaces, acuerdos del equipo, evidencia, ADR relacionados.
```

## Reglas que valida el harness

- `status` del enum, y `deciders` con `@usuario` (no texto libre).
- `status: sustituida` exige `superseded-by`, y el linaje se enlaza **en ambos sentidos**.
- Las 4 secciones, con contenido de verdad: un encabezado con nada debajo (o con `TBD`) cuenta como
  que falta.

### ADR anteriores a 2026-09-22

No se rompen. Se avisa de lo que les falta, pero **no bloquean**: un repo con historia no puede
encontrarse `validate` en rojo por decisiones de hace meses — el reflejo sería desactivar la regla,
y se perdería también para las nuevas.

Se completan preguntando, en los dos momentos en que sale barato:

- **al editar ese ADR** — ya lo tienes abierto y el contexto está fresco;
- **cuando el triaje necesite citarlo** — ahí la respuesta se aprovecha en el acto.

Y nunca los rellena el agente por su cuenta. Un ADR dice qué se decidió y por qué, y eso solo lo sabe
quien estuvo: inventarlo sería fabricar historia, y el triaje acabaría citando como decisión algo que
nadie decidió.

## Repos que adoptan FARO con historia previa

El problema ahí no es que los ADR estén incompletos: es que **no hay ninguno**. Las decisiones se
tomaron — el código las demuestra — pero nunca se escribieron.

`adoptar` pregunta por las estructurales y las registra. No es documentar por documentar: sin eso, el
triaje solo puede responder «falta decidir» a todo.
