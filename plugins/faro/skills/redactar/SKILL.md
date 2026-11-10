---
description: "Úsala para redactar cualquier documento de la iniciativa (funcional, spec, informe, guía…) — pregunta el enfoque y lo genera con la plantilla neutra de FARO (redactor-documento)."
argument-hint: "[tipo/tema del documento]"
---

Documento solicitado: $ARGUMENTS

> **Rama de trabajo (obligatorio antes de generar):** un documento se ESCRIBE. Si estás en `main`/`master`/`develop` (instancia, no template), NO generes aquí — abre primero una rama `docs/<tema>` (`node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" rama docs "<tema>"`), genera ahí y entra por PR a develop (`/faro:pr`). El harness lo bloquea si lo intentas en rama protegida.

Adopta el rol **redactor-documento** (agente del plugin) y ejecútalo **TÚ en esta conversación (hilo principal)**, NO como subagente — así `AskUserQuestion` funciona y puedes preguntar al usuario con opciones. Si el enfoque no está claro, **PREGUNTA primero** (tipo, propósito, audiencia, alcance y formato de entrega); **no asumas ni rellenes secciones por rellenar**. `redactor-documento` es SIEMPRE el dueño del ciclo de vida del documento (tipo, `doc_id`, ubicación, frontmatter) — ningún especialista lo sustituye, solo aportan contenido experto (ver "Derivación a especialistas" abajo). Luego genera:
- el **MD vivo** en `documentos/` o `gestion/` (estructura profesional consistente, con `doc_id` automático vía `docref`; la convención la sirve el plugin: `${CLAUDE_PLUGIN_ROOT}/docs/nomenclatura-documental.md` y el contrato vigente `harness.js tipo`), y
- si se pide, el **HTML entregable** (plantilla `faro-documento.html`, plantilla neutra, imprimible).

Mantén SIEMPRE la misma plantilla/estructura (cambia el contenido, no la marca). El MD es la fuente; el HTML se regenera desde él.

## Derivación a especialistas (mismo patrón que `revisor-code` + `revisor-code-worker`)

Antes de redactar el contenido de un tipo `ARQ` (arquitectura), detecta la firma técnica del repo y decide si sumas un especialista — **nunca en lugar de `redactor-documento`, siempre además**, igual que `revisor-code-worker` se lanza junto a `revisor-code`:

- **Repo con `wrangler.toml`/`wrangler.jsonc`/`wrangler.json`** (Cloudflare Worker) → lanza también el subagente `redactor-tecnico`: detecta el TIPO de worker (back-API/back-proceso/front) y redacta las secciones expertas (C4, Mermaid, endpoints/triggers/rutas) desde el estado real (código, bindings, specs). `redactor-documento` sigue gestionando `doc_id` (vía `docref ARQ`), ubicación (`documentos/arquitectura/<doc_id>-<slug>.md`) y frontmatter; `redactor-tecnico` solo aporta el CONTENIDO técnico para esas secciones.
- **Ningún especialista aplica** (librería, monolito no-Workers, infraestructura no-Cloudflare…) → `redactor-documento` redacta el `ARQ` él mismo con la plantilla genérica (arc42+C4).
- Añadir un especialista nuevo (`redactor-tecnico-<stack>`) sigue el mismo patrón: se suma, nunca sustituye, y nunca gestiona su propio `doc_id`/ubicación/frontmatter.
