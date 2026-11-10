---
description: "Úsala cuando el trabajo EVOLUCIONA a código — pregunta el stack, investiga el tooling y scaffoldea src/ (o apps/<nueva> en un monorepo) con arquitectura sólida, reclasificando el repo."
argument-hint: "[lenguaje/stack o instrucciones, opcional]"
---

Actúa como **arquitecto de software inicializando el código de un Proyecto FARO** que evoluciona: hasta ahora era gestión/documentación y a partir de ahora también se programa — **sin cambiar de repo**. Ejecútalo **TÚ en esta conversación (hilo principal)**, NO como subagente — así `AskUserQuestion` funciona. Habla al usuario en llano; la mecánica la resuelves tú.

## 0 · ANALIZA antes de preguntar (el proyecto ya sabe cosas)

Lee TODO lo que exista y extrae decisiones ya tomadas — no preguntes lo que ya está escrito:

- `faro/ESTADO.md` — qué es el trabajo, fase actual, tareas que piden código.
- El **funcional** (frontmatter `funcional:` o `faro/documentos/funcional/`) — QUÉ debe hacer el sistema.
- `faro/documentos/` **técnicos y decisiones (ADR)** — restricciones de stack ya decididas.
- `faro/gestion/cambios/` — specs/deltas que describan capacidades a construir.
- Lo ya presente en el repo (¿hay `package.json`, `wrangler.toml`, `requirements.txt` sueltos?).

Resume al usuario en 3-4 líneas qué entendiste que se va a construir, y confírmalo.

## 0b · ¿MONOREPO? El código nuevo es una APP, no la raíz

Si `faro/config.json` declara `monorepo` (lo ves con `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" apps`), la raíz es de la gestión FARO y del workspace: **no** crees `src/`, `tests/` ni `ARCHITECTURE.md` en ella. Lo que se construye es una app nueva en `apps/<nueva>` (o un paquete compartido en `packages/<nombre>` si no se despliega). Todo lo de los pasos 2-3b se aplica **dentro de esa carpeta**:

- **¿Hay una plantilla de stack de la organización que encaje** (p. ej. `TANSTACK-WORKER-UI` para un front en Worker)? Entonces NO scaffoldees a mano: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" app nueva <nueva> --plantilla <REPO> --rol "<una frase>"` muestra el plan (dry-run) y, con `--confirmo`, deja `apps/<nueva>` con la plantilla sin su historial, normalizada al workspace (workspace, lock y `faro/gestion/` de la plantilla fuera; `allowBuilds`, `packageManager` y `.node-version` a la raíz; Workers `<repo>-<nueva>-dev|prod`) y **registrada** (`faro/config.json`, `CLAUDE.md`, etiqueta `app:<nueva>`). No commitea: revisa y commitea tú. Luego `pnpm install` en la raíz.
- **Sin plantilla, scaffold con pnpm**, el gestor del workspace (nunca npm dentro de un monorepo pnpm): `pnpm create cloudflare@latest apps/<nueva> --no-deploy` para un worker, `pnpm create vite@latest apps/<nueva>` para un front; comprueba antes la sintaxis vigente (paso 2). Después, `pnpm install` en la raíz para que el workspace la enlace.
- **`apps/<nueva>/ARCHITECTURE.md`** (su contrato), un **`apps/<nueva>/CLAUDE.md`** propio (comandos y patrones de ESA app; Claude Code lo carga solo al trabajar en la carpeta) y sus tests en `apps/<nueva>/tests/` o colocados en `src/**/*.test.ts`, según la convención del stack.
- **Regístrala con el harness, nunca editando `faro/config.json` a mano**: si no vino de `app nueva`, `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" monorepo init --app <nueva> --rol "<una frase>" [--funcional <doc_id>] [--equipo <team>]` (dry-run; luego `--confirmo`) la declara en `faro/config.json > monorepo.apps`, le crea su `CLAUDE.md` y la etiqueta `app:<nueva>`. Sin registro, `validate` avisa de una app sin declarar.
- Comprueba con `harness.js apps` que sale con su rol y sus rasgos (worker, contrato, tests).

## 1 · PREGUNTA solo lo que falta (AskUserQuestion, con opciones)

- **Tipo de sistema**: backend (API/servicio) · frontal · fullstack · worker Cloudflare · CLI/librería. Si el funcional lo delata, propónlo como recomendado.
- **Lenguaje/stack**: TypeScript · Python · Go · otro — con recomendación razonada según el tipo y el ecosistema del equipo (Cloudflare ⇒ TS).
- Lo dudoso de arquitectura que cambie el esqueleto (¿monolito modular o servicios?, ¿SSR o SPA?). No preguntes minucias: decide tú con criterio y dilo.

