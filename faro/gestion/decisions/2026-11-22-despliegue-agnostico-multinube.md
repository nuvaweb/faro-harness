---
status: aprobada
date: 2026-11-22
deciders: FernandoTWE
version: 3.1.0 (prevista)
---

# FARO · Despliegue agnóstico y multinube por adaptadores (Cloudflare primero, AWS después)

## Contexto

- FARO 3.0 deja el flujo en `main` con auto-merge y publicación desde el CI (decisión `2026-11-16-flujo-directo-a-main`). El CI **valida y publica**, pero **no despliega**: `harness.js ci` genera solo los gates y no incluye entornos ni jobs de despliegue.
- `lib/code.js` detecta el modo del repo (`cloudflare` si hay `wrangler.jsonc|json|toml`, `generic`, `monorepo` o `none`), los bindings de wrangler (D1, KV, R2, Hyperdrive…) y lanza `wrangler deploy --dry-run` como gate. **Terraform no aparece en ningún sitio.**
- `lib/hexagonal.js` ya verifica de forma determinista las capas declaradas en `ARCHITECTURE.md > ## Hexagonal`: dominio, puertos, aplicación y adaptadores.
- El 2026-11-22 se configuró a mano una organización de GitHub (plan Team) para la 3.0:
  - ruleset de organización sobre `main` (PR obligatorio, squash, sin force push ni borrado);
  - ruleset `tags-version` sobre `v*`: se pueden crear tags, pero no moverlos ni borrarlos;
  - política de Actions con lista blanca, aprobación para forks externos y `GITHUB_TOKEN` en solo lectura;
  - equipo de aprobadores;
  - entornos `staging` y `production`, restringidos a `main`, en los repos que despliegan.
  - Con el plan Team, los *required reviewers* de los entornos en repos privados **no están disponibles** (HTTP 422).
- Los repos de producto siguen ya una arquitectura de puertos y adaptadores en paquetes: dominio puro, puerto `bucket` con adaptador R2, transporte de IA inyectable y simulador local. Algunos usan Durable Objects (Agents SDK) e Hyperdrive.

## Intención

Que **cualquier repo, de cualquier organización y forja**, pueda pasar por el mismo recorrido:

```
local ──▶ preview del PR ──▶ staging (merge a main) ──▶ production (tag v*)
```

Esto incluye usar **Terraform desde el inicio** para la infraestructura, empezar desplegando en **Cloudflare** y poder **pasar a AWS** (o a Azure) añadiendo un adaptador, sin rehacer el flujo. FARO **valida** de forma determinista y una skill **guía** la puesta en marcha.

**Principio rector (del usuario):** la lógica de negocio es **la misma en todos los destinos**. Lo que cambia según la infraestructura (base de datos, ficheros, colas, coordinación, entrada HTTP) es adaptativo: se elige un adaptador por destino, sin tocar el dominio. FARO hace lo mismo en su propio terreno: un único flujo y adaptadores por forja y por destino.

## Objetivos

1. **Detectar** de forma determinista qué despliega un repo y cómo:
   - destinos: Cloudflare (wrangler), Terraform con sus providers, AWS SAM, contenedor;
   - entradas (`worker.ts`, `lambda.ts`, `server.ts`, o lo que declare el repo);
   - entornos y forma de levantarlo en local.
2. **Validar** con gates y un diagnóstico (`harness.js despliegue`):
   - Terraform: `fmt -check`, `validate` y, si están instalados, `tflint` y `checkov`;
   - coherencia entre entornos de wrangler;
   - existencia de un camino local y aislamiento de los recursos locales;
   - secretos esperados por entorno, solo por nombre y nunca por valor.
3. **Generar** el CI de despliegue por adaptador:
   - `plan` comentado en el PR;
   - `apply` y despliegue en staging al integrar en `main`;
   - lo mismo en producción con el tag `v*`;
   - preview por PR cuando el destino lo permita.
