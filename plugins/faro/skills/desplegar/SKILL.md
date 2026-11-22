---
description: "Úsala para preparar el despliegue de un repo: diagnostica hexagonal, infra y entornos, y propone wrangler.jsonc e infra/. Los gates de IaC van en el CI; el despliegue lo prepara devops."
argument-hint: "[--gates|local]  (vacío = diagnóstico completo)"
---

Ejecútalo **TÚ en esta conversación (hilo principal)**, NO como subagente — así `AskUserQuestion` funciona y puedes preguntar con opciones. **No asumas nada, pregunta ante cualquier duda y confirma antes de crear ficheros.**

Petición del usuario: $ARGUMENTS

FARO es agnóstico del destino: el despliegue se resuelve por adaptadores (Cloudflare, Terraform). FARO **diagnostica, propone y genera los gates**; **no gestiona la forja ni los entornos** — los prepara devops.

## Pasos

1. **Diagnóstico.** Ejecuta `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" despliegue` (con `--json` si necesitas datos; `--gates` **ejecuta** en local los gates de IaC —terraform/tofu/wrangler— y sale con código 1 si fallan: pide confirmación al usuario antes de lanzarlo) y explica los hallazgos **por orden**, sin saltarte ninguno.
2. **Hexagonal.** Un repo que despliega necesita arquitectura hexagonal declarada (`validate` falla con «repo que despliega sin hexagonal declarada»). Si falta, ejecuta `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" hexagonal --plan` y presenta la estructura propuesta, con los nombres de carpetas y ficheros **en inglés**. No la crees sin confirmación.
3. **Propuesta de configuración.** Propón el `wrangler.jsonc` por entorno (si el destino es Cloudflare) y la estructura `infra/modules/<target>` + `infra/envs/<env>` (si es Terraform). **Enséñala y no la crees sin confirmación.**
4. **Gates de IaC.** Van en el CI de tests (`node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" ci`), sin credenciales; no hace falta generar ningún workflow de despliegue aquí. Si el repo aún no tiene CI, deriva a ese comando.
5. **Hacia devops.** Pide al usuario que traslade a devops que configure los secretos y entornos que su despliegue necesite en la forja. El diagnóstico ya imprime una sección «Para devops» con lo que declara el repo (providers y variables sin default de Terraform, bindings de wrangler): pásasela. FARO **nunca pide ni maneja valores** de secretos.
6. **Local.** Para probar en la máquina del desarrollador: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" local` (muestra el plan) y `local --ejecutar` solo si el usuario lo confirma.

## Recordatorio

La salida a producción por tag la hace devops cuando lo decide; FARO no crea tags de producción.

Relacionado: `/faro:forja` (operaciones de la forja), `/faro:code` (scaffolding y CI).
