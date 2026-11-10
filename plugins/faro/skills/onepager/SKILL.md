---
description: "Úsala para un one-pager ejecutivo — una página de decisión (estado + negocio) con la plantilla neutra de FARO, desde faro/ESTADO.md, risks.md y kpis.md."
argument-hint: "[foco opcional]"
---

> **Rama de trabajo (obligatorio antes de generar):** un one-pager se ESCRIBE. Si estás en `main`/`master`/`develop` (instancia, no template), NO generes aquí — abre primero una rama `docs/<tema>` (`node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" rama docs "<tema>"`), genera ahí y entra por PR a develop (`/faro:pr`). El harness lo bloquea si lo intentas en rama protegida.

Genera el **one-pager ejecutivo** del trabajo: UNA sola página (plantilla neutra, imprimible A4, claro/oscuro) que cruza **estado de proyecto** (semáforo RAG global, salud por dimensión, avance de fases, hitos) con **negocio** (KPIs, valor) y remata con **"Decisiones para dirección"**. Estándar de industria (RAG + A3 + OKR/Scorecard). Ejecútalo **TÚ en el hilo principal (inline)**, NO como subagente — así puedes preguntar con `AskUserQuestion`.

Mecánica:

1. **Genera** con `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" onepager` — lee `faro/ESTADO.md` + `faro/gestion/risks.md` + `faro/gestion/kpis.md`, deriva el modelo (RAG, dimensiones, avance, hitos, riesgos top, decisiones) y escribe `faro/gestion/reporting/presentaciones/onepager-AAAA-MM-DD.html`. **Versionado por FECHA — nunca sin fecha, nunca SemVer**: **misma fecha → ACTUALIZA** ese mismo fichero (no crea otro), **fecha nueva → snapshot nuevo**. No hay "one-pager vivo": el vigente es simplemente **el de fecha más reciente**, y los anteriores se conservan como histórico. (El SemVer con `doc_id` es de los documentos de `faro/documentos/`, que sí son conocimiento versionado; el reporting NO.) Es **adaptativo por tipo** (proyecto → fases · RAID · KPIs; worker/app → añade señal de código; iniciativa → OKRs). **No inventa**: lo que falta se marca `dato pendiente`.
2. **Avisa de huecos** que restan valor ejecutivo y **ofrece rellenarlos** (sin asumir, preguntando):
   - **KPIs de negocio sin definir** (`faro/gestion/kpis.md` vacío) → propón definir 3–6 KPIs (definición, línea base, objetivo, fuente); el rol `analista-kpis` ayuda.
   - **Fases sin fecha objetivo** → el bloque de hitos sale pobre; sugiere añadir `Objetivo: AAAA-MM-DD` a las fases en `faro/ESTADO.md`.
   - **Decisiones**: se derivan de riesgos bloqueados/a-decidir en `risks.md`; si quieres control fino, añade una sección `## Decisiones para dirección` (con viñetas) en `risks.md` y manda sobre la derivación.
3. **Muestra** la ruta generada y el resumen (RAG · avance · riesgos abiertos · nº decisiones · KPIs definidos/sin definir). Recuerda: **Imprimir → PDF** para compartir a dirección. Si estás en `develop`/`feature`, commitea el HTML generado.

Foco opcional del usuario: $ARGUMENTS. **No asumas**: pregunta ante cualquier duda; no rellenes con cifras inventadas.