4. **Decir qué espera cada entorno**: secretos y variables por nombre, para que devops los cargue. *(Decisión del usuario: FARO no lee ni configura la forja; eso lo prepara devops.)*
5. **Desarrollo local de primera clase**: `harness.js local` lanza la herramienta del destino detectado.
6. **Skill `/faro:desplegar`**: guía, de forma agnóstica, la puesta en marcha y la ampliación a nuevos destinos.

## No objetivos

- Que FARO cree credenciales, guarde secretos o cambie el plan de facturación. Los nombra y dice dónde ponerlos.
- Que FARO imponga un framework o unos nombres de carpeta concretos. **Sí exige el enfoque hexagonal** (ver «Arquitectura hexagonal»): las capas se declaran y se validan, y si el repo no tiene ninguna estructura, FARO propone una.
- Escribir los adaptadores de las apps: ni el de Durable Objects para AWS ni el de Hyperdrive. Eso es arquitectura de cada producto; FARO solo comprueba que el dominio no dependa de la nube.
- Gestionar la configuración de la forja (entornos, rulesets, secretos), ni con Terraform ni desde FARO: la prepara devops.
- Desplegar a mano desde la sesión. El despliegue sigue siendo cosa del CI, y el hook de deploy manual se mantiene.

## Antiobjetivos (fallaría aunque funcione)

- Meter nombres de organizaciones, repos, cuentas o dominios en la configuración de FARO.
- Que la definición de la app exista dos veces, una para local y otra para desplegar.
- Que el token de producción sea visible fuera del job y del entorno de producción, o que se guarde a nivel de organización.
- Que FARO falle por el plan de la forja en lugar de degradar a la mejor opción disponible y decirlo.
- Que añadir AWS obligue a cambiar la skill o el flujo, en lugar de añadir un adaptador.
- **Que FARO se case con un proveedor.** Ninguna nube, forja ni herramienta es la opción por defecto del harness: el destino sale de lo que hay en el repo. El orden de las fases (Cloudflare primero) es un orden de implementación, no una preferencia. Ninguna recomendación ni plantilla empuja a un proveedor concreto, y todo lo propio de un proveedor vive en su adaptador.

## Restricciones

- Agnóstico de forja (GitHub y GitLab) y de nube. Las piezas propias de cada forja van en sus módulos `github*.js` / `forge-gitlab-*.js`.
- Sin dependencias nuevas en el harness: solo `fs` y `child_process` nativos, como `code.js`.
- Los gates pesados pasan por `lib/ejecutar-pesado.js`.
- `harness.js ci` **nunca sobrescribe** un CI existente. Si ya existe, propone los pasos para mezclarlos a mano.
- Ninguna acción hacia fuera (forja, nube) sin confirmación del usuario.
- `terraform` y `tofu` son intercambiables: se usa el binario que esté instalado.

## Enfoques considerados

| | Enfoque | Ventajas | Inconvenientes |
|---|---|---|---|
| A | Solo harness: detección, gates, diagnóstico y plantilla de CI | Determinista y barato | Nadie guía la puesta en marcha (estado remoto, tokens, módulos) |
| **B** | **Harness que valida + skill `/faro:desplegar` agnóstica que guía** | Sigue el patrón de FARO (skill + `harness.js`). Terraform y wrangler son adaptadores, así que añadir AWS no cambia la skill | Más superficie que A |
| C | Una skill por herramienta (terraform, wrangler, aws) | Cada una más simple | Ata FARO a herramientas, duplica lógica y no es agnóstico |

**Elegido: B** (decidido por el usuario el 2026-11-22).

## Decisiones tomadas

### Reparto de responsabilidades (un solo dueño por recurso)

| Qué | Dueño |
|---|---|
| Infraestructura con datos o de larga vida (DNS, D1, R2, KV, colas, Hyperdrive, Access, WAF; en AWS: redes, IAM, RDS, S3, SQS, ECS/Lambda como servicio) | **Terraform** (u OpenTofu) |
| Código de la app, rutas, bindings y entornos de la app | **Herramienta propia del destino**: `wrangler.jsonc` en Cloudflare; SAM, imagen o CLI en AWS |
| Secretos de la app | La herramienta del destino desde el CI (`wrangler secret`…), nunca en Terraform |
| Credenciales del CI | A mano, una vez, en el **entorno** de la forja |
| Ajustes de la forja (rulesets, entornos, auto-merge) | **Devops** (en la forja; FARO no la toca) |

