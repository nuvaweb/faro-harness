---
description: "Úsala antes de aprobar una spec — revisión de calidad en background (subagente revisor-spec), veredicto APTA/NO APTA."
argument-hint: "[ruta o nombre de la spec]"
---

Si no se indica spec en $ARGUMENTS y hay **varias** en estado borrador, **pregunta cuál TÚ en el hilo principal** (con AskUserQuestion) ANTES de lanzar el subagente; si solo hay una en borrador, usa esa.

Luego lanza el subagente `revisor-spec` **en background** para revisar la spec indicada (ruta o nombre en `faro/gestion/cambios/changes/<cambio>/proposal.md`). El subagente es **solo lectura** y no puede interrumpir con preguntas — `AskUserQuestion` no existe dentro de un subagente, la plataforma la filtra siempre —, así que devuelve un veredicto (APTA / NO APTA / APTA CON RESERVAS) con los problemas por severidad.

**Por que en background:** revisar una spec obliga a leer la spec, el funcional, el faseo y las specs
vecinas para devolver un veredicto de pocas lineas. Esa lectura se queda en el subagente y a la sesion
solo vuelve la conclusion. Ojo al orden: la pregunta de QUE spec revisar va ANTES y en el hilo
principal (arriba) — un subagente en background no es sitio para preguntar. Mientras corre, no
anticipes su veredicto: no lo sabes hasta que llega.

Preséntaselo al usuario. Solo si el veredicto es APTA y el usuario **confirma**, actualiza el frontmatter de la spec a `estado: aprobada` con `aprobada_por:` el usuario git actual.
