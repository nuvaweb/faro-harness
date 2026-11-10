# Plantillas — las provee el PLUGIN, no este repo

Aquí ya no hay esqueletos de documento ni plantillas HTML. **El contrato documental
vive en el plugin `faro`** (`faro-schema.json`) y se actualiza solo con `autoUpdate`.

## Por qué se retiraron

Cada repo se quedaba con la copia del día en que nació. Mejorar una plantilla obligaba
a re-aplicar la capa FARO repo por repo, y `faro check` ni lo detectaba (solo comprueba
que exista la carpeta `documentos/`, nunca su contenido). Resultado: repos con plantillas
de hace meses sin que nadie lo supiera.

Y el dato: de 36 tipos declarados solo 18 se habían usado, y tres de los usados
(`ESP`, `DOC`, `TEC`) **no tenían plantilla**. La gente los escribió igual. El esqueleto
no es lo que habilita el documento — el criterio sí.

## Qué hay ahora

**Instrucciones por familia**, no un esqueleto por tipo. Cada documento responde a una
pregunta, y de ahí sale su estructura:

| Familia | Pregunta | Tipos |
|---|---|---|
| `entender` | Cómo funciona, por qué pasa | ANA · INV · TEC · RES |
| `definir` | Qué debe hacer | FUN · BRF · PRF · HU · ESP · SRV · QA |
| `disenar` | Cómo se construye | ARQ · DIS |
| `decidir` | Por qué así y no de otra forma | ADR |
| `operar` | Cómo se usa, cómo se mantiene | GUI · RUN · MAN · PRO · INC · CHG |
| `gobernar` | Qué regla hay que cumplir | COM · POL · DPIA · ACU · SLA |
| `dirigir` | Cómo se organiza el trabajo | PLN · RACI · LEC |
| `general` | Último recurso | resto |

## Cómo se usa

```
harness.js tipo              # catálogo: qué tipos hay y para qué sirve cada uno
harness.js tipo ADR          # secciones, criterio, diagramas, errores y frontmatter
harness.js docref ADR        # el doc_id correlativo (nunca a mano)
harness.js docgen <md>       # entregable HTML con la plantilla de marca del plugin
```

Los artefactos de reporting: `/faro:onepager` (decisión, dirección) · `/faro:roadmap`
(dónde estamos, cliente) · `/faro:reportar` (informe o presentación de estado).

## Si necesitas personalizar algo en ESTE repo

- **Una plantilla HTML**: cópiala a `documentos/plantillas/html/<nombre>.html`. El harness
  usa la del repo si existe, si no la del plugin.
- **El contrato** (tipos, familias, cabecera): crea `.claude/faro-schema.json` con tu
  override — tiene prioridad sobre el del plugin.

En ambos casos dejas de recibir mejoras en eso que copias. Hazlo solo si de verdad este
repo debe salirse del estándar, y anótalo en un ADR.