- **Modo por defecto:** Terraform para la infraestructura y la herramienta del destino para el código.
- **Modo alternativo** (detectado, no configurado): hay `*.tf` sin `wrangler.*` → despliegue solo con Terraform. El diagnóstico avisa de que ese modo no tiene desarrollo local.
- **Sin `*.tf`:** solo la herramienta del destino. Terraform es opcional por repo, aunque se recomienda desde el inicio cuando hay recursos con datos.

### Infraestructura en el propio repo o en un repo de IaC central

Hay dos modelos válidos y FARO acepta los dos:

| Modelo | Dónde está la infraestructura | El repo de la app… |
|---|---|---|
| **Junto a la app** | `*.tf` en el propio repo (`infra/`) | planifica y aplica la infra y despliega el código |
| **Central** (como `fractalia.iac` en una organización con política de IaC) | Un repo de IaC con un stack por app, que gestiona otro equipo | **solo construye, publica y despliega**. Los valores que necesita (cuenta, rol, nombres) salen de los *outputs* del stack y se cargan como variables del entorno de la forja |

- **Detección:** sin `*.tf` en el repo y con `faro/config.json > despliegue.infra = "externa"` (opcionalmente con `referencia`: URL o nombre del stack, solo para mostrarla), el diagnóstico **no exige Terraform**. En su lugar comprueba que el CI recibe por variables de entorno lo que necesita.
- Sin esa clave y sin `*.tf`, el diagnóstico pregunta qué modelo se usa; no supone ninguno.

### Principios del despliegue (aprendidos de un repo real en AWS)

1. **Construir una vez y promover el mismo artefacto.** La imagen, el bundle o la versión del Worker se construye una sola vez por commit, se etiqueta de forma inmutable (SHA) y es **ese** artefacto el que pasa por dev → staging → production. Si se reconstruye en cada entorno, lo que se probó en staging no es lo que llega a producción. Si cada entorno tiene su propio registro, se copia o replica el artefacto; no se vuelve a construir.
   - **Cuándo:** se construye **una sola vez, al integrar en `main`**. Ese mismo job despliega en staging. El PR solo construye para validar y para la preview; ese artefacto no se promueve.
   - **Contenedores:** producción despliega el mismo *digest* que staging.
   - **Workers:** staging y production son Workers distintos y una versión no se puede mover de uno a otro. Por eso se garantiza la equivalencia con *mismo commit y mismo lockfile*. El diagnóstico comprueba que el tag de producción apunta a un commit que ya se desplegó con éxito en staging.
   - **Reparto de papeles:** devops gobierna la infraestructura, los entornos, los secretos y la puerta de producción; FARO solo valida y genera.
2. **Paso previo al despliegue (migraciones).** Cada adaptador admite un paso `antes` (migraciones de D1 o Postgres, tarea puntual de ECS…). Si falla, no se actualiza el servicio.
3. **El despliegue espera a que esté sano.** Comprobación de salud o *smoke test* tras desplegar y reversión si falla (`wrangler rollback`, *circuit breaker* de ECS).
4. **Los nombres de los entornos son configurables.** `staging`/`production` son el valor por defecto; un repo puede usar `dev`/`staging`/`prod` (`despliegue.entornos`), con promoción secuencial.
5. **Sin claves de larga duración cuando la nube lo permite.** OIDC desde el CI, rol de despliegue por cuenta y variable del rol protegida, de modo que solo existe en la rama principal.

### Adaptadores de destino

Cada adaptador es un módulo con la misma forma:
- `detectar(raiz)` → `{ destino, ficheros, entornos, local }`;
- `gates()`;
- `diagnostico()` → filas `ok | falta | no-disponible`;
- `pasosCi(entorno)`;
- `comandoLocal()`;
- `secretosEsperados(entorno)`, solo nombres;
- `preview()` | `null`.