## 2 · INVESTIGA el tooling VIGENTE (no de memoria)

Busca en internet (WebSearch/WebFetch) las versiones y opciones actuales antes de fijar: framework de **testing** (p. ej. vitest/pytest — el adecuado al stack), linter/formatter, y el **scaffold oficial** si existe. Regla: **scaffold oficial primero** (C3 `npm create cloudflare@latest -- --no-deploy` para worker; `npm create vite@latest`, `uv init`…) y la estructura FARO encima; solo scaffold manual si no hay oficial. Nunca degradar versiones.

## 2b · PLAN DE VALIDACIÓN — DOS niveles, no confundirlos

Lo crítico no es "cuánto código está cubierto" — es "¿el sistema demuestra que cumple el requisito de
negocio?". Un test unitario en verde no prueba eso; puede pasar y el sistema seguir sin resolver el
problema real. Separa SIEMPRE los dos niveles y presenta el plan completo al usuario (AskUserQuestion,
una pantalla) **antes de escribir código**:

- **Nivel técnico** (código correcto): librería elegida (vitest/pytest…), unit por módulo,
  integración de contratos entre módulos. Gates del harness en verde. Esto demuestra que el código
  no está roto — NO que resuelve el negocio.
- **Nivel de NEGOCIO** (el sistema hace lo que pide el funcional) — **este es el crítico, no lo trates
  como secundario**: por cada requisito/criterio de aceptación del funcional o de la spec, define CÓMO
  se demuestra con evidencia ejecutable, adaptando el medio al caso:
  - **Notebook** (`faro/notebooks/<slug>.ipynb`, estándar Cookiecutter Data Science ya usado en FARO) cuando
    el requisito es sobre DATOS, un cálculo, un modelo, una comparativa, un pipeline — algo que se
    demuestra mejor viendo la entrada/salida REAL ejecutada que leyendo un `assert`. Es la elección por
    defecto para requisitos de negocio no triviales: corre, se ve, queda como evidencia citable.
  - **Test funcional/e2e** (misma librería del nivel técnico, o Playwright/similar si hay UI) cuando el
    requisito es un flujo o comportamiento del sistema en marcha (API responde X ante Y, un flujo de
    usuario completa Z).
  - **Script de validación** (`scripts/`) cuando es una comprobación puntual reproducible sin necesitar
    el aparato de un notebook.
  Cada requisito de aceptación → UNA fila con: qué se demuestra, con qué medio, y el criterio de "pasa".
  Esta tabla es la que luego lee `revisor-code` para verificar trazabilidad — no la omitas ni la
  reduzcas a "hay tests".

Si el usuario ajusta algo, incorpora y re-presenta. **Sin su OK no se scaffoldea.**

## 3 · SCAFFOLDEA con arquitectura sólida

Crea `src/` (o el layout idiomático del stack; en un monorepo, `apps/<nueva>/src/`) con **arquitectura hexagonal** (puertos y adaptadores) aplicando **SOLID y modularidad** — adaptado al proyecto, no una plantilla ciega:

```
src/
├── dominio/          ← reglas de negocio PURAS, por concepto del funcional: sin E/S, sin entorno, sin SDKs
├── aplicacion/       ← casos de uso: orquestan el dominio a través de los puertos
├── puertos/          ← interfaces que el negocio necesita del mundo (repositorio, notificador, reloj…)
├── adaptadores/      ← lo que toca el mundo: HTTP/handlers, base de datos, colas, APIs, config/entorno
└── index.*           ← composición: el ÚNICO sitio que importa adaptadores y los inyecta en la aplicación
tests/                ← espejo de src/, con un test real del primer caso de uso (no dummy vacío)
```

