# Task 5 — Gates de IaC en el CI de tests generado

## Implementado (plugins/faro/hooks/harness.js)
- `iacGates()`: construye el ctx con `ctxDesdeDisco(ROOT, config)` y `enPath: () => false`, recorre `adaptadores()`, y devuelve `{cloudflare:{gates}, terraform:{binario,gates}}` solo con lo detectado (o `null`). Los gates salen de `gates()` de cada adaptador, sin recalcular.
- GitHub: `githubCiYaml(plan, gates, iac)` añade un job `iac` (checkout; `hashicorp/setup-terraform@v3` u `opentofu/setup-opentofu@v1` segun `terraform.binario`; para wrangler, mismos pasos setup-node/pnpm + install que el job `gates`; luego un `run` por gate). Sin `paths`, mismo trigger (PR y push a main).
- GitLab: `gitlabIacJobs`: `iac-terraform`/`iac-opentofu` (imagen oficial hashicorp/terraform o ghcr.io/opentofu/opentofu, `entrypoint: [""]`) e `iac-cloudflare` (imagen del plan, before_script e install del plan). Mismo stage y reglas (MR y main).
- Sin adaptador detectado: `iac` es `null` y el YAML no cambia.
- Sin credenciales: ni `secrets.` ni TOKEN/API_KEY; wrangler dry-run y `init -backend=false` ya vienen de los adaptadores.

## Tests
`test/despliegue-ci.test.mjs` (6 casos, registrado en `.faro.json` junto a despliegue-terraform). `node --test` de los 5 ficheros pedidos: 65/65 pasan.

## Concerns
- `harness.js ci` sale antes si no hay gates de codigo (`plan.gates` vacio): un repo solo-Terraform sin package.json/faro.gates no genera CI (comportamiento previo, no tocado).
- Imagenes GitLab con tag `latest` (no fijadas).
- Con CI existente (no se sobrescribe) el aviso de «mergea a mano» no lista los pasos iac.
- En monorepo el job iac no usa el filtro de apps cambiadas (corre siempre).
