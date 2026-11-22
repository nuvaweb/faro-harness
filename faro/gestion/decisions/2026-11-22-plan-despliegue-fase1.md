# Despliegue agnóstico · Fase 1 (FARO 3.1.0) · Plan de implementación

> **Para agentes:** SUB-SKILL OBLIGATORIA: usa superpowers:subagent-driven-development (recomendada) o superpowers:executing-plans para implementar este plan tarea a tarea. Los pasos usan casillas (`- [ ]`).

**Fuera de alcance (decisión del usuario):** FARO no lee ni configura la forja (entornos, rulesets, secretos). Eso lo prepara devops; FARO solo dice qué secretos y variables espera cada entorno.

**Objetivo:** que FARO detecte, valide y genere el despliegue de un repo de producto de forma agnóstica, con un núcleo y adaptadores (Cloudflare/wrangler y Terraform en esta fase), hexagonal estándar en inglés y `/faro:desplegar` como guía.

**Arquitectura:**
- Núcleo `lib/despliegue.js`: config, registro de adaptadores y agregado del diagnóstico. Es puro: recibe un `ctx` con lectura de ficheros inyectada.
- Un fichero por adaptador, con la misma interfaz.
- `lib/despliegue-ci.js` genera el workflow de despliegue para GitHub o GitLab a partir de lo que piden los adaptadores.
- Cableado en `harness.js` (`despliegue`, `local`) y en `validate`.

**Stack:** Node ≥ 18, CommonJS en `plugins/faro/hooks`, tests `node:test` en `test/*.test.mjs`, sin dependencias nuevas.

**Especificación:** `faro/gestion/decisions/2026-11-22-despliegue-agnostico-multinube.md` (aprobada). Quien ejecute el plan la lee entera antes de empezar.

## Restricciones globales

- Sin dependencias npm nuevas.
- Todo comando pesado (`terraform`, `tofu`, `wrangler`, `tflint`, `checkov`) pasa por `lib/ejecutar-pesado.js`, sin shell.
- `terraform` y `tofu` son intercambiables: se usa `despliegue.terraform.binario` si está; si no, el que esté en el `PATH`, con preferencia por `tofu` solo si `terraform` no existe.
- Generar CI nunca sobrescribe un fichero existente: si ya existe, se imprime el YAML para que se pegue a mano (como `cmdCi`).
- Nada de nombres de organización, repo, cuenta o proveedor en la config por defecto de FARO. Todo lo propio de un proveedor vive en su adaptador.
- Entornos por defecto: `["staging", "production"]`. La preview usa el entorno `preview`.
- Puerta por defecto: `puerta_produccion: "tag"`, con tags `v*` (monorepo: `{app}@{version}`, `TAG_DEFECTO` de `lib/apps.js`). El CI del producto **nunca** crea el tag de producción.
- SDKs prohibidos en `domain`/`ports`/`application`, con prioridad sobre `permitidos`: `cloudflare:*`, `agents`, `@cloudflare/*`, `@aws-sdk/*`, `aws-lambda`, `@azure/*`, `wrangler`.
- Secretos esperados de Cloudflare: `CLOUDFLARE_API_TOKEN_DEPLOY`, `CLOUDFLARE_API_TOKEN_TF`, `CLOUDFLARE_ACCOUNT_ID`, y `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` si el backend de Terraform es R2.
- Mensajes al usuario y comentarios en español; los identificadores, como en el resto de FARO.
- Los tests de integración usan repos temporales y `GCM_INTERACTIVE=never GIT_TERMINAL_PROMPT=0`. Ningún test llama a la red.

## Foco de revisión

1. **Repo que ya tiene `ARCHITECTURE.md` con capas en español** (orbital, atlas): no debe romperse. Las claves en español y en inglés valen igual.
2. **`wrangler.toml`** (sin JSON parseable): el adaptador lo detecta, avisa de que solo valida `wrangler.jsonc`/`.json` y no da falsos rojos.
3. **Repo sin `*.tf` y sin `despliegue.infra`**: el diagnóstico pregunta qué modelo se usa (no exige Terraform ni lo da por externo).
4. **`.github/workflows/deploy.yml` ya existe**: no se toca y se imprime el YAML.
5. **Secreto con valor en el repo** (un `.dev.vars` sin ignorar o un token en `vars`): se marca como error y nunca se imprime su valor.

