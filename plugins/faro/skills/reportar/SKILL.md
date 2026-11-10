---
description: "Úsala para el informe de cierre de fase o semanal, o una pieza puntual por tema, en documento y/o presentación (redactor-informe + presentador-faro)."
argument-hint: "[fase N | semanal | estado | presentada | <tema>]  (vacío = el que toque)"
---

> **Rama de trabajo (obligatorio antes de generar):** una pieza de reporting se ESCRIBE. Si estás en `main`/`master`/`develop` (instancia, no template), NO generes aquí — abre primero una rama `docs/<tema>` (`node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" rama docs "<tema>"`), genera ahí y entra por PR a develop (`/faro:pr`). El harness lo bloquea si lo intentas en rama protegida.

Ejecuta **TÚ en esta conversación (hilo principal)**, NO como subagente — así `AskUserQuestion` funciona y puedes preguntar al usuario con opciones. Todo el reporting de `gestion/reporting/` se **confecciona** desde la evidencia real (artefactos + git), nunca se inventa ni se rellena con supuestos: si algo falta o no cuadra, señálalo y pregunta. **Reporting SIEMPRE versionado por FECHA, nunca SemVer** (es snapshot datado, no conocimiento vivo con `doc_id`): misma fecha → ACTUALIZA ese mismo fichero; fecha nueva → snapshot nuevo, los datados conviven.

Según `$ARGUMENTS`, decide el modo y el rol:

- **"fase N" o "semanal"** (o vacío → el que toque según ESTADO.md) → adopta el rol **redactor-informe**: informe de **cierre de fase / semanal**, gate obligatorio de cierre de fase. Fichero plano y datado en `gestion/reporting/informes/AAAA-MM-DD-fase-<N>-informe.md` (o `-semanal-informe.md`). Para el semanal, el esqueleto con los datos del faseo lo genera `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" informe-semanal` (el arranque de sesión solo avisa de que toca; ya no lo escribe solo): partes de ahí y lo completas con la evidencia.
- **Sin tema (o "estado")** → adopta el rol **presentador-faro**: presentación de **estado** a dirección, SIEMPRE DATADA (`gestion/reporting/presentaciones/<AAAA-MM-DD>-presentacion-estado.html`), plantilla neutra de FARO (6 diapositivas: BLUF, qué es, flujo, roadmap, estado de fase, riesgos+decisiones).
  - Si incluye **"presentada"** → además `git tag presentacion-<AAAA-MM-DD>` (marca la que se presentó).
- **Un tema** (p. ej. "de la integración X", "resultados Q2", "de la fase 2") → pieza **PUNTUAL por-tema**: localiza el documento de referencia y confecciónala en `gestion/reporting/{informes,presentaciones}/<tema>/<tema>-AAAA-MM-DD.md` (+ HTML hermano), con frontmatter FARO. **Pregunta la vista** (AskUserQuestion) si no viene clara:
  - Vista **documento** (vertical, rol redactor-informe): `docgen <ruta.md>`.
  - Vista **presentación** (horizontal animada, rol presentador-faro, síntesis 1 idea/slide): `docgen <ruta.md> --presentacion`.
  - Puedes generar ambas si se piden. Misma fecha → ACTUALIZA ese fichero (se re-pide ese día); fecha nueva → snapshot nuevo.
- **"para negocio" / "en Word"** → reporte de negocio en **.docx** con la plantilla neutra de FARO (valor entregado, plazo, KPIs, riesgos, próximos pasos; nada técnico): `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" reporte-negocio` → `gestion/reporting/informes/<AAAA-MM-DD>-reporte-negocio.docx` (misma fecha = se actualiza).

Recuerda: ninguna pieza de reporting cierra la fase — el cierre lo decide el usuario después de revisarla.

Instrucciones adicionales del usuario: $ARGUMENTS