Fase 1: `cloudflare` (wrangler) y `terraform` (con detección de providers: `cloudflare`, `aws`, `azurerm`…). Fase 2: `aws-sam` y `contenedor`.

### Cloudflare (fase 1)

- La definición única es `wrangler.jsonc` (también `.json` y `.toml`, como ya hace `code.js`), con `env.staging` y `env.production`.
- El diagnóstico comprueba:
  - que existen los dos entornos;
  - que cada binding de datos (D1, KV, R2, Hyperdrive, colas) está en **todos** los entornos;
  - que cada entorno usa **IDs distintos**: staging no comparte base de datos con producción.
- **Hyperdrive:**
  - Es un adaptador de un puerto "conexión SQL".
  - En local, `localConnectionString` (o `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`) contra una base de datos local. El diagnóstico **marca como fallo** una cadena local que apunte a un host remoto.
  - En Terraform, la contraseña de origen va como variable `sensitive` y se avisa de que queda en el estado.
- **Preview por PR:** `wrangler versions upload` con su URL de preview comentada en el PR. No toca staging.
- **Secretos esperados por entorno:**
  - `CLOUDFLARE_API_TOKEN_DEPLOY` (solo Workers) y `CLOUDFLARE_ACCOUNT_ID`;
  - si hay Terraform: `CLOUDFLARE_API_TOKEN_TF` y las claves R2 del estado.
  - Cloudflare no admite OIDC: se usa token por entorno, con permisos mínimos y caducidad.

### Terraform (fase 1)

- Detecta `*.tf` (raíz, `infra/` o lo que declare `faro/config.json > despliegue.terraform.dir`), los providers usados y la estructura `envs/<entorno>`.
- Si hay un directorio por entorno, lo usa. Si no, usa workspaces, y si tampoco los hay, avisa.
- **Gates** (con `terraform` o `tofu`):
  - siempre: `fmt -check`, `init -backend=false` y `validate`;
  - `tflint` y `checkov` si están instalados; si no, aviso, no fallo.
- **Diagnóstico:**
  - backend remoto declarado, nunca estado local en el repo;
  - `.terraform.lock.hcl` versionado;
  - versiones de Terraform y providers fijadas;
  - `prevent_destroy` en recursos con datos (D1, R2, RDS, S3, buckets del estado…);
  - estado no presente en `.gitignore` → fallo si hay `*.tfstate` versionado.
- **CI:**
  - en el PR: `plan` por entorno, comentado en el PR;
  - en `main`: `apply` en staging y después el despliegue de código;
  - con el tag `v*`: `apply` en producción y después el despliegue de código.
  - El `apply` va siempre antes que el deploy de código.
- **Drift:** job programado opcional con `plan -detailed-exitcode`, que abre una issue si hay diferencias.

### Entornos y puerta de producción (se adapta al plan)

| Disponible en la forja | Puerta de producción |
|---|---|
| Required reviewers (GitHub Enterprise o repo público) / protected environments (GitLab Premium) | Aprobación en el entorno, además del tag |
| Entornos sin aprobadores (GitHub Team) | **Tag `v*` protegido por ruleset** (por defecto) |
| Sin entornos en repos privados (GitHub Free) | Tag `v*` + secretos de repositorio. El diagnóstico avisa de que no hay aislamiento por entorno |

- **Decisión del usuario: el despliegue a producción es manual y lo confirma devops.**
  - **GitHub Team:** devops **crea el tag**, y ese acto es la confirmación. El ruleset de tags solo deja crear `v*` (y `*@*` en monorepo) a quien tiene la excepción, es decir, al equipo de devops. Devops se asegura de que solo ellos puedan crear el tag; si cualquiera con escritura puede, la puerta no protege nada.
  - **El push del tag**, hecho por una persona y no por el CI, lanza el workflow de producción.
  - **GitLab:** `when: manual` en un entorno protegido.
  - **Donde haya aprobadores:** tag + aprobación en el entorno (`aprobacion`).
  - En los productos, el CI **nunca** crea el tag de producción. El release automático es propio de FARO, no de los productos.
