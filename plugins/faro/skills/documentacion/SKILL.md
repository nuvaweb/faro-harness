---
description: "Úsala SIEMPRE antes de crear o colocar un artefacto (documento, informe, nota, script, dato) en un repo FARO — decide si es gestión, entregable o spec y dónde vive."
---

# Directiva documental FARO

Esta skill es la **pauta única** para decidir qué es cada artefacto y dónde vive. El agente la aplica
con criterio; las plantillas (si existen en `documentos/plantillas/`) son APOYO opcional, nunca la regla.

## Caso especial: "quiero un documento de gestión de proyectos"

Es la petición MÁS AMBIGUA que recibirás — resuélvela así, sin dar por hecho ninguna interpretación:

1. **"Gestión de proyectos" NO es un documento único** en FARO — vive repartida y VIVA en varios
   sitios (`ESTADO.md` = plan y fases, `gestion/risks.md` = riesgos, `gestion/kpis.md` = indicadores,
   `gestion/decisions/` = decisiones, `gestion/reporting/` = informes). Fragmentarlo así evita que un
   PDF quede desactualizado el día después de generarlo: cada pieza se edita donde vive, sola.
2. **Pregúntale al usuario, en llano**, qué necesita de verdad (no asumas ni la jerga ni el formato):
   - *"¿Quieres ver cómo va el proyecto ahora mismo?"* → muéstraselo con `/faro:estado` (lectura, nada que crear).
   - *"¿Necesitas un documento para enseñar/entregar a alguien (dirección, cliente, comité)?"* →
     `/faro:onepager` (una página, actualizada al momento) o `/faro:reportar`
     (más detalle, versionado por fecha).
   - *"¿Quieres un PLAN completo tipo PMI (WBS, cronograma, RACI, presupuesto) para entregar como
     documento formal?"* → eso SÍ es un documento controlado: tipo `PLN` en `documentos/`, con
     `doc_id`, versión y aprobación — es la excepción que sale de `gestion/` porque se firma y se
     entrega, no se usa para dirigir el día a día.
3. Nunca generes un "documento de gestión" genérico sin haber aclarado cuál de los tres casos es —
   las tres respuestas usan datos y formatos distintos.

## La pregunta que decide el estándar

Antes de escribir NADA, clasifica el artefacto respondiendo UNA pregunta — ¿qué es esto?:

1. **¿Conocimiento que perdura y SE ENTREGA?** → **DOCUMENTO CONTROLADO** (entregable documental).
   - Control ISO: frontmatter con `doc_id` (CLAVE-TIPO-NNN, corto estilo Jira — la CLAVE se declara en `clave:` de ESTADO.md; generar con `harness.js docref <TIPO>`).
     **Gestión de la CLAVE** (`harness.js clave`): es ÚNICA en toda la organización (se registra como
     topic `clave-<clave>` del repo, verificado vía la API de la forja) y **estable de por vida** —
     renombrar el repo NUNCA la cambia (mismo principio que el renombrado: el nombre es cosmético,
     la clave es identidad permanente). Antes de fijarla por primera vez: `harness.js clave --sugerir
     "<nombre>"` la propone y avisa de repos con nombre PARECIDO en la org — si aparece uno, **pregunta
     al usuario** (nunca decidas solo) si es el MISMO proyecto (reutiliza su clave) o un
     microservicio/componente SEPARADO (clave propia está bien). Si la clave elegida ya está en uso
     en otro repo, `harness.js clave <CLAVE>` la fija igualmente y avisa `COMPARTIDA`: compartirla
     entre repos de un mismo proyecto es legítimo (back/pipeline/front). Lo que SÍ hay que acordar
     con el usuario es la numeración, porque los doc_id se cuentan por repo: rangos separados o
     tipos que no se solapen, para no emitir dos `<CLAVE>-TIPO-001` distintos. **En cuanto exista 1 documento controlado, `clave:` sin declarar en
     ESTADO.md BLOQUEA `validate`** (gestión documental estricta: una clave derivada en silencio no
     se puede corregir después sin romper los doc_id ya emitidos).
     `version` SemVer, `status` (`draft → in_review → approved → obsolete`), `classification`, `author`, `date`,
     y `description` (**recomendada**: UNA línea de qué va el documento — el harness la usa para inventariar
     y enrutar sin abrir el doc, y avisa si falta; docgen la pinta bajo el título en la portada, así que
     **≤ ~160 caracteres, una frase, sin punto final** — más largo se recorta en la maqueta).
     **`author` (y todo campo de persona: `deciders`, owner, responsable) NUNCA se inventa**: va el
     **login de la forja** del usuario (`harness.js identity`; para terceros `harness.js equipo`), y si
     no está disponible, el `user.name` de git; si tampoco, PREGUNTA. Nada de nombres plausibles ni
     de placeholders tipo "Equipo FARO" — firmaría a alguien que no ha firmado.
   - Vive SIEMPRE en subcarpeta temática `documentos/<tema>/` con nombre `<doc_id>-<slug>.md`.
     NUNCA en la raíz de `documentos/`. Queda `approved` al publicarse a main (`/faro:publicar`).
   - El TIPO sale del contrato (`faro-schema.json > tipos_documento`): BRF, FUN, ANA, ARQ, DIS, ADR, GUI, RUN…
     No inventar tipos; clasificar por el CONTENIDO real.
   - Todo cambio de contenido SUBE la versión y añade fila en «Control de versiones».