Cada línea tiene su test en la tarea que posee el código. Las marco con **(FR)**.

---

### Task 1: Hexagonal estándar en inglés y SDKs de nube prohibidos

**Ficheros:**
- Modificar: `plugins/faro/hooks/lib/hexagonal.js`
- Test: `test/hexagonal-ingles.test.mjs`

**Interfaces:**
- Produce: `leerDeclaracion(texto)`, que ahora también acepta las claves `domain`, `application`, `ports`, `adapters`, `composition`/`entrypoints` y `allowed`, normalizadas a las claves internas actuales (`dominio`, `aplicacion`, `puertos`, `adaptadores`, `composicion`, `permitidos`). Exporta `SDK_NUBE: string[]` y `esSdkNube(spec): boolean`.
- `planMigracion(ficheros)` propone `src/domain/`, `src/application/`, `src/ports/`, `src/adapters/<target>/` y `src/entrypoints/`, y añade un paso que pide renombrar las carpetas en español detectadas (`dominio/` → `domain/`, `aplicacion/` → `application/`, `puertos/` → `ports/`, `adaptadores/` → `adapters/`).

- [ ] **Paso 1: tests que fallan**

```js
test('claves en inglés equivalen a las españolas', () => {
  const d = HX.leerDeclaracion('## Hexagonal\n- domain: src/domain/\n- application: src/application/\n- ports: src/ports/\n- adapters: src/adapters/\n- entrypoints: src/entrypoints/\n- allowed: zod\n');
  assert.deepStrictEqual(d.capas.dominio, ['src/domain/']);
  assert.deepStrictEqual(d.composicion, ['src/entrypoints/']);
  assert.deepStrictEqual(d.permitidos, ['zod']);
  assert.deepStrictEqual(d.errores, []);
});
test('(FR) declaración en español sigue igual', () => { /* SECCION de test/hexagonal.test.mjs → mismas capas que antes */ });
test('SDK de nube en application es violación aunque esté en allowed', () => {
  // decl con allowed: @aws-sdk/client-s3; fichero src/application/x.ts importa '@aws-sdk/client-s3'
  // → violación con regla 'application usa SDK de nube'
});
test('cloudflare:workers en domain es violación', () => { /* regla 'dominio usa SDK de nube' */ });
test('SDK de nube en adapters es válido', () => { /* sin violaciones */ });
test('planMigracion propone rutas en inglés y renombrar las españolas', () => {
  const p = HX.planMigracion(fich({ 'src/dominio/a.ts': 'export const a=1', 'src/index.ts': '' }));
  assert.match(p.seccion, /- domain: src\/domain\//);
  assert.ok(p.pasos.some((x) => /dominio\/ → domain\//.test(x)));
});
```

- [ ] **Paso 2:** `node --test test/hexagonal-ingles.test.mjs`. Debe fallar.
- [ ] **Paso 3: implementación en `hexagonal.js`**
  - Tabla de alias `{ domain: 'dominio', application: 'aplicacion', ports: 'puertos', adapters: 'adaptadores', composition: 'composicion', entrypoints: 'composicion', allowed: 'permitidos' }`, aplicada en `leerDeclaracion`.
  - En `comprobar`, antes de las reglas actuales: si la capa está en `['dominio', 'puertos', 'aplicacion']` y `esSdkNube(imp.spec)`, añade la violación `${capa} usa SDK de nube` y salta el resto de reglas para ese import.
  - `esSdkNube`: prefijo `cloudflare:`, igualdad con `agents`, `wrangler` o `aws-lambda`, o empieza por `@cloudflare/`, `@aws-sdk/` o `@azure/`.
  - El texto de `pintar` muestra las capas con su nombre en inglés solo si así se declararon. Basta con conservar en `decl` un mapa `etiquetas`.