- Configurable por repo en `faro/config.json > despliegue.puerta_produccion`: `tag` (por defecto), `aprobacion` o `manual` (`workflow_dispatch` / `when: manual`).
- Los entornos solo aceptan despliegues desde la rama principal de flujo (`flujo.js`) y desde tags `v*`.

### Variables y secretos por entorno

| Tipo | Dónde se define | Quién lo usa |
|---|---|---|
| Variable de la app, no secreta (URL de API, flags) | En la definición de la app, por entorno: `wrangler.jsonc > env.<entorno>.vars`. Versionada y revisada en el PR | La app en ejecución |
| Secreto de la app (claves de terceros) | Secreto del **entorno** de la forja → el CI lo sube con la herramienta del destino (`wrangler secret put`, Secrets Manager/SSM en AWS) | La app en ejecución |
| Variable del CI, no secreta (`CLOUDFLARE_ACCOUNT_ID`, región, rol a asumir) | Variable del **entorno** de la forja (`vars.X` en GitHub, variable con *environment scope* en GitLab) | El job de ese entorno |
| Credencial del CI | Secreto del **entorno** de la forja | Solo el job de ese entorno |

- Un job solo ve las variables y secretos del entorno que declara. Los del entorno tienen prioridad sobre los del repo y la organización.
- El diagnóstico compara lo que la app espera (los `vars` y los secretos que referencia el código o declara `faro/config.json > despliegue.secretos`) con lo que existe en cada entorno de la forja. Solo lista nombres, nunca valores.

### Desarrollo local

- `harness.js local` según el destino detectado:
  - `wrangler dev` (o el script `dev` de `package.json` si existe, que tiene prioridad);
  - `sam local start-api`;
  - `docker compose up`.
- En monorepo, por app (`--app <id>`), reutilizando `apps.js`.
- Los bindings sin emulación (Vectorize, AI, Browser) se marcan como en `code.js:656`.

### Arquitectura hexagonal (siempre)

**Decisión del usuario:** el enfoque es siempre hexagonal, con puertos, adaptadores y carpetas bien estructuradas que permitan compatibilidad con otros destinos. Si mañana el foco pasa a AWS, solo se añaden o cambian adaptadores; el dominio no se toca.

- **Estructura estándar, con rutas en inglés** (decisión del usuario: "en inglés las rutas, domains y demás… así estandarizamos"). Es la que propone FARO cuando el repo no declara ninguna; lo exigible sigue siendo lo declarado en `ARCHITECTURE.md > ## Hexagonal`, de modo que los repos existentes no se rompen:
  ```
  src/
    domain/            reglas de negocio puras
    ports/             interfaces que el dominio necesita (repositories, storage, queue, mail, coordination…)
    application/       casos de uso que orquestan domain y ports
    adapters/
      <target>/        uno por destino: cloudflare/, aws/, azure/, node/, memory/ (tests y local)
    entrypoints/       uno por destino: worker.ts, lambda.ts, server.ts, container
  infra/
    modules/<target>/  módulos de Terraform por destino, con los mismos outputs
    envs/<env>/        staging/, production/ (o dev/, staging/, prod/)
  ```
  En monorepo, el mismo reparto en paquetes: `packages/domain`, `packages/<port>` con `src/adapters/<target>/`, y `apps/<entrypoint>`.
  - El código, los identificadores y las rutas van en inglés. La documentación y los mensajes de FARO siguen en español.
  - `hexagonal.js` reconoce por defecto estos nombres (además de los que declare el repo) para proponer la migración. `planMigracion` sugiere renombrar las carpetas en español (`dominio/`, `adaptadores/`…) a su equivalente en inglés.
- **Un adaptador en memoria o local** (como un simulador o PGlite) por cada puerto con E/S, para tests rápidos y desarrollo sin nube.
- **Exigencia:**
  - En repos con código que despliegan, el diagnóstico de despliegue **exige** la sección `## Hexagonal` y el gate hexagonal en verde. Sin sección, falla con la propuesta de `planMigracion` ya preparada.
  - En el resto de repos con código, sigue como hoy: aviso y propuesta.
