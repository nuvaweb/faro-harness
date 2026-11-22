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

## Fix ronda 1 — dry-run de wrangler duplicado
- `iacGates(plan)` omite la parte cloudflare cuando `plan.gates` ya trae `deploy-dry-run*` (simulacro con build/deploy:dry); si iac se queda sin gates, no se genera. Terraform sigue igual.
- Tests: los casos wrangler pasan a comprobar un solo dry-run y sin job iac; nuevo test de regresion (wrangler.jsonc + scripts.build: `npm run build && npx wrangler deploy --dry-run` una sola vez, sin iac). El JSON.parse manual de la config se mantiene (no hay cargador reutilizable en harness.js).
- Comando: `node --test test/despliegue-ci.test.mjs test/ci-generado.test.mjs test/gates-por-app.test.mjs`. Corrida completa previa al ultimo ajuste de test: 33/34 (el unico fallo era el test gitlab, ya corregido); despues `despliegue-ci.test.mjs` solo: 7/7. ci-generado y gates-por-app pasaron en la corrida completa.