- [ ] **Paso 4:** `node --test test/hexagonal-ingles.test.mjs test/hexagonal.test.mjs`. Todo en verde.
- [ ] **Paso 5:** commit `feat(hexagonal): claves en inglés y SDKs de nube fuera del núcleo`.

---

### Task 2: Núcleo `lib/despliegue.js` (config, registro y agregado)

**Ficheros:**
- Crear: `plugins/faro/hooks/lib/despliegue.js`
- Crear: `plugins/faro/hooks/lib/jsonc.js` (mover aquí `parseJsonc` desde `code.js` y usarlo desde ambos)
- Modificar: `plugins/faro/hooks/lib/code.js` (importar `jsonc.js`)
- Test: `test/despliegue-nucleo.test.mjs`

**Interfaces:**
- `jsonc.parse(texto): object|null`
- `despliegue.config(cfgRepo): { entornos: string[], puerta_produccion: 'tag'|'aprobacion'|'manual', preview: boolean, infra: 'propia'|'externa'|null, referencia: string|null, terraform: { dir: string|null, binario: string|null } }`. Lee `faro/config.json > despliegue`; los valores por defecto son `['staging','production']`, `'tag'`, `true`, `null`, `null` y `{dir:null, binario:null}`. Un valor inválido cae al defecto y añade un aviso en `config.avisos: string[]`.
- `ctx = { root, leer(rel): string|null, existe(rel): boolean, listar(dirRel): string[], cfg, forja: 'github'|'gitlab'|null, monorepo: boolean, apps: Array<{id, dir}> }`
- Contrato de adaptador: `{ id: string, detectar(ctx): object|null, diagnostico(ctx, det): Hallazgo[], gates(ctx, det): Array<{gate, pasos:[[cmd,args]], run}>, pasosCi(ctx, det, { fase: 'pr'|'main'|'tag', entorno, forja }): Paso[], comandoLocal(ctx, det): { cmd, args, nota }|null, secretosEsperados(ctx, det): Array<{ nombre, entornos: string[], proposito }> }`
- `Hallazgo = { nivel: 'error'|'aviso'|'info', codigo: string, mensaje: string, arreglo?: string }`
- `Paso = { nombre: string, run?: string, uses?: string, with?: object, env?: object, si?: string }`
- `despliegue.diagnosticar(ctx, adaptadores): { detectados: Array<{id, det}>, hallazgos: Hallazgo[], secretos: [...] }`. Si nada se detecta, devuelve `{ detectados: [] }` con un `info` del tipo "sin despliegue detectado".
- `despliegue.ADAPTADORES`: lista registrada (`[cloudflare, terraform]`, cargados con `require` perezoso).
- `despliegue.ctxDesdeDisco(root, cfgRepo): ctx` (el único sitio que toca `fs`).

- [ ] **Paso 1: tests que fallan.** `config` con y sin clave; entorno inválido (`["Prod!"]`) cae al defecto con aviso; `puerta_produccion: "x"` cae a `tag`; `diagnosticar` con dos adaptadores falsos agrega y ordena los hallazgos (primero error, luego aviso, luego info) y une los secretos por nombre, juntando sus entornos; sin detectados devuelve el `info`. Validación de nombres de entorno: `/^[a-z][a-z0-9-]{0,30}$/`.
- [ ] **Paso 2:** ejecutar. Debe fallar.
- [ ] **Paso 3:** implementar `despliegue.js` y `jsonc.js`, y sustituir el `parseJsonc` local de `code.js` por `require('./jsonc.js').parse`.
- [ ] **Paso 4:** `node --test test/despliegue-nucleo.test.mjs` y la batería de `code` (`node test/run.js test/ci-generado.test.mjs test/ci-vigente.test.mjs`). Todo en verde.
- [ ] **Paso 5:** commit `feat(despliegue): núcleo agnóstico con contrato de adaptadores`.

---

### Task 3: Adaptador Cloudflare (`lib/despliegue-cloudflare.js`)

**Ficheros:**
- Crear: `plugins/faro/hooks/lib/despliegue-cloudflare.js`
- Test: `test/despliegue-cloudflare.test.mjs`