- **Compatibilidad entre destinos:** el diagnóstico cruza las entradas detectadas con los adaptadores declarados. Por ejemplo: "hay `entradas/lambda` pero el puerto `almacen` solo tiene adaptador `cloudflare/`" → falta un adaptador para ese destino.
- Se reutiliza `lib/hexagonal.js`. Hoy `dominio` y `puertos` ya rechazan cualquier paquete externo que no esté en `permitidos`. Se añade una **lista de SDKs de nube** (`cloudflare:*`, `agents`, `@cloudflare/*`, `@aws-sdk/*`, `aws-lambda`, `@azure/*`, `wrangler`) que:
  - está prohibida en `domain`, `ports` **y `application`**, porque los casos de uso hablan con la nube a través de puertos;
  - **tiene prioridad sobre `permitidos`**, así que un repo no puede permitirse un SDK de nube en el núcleo;
  - incluye los especificadores con esquema (`cloudflare:workers`) como externos. *(Decisión mía: es lo que hace que la regla sirva de algo.)*
- **Durable Objects / Agents SDK:** FARO no los emula ni los porta. Solo comprueba que el dominio no los importe. El puerto debe definirse por lo que la app hace con ellos (recibir, estado, emitir, programar), no copiando la API del DO. El adaptador de AWS (SQS FIFO + DynamoDB + API Gateway WebSocket + EventBridge Scheduler, o un motor de actores portable como Restate) es decisión de cada producto.

### Forja: fuera de FARO (decisión del usuario)

> Sustituido: la forja la prepara devops. Lo de abajo queda solo como referencia de lo que devops configura.

- Diagnóstico en tabla (`ok | falta | no lo permite el plan | lo gestiona la organización`) y, con confirmación, aplicación de:
  - auto-merge y método de merge;
  - protección de la rama principal: no se duplica si ya hay un ruleset de organización que la cubre (se leen las reglas efectivas de la rama);
  - check portero `faro-gate`;
  - entornos `staging` y `production` restringidos a la rama principal y a `v*`;
  - aprobadores solo si el plan lo permite. Si no, se informa y se usa el tag como puerta.
- Los ajustes de organización (política de Actions, rulesets de organización) **solo se diagnostican** y se explica cómo cambiarlos; no se aplican.
- Sustituye o ajusta `proteger` y `exigir-pipeline` al flujo 3.0, que hoy siguen con el flujo anterior.

### Skill `/faro:desplegar`

- Agnóstica: pregunta y orquesta; el harness comprueba. Subcomandos orientativos:
  - `estado`: diagnóstico;
  - `preparar`: puesta en marcha guiada;
  - `añadir-destino`: por ejemplo, AWS;
  - `local`;
  - `drift`.
- En la puesta en marcha guía, en este orden:
  1. backend del estado;
  2. tokens o roles por entorno, solo indicando nombres y dónde ponerlos;
  3. entornos en `wrangler.jsonc`;
  4. módulos de Terraform por entorno;
  5. CI de despliegue;
  6. Entregar a devops la tabla de secretos y variables por entorno.
- No existe una skill "de Terraform": Terraform es un adaptador.

### Credenciales en los jobs del PR *(decisión mía tras la revisión)*

Un job de PR no puede entrar en `staging` ni en `production`, que solo aceptan `main` y los tags. Por eso:

- **Entorno `preview`**, que acepta cualquier rama del propio repo. Los PR desde forks no reciben secretos.
  - Tiene **solo** credenciales de la cuenta o recursos de staging: un token de Terraform de **solo lectura** para el `plan` y un token de Workers para `wrangler versions upload`.
  - La preview es una **versión no desplegada del Worker de staging**: tiene URL propia y no recibe tráfico de staging.
- **En el PR se muestra solo el `plan` de staging.**
- **El `plan` de producción** se ejecuta dentro del job de producción, justo antes del `apply`, y queda en el resumen del job. Así, la credencial de producción nunca está al alcance del código de un PR.
- Por eso, devops crea tres entornos: `preview`, `staging` y `production`.