2. **¿El PROCESO de cambiar el sistema?** → **SPEC-DRIVEN**. Vive en `gestion/cambios/`
   (`changes/<cambio>/proposal.md` + `tasks.md`; specs vivas en `specs/`). La exploración/brainstorm
   es la fase 0 DEL CAMBIO, dentro de su carpeta — jamás una carpeta suelta.
3. **¿Dirección y seguimiento del trabajo?** → **GESTIÓN**. Vive en `gestion/` y `ESTADO.md`:
   riesgos (`risks.md`, RAID del PROYECTO, nunca bugs del tooling), KPIs (`kpis.md`), reporting.

**Gestión ≠ entregable.** Un informe de fase o una presentación es GESTIÓN (reporting DATADO en
`gestion/reporting/…/<tema>-AAAA-MM-DD.*`; misma fecha actualiza, fecha nueva = snapshot). Un
funcional, un análisis o un ADR es DOCUMENTO CONTROLADO (con `doc_id`, versionado, publicable).
Si dudas: ¿lo firmarías y entregarías a un tercero como conocimiento? → controlado. ¿Sirve para
dirigir/contar el trabajo? → gestión.

## Dónde va cada cosa (regla de ROL — nunca en la raíz)

- **Pensar** (teoría, hipótesis, exploración) → fase 0 del cambio: `gestion/cambios/changes/<cambio>/`.
- **Demostrar** (validación con valor) → método en `notebooks/` (o `scripts/` si reutilizable);
  la CONCLUSIÓN en un ANA de `documentos/analisis/` que lo referencia; evidencia en `fuentes/`.
- **Usar y tirar** → `borrador/` (gitignored, no se versiona).
- **Material recibido** (brutos, exports, evidencia) → `fuentes/`.
- **Ejecutable de automatización** (n8n, etc.) → `flujos/` (1:1 con su documento MAN).
- **NUNCA** notebooks/código/datos dentro de `documentos/` (solo prosa controlada).

Si el usuario pregunta «¿dónde pongo X?»: NO asumas — haz 1-2 preguntas de ROL (¿desechable o con
valor? ¿para pensar o para demostrar? ¿material recibido?) y coloca según esta regla, confirmando antes.

## Pautas de redacción (en vez de plantilla rígida)

- Estructura mínima de todo documento controlado: cabecera de control (frontmatter) → resumen
  ejecutivo → contenido según su tipo → control de versiones. La estructura interna se adapta al
  contenido real; no rellenes secciones vacías por cumplir una plantilla.
- Idioma del repo; términos técnicos en su forma original. Plantilla de marca solo en el ENTREGABLE
  renderizado (`documentos/entregables/`, se regenera desde el MD, nunca se edita a mano).
- Decisión estructural → ADR de **GESTIÓN** (no entregable) en `gestion/decisions/<AAAA-MM-DD>-<slug>.md`
  (estándar MADR/Nygard: `status` propuesta|aceptada|rechazada|sustituida, `deciders` '@usuario';
  'sustituida' exige `superseded-by`, enlazado en ambos ADR). `documentos/decisiones/` es legado a migrar.
- El pack documental que corresponde al trabajo lo recomienda el harness según el `type` del repo;
  valida siempre con `harness.js validate` antes de dar nada por colocado.