**Interfaces:**
- Consume: el contrato de la Tarea 2 y `jsonc.parse`.
- `detectar`: si existe `wrangler.jsonc|json|toml` en la raíz (o en cada app, en monorepo), devuelve `{ fichero, cfg|null, toml: boolean }`.

Hallazgos con su código y nivel:

| codigo | nivel | cuándo |
|---|---|---|
| `cf-toml` | aviso | `wrangler.toml`: solo se valida `jsonc`/`json` **(FR)** |
| `cf-sin-env` | error | falta `env.<e>` para algún entorno de `config.entornos` |
| `cf-binding-falta-env` | error | un binding de nivel superior (d1, kv, r2, queues, hyperdrive, durable_objects, services…) no está redeclarado en `env.<e>` (los bindings no se heredan) |
| `cf-id-repetido` | error | el mismo `database_id`/`id`/`bucket_name` en dos entornos |
| `cf-hyperdrive-local` | aviso | hyperdrive sin `localConnectionString` (y sin `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` mencionada en `.dev.vars.example`) |
| `cf-secreto-en-vars` | error | clave de `vars` (global o de un entorno) que encaja con `/(TOKEN\|SECRET\|PASSWORD\|PRIVATE\|API_KEY)/i` |
| `cf-sin-compat` | aviso | falta `compatibility_date` |
| `cf-devvars-versionado` | error | `.dev.vars` existe y no está en `.gitignore` (solo se comprueba `.gitignore`, sin leer `.dev.vars`) |

- **`gates`**: reutiliza el simulacro de `code.js` (`simulacroDespliegue`) por entorno: `wrangler deploy --dry-run --env <e>`.
- **`pasosCi`**:
  - `pr`: `npx wrangler versions upload --env staging --message "PR #${{ github.event.number }}"`;
  - `main`: `npx wrangler deploy --env staging`;
  - `tag`: `npx wrangler deploy --env production`;
  - con `env: CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN_DEPLOY }}` y `CLOUDFLARE_ACCOUNT_ID`.
  - Si `package.json` tiene el script `db:migrate:<entorno>` o `migrate`, añade antes un paso `migraciones`.
  - Después de `deploy` va un paso `salud` si existe `despliegue.salud_url` (URL con `{entorno}`): `curl -fsS` con 3 reintentos y, si falla, `npx wrangler rollback --env <e>`.
- **`comandoLocal`**: `npx wrangler dev` (o el script `dev` del `package.json` si existe), con la nota "bindings locales con Miniflare; Hyperdrive usa localConnectionString".
- **`secretosEsperados`**: `CLOUDFLARE_API_TOKEN_DEPLOY` en preview, staging y production, y `CLOUDFLARE_ACCOUNT_ID` en los tres.

- [ ] **Paso 1: tests que fallan**, uno por cada código de la tabla, con `ctx` en memoria (`leer` desde un objeto). Más:
  - un `wrangler.jsonc` completo y correcto: cero errores;
  - `pasosCi` para `main` contiene `wrangler deploy --env staging` y el env con `secrets.CLOUDFLARE_API_TOKEN_DEPLOY`.
- [ ] **Paso 2:** ejecutar. Debe fallar.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** en verde.
- [ ] **Paso 5:** commit `feat(despliegue): adaptador Cloudflare (wrangler.jsonc por entorno)`.

---

### Task 4: Adaptador Terraform (`lib/despliegue-terraform.js`), con infra propia o externa

**Ficheros:**
- Crear: `plugins/faro/hooks/lib/despliegue-terraform.js`
- Test: `test/despliegue-terraform.test.mjs`

**Interfaces:**
- `detectar`: busca `*.tf` en `config.terraform.dir`, `infra/` o la raíz (sin entrar en `.terraform/` ni `node_modules`). Devuelve `{ dir, ficheros: string[], porEntorno: 'carpetas'|'workspaces'|null, binario }`.
  - Si no hay `*.tf` y `config.infra === 'externa'`: `{ externa: true, referencia }`.
  - Si no hay `*.tf` y `config.infra` es `null`, pero sí hay otro adaptador de destino: `{ indefinida: true }`.
  - En los demás casos: `null`.