### De Terraform a `wrangler.jsonc`: cómo llegan los IDs *(decisión mía tras la revisión)*

- Los IDs **se commitean** en `wrangler.jsonc`. Es la única definición de la app, y en el CI no se inyecta ni se genera nada.
- **Recurso nuevo:**
  1. Un primer PR añade el recurso en Terraform; se integra y se aplica en staging.
  2. `harness.js despliegue` lee los outputs y propone el parche exacto para `wrangler.jsonc`.
  3. Un segundo PR añade el binding.

  Son dos pasos, pero cada PR es seguro por sí solo, y es el mismo orden que ya siguen los repos con IaC central (primero la infra y después la app).
- **El diagnóstico cruza** los IDs de `wrangler.jsonc` con los outputs de Terraform cuando el estado es legible. Un ID que no está en los outputs se marca como recurso creado a mano o borrado.

### Monorepo *(decisión mía tras la revisión)*

- **La unidad de despliegue es la app.** El tag de producción es el de la app (`{app}@{version}`, `TAG_DEFECTO` de `apps.js`); en repos de una sola app es `v*`.
- Los entornos aceptan los dos patrones. El ruleset de tags de la organización debe cubrir también `*@*` (lo configura devops).
- Hay un `wrangler.jsonc` por app (como ya detecta `apps.js`). Terraform puede ser compartido (`infra/` en la raíz) o por app (`apps/<id>/infra/`), según lo que se detecte.
- `plan`, preview y despliegue van por app, solo para las apps que toca el cambio (reutilizando `alcanceApps`).

### Configuración por repo (opcional; por defecto no hace falta nada)

```json
"despliegue": {
  "entornos": ["staging", "production"],
  "puerta_produccion": "tag",
  "preview": true,
  "terraform": { "dir": "infra", "binario": "auto" }
}
```

## Fases

1. **Fase 1 (Cloudflare + Terraform):** adaptadores `cloudflare` y `terraform`, gates, `harness.js despliegue`, `harness.js local`, plantilla de CI de despliegue (GitHub y GitLab), previews, extensión de `hexagonal.js` y skill `/faro:desplegar`. También el pendiente de la 3.0: el wizard deja de crear `develop`.
2. **Fase 2 (AWS):** adaptadores `aws-sam`, `contenedor` y, como alternativa de infraestructura a Terraform, **stacks de AWS** (CloudFormation / CDK, detectados por `cdk.json` o `template.yaml`: `cdk diff` en el PR, `cdk deploy` por entorno). Terraform sigue siendo el modo por defecto porque sirve para cualquier nube; un repo con stacks y `*.tf` a la vez debe declarar qué recurso tiene cada dueño. Además: autenticación OIDC en el CI (rol IAM limitado al entorno), backend S3 con `use_lockfile`, diagnóstico de cuentas separadas por entorno.
3. **Después:** Azure (`azurerm`, federated credentials, backend de Azure Storage) y entornos efímeros por PR en AWS y Azure.

## Lo que queda al implementador

- Estructura interna de los módulos (`lib/despliegue.js` + `lib/despliegue-<adaptador>.js` es la propuesta) y su integración en `code.js` y en `cmdCi`.
- Formato exacto de las tablas del diagnóstico y de los mensajes.
- Cómo mezclar los jobs de despliegue en un CI existente sin sobrescribirlo: proponer el bloque, como hace hoy `cmdCi`.
- Tests con fixtures sintéticos por adaptador, siguiendo el estilo de `test/monorepo-sintetico.cjs`, sin red ni credenciales.

## Consecuencias

- FARO pasa de "validar y publicar" a "validar, publicar y desplegar por entornos", sin desplegar nunca desde la sesión.
- El rol de DevOps se centra en preparar una vez (credenciales, backend, políticas) y en revisar los PR de infraestructura. El día a día es PR → staging y tag → producción.
- Con el plan Team de GitHub, la aprobación de producción es el tag protegido, no un botón.