- **La regla que no se negocia**: las dependencias apuntan hacia dentro. `dominio/` y `puertos/` no importan `aplicacion/` ni `adaptadores/`, no hacen E/S (`fetch`, `fs`, `process.env`, `open()`…) ni usan paquetes externos salvo los puros que se declaren en `permitidos`; `aplicacion/` no importa `adaptadores/`. Así el dominio se prueba sin red ni disco y cambiar de proveedor es cambiar un adaptador.
- Lo comprueba el harness, no la memoria: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" hexagonal` lee la sección `## Hexagonal` de `ARCHITECTURE.md` (paso 3b) y lista cada import que la rompe; con la sección declarada, `validate --gates` lo **bloquea**.
- Frontal: el mismo corte — componentes y estado son adaptadores de UI; la lógica de negocio va en `dominio/`/`aplicacion/`, y los servicios que llaman a la API son adaptadores detrás de un puerto. Fullstack: un hexágono por lado (`apps/` o `src/server|client` según el stack).
- Utilidades compartidas: si son puras, dentro de `dominio/` (o un paquete puro declarado en `permitidos`); si tocan el mundo, son un adaptador.
- Configura lint + format + test **funcionando** (scripts en package.json o equivalente).
- **Control de entornos (obligatorio, no opcional)**:
  - `.env.example` VERSIONADO con TODAS las variables documentadas (nombre, para qué, ejemplo inocuo) — es el contrato de configuración.
  - `.env*` en `.gitignore` SIEMPRE (verifícalo tú: `git check-ignore .env` debe pasar) — un secreto commiteado es incidente, no descuido.
  - Config **tipada que valida al arrancar** (fail-fast en `config/`): si falta una variable, el arranque lo dice con nombre y apellidos, no un crash críptico a mitad de request.
  - Secretos por el canal del stack (p. ej. `wrangler secret` en workers), NUNCA en código ni en el repo.
- **Workers: el `wrangler` declara SIEMPRE de qué repo sale** — `"vars": { "REPO_URL": "<url del repo>" }`.
  Cloudflare no tiene campo estándar para esto, así que es convención de FARO. Sin ella, quien abre el
  dashboard mirando un incidente ve un worker llamado `api` y no tiene forma de llegar al código —
  justo cuando más prisa hay. El harness ya sabe cuál es el remoto: `harness.js infra` avisa si falta
  **diciendo qué URL poner**, y también si apunta a otro repo (peor que faltar: nadie duda de un dato
  que está escrito).
- `.gitignore`: MERGE — añade lo del stack (node_modules, dist, .env*, cachés) SIN tocar las reglas FARO; **no toques** `faro/documentos/ faro/gestion/ faro/fuentes/ faro/flujos/ faro/borrador/`.
- **CI de verdad, no solo gates locales (obligatorio al scaffoldear)**: en cuanto los scripts de
  lint/test/build existan, ejecuta `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" ci`. Genera el fichero de la
  forja del repo (`.gitlab-ci.yml` en GitLab, `.github/workflows/ci.yml` en GitHub) que corre **esos
  mismos comandos** en cada petición de integración. Por qué importa: los gates locales son voluntarios
  y corren en la máquina de cada uno; el pipeline corre sobre una copia limpia, es igual para todos, deja
  constancia para quien aprueba y es lo único que puede **bloquear** la fusión. El comando **nunca
  sobrescribe** un CI existente; si ya hay uno, te dice qué comandos mergear a mano. Enséñale el fichero
  generado al usuario y dile que lo revise (imagen/versión) antes de commitearlo. Una vez commiteado y
  corriendo, el pipeline **solo informa** hasta que alguien lo exige: en GitLab, un Mantenedor lo
  convierte en requisito con `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" exigir-pipeline` (el comando se niega
  si el repo aún no tiene fichero de CI, porque exigirlo sin pipeline bloquearía toda fusión); en
  GitHub, el equivalente es marcar ese workflow como comprobación requerida en la protección de rama.
  Tener pipeline es OPCIONAL (un repo documental no lo tendrá nunca); que PASE, en los que lo tienen,
  no debería serlo.

## 3b · MANIFIESTO DEL CÓDIGO — `ARCHITECTURE.md` (estándar de industria)

Genera **`ARCHITECTURE.md` en la raíz** (en un monorepo, en la carpeta de la app: `apps/<nueva>/ARCHITECTURE.md`) (la convención de la industria para el "codemap") y mantenlo como contrato vivo del código:

```markdown
# Arquitectura — <proyecto>
## Mapa de módulos          ← cada módulo: UNA línea de responsabilidad + su carpeta
## Invariantes               ← reglas que NUNCA se rompen (p. ej. "dominio no importa de infraestructura")
## Dónde va cada cosa        ← "¿un helper nuevo? → shared/·  ¿un endpoint? → <dominio>/api"
## Convenciones              ← naming, errores, validación de entrada, logging
## Estándares                ← los CONTRATOS del sistema, según lo que sea:
##   · API: estilo (REST/RPC), formato de error ÚNICO, versionado, contrato OpenAPI si expone API
##   · Datos: esquema/migraciones, validación en el borde (zod/pydantic o equivalente)
##   · Seguridad: authn/authz dónde se decide, secretos NUNCA en código, inputs siempre validados
##   · (lo que aplique al proyecto: eventos, jobs, i18n… — estándar declarado = estándar exigible)
## Testing                   ← librería, niveles, cómo correr, umbral de cobertura acordado
## Hexagonal                 ← las capas, EXIGIBLES (rutas relativas a la carpeta de este ARCHITECTURE.md)
- dominio: src/dominio/
- aplicacion: src/aplicacion/
- puertos: src/puertos/
- adaptadores: src/adaptadores/
- composicion: src/index.ts
- permitidos:                ← paquetes externos PUROS que el dominio puede usar (p. ej. zod); vacío = ninguno
```

La sección `## Hexagonal` es lo que convierte la arquitectura en un gate: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" hexagonal` la contrasta con los imports reales (JS/TS y Python) y `validate --gates` bloquea si se rompe. Sin ella, `validate` solo avisa. En un repo que ya tenía código, `harness.js hexagonal --plan` propone la sección y los pasos de migración a partir de lo que hay.

Regla para TODO el trabajo posterior en el repo: **si un cambio altera el mapa (módulo nuevo, límite movido), el mismo cambio actualiza ARCHITECTURE.md** — un manifiesto desactualizado es peor que ninguno. Los agentes/skills de código lo leen ANTES de tocar `src/`.

Este manifiesto cumple el papel de la **"constitution" del spec-driven de industria** (GitHub Spec Kit): los invariantes + estándares son los principios no negociables que cada cambio posterior respeta — y en FARO cada capacidad nueva entra por el ciclo ya existente (`/faro:cambio` → proposal → tasks → `/faro:aplicar`), nunca improvisada.

Añade también el **contexto para agentes** (estándar `AGENTS.md` de industria; en Claude Code, la sección equivalente del `CLAUDE.md` del repo): comandos de build/test/lint exactos, restricciones duras, y los **patrones NO obvios** del proyecto (lo que un agente no adivinaría). Máx ~150 líneas, alto señal — nada de duplicar lo que ya dicen ARCHITECTURE.md o el harness.

## 4 · RECLASIFICA y despierta el gobierno

- Topic `nat-worker`/`nat-app` (vía `/faro:forja` o `harness.js`) y metadato del repo coherentes.
- Los **gates de código del harness despiertan solos** al detectar código — ejecuta `node <harness> validate --gates` (el `validate` a secas no los corre: es rápido a propósito) y deja los gates en verde (tests + lint pasando).
- **Comprueba que el esqueleto nace hexagonal**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" hexagonal` debe salir conforme. Si no, corrige el import antes de entregar: un esqueleto que ya rompe las capas enseña el patrón equivocado a todo lo que venga después.
- **Comprueba la salud estructural del esqueleto que acabas de crear**: `node <harness> codigo`. Da tres señales objetivas — ficheros por encima del umbral de atomicidad, ciclos de dependencia y módulos que nadie importa. Un esqueleto recién scaffoldeado debería salir limpio en las tres; si ya nace con un ciclo, la frontera entre módulos está mal puesta y es el momento barato de arreglarlo. Los ciclos son un defecto; el tamaño es solo una señal para mirar ese fichero.
- Registra la decisión de stack como **ADR de gestión** en `faro/gestion/decisions/<AAAA-MM-DD>-<slug>.md` (fecha, autor, estado, contexto/decisión/consecuencias) y actualiza `faro/ESTADO.md` (tarea de fase correspondiente).
- **Cuadra con el RAID** (`faro/gestion/risks.md`): si la inicialización introduce riesgos técnicos reales — dependencia crítica de terceros, límite del plan/plataforma, deuda aceptada a propósito, dato sensible que ahora circula por código — regístralos como filas del RAID **con dueño**, y avísalo al usuario en llano. El agente `gestor-riesgos` los seguirá; no los dejes en tu cabeza.

## 5 · ENTREGA

Cierra con: qué se montó y por qué (2-3 líneas al usuario), cómo correr tests/lint, y el siguiente paso natural (primer cambio spec-driven con `/faro:cambio` para la primera capacidad). Todo por rama de trabajo — el merge a develop vía `/faro:pr`, como siempre.

**Nunca**: deploy, tocar credenciales, borrar contenido documental, o elegir stack en silencio cuando había duda razonable.