- `porEntorno`: `carpetas` si existe `<dir>/envs/<e>/` para cada entorno; `workspaces` si los `*.tf` usan `terraform.workspace`.

| codigo | nivel | cuándo |
|---|---|---|
| `tf-infra-indefinida` | aviso | `indefinida`: pregunta si la infra va junto a la app (`infra/`) o en un repo central (`despliegue.infra: "externa"`) **(FR)** |
| `tf-externa` | info | infra externa: lista las variables que el CI espera por entorno (los `secretosEsperados` de los demás adaptadores) y la `referencia` |
| `tf-backend-local` | error | no hay bloque `backend` o es `local` |
| `tf-sin-lock` | error | falta `.terraform.lock.hcl` en el directorio raíz o en algún entorno |
| `tf-version-libre` | aviso | sin `required_version` o un provider sin `version` |
| `tf-estado-versionado` | error | hay `*.tfstate` en el repo |
| `tf-gitignore` | aviso | `.gitignore` no cubre `.terraform/` |
| `tf-sin-entornos` | error | `porEntorno === null` con más de un entorno |
| `tf-sin-prevent-destroy` | aviso | un recurso con estado (`cloudflare_d1_database`, `cloudflare_r2_bucket`, `cloudflare_workers_kv_namespace`, `aws_db_instance`, `aws_rds_cluster`, `aws_s3_bucket`, `aws_dynamodb_table`, `azurerm_*_database`, `azurerm_storage_account`) sin `prevent_destroy = true` |

- **`gates`**: `fmt -check -recursive` y `validate` (tras `init -backend=false`) con el binario elegido, más `tflint` y `checkov -d <dir> --quiet` si están en el `PATH`.
- **`pasosCi`**:
  - `pr`: `init` + `plan` del entorno `staging`, con resumen en `$GITHUB_STEP_SUMMARY`;
  - `main`: `init` + `apply -auto-approve` de staging;
  - `tag`: `init` + `plan` y `apply` de producción, en el mismo job.
  - Siempre **antes** de los pasos del adaptador de código.
- **`secretosEsperados`**: `CLOUDFLARE_API_TOKEN_TF` en `preview` (solo lectura), `staging` y `production`, más las claves de R2 si el backend es `s3` con `endpoints` de r2.

- [ ] **Paso 1: tests que fallan**, uno por código, con ficheros `.tf` en memoria; un caso externo; un caso sin nada (`null`); y comprobar que en `pasosCi` de `tag` el `plan` va antes del `apply` y ambos usan `envs/production`.
- [ ] **Paso 2:** ejecutar. Debe fallar.
- [ ] **Paso 3:** implementar. Detectar con expresiones regulares sobre el HCL (bloques `backend "x"`, `required_version`, `lifecycle { prevent_destroy = true }` dentro de `resource "<tipo>"`). Sin parser de HCL.
- [ ] **Paso 4:** en verde.
- [ ] **Paso 5:** commit `feat(despliegue): adaptador Terraform/OpenTofu con infra propia o externa`.

---

### Task 5: Generador de CI de despliegue (`lib/despliegue-ci.js`)

**Ficheros:**
- Crear: `plugins/faro/hooks/lib/despliegue-ci.js`
- Test: `test/despliegue-ci.test.mjs`

**Interfaces:**
- `generarGithub(ctx, detectados, adaptadores, config): string` produce el YAML de `.github/workflows/deploy.yml`.
- `generarGitlab(...)` produce el bloque de jobs para incluir (`.gitlab/deploy.yml` + línea `include:`).

Forma en GitHub:

| job | disparo | `environment` | contenido |
|---|---|---|---|
| `preview` | `pull_request` desde el mismo repo (`if: github.event.pull_request.head.repo.full_name == github.repository`) | `preview` | pasos `pr` |
| `staging` | `push` a la rama principal (`flujo.config().rama_principal`) | `staging` | pasos `main` |
| `production` | `push` de tags `v*` (o `*@*` en monorepo) | `production` | pasos `tag` |

- En `production`, el primer paso comprueba que el commit del tag es ancestro de la rama principal: `git merge-base --is-ancestor $GITHUB_SHA origin/<principal>`. Si no lo es, falla con "el tag no apunta a un commit integrado en <principal>".
- `concurrency: deploy-<entorno>`, sin cancelar en curso.
- En cada job, orden de los pasos: checkout → setup de los adaptadores → infra (terraform) → código (cloudflare).
- Con `puerta_produccion: 'manual'`, `production` se dispara con `workflow_dispatch` y el input `tag`.
- **GitLab:**
  - `rules` equivalentes: `$CI_PIPELINE_SOURCE == "merge_request_event"`, la rama por defecto y `$CI_COMMIT_TAG =~ /^v/`;
  - `environment: name: <e>`;
  - `production` con `when: manual` si la puerta es `manual` o `aprobacion`;
  - variables `$CLOUDFLARE_API_TOKEN_DEPLOY`, etc. (con *environment scope* en GitLab).

- [ ] **Paso 1: tests que fallan.** Con Cloudflare + Terraform detectados:
  - el YAML contiene los tres `environment:`;
  - en `staging`, `terraform` aparece antes que `wrangler deploy`;
  - `production` incluye `merge-base --is-ancestor`;
  - con `puerta_produccion: 'manual'` aparece `workflow_dispatch`;
  - con monorepo, el filtro de tags es `'*@*'`;
  - la versión GitLab con `aprobacion` tiene `when: manual` en production;
  - el YAML de GitHub parsea como YAML válido (comprobación mínima de sangrías con la misma utilidad que `test/ci-generado.test.mjs`).
- [ ] **Paso 2:** ejecutar. Debe fallar.
- [ ] **Paso 3:** implementar. Reutilizar `ymlValor` de `harness.js` si está exportado; si no, moverlo a `lib/yml.js` y usarlo desde ambos sitios.
- [ ] **Paso 4:** en verde.
- [ ] **Paso 5:** commit `feat(despliegue): CI de despliegue por entornos para GitHub y GitLab`.

---

### Task 6: `harness.js despliegue` y `harness.js local`, más la exigencia en `validate`

**Ficheros:**
- Modificar: `plugins/faro/hooks/harness.js` (despachador cerca de `:4784`, mensaje de subcomandos desconocidos y el gate de `validate` donde hoy se llama al hexagonal)
- Test: `test/despliegue-cli.test.mjs`

**Interfaces:**
- `harness.js despliegue`: imprime los detectados, los hallazgos (error, aviso, info, cada uno con su `arreglo`), la tabla de secretos esperados por entorno y los siguientes pasos. Sale con 1 si hay errores.
- `--json`: imprime el objeto de `diagnosticar`.
- `--ci`: escribe `.github/workflows/deploy.yml` (o `.gitlab/deploy.yml` + `include`) **solo si no existe**. Si existe, imprime el YAML **(FR)**.
- `--gates`: ejecuta los `gates` de los adaptadores con `ejecutar-pesado`.
- `harness.js local`: imprime el `comandoLocal` del adaptador de código y la nota. Con `--ejecutar`, lo lanza con `stdio: 'inherit'`, por `lanzador` de `ejecutar-pesado` y sin shell.
- `validate`: si `diagnosticar` detecta algún adaptador de destino, el repo tiene código y `ARCHITECTURE.md` no tiene la sección `## Hexagonal`, falla con "repo que despliega sin hexagonal declarada" y la sugerencia de `harness.js hexagonal --plan`. Los errores de despliegue se muestran como **avisos** en `validate` (bloquean solo en `harness.js despliegue`).

- [ ] **Paso 1: tests que fallan** (repo temporal, `spawnSync` del harness, como en `test/hexagonal.test.mjs`):
  - repo con `wrangler.jsonc` sin `env.production` → `despliegue` sale con 1 y muestra `cf-sin-env`;
  - `--json` parsea;
  - `--ci` crea `deploy.yml`;
  - segundo `--ci` no lo cambia (mismo hash) e imprime el YAML **(FR)**;
  - `local` imprime `wrangler dev`;
  - `validate` en un repo que despliega sin `## Hexagonal` falla con el texto indicado;
  - **(FR)** el mismo repo con la sección en español pasa.
- [ ] **Paso 2:** ejecutar. Debe fallar.
- [ ] **Paso 3:** implementar el cableado (sin lógica nueva fuera de `lib/`).
- [ ] **Paso 4:** `node test/run.js test/despliegue-cli.test.mjs test/hexagonal.test.mjs`. En verde.
- [ ] **Paso 5:** commit `feat(despliegue): harness.js despliegue y local; validate exige hexagonal si despliega`.

---

### Task 7: Skill `/faro:desplegar`, documentación y versión 3.1.0

**Ficheros:**
- Crear: `plugins/faro/skills/desplegar/SKILL.md`
- Modificar: `plugins/faro/skills/code/SKILL.md` y `plugins/faro/skills/forja/SKILL.md` (una línea que derive a `/faro:desplegar`), `plugins/faro/.claude-plugin/plugin.json` (`"version": "3.1.0"`), `CHANGELOG.md` (sección `## 3.1.0 — <fecha>`) y README del plugin (lista de comandos)
- Test: el de coherencia de skills que ya exista (`grep -l "skills" test/*.test.mjs`); si no hay ninguno que cubra el frontmatter, uno mínimo que compruebe `description` y `argument-hint`.

**Contenido de la skill** (frontmatter como `forja/SKILL.md`; rol en hilo principal, con `AskUserQuestion`):
1. Ejecuta `harness.js despliegue` y explica los hallazgos por orden.
2. Si la infra está indefinida, pregunta: junto a la app o en un repo central.
3. Hexagonal: si falta, `harness.js hexagonal --plan` con la estructura en inglés.
4. Propone el `wrangler.jsonc` por entorno y la estructura `infra/modules/<target>` + `infra/envs/<env>` (no la crea sin confirmación).
5. `harness.js despliegue --ci`.
7. Le dice a devops qué secretos y variables cargar en cada entorno (la tabla de `secretosEsperados`). Nunca pide ni maneja los valores.
8. Recuerda que producción se publica cuando devops crea el tag.

La skill no menciona ninguna organización ni cuenta.

- [ ] **Paso 1:** test de frontmatter (falla si no existe la skill).
- [ ] **Paso 2:** escribir la skill, las derivaciones, el bump y el CHANGELOG (`### Añadido`: despliegue agnóstico por adaptadores, Cloudflare + Terraform, CI por entornos, `local` y hexagonal estándar en inglés; `### Cambiado`: `validate` exige hexagonal en repos que despliegan).
- [ ] **Paso 3:** `npm test` (batería completa, en serie). Todo en verde.
- [ ] **Paso 4:** commit `feat(desplegar): skill /faro:desplegar y FARO 3.1.0` (sin ruptura: los repos con hexagonal declarada no cambian).

---

### Task 8: Prueba en repos reales (solo lectura)

- [ ] `node plugins/faro/hooks/harness.js despliegue` con `cwd` en una copia temporal de orbital o atlas (clonada en el scratchpad o con `git worktree`). Anotar los hallazgos; no tocar esos repos desde esta sesión.
- [ ] Lo mismo en una copia de `aws-identity`. Lo esperado:
  - `tf-infra-indefinida`, o `tf-externa` si se añade `despliegue.infra: "externa"` a la copia;
  - hexagonal declarada sin violaciones;
  - ningún adaptador de destino para ECS todavía: es la **fase 2**, y el diagnóstico debe decir "sin adaptador para este destino", no fallar.
- [ ] Llevar los hallazgos a la sesión de cada repo como tareas. Este plan no cambia esos repos.

---

## Fase 2 (plan aparte, después de esta)

Para conectar `aws-identity` del todo:
- adaptador `contenedor` + `aws-ecs`: build único por commit, push a ECR, migraciones como tarea ECS, rolling deploy con *circuit breaker*;
- OIDC (`AWS_DEPLOY_ROLE_ARN` protegida) y backend S3 con `use_lockfile`;
- CDK/CloudFormation como alternativa a Terraform;
- Job programado de drift (`plan -detailed-exitcode` que abre una issue), aplazado desde la fase 1 por ser opcional.

Se escribirá en su propio plan, partiendo de lo que deje la Tarea 9.
