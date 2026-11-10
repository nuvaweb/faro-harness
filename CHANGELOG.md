# Changelog — plugin faro

## [Unreleased]

## 2.0.0 — 2026-11-10

### Cambiado (rompe el layout)
- Todo lo de FARO cuelga de `faro/` (#293): `faro/{gestion,fuentes,documentos,flujos,borrador,notebooks}/`, `faro/ESTADO.md` y `faro/config.json` (antes `.faro.json`). En un monorepo hay una sola `faro/` en la raíz.
  - Siguen en la raíz `CLAUDE.md`, `.claude/`, `README.md`, `CHANGELOG.md`, `ARCHITECTURE.md`, el CI, `src/` y `scripts/`.
  - Las skills y los agentes siguen en el plugin; solo cambian las rutas que citan.
  - `~/.faro.json`, las credenciales del usuario, no cambia.
- Mapa único de rutas en `lib/paths.js` (`BASE`, `AREAS`, `ESTADO`, `CONFIG`, `ruta()`, `detectarLayout`) y un lector y escritor único de la configuración (`lib/config-repo.js`). Un test impide leer `ESTADO.md` o `.faro.json` con literales fuera del mapa.
- Lectura dual: un repo sin migrar sigue funcionando con el layout antiguo. `validate` avisa en una línea de que puede migrar.
- Los mensajes del motor citan `faro/config.json > …`.

### Añadido
- `harness.js migrar-layout [--dry-run]`:
  - mueve a `faro/` con `git mv`, para conservar el historial;
  - recalcula los enlaces relativos y actualiza las rutas citadas, el `.gitignore` y los permisos de `.claude/settings.json`;
  - el histórico (`changes/archive/`, `decisions/`, `reporting/`, `CHANGELOG.md`) solo recalcula enlaces.
  - Para sin mover nada si un destino ya existe o hay cambios sin guardar. Deja todo en el índice, sin commit.

### Quitado
- `.metrics/`, que era de la telemetría retirada. `migrar-layout` la retira.

### Corregido
- Repo a medio migrar (#295): si ya existe `faro/` pero la configuración sigue en `.faro.json`, se lee `.faro.json` en vez de una configuración vacía sin aviso. Es la misma regla en el motor, el wizard y los hooks de TDD.
- `migrar-layout` no sigue enlaces simbólicos al buscar markdown ni reescribe a través de ellos (`.gitignore`, `.claude/settings.json`, `.md`). Comprueba cada segmento de la ruta, también un `.claude/` enlazado, así que no puede tocar ficheros de fuera del repo. Si `faro/` es un enlace, no migra.
- La importación de la gestión de un repo al monorepo rechaza un enlace simbólico en cualquier segmento del área (`faro/gestion`), no solo en el último.

## 1.6.0 — 2026-11-10

### Añadido
- Validación de PR/MR delegada en el CI de la forja (#289). `.faro.json > validacion` elige dónde se valida: `ci`, `local` o `ambos`. Sin la clave, todo sigue como hasta ahora (`local`).
  - Puerto `estadoCi` / `estadoCiCommit` en el contrato de forja, con adaptadores de GitHub (check-runs y estados) y GitLab (pipeline del MR o del commit). El estado sale normalizado: `verde`, `rojo`, `pendiente`, `sin-ci` o `sin-cuota`. Un fallo por minutos o crédito agotados no cuenta como fallo del código.
  - `consolidar` consulta el CI de cada PR/MR antes de integrarlo:
    - en `verde` con `ci`, no repite la suite en local;
    - en `rojo` o `pendiente`, deja fuera esa rama y sigue con las demás;
    - en `sin-ci` o `sin-cuota`, avisa en una línea y valida en local la suite completa.
  - `publicar` mantiene la suite local completa y cancela, antes de archivar ni tocar `main`, si el CI de `develop` está en rojo.
  - `faro-schema.json` declara la clave `validacion`.

## 1.5.1 — 2026-11-10

### Cambiado
- Origen público en `nuvaweb/faro-harness` (#282): el marketplace que declara el plugin, el `repository` de `plugin.json`, el wizard y el README apuntan al repo de la organización en lugar de al personal. Quien ya tenga el marketplace añadido con el nombre anterior debe volver a añadirlo: `/plugin marketplace add nuvaweb/faro-harness`.

## 1.5.0 — 2026-11-10

### Añadido
- Arquitectura hexagonal verificada (#280). La sección `## Hexagonal` de `ARCHITECTURE.md` declara las capas (`dominio`, `aplicacion`, `puertos`, `adaptadores`, `composicion` y los paquetes puros `permitidos`) y pasa a ser exigible:
  - `harness.js hexagonal [app] [--json] [--plan]` contrasta las capas con los imports reales de JS/TS y Python y da cada violación con su `fichero:línea`: el dominio que importa aplicación o adaptadores, que hace E/S (`fetch`, `fs`, `process.env`, `open()`…) o que usa un paquete externo no permitido, y la aplicación que importa adaptadores. En un monorepo, por app.
  - Con la sección declarada, `validate --gates` bloquea si hay violaciones. Sin ella, `validate` avisa y `hexagonal --plan` propone la sección y los pasos de migración a partir del código que hay.
  - `/faro:code` scaffoldea `dominio/`, `aplicacion/`, `puertos/` y `adaptadores/` con la composición en `index`, y la plantilla de `ARCHITECTURE.md` trae la sección.
  - `revisor-code` y `revisor-code-worker` ejecutan la comprobación y tratan cada violación como bloqueante. En Workers, además, los bindings (`env.*`) y `ctx` solo se usan en adaptadores o en la composición.
- El motor sigue el mismo patrón: `lib/hexagonal.js` es dominio puro (un test lo comprueba) y la lectura de disco y la extracción por lenguaje viven en adaptadores.

## 1.4.0 — 2026-11-10

### Cambiado
- Planificador externo genérico (#277). FARO ya no nombra a ninguna herramienta de planificación concreta: lee de la forja las marcas de la que se declare en `.faro.json` (o en `~/.faro.json`) con `"planificacion": { "prefijo": "<prefijo>", "nombre": "<Nombre>" }`. Las marcas son la propiedad `<prefijo>_id` (GitHub), el topic `<prefijo>-PRJ-x` (GitLab) y `<prefijo>:epica=EPI-n · título` en la descripción del milestone. Si no se declara nada, no se lee ni se pinta nada.
- **Rompe:** el subcomando pasa a ser `harness.js planificacion [--json]`; el nombre anterior se retira sin alias. Quien leía la planificación con el prefijo de antes debe declararlo en `planificacion.prefijo` para seguir viéndola.
- Diseño hexagonal: `lib/planificacion.js` es dominio puro (no importa nada ni lee entorno, ficheros o red); el cableado de `harness.js` resuelve la configuración y lo inyecta en los adaptadores de GitHub y GitLab, que no lo construyen. Un test lo comprueba.
- Fixtures y ejemplos neutros: los tests, los comentarios y las skills dejan de usar nombres de proyectos, personas o claves reales. El CHANGELOG histórico, también.

## 1.3.2 — 2026-11-10

### Cambiado
- Instalación en un paso (#274): el README propone `npx faro-harness instalar`, que deja el plugin en Claude Code sin cuenta ni token (wizard 2.1.0). `/plugin marketplace add` queda como alternativa manual. La cuenta de la forja solo se pide al crear o traer un repo.

## 1.3.1 — 2026-11-10

### Corregido
- Seguridad (#271): las plataformas de `.faro.json > plataformas` se validan antes de llegar al contexto de la sesión. El `nombre` debe ser corto (hasta 40 caracteres: letras, números, espacio, `.`, `_` o `-`), cada código de `pack` debe tener la forma de un código de documento (`BRF`, `ARQ`…) y el id, como mucho 31 caracteres. La plataforma que no cumpla se ignora: un `.faro.json` ajeno ya no puede colar texto libre en la sesión.

## 1.3.0 — 2026-11-10

### Cambiado
- FARO es universal y sin marca (#256): plugin, wizard, agentes, skills y README dejan de nombrar a ninguna organización. Licencia MIT (`LICENSE`, © 2026 Fernando Acevedo); `plugin.json` con autor, licencia y repositorio público.
- Plantillas neutras: `plantillas/html/<marca>-*.html` pasan a `faro-*.html`, sin logo incrustado, paleta sobria y pie «Generado por FARO el <fecha>». El Word de negocio sale sin logo y `logo<Marca>` se renombra a `logoMarca`. **Atención:** un override `documentos/plantillas/html/<marca>-*.custom.html` deja de usarse; renómbralo a `faro-*.custom.html`.
- Plataformas declarables: Las plataformas de ejemplo ya no vienen en el motor. Cada organización declara las suyas en `.faro.json > plataformas` (`{ "<id>": { "nombre", "pack" } }`) y cada una aporta el tipo `<id>-func`. Sin declarar, un `tipo: core-func` se ignora en silencio.
- Credenciales: la variable `<MARCA>_GITHUB_TOKEN` pasa a `FARO_GITHUB_TOKEN` (la del wizard) y `<MARCA>_CLIENT_ID` a `FARO_CLIENT_ID`. El plugin y el wizard ya no traen la app OAuth de la organización anterior: el login por código usa `git config --global faro.githubClientId <id>` o `FARO_CLIENT_ID`; sin ella, el wizard conecta con token pegado.
- Marketplace: un solo origen público (`FernandoTWE/faro-harness`) para repos de GitHub y de GitLab, igual que el wizard; un espejo propio sigue declarándose con `git config faro.marketplaceUrl`.

### Retirado
- El servidor MCP de la organización anterior en `plugin.json` y su aviso en sesión.
- La compatibilidad con los ficheros legados `.<marca>-template.json` y `~/.<marca>-cli.json` (los sustituyeron `.faro.json` y `~/.faro.json`), y las colisiones `*.<marca>` en el adoptador (el wizard deja `*.faro`).

## 1.2.1 — 2026-11-10

### Retirado
- FARO no envía nada a ningún sitio (#261): fuera la carpeta `n8n/` (flujos de webhooks de GitHub, GitLab y Userback) con sus tests, la guía `CLICKUP.md` del gestor que ya salió del plugin (#218) y las menciones a webhooks en skills y mensajes. `validate` deja de vigilar `.metrics/` y el esqueleto del wizard ya no lo reserva en el `.gitignore`: tras retirar la telemetría (#253) nada lo crea.

## 1.2.0 — 2026-11-10

### Añadido
- El wizard (paquete npm `faro-harness`, comando `faro`) vive ahora en `cli/` de este repo, con su historial: plugin y wizard se publican juntos. Menú de cuatro modos: crear, traer (con migración a otra forja o URL), conectar (explica el token, sus permisos por forja y SSH) y actualizar. Añadir personas y fijar sus niveles queda en manos del owner en la forja; el wizard lo explica y enlaza. Dominio de tests `wizard` (#257).

### Seguridad
- La migración no pone el token en la URL, en los argumentos de git ni en los errores: viaja como cabecera por entorno, limitada al host de destino. Los tokens de entorno y de `gh` solo se usan con hosts públicos o declarados. La allowlist del esqueleto ya no abre WebFetch ni deja reescribir el historial sin confirmar (#257).
## 1.1.32 — 2026-11-10

### Añadido
- Los worktrees que crean los agentes aislados (`.claude/worktrees/<x>`) ya no se quedan olvidados (#251). Al arrancar la sesión y al terminar cada agente (hook `SubagentStop`) FARO borra los que están **limpios y con su rama ya integrada** en develop (merge normal o squash) y hace `git worktree prune`; el resto se cita por nombre con su motivo (`cambios sin guardar`, `rama sin integrar`) y nunca se toca. Nuevo comando `harness.js worktrees` (lista; `--limpiar` fuerza el barrido; `--ignorar` añade `.claude/worktrees/` al `.gitignore`). `validate` avisa si falta esa línea en el `.gitignore`, y `/faro:iniciar`, `/faro:adoptar` y `/faro:ramas` lo documentan.

## 1.1.31 — 2026-11-10

### Añadido
- Forja declarada para servidores propios con nombre neutro: `git config faro.forja gitlab` (un repo) o `git config --global faro.<host>.forja gitlab` (todo el servidor). Manda sobre la detección por nombre y vale con remotos https y ssh. `harness.js forge` explica cómo declararla cuando no reconoce el servidor (#254).
- `FARO_TOKEN` como credencial de entorno para un servidor propio en CI, atada al host que nombra `FARO_TOKEN_HOST`: ningún otro servidor la recibe (#254).

### Corregido
- Un remoto `ssh://git@host:2222/grupo/repo` dejaba el puerto dentro de la ruta del proyecto (#254).
- `migrar-tareas` ya no escribe rutas de la API de GitHub: usa `hito verificar` y `cerrar-tarea` (#254).

## 1.1.30 — 2026-11-10

### Añadido
- Comandos por intención en las dos forjas: `harness.js issue <N>` (leer o editar), `harness.js comentar <N> "…"` y `harness.js pr revisor <N> <login>`. Skills y agentes dejan de escribir rutas de la API de GitHub (#254).
- GitLab cubre `mover-tarea`, `cerrar-tarea`, `ampliar-tarea`, `triaje adjuntos`, las etiquetas de app del monorepo, y el descarte marca `faro:descartado` para distinguirlo de una tarea hecha (#254).
- `harness.js forge` muestra también horas por tarea, enlaces de bloqueo, reparar tareas y sincronizar tareas (#254).

### Cambiado
- Contrato único de forja (`lib/forge-contrato.js`): un test exige que los dos adaptadores cumplan las mismas operaciones. Lo que una forja no ofrece se declara en `CAPACIDADES` y el comando explica la alternativa. En GitLab siguen sin estar disponibles `reparar-tarea`, `campos-tarea` y `tarea migrar`/`sync` (#254).

### Corregido
- El marketplace de GitLab y los espejos propios usan `source: 'git'`; con `source: 'url'` Claude Code espera un enlace directo a `marketplace.json` y no descarga un repo. Un bloque antiguo con `url` y `.git` recibe un aviso para corregirlo (#254).

## 1.1.29 — 2026-11-10

### Eliminado
- Telemetría retirada: FARO ya no envía datos de uso a ningún panel ni escribe `.metrics/uso.jsonl`. Desaparecen el comando `harness.js metrics`, el hook `SessionEnd`, `FARO_METRICS_URL`, `FARO_METRICS_TOKEN` y las claves `faro.metricsUrl` y `faro.metricsToken` de git. El panel deja de recibir estadísticas nuevas. Primer paso para publicar el motor (#253).
## 1.1.28 — 2026-11-09

### Corregido
- Fusionar por la API ya no falla con «SHA must be provided when merging» en GitLab: los grupos con `require_sha_for_merge` (activo por defecto en los nuevos) exigen el SHA de cabeza. `pr mergear` y la integración por petición (develop → main) leen la petición justo antes y mandan su SHA, en GitLab y en GitHub. Si la rama cambió entre medias, la forja responde 409 y el harness lo explica en vez de fusionar commits sin revisar. En `consolidar` y `publicar` con rama protegida se fusiona exactamente el commit que se acaba de subir, aunque GitLab no haya calculado aún el SHA de la MR recién abierta. El agente `gestor-forja` ya no fusiona por la API cruda: usa `pr ver` / `pr aprobar` / `pr mergear --confirmo`, que comprueban el rol (#262).

## 1.1.27 — 2026-10-28

### Corregido
- En un monorepo con dominios, el Stop de TDD ya no pide la suite completa (`pnpm test` de la raíz) cuando la app tocada acaba de pasar su propia batería en verde: ese verde, posterior a la edición, cubre el dominio. Un dominio sin tests propios ya no ordena el comando base solo; se trata por app, donde «sin ejecutar» no bloquea y un rojo sí (#249).

## 1.1.26 — 2026-10-28

### Corregido
- El triaje ya no da `no-aplica` a un bug por coincidir en palabras con el fuera de alcance del funcional: un fallo no necesita estar planificado; queda en `sin-criterio`. Las ideas y sugerencias siguen descartándose citando la línea (#244).

## 1.1.25 — 2026-10-28

### Corregido
- `harness.js gh` expande `{org}` y `{repo}` por los del remoto de la sesión antes del control de alcance, como documentan los skills (triaje, pr, consolidar); antes los bloqueaba como «no es la organización de esta sesión». El control juzga la ruta ya expandida, así que no se amplía el alcance (#245).

## 1.1.24 — 2026-10-28

### Corregido
- Un ADR con `doc_id` en `gestion/decisions/` se valida contra el enum de ADR (`propuesta|aceptada|rechazada|sustituida`) y no tumba `validate` por el de documentos controlados; los estados de documento legados (`draft`, `approved`…) solo avisan. Antes ningún status valía para los dos validadores y `/faro:consolidar` cancelaba (#243).

## 1.1.23 — 2026-10-28

### Corregido
- El Stop de TDD ya no hereda el rojo de una ejecución de la raíz sin atribuir (timeout, salida sin tests citados) en las apps y dominios con verde propio posterior a su última edición: solo quedan pendientes las que no tienen ese verde (#241).

## 1.1.22 — 2026-10-28

### Corregido
- El Stop de TDD ya no ordena nunca la suite completa (`npm test`): sin dominio que acote el cambio solo exige arreglar un rojo ya visto y relanzar lo afectado (`tests-dominios --afectados`); la suite completa la corren CI y `/faro:publicar` (#237).
## 1.1.21 — 2026-10-28

### Cambiado
- `.faro.json` es libre: el harness ya no pide confirmación al editarlo ni cuando una orden lo menciona (#238).

## 1.1.20 — 2026-10-28

### Corregido
- El aviso `[ria]` de uso de IA solo cita nombres de dependencia válidos (gramática npm, longitud
  acotada): un nombre manipulado en `package.json` ya no entra en el texto que lee el agente (#234).

## 1.1.19 — 2026-10-28

### Añadido
- `validate` detecta solo que el proyecto usa IA (SDK de IA en `package.json`, `requirements.txt` o
  `pyproject.toml`, también en `apps/*` y `packages/*`, o binding de Workers AI) y, si `ESTADO.md`
  no declara `ia:`, avisa y sugiere `/faro:cumplimiento-ia` (#232).
- Skill `/faro:cumplimiento-ia`: analiza el proyecto, propone el nivel del RIA citando la evidencia y,
  con una sola confirmación, aplica la declaración `ia:`, las filas `RIA:art.N` del RAID y los
  documentos de ISO/IEC 42001 en `gestion/compliance/`.
- `auditor-faro` señala niveles declarados por debajo de lo que describe el funcional.

## 1.1.18 — 2026-10-28

### Añadido
- `validate` avisa (`[ria]`) de las obligaciones del Reglamento europeo de IA y de ISO/IEC 42001 que
  faltan en el RAID, solo si `ESTADO.md` declara `ia: { riesgo, rol, iso42001 }` (#227). Alto riesgo:
  arts. 9–15; transparencia: art. 50; `prohibido` (art. 5) es error. Una fila cubre una obligación con
  la etiqueta `RIA:art.N`. ISO/IEC 42001: evaluación de impacto y declaración de aplicabilidad en
  `gestion/compliance/`. Solo lee texto; `enums.ria.modo: "gate"` lo endurece. El agente
  `gestor-riesgos` gana el modo «RIA e ISO/IEC 42001». Calendario del Reglamento (UE) 2026/1744.

## 1.1.17 — 2026-10-28

- **`consolidar` integra solo lo pedido y valida solo lo que toca** (#226). Antes metía en develop todas las ramas de trabajo locales sin integrar y lanzaba siempre `validate --todas`, que pasa los tests de todas las apps. Con 17 ramas locales y un solo PR pedido, integraba trabajo que nadie había pedido y saturaba la máquina. Ahora:
  - `consolidar 65` integra la rama del PR #65; también vale el número del issue o el nombre de la rama.
  - Sin argumentos, entran solo las ramas con un PR abierto a develop. Las demás se nombran en el aviso y no se integran.
  - Si no se pueden consultar los PRs, no integra nada.
  - El gate valida solo las apps que tocan las ramas elegidas. En un repo sin apps, solo sus gates.
  - `--todas` pide la batería completa y `--todas-las-ramas` recupera el comportamiento anterior.
  - `publicar` sigue validando con `--todas`.

## 1.1.16 — 2026-10-27

- **Consultar `.faro.json` ya no pide confirmación por error** (#224). Antes, el detector de escrituras en `node -e` y `python -c` confundía palabras como `platform`, `filesystem`, `confirm` o la palabra clave `function` con órdenes que escriben. Ahora esos verbos solo cuentan como palabra completa, y `Function` solo cuenta como `new Function(`. Las órdenes del propio `harness.js` del plugin tampoco preguntan, porque solo leen el alcance. Sigue pidiendo confirmación cualquier escritura real: `writeFileSync`, `rmSync`, `open(...,'w')`, `child_process` o un script que no es el del plugin.

## 1.1.15 — 2026-10-17

FARO deja de hablar con ClickUp. Un planificador externo organiza el trabajo y deja en la forja lo justo; FARO lo lee de ahí y lo muestra.

- **`harness.js planificacion [--json]`** (#218): enseña el proyecto del planificador, sus épicas y el avance de cada milestone. Lo lee de la forja con el token del harness, sin API, token ni login del planificador. En GitHub, el proyecto sale de la propiedad del repo `<prefijo>_id`; en GitLab, del topic `<prefijo>-PRJ-x`. La épica de cada milestone sale de la línea `<prefijo>:epica=EPI-n · título` de su descripción. FARO nunca escribe estos datos: el contrato vive en el repo del planificador.
- **La épica, a la vista** (#218): el arranque de sesión resume la relación en una línea, desde la caché del refresco en segundo plano. `asignar-tarea` (GitHub y GitLab), `mover-tarea` y el cierre de tareas de `consolidar` dicen a qué épica pertenece el milestone. No añaden ninguna llamada: la forja ya devuelve el milestone dentro del issue.
- **ClickUp sale del plugin** (#218): se retiran el subcomando `clickup`, la skill `/faro:clickup`, el agente `gestor-clickup`, `lib/clickup.js`, `lib/epica.js` y `lib/pm.js`. También se retiran el push al gestor y la coherencia PM de `consolidar`. Si un `ESTADO.md` conserva `clickup_*` o `pm_*`, sigue funcionando: la sesión y `validate` dan un único aviso para que se quiten.

## 1.1.14 — 2026-10-17

Una app nueva de un monorepo puede salir de una plantilla de stack de la organización con un solo comando.

- **`app nueva`** (#216): `harness.js app nueva <id> --plantilla <REPO> --rol "<frase>"` crea `apps/<id>` desde un repo plantilla de la misma organización, sin su historial. La adapta al workspace: quita su `pnpm-workspace.yaml`, su lock y su `gestion/`, lleva `allowBuilds`, `packageManager` y `.node-version` a la raíz y da a cada Worker el nombre `<repo>-<id>-dev|prod`. La registra en `.faro.json` con su `plantilla`, le crea su `CLAUDE.md` y la etiqueta `app:<id>`. Sin `--confirmo` solo muestra el plan, y nunca commitea.
- **`monorepo init --inicial`** (#216): en un repo recién creado, con un único commit, se aplica aunque se esté en `develop` y sin rama anclada. Con más historia, el flag no levanta ningún bloqueo. `app nueva` acepta el mismo flag.
- **`/faro:code`** (#216): en un monorepo usa `app nueva` si hay una plantilla que encaje y, si no, registra la app con `monorepo init --app`. Ya no edita `.faro.json` a mano.

## 1.1.13 — 2026-10-16

El flag que ancla un issue a su hito se llama `--hito`, porque un hito no siempre es una fase.

- **`--hito`** (#217): `asignar-tarea` y `mover-tarea` anclan con `--hito <N|backlog|título>`: el número de una fase de ESTADO.md, el Backlog, la versión en el motor (`--hito 1.2`) o el título de cualquier hito que ya exista, como un sprint. Un valor que no es nada de eso se rechaza sin crear ni mover el issue.
- **Iguales en las dos forjas** (#217): el `--hito` de GitLab acepta ahora también el número de fase y `backlog`, como en GitHub.
- **`--fase` sigue funcionando** como alias, con un aviso que pide usar `--hito`. `--origen-fase` no cambia. Mensajes, textos de uso, skills y agentes ya hablan de `--hito`.

## 1.1.12 — 2026-10-16

Los issues pueden llevar los campos de issue de la organización de GitHub: Target date, Start date, Priority, Effort o cualquier otro que defina.

- **Campos al crear** (#215): `asignar-tarea` acepta `--fecha-objetivo`, `--inicio`, `--prioridad` y `--esfuerzo`, que se buscan entre los campos de la organización, y `--campo "Nombre=valor"` para cualquier otro. Los valores se validan antes de crear nada: si una fecha no es válida o una opción no existe, el issue no se crea y el mensaje dice qué hay disponible.
- **Fecha heredada del hito** (#215): sin `--fecha-objetivo`, el issue toma la fecha del hito al que se ancla, sea fase, versión o cualquier otro. Al `mover-tarea`, la fecha heredada pasa a la del hito nuevo, o se quita si el nuevo no tiene. Una fecha puesta a mano no se toca.
- **`campos-tarea`** (#215): sin número lista los campos de la organización y a cuál apunta cada atajo; con número muestra los valores del issue; con `--campo` los fija y con `--quitar` los borra.
- Solo GitHub. FARO no crea las definiciones de los campos: se crean en la configuración de la organización.

## 1.1.11 — 2026-10-16

Todo issue queda clasificado en GitHub como Bug, Feature o Task, sin excepciones.

- **Tipo de GitHub obligatorio** (#213): `asignar-tarea` lo fija para cualquier `--tipo` (también `reporte`, `duplicado` y `descartado`, que van como Task) y también con `--repo` a otro repo de la organización. Antes esos casos se creaban sin tipo.
- **Se reconcilia al mover** (#213): `mover-tarea` corrige el tipo en cada movimiento si no cuadra con la etiqueta, no solo al salir de la bandeja o del Backlog.
- **Auditoría y reparación** (#213): `reparar-tarea` sin número lista también los issues abiertos sin tipo (o con uno que no cuadra), y `reparar-tarea <N> --confirmo` se lo pone, aunque el formato ya esté completo.

## 1.1.10 — 2026-10-15

Un issue de un monorepo puede afectar a varias apps.

- **Varias apps por issue** (#211): `asignar-tarea … --app api,web` (o `--app` repetido) pone una etiqueta `app:<id>` por cada app, y así el issue sale al filtrar por cualquiera de ellas. Se valida cada app antes de crear nada: si una no existe, el issue no se crea y el mensaje dice cuál falla. Vale en GitHub y en GitLab.

## 1.1.9 — 2026-10-15

Los issues que crea el harness llevan su tipo de GitHub, no solo la etiqueta.

- **Tipo de GitHub al crear** (#196): `asignar-tarea` fija el campo Type del issue según el `--tipo`: `bug` → Bug; `requerimiento` y `mejora` → Feature; el resto → Task. Un `reporte` no lleva tipo hasta que se tría. Antes había que fijarlo a mano con un PATCH.
- **Tipo de GitHub al triar** (#196): `mover-tarea`, al sacar un issue de la bandeja de entrada o del Backlog, le fija el tipo según su etiqueta.
- Si la organización no tiene tipos de issue (o el repo es de un usuario), el issue se crea igual con su etiqueta y el harness lo avisa. En GitLab y con `--repo` no cambia nada.
## 1.1.8 — 2026-10-15

Un gate de tests cortado por tiempo ya no se confunde con un fallo.

- **Tiempo agotado** (#208): un gate que se corta por tiempo sale como `TIEMPO AGOTADO (N s): se corto por tiempo, no es un fallo de los tests — sube el presupuesto con: git config faro.timeout-app <segundos>`, en `validate`, `gates`, `consolidar` y `publicar`. Antes, en un repo de una sola app salía como `FALLA` con la salida parcial (todo en verde) y el agente relanzaba la suite completa buscando un fallo que no existía.
- **`faro.timeout-app` también en repos de una sola app** (#208): antes solo se leía en un monorepo y el límite quedaba fijo en 180 s. Ahora vale igual para los dos, con el mismo valor por defecto (300 s).
## 1.1.7 — 2026-10-15

Cierra dos huecos de la 1.1.6 por los que awk o sed podían escribir .faro.json sin confirmar.

- **awk** (#206): ya no cuenta como lectura si su programa redirige (`>`), usa tuberías (`|`), `system`, `getline`, `ARGV` o `ENVIRON`, o si un `-v` nombra `.faro.json`. `awk '{print > ARGV[1]}' .faro.json` lo reescribía sin preguntar.
- **sed** (#206): tampoco cuenta como lectura si el programa usa los comandos `e`/`w`/`W` o los flags `/e`, `/w` de `s`, que ejecutan órdenes o escriben ficheros.
- **Copy-Item / copy** (#206): con parámetros con nombre (`-Path`, `-Destination`) o modificadores de cmd (`/y`), el destino no se adivina y se confirma.
- Siguen sin preguntar `sed -E 's#.*github.com[:/]##'`, `sed -n 1,20p .faro.json`, `awk '{print}' .faro.json`, `awk -F:` y `cp .faro.json otro`.

## 1.1.6 — 2026-10-15

Leer .faro.json con sed/awk/cp, o una orden con comodines, ya no pide confirmación.

- **Las expresiones con comodines ya no se toman por `.faro.json`** (#204): `sed -E 's#.*github.com[:/]##'` disparaba «Cambio en .faro.json» porque `.*` y `[:/]` se leían como un patrón de fichero. El programa de sed/awk solo cuenta si nombra `.faro.json` de forma literal.
- **Más lecturas reconocidas** (#204): `sed`/`awk` sin `-i` ni programa en fichero, y `cp .faro.json otro` (`.faro.json` solo como origen), pasan sin preguntar.
- **Lo que no se reconoce como lectura sigue confirmándose**: un script en fichero (`node x.js .faro.json`), `sed -i`, `awk -f`, un programa que escribe en `.faro.json` o `cp` hacia él. El aviso dice el motivo concreto.

## 1.1.5 — 2026-10-15

Consultar .faro.json ya no pide confirmación.

- **Un `node -e`, `python -c` u otro intérprete que solo consulta `.faro.json` pasa sin preguntar** (#202). Antes, cualquier orden que mencionara `.faro.json` y no fuera una herramienta de lectura conocida pedía confirmación, así que cada consulta con `node` paraba al usuario. Ahora, con código en línea (`-e`, `-c`, `-p`, `--eval`; `-r` en php), se mira ese código y solo se confirma si lleva una escritura, un borrado o una ejecución visibles (`writeFileSync`, `open(…, 'w')`, `os.remove`, `cpSync`, `file_put_contents`, `child_process`…); `stdout.write` no cuenta. Un script en fichero (`node x.js .faro.json`) y la edición en el sitio (`perl -pi`) se siguen confirmando, porque no se puede ver qué hacen. Es una red de seguridad, no una frontera: una escritura disimulada en el código en línea puede pasar. Las redirecciones, `tee`, `cp`, `mv`, `sed -i` y `git checkout` sobre `.faro.json` siguen confirmándose.
- **La confirmación por `.faro.json` dice su motivo real** (#202). Usaba el texto genérico «La orden podría escribir fuera del repo de esta sesión… abre allí un issue con asignar-tarea --repo», que no aplica: no hay otro repo, sino la lista `alcance.repos_permitidos`, que el agente no amplía por su cuenta. Ahora lo explica así, sin paréntesis anidados; el resto de confirmaciones conserva su texto.

## 1.1.4 — 2026-10-14

La forja por API con el token del harness: subir y publicar sin depender de SSH ni de la web.

- **Toda subida pasa por `lib/subir.js` y, si la credencial de git falla, reintenta con el token del harness** (#194). Antes cada comando hacía su `git push` y, si fallaba (sin SSH, sin credential manager, sin red al remoto), mandaba al usuario a «subir a mano». Ahora `rama`, `pr crear`, `consolidar`, `publicar` y los commits de estado empujan primero por la vía normal (sin prompts) y, si falla, por HTTPS con el token de `~/.faro.json`. El token va solo en el entorno de ese proceso: ni en `.git/config`, ni en la línea de comandos, ni reescribiendo `origin`. El timeout de 15 s al publicar una rama nueva (que daba por fallido un push que sí subía) pasa a 120 s.
- **Rama protegida: `publicar` y `consolidar` integran por petición vía API** (#194). Si la forja rechaza el push a `main`, `publicar` integra `develop → main` por petición con el token (la abre o reutiliza la que haya), **verifica en la forja** que el commit fusionado es el que la forja dice y contiene `develop`, y solo entonces alinea `main` local y crea los tags sobre él. Si `develop` también está protegida (o lo está en `consolidar`), lo local —merges, commit de cierre, commit previo— sube a una rama temporal `faro/integrar-…` que entra por petición y se borra al terminar: no se pierde ningún commit. Si `main` no llega a la forja, se deshace siempre el merge local, así que reintentar `/faro:publicar` funciona. La fusión se reintenta unos segundos mientras la forja calcula si es fusionable (GitLab lo hace de forma asíncrona); si no fusiona (checks pendientes, conflicto), lo dice con su motivo y deja la petición abierta. Nuevo `integrarPorPeticion` en los adaptadores de GitHub y GitLab (sin borrar la rama origen). La cabecera con el token se acota al host de la forja, y un push rechazado por ir por detrás pide traer primero en vez de reintentar con el token.
- **Un heredoc con el delimitador entre comillas ya no pide confirmación** (#197). Al escribir un texto con `cat > f <<'EOF'`, el control de alcance analizaba como órdenes las comillas invertidas y los `$(…)` del texto: un cron como `0 3 * * *` se leía como la orden `0` con comodines que «podían ser .faro.json» y saltaba «La orden podría escribir fuera del repo de esta sesión». Con `<<'EOF'`, `<<"EOF"` o `<<\EOF` el shell no ejecuta nada del cuerpo y ya no se analiza; sin comillas, o si el heredoc alimenta a un shell, se sigue analizando igual.
- **Los tests enfocados ya no acaban en la suite completa** (#198). Las instrucciones del motor (arranque, `/faro:tests`, aviso de presupuesto y el bloque del `CLAUDE.md`) ya no invitan a pasar la suite completa «una vez al final»: la corren CI y `/faro:publicar`, y el agente solo si se la piden expresamente. Un `npm run test:afectados` en verde anota lo validado (en `.git/faro-tests-verdes.json`, fuera del árbol) y la siguiente vez solo entra lo que ha cambiado desde entonces: en una rama apilada sobre otra sin integrar ya no se repite lo de debajo. Y un fichero de código que solo cambia en textos (cadenas, comentarios) cuenta como cambio interior de su dominio, sin arrastrar a los dependientes de su contrato: cambiar un aviso de `harness.js` pasa de 9 dominios a 2. Nuevo `lib/validado.js`; `tests-dominios --afectados` y `test:afectados` lo usan (con `--base` explícito no se descuenta lo validado).

## 1.1.3 — 2026-10-12

Reporte de negocio en Word y tests del motor independientes de la rama.

- **gate-planes ya no falla cuando la suite corre en develop o main** (#188): el test probaba el hook sobre el checkout real y, en una rama protegida, el guardarraíl de ramas respondía antes que el gate de planes. Ahora usa un clon temporal en una rama de trabajo. Sin cambio funcional para el usuario.

- **Reporte de negocio en Word (.docx) de marca corporativa, adjunto a la épica** (#121). Nuevo `harness.js reporte-negocio` (`--json`): genera `gestion/reporting/informes/AAAA-MM-DD-reporte-negocio.docx` (misma fecha = se actualiza) desde el mismo modelo que el one-pager, enfocado a negocio: resumen ejecutivo con semáforo, descripción, entregables con su estado y el valor que aportan, plazo, KPIs, riesgos y próximos pasos; nada de repos, issues ni ramas. El Word se imprime sin dependencias (`lib/docx.js`: OOXML + zlib), con colores, logo y pie confidencial de marca. En modo épica, **`clickup push` lo adjunta a la épica solo si el estado de negocio cambió** (huella del contenido, sin la fecha) y la sección «📎 Reportes» del resumen de la épica dice cuál es el vigente y de qué fecha; si no cambió, no se sube otra copia ni se escribe un .docx nuevo.

## 1.1.2 — 2026-10-12

Tests enfocados: cierre del #178.

- **La CI reparte la suite completa en 4 trozos que corren en paralelo** (#178). `node test/run.js --trozo=i/n` ejecuta solo la parte i de n, repartida por tamaño de fichero (determinista: la unión de los trozos es la suite entera, sin repetidos). El workflow `ci.yml` usa una matriz `trozo: [1,2,3,4]` (con `node` directo, para que el `--` no se pierda en Windows); un trozo vacío o mal escrito sale con 2: mismo gasto de minutos, un cuarto de espera.
- **En un monorepo, el comando de tests pregunta cuando no puede deducir qué probar** (#178). La app se sigue deduciendo de los ficheros cambiados; si el cambio toca **varias apps** o hay **código sin dominio**, `tests-dominios --afectados` (y `npm run test:afectados` en el motor) lo marca con «PREGUNTA AL USUARIO» y las opciones (las apps, o los dominios de esa app), y el agente lo pregunta en vez de elegir. Nuevo `--app <ruta>|todas` para responder: acota los dominios a esa app (un cambio transversal de la raíz o de `packages/` la sigue alcanzando) y, mientras falte elegir, `npm run test:afectados` no ejecuta nada. Una app inexistente sale con código 2 y la lista de apps. La regla que `/faro:tests` escribe en el CLAUDE.md de los repos lo incluye.
- **Medición**: cambiar un único módulo ejecuta el 1-3 % de los ficheros de test (clickup: 2 de 150 en 2 s; triaje: 3 en 3 s), frente a los 13-15 min de la suite completa.

## 1.1.1 — 2026-10-11

Mantenimiento de la 1.1: gobernador de recursos para los gates y arreglos del CI de Linux.

- **Arreglos del CI de Linux de la 1.1.0** (#183): límite de 200 caracteres en la descripción de la skill `tests`, módulos y tests nuevos asignados a sus dominios, lectura de la variante Windows (`\`) en `alcance.js` desde POSIX (gana el peor veredicto), procesos zombi de Linux como no vivos y fixtures de procesos que se autoexpiran. Sin cambio funcional para el usuario.

- **Gobernador de recursos: los gates pesados no se lanzan sin límite ni coordinación entre sesiones** (#182).
  Varias sesiones lanzaban a la vez `wrangler deploy --dry-run`, `tsc`, `vitest` (algunos colgados en watch) y builds hasta
  dejar la máquina sin memoria. Ahora todo gate pesado de `gates`/`validate --gates` pasa por un único ejecutor con
  un **semáforo global por usuario** (máx. 2 a la vez entre TODAS las sesiones y repos; `FARO_PESADOS` o
  `.faro.json > recursos.max_pesados`), cola con espera acotada y un aviso de una línea, timeout por trabajo, memoria libre
  mínima antes de lanzar, `NODE_OPTIONS=--max-old-space-size` y cierre del árbol de procesos al acabar, expirar o
  recibir una señal. Si no hay turno o memoria, el gate sale **no evaluado** (nunca verde). **vitest y jest** corren siempre
  en modo run con 2 workers (`--pool=forks --maxWorkers=2`) y **tsc** de forma incremental, solo si el script tiene una
  forma reconocida; un comando desconocido no se toca. **Caché de gates**: si el árbol git de la app y de sus
  dependencias de workspace no cambió, el verde se reutiliza («gate X reutilizado»); `--sin-cache` lo ignora y un rojo
  nunca se guarda. **`wrangler deploy --dry-run`** ya no corre en cada validación: solo al publicar, con `--simulacro` o
  si el cambio toca `wrangler.*`, el entrypoint o las dependencias, y nunca a la vez que otro pesado. Nuevo `harness.js
  recursos` (pesados en curso, memoria libre, caché; `--limpiar --confirmo [--cache]`) y un aviso de saturación de una línea
  antes de lanzar un gate pesado (silencio si todo va bien). El comando de `git config faro.gates` sigue como hasta ahora.

## 1.1.0 — 2026-10-11

FARO 1.1: el estado de las tareas pasa a registros JSON con ids locales (L-n) y sincronización con la forja; alcance restringido al repo de la sesión; referencias navegables (ir/refs); CI con acciones vigentes; monorepo init/importar y /faro:monorepo; tests por dominio con gate de integridad; higiene de procesos y servidores; tests sin firma.

**Cambio de contrato:** `harness.js validate` ya no ejecuta los gates (typecheck, lint, test, build) salvo con `--gates`, `--todas` o `--app <id>`; `consolidar` y `publicar` siguen corriendo la batería completa.

- **Tests por dominio: mientras se trabaja corre solo lo afectado, la suite completa queda para CI y al publicar** (#178).
  Un *dominio* es una funcionalidad (no solo una carpeta) con su interior, su contrato público y sus dependientes,
  declarada en `.faro.json > tests.dominios`. Si cambias el interior corre ese dominio; si cambias su contrato, también
  los hermanos que lo usan (declarados y deducidos del grafo de imports); si es transversal, los que lo alcanzan.
  El código que ningún dominio cubre y los tests que necesitan otro dominio se avisan en `validate` en vez de
  esconderse ejecutándolo todo. El hook TDD pide los tests por dominio (no `npm test`), registra nº de tests y tiempo
  de cada ejecución, avisa si encadenas baterías completas y, al terminar, contrasta el diff de los tests (aserciones
  eliminadas, `.skip`/`.only`, umbrales o `expect` relajados) con lo que el agente afirma: «no rebajé aserciones»
  con una aserción menos devuelve el control. Los comandos de test declarados solo se aceptan en una lista cerrada
  (`node --test`, `vitest`, `jest`, `npm|pnpm|yarn test`) y el harness no los ejecuta nunca. Nuevo
  `harness.js tests-dominios` (`--proponer` solo lectura, `--aplicar --confirmo`, `--afectados`, `--integridad`), la skill
  `/faro:tests` para migrar un repo existente conversando (nunca en silencio) y un aviso de una línea tras actualizar el
  plugin. En el motor: `npm run test:afectados` y `npm run test:dominio -- <nombre>` con la etiqueta `lento`.

- **Higiene de procesos y recursos: la suite y el motor no dejan huérfanos ni saturan la máquina, y el agente no levanta servidores de desarrollo** (#177). `npm test` ahora ejecuta cada fichero con timeout (por fichero y por batería), cierra el árbol de procesos hijo al terminar, expirar o recibir una señal, avisa y espera si queda poca memoria libre y no deja lanzar dos baterías completas a la vez (la segunda avisa y no arranca; un candado obsoleto se recupera). Los procesos que lanza el motor heredan `FARO_PROC`; `harness.js procesos` los lista (PID, antigüedad, CPU, huérfano) y `procesos --limpiar --confirmo` cierra solo los propios huérfanos o pasados de umbral, nunca uno sin marca. `pre-bash` pide confirmación (`ask`) ante `vite`, `pnpm|npm|yarn run dev|start|serve`, `wrangler dev`, `next dev`, `serve`, `nodemon`… con «dame el comando y el puerto; lo levantas tú en una terminal aparte» (red de seguridad sobre el texto, no frontera; tests, builds y lint no se tocan). SessionStart y Stop avisan en una frase si hay procesos propios huérfanos o una batería en curso, y callan si todo está bien. Los tests sensibles al tiempo usan umbrales escalados por la carga y un único reintento marcado.
- **El CI generado usa las acciones vigentes y el monorepo recibe su labeler** (#155). `harness.js ci` generaba
  `actions/checkout@v4` y `setup-node@v4`; ahora `checkout@v7` y `setup-node@v7` (verificadas en sus repos
  oficiales el 2026-10-11; `pnpm/action-setup@v6` ya era la vigente). Si el fichero de CI ya existe, el aviso de
  «mergea a mano» lista también el paso que habilita pnpm (o corepack en GitLab) y el setup de Node, no solo
  instalación y gates. En un monorepo de GitHub, `ci` escribe además `.github/workflows/labeler.yml`
  (`pull_request_target` sin checkout del PR y con permisos mínimos; no pisa uno existente), avisa de que
  `codeowners` genera CODEOWNERS y `labeler.yml`, y con `--con-codeowners` los genera en el mismo paso.
- **El histórico de tareas se migra solo y ESTADO.md pasa a ser un índice** (#149, parte 2).
  `harness.js tarea migrar` rellena un `gestion/tareas/<N>.json` por cada issue de todo el histórico
  (también de las fases cerradas) a partir de las líneas de ESTADO.md, la forja (título, estado, fase,
  apps, fechas, responsable, objetivo, subtareas, PR que lo cerraron), los cambios spec-driven y los
  `REQ-NN` citados. No inventa: lo que no se puede deducir queda marcado para revisar y `validate` lo
  enseña como pendiente. Sin `--confirmo` solo enseña el plan; se puede repetir sin pisar lo editado a
  mano. Sin token trabaja offline con ESTADO.md y los cambios. Nuevo `harness.js estado-indice`
  (`--comprobar` / `--escribir`): regenera solo las líneas `- [ ] #N · título — @quién` de cada fase
  desde los registros y deja el resto de ESTADO.md intacto, byte a byte; `validate` avisa si no
  cuadra. El registro admite `responsable` (opcional). La skill `migrar-tareas` usa estos comandos en
  lugar de reescribir las fases a mano. Depende de la parte 1; la sincronización con el issue llega
  en la parte 3.

- **Las tareas históricas sin issue ya tienen id y los registros se sincronizan con su issue** (#149, parte 3).
  Las líneas de fase sin `#N` (en un-repo-de-trabajo son 28) reciben al migrar un id local `L-<n>`
  (`gestion/tareas/L-<n>.json`): se numeran en el orden de ESTADO.md y el id no cambia aunque marques la
  casilla, añadas líneas o repitas la migración; `estado-indice` las rotula (`- [x] L-3 · título`) sin
  tocar el resto del fichero y `tarea`, `ir` y `refs` las resuelven. Nuevo `harness.js tarea sync <N>`
  (o `--todas`): refresca desde la forja solo lo derivable (abierta/cerrada, PR enlazados, subtareas
  hechas/total, fechas de creación y cierre) y no pisa lo que escribe la persona; `--comprobar` solo
  informa de la deriva. Sin forja no escribe nada.

- **Un estándar de referencias y dos comandos para navegar por ellas** (#157). Citar un registro
  tiene ya una forma única, declarada una sola vez en `faro-schema.json`: `fase:2`, `#149`, `L-3`,
  `cambio:slug`, `REQ-136`, `R-07`, un `doc_id` o `app:api`. `harness.js ir REQ-136` dice qué es, dónde
  vive, en qué estado está y con qué se relaciona en menos de 20 líneas, leyendo solo su fichero
  (`--campo fechas.objetivo` devuelve una línea; `--json` es para integraciones); `harness.js refs
  REQ-136` lista quién la cita. Ambos responden sin cargar el motor (≈ lo que tarda arrancar node).
  `validate` avisa, en una línea y sin bloquear, de las tareas que citan requisitos que no existen,
  cambios sin carpeta o apps no declaradas, y el arranque de la sesión añade una línea que lo recuerda
  en los repos que tienen tareas JSON o documentos controlados. La referencia que llega por argumento
  se valida con un patrón estricto antes de tocar ninguna ruta.
- **El estado de cada tarea pasa a ser un registro corto y validado** (#149, parte 1). Cada issue
  puede tener `gestion/tareas/<id>.json` con un esquema cerrado (`tarea.schema.json`): objetivo,
  resultado, fechas, apps, cambios y recuento de subtareas. El motor rechaza lo incoherente, por
  ejemplo una tarea «hecha» sin resultado o con cambios sin archivar. `harness.js tarea 7 --campo
  fechas.objetivo` devuelve una sola línea en vez de cargar documentos enteros; `tarea set` cambia un
  campo con validación; `harness.js resumen-json` genera `gestion/resumen.json`, el contrato público de
  lectura para integraciones. `validate` avisa de los registros incoherentes y de un resumen
  desactualizado; un repo sin `gestion/tareas/` no nota nada. La migración del histórico y la
  sincronización con el issue llegan en las partes 2 y 3.
- **El agente solo modifica el repo de la sesión; en repos ajenos se abre un issue** (#150). `pre-doc`
  (ahora también `MultiEdit`) y `pre-bash` bloquean escribir, editar o commitear en un repo que no es
  el de la sesión ni un worktree suyo (`git -C`, `--git-dir`, `cd <otro> && git commit`, redirecciones
  simples `>`/`>>`, también dentro de `bash -c` o `$(…)`) y proponen la salida: `asignar-tarea --repo
  org/repo` abre el issue en ese repo (misma organización; otra se rechaza). Leer repos ajenos sigue
  permitido (hacia otro repo solo `status`, `log`, `diff`, `show`, `rev-parse`, `branch`, `ls-files`,
  `remote` y `describe` sin opciones que escriban o ejecuten; lo demás pide confirmación) y las carpetas fuera de cualquier repo (temporales, `~/.claude`) no se acotan. El
  transporte `harness.js gh` solo opera en la organización del remoto y, fuera del repo de la sesión,
  solo deja leer, crear issues y comentar. Un hermano se autoriza en `.faro.json` con
  `"alcance": { "repos_permitidos": ["org/repo"] }`. Las guardas fallan cerrado: deniegan solo cuando
  está probado que el destino es otro repo y piden confirmación (`ask`) cuando no se puede resolver
  (variables, sustituciones, `C:foo`, UNC, `cd -`…); resuelven enlaces, junctions y nombres 8.3. Son una
  red contra accidentes e inyecciones de instrucciones, no una frontera de seguridad. Cubren: `pre-doc`,
  git hacia otro repo, `gh` por organización y `asignar-tarea --repo`. No cubren: intérpretes (`node -e`,
  `python -c`), herramientas sueltas (`rm`, `cp`, `find`, `tar`, `curl`, `sed -i`…), aliases de git ni
  enlaces creados durante la orden. Cualquier error interno cae en `ask`. La frontera real son los
  permisos de Claude Code y el alcance del token.
- **Los tests ya no dependen del agente de firma ni de tu identidad git** (#169). Los repos temporales de la
  suite heredaban `commit.gpgsign=true` y la firma por 1Password: con el agente bloqueado la batería fallaba en
  bloque y con el agente activo saltaban avisos de aprobación por commits de prueba. Ahora `test/run.js` fija
  una config git propia (sin firma, identidad fija) para todos los procesos hijos; tu configuración real no se toca.
- **`validate` ya no tarda minutos en un monorepo** (#167). Lo lento no era la validación sino los gates
  (typecheck, lint, test, build y simulacro de despliegue de cada app afectada, ~10 s cada uno sin
  dependencias instaladas): en un monorepo sintético de 8 apps, `validate` pasa de 50 s a 3 s. Ahora `validate`
  a secas no los ejecuta y lo avisa; se piden con `--gates` (apps afectadas), `--todas` o `--app <id>`.
  `consolidar` y `publicar` siguen corriendo la batería completa.
- **`harness.js monorepo init` y la skill `/faro:monorepo`: de repo simple a monorepo con un comando** (#161).
  Antes era una mudanza manual. Ahora el usuario conversa con `/faro:monorepo` (qué es cada carpeta,
  su rol, su equipo; sin jerga) y sus respuestas quedan en `gestion/monorepo-plan.json`, un plan
  validado, reproducible y retomable. `monorepo init` lo lee (o detecta las apps del workspace) y
  enseña qué haría: es un ensayo por defecto y solo con `--confirmo` mueve el código a `apps/<app>/`
  con `git mv` (el historial se conserva), crea el workspace, el `package.json` raíz con scripts
  `pnpm -r`, el `CLAUDE.md` de cada app y el bloque `monorepo` de `.faro.json`, y deja las etiquetas
  `app:<id>` y, si se pide, CODEOWNERS. También deja un repo vacío «preparado» con una app. Se niega
  con el árbol sucio, en `main`/`develop` o en una rama sin issue, y ante lo ambiguo (varias carpetas
  candidatas, app sin rol); en un monorepo ya declarado no hace nada. Con `--consolidar`, una app que
  ya trae su propia gestión pasa a la de la raíz: riesgos y requisitos renumerados (+100, +200…) con
  todas las referencias reescritas, documentos movidos con su `doc_id`, ESTADO original archivado en
  `gestion/historico/` y `.gitignore`/`.node-version`/`allowBuilds` unificados; lo que pide criterio
  (fusión de faseos, documentos duplicados) sale como pregunta, nunca se resuelve en silencio. El
  aviso de «workspace sin declarar» ya apunta a `/faro:monorepo`.
- **`harness.js monorepo importar`: unir repos existentes como apps, con su historial** (#162).
  Valida el origen (solo `org/repo`, URL de GitHub o ruta local; la misma organización que la sesión;
  nunca opciones de git), lo trae a una carpeta temporal en solo lectura —el origen no se toca y no se
  ejecuta nada suyo— y lo fusiona bajo `apps/<app>/` reescribiendo la historia de la copia, de modo
  que `git log --follow` llega a los commits originales. Consolida su gestión en la raíz con la misma
  mecánica de `--consolidar`, califica sus issues como `org/repo#N` y deja cada origen en el plan
  (fuente, rama, modo, commit). Ensayo por defecto, idempotente (`--actualizar` trae lo nuevo) y con
  modo `--modo copia` para importar sin historial. Si el commit falla por la firma, se detiene y
  deja el índice para que lo completes: nunca la salta. Los enlaces simbólicos no se siguen nunca: las
  lecturas exigen un fichero regular dentro de la raíz, un origen que contiene symlinks se rechaza
  antes de tocar nada y ninguna operación puede salir de la raíz por un enlace de carpeta. `rol` y
  `funcional` son una sola línea y `equipo` un team/@usuario/@org/team (nada de saltos de línea hacia
  CODEOWNERS o CLAUDE.md). Desde el plan solo se admiten orígenes `org/repo` o URL de GitHub; una ruta
  local solo como argumento, nunca UNC, y con remote de la misma organización (el plan guarda
  `org/repo`). Si el plan resultante no vale, la importación se deshace con `git merge --abort`, y se
  avisa de secretos (`.env`, `.dev.vars`) o `.gitattributes` versionados en el origen.

## 1.0.0 — 2026-10-11

FARO v1: contexto mínimo en los hooks, modo monorepo, ciclo por app, TDD verificable y catálogo ligero.

- **`.dev.vars` ya es un fichero sensible** (#148). Es donde los Workers de Cloudflare guardan sus
  secretos locales y las guardas no lo conocían: el agente podía leerlo o commitearlo. Ahora `.dev.vars` y sus
  variantes por entorno (`.dev.vars.staging`) se tratan como credenciales; `.dev.vars.example`, la plantilla
  que se versiona, sigue exenta.
- **El arranque de sesión cabe entero: índice con presupuesto** (#123, #127). Pasaba de 26.000
  caracteres en un repo de trabajo real y la plataforma, por encima de 10.000, solo deja ver 2.000.
  Ahora es un índice (fase, rama y su seguridad, rol, plataforma, bloqueos, ciclos abiertos una sola
  vez, protocolo spec condensado y avisos agregados en una línea) montado por prioridad con tope de
  8.000: si no cabe, se recortan avisos y se dice; la seguridad de rama y los bloqueos nunca. El
  detalle completo, bajo demanda con `harness.js estado`. Fuera el catálogo de subagentes (ya lo da
  el prompt de sistema) y las convenciones documentales (viven en `faro:documentacion`).
- **El hook de cada prompt solo dice lo que cambió** (#127). Guarda la huella de cada sección por
  repo y sesión en `CLAUDE_PLUGIN_DATA` (o el temporal del sistema), nunca en el repo; tras compactar
  la olvida y lo vuelve a decir. El aviso de rama sin escritura sale siempre. `pre-doc` no repite un
  aviso idéntico en la misma sesión (los bloqueos sí, siempre) y `pre-bash` despacha las órdenes
  inocuas sin cargar el motor. Medido en un clon de un-repo-de-trabajo: sesión típica (20 prompts, 15
  ediciones) de ~15.800 a ~2.200 tokens; arranque de 26.852 a 7.557 caracteres.
- **En el motor, el hook de cada prompt deja de repetir el bloque fijo de flujo de desarrollo**
  (#122). Eran ~1.040 caracteres idénticos en cada mensaje; ahora se dan al arrancar y vuelven en el
  reancla tras compactar. Además el reancla por fin se dispara: la plataforma entrega el motivo en
  `source` y el harness solo miraba `start_reason`. La spec `presupuesto-hooks` recoge la excepción
  de `UserPromptSubmit` (timeout explícito >= 60 s) que ya aplicaban el código y su test.
- **Un aviso informativo ya no bloquea ni despierta al agente** (#124). "N ramas en el remoto sin
  integrar" salía con código 2 y la plataforma lo mostraba como "Stop hook blocking error". Ahora va
  al humano por `systemMessage` con salida 0; el código 2 queda para lo que el agente debe resolver
  (base movida, rama por detrás, desajustes con la forja, artefactos generados sin commitear).
- **Abrir una sesión ya no escribe en el repo** (#125). El arranque creaba el informe semanal en
  `gestion/reporting/informes/` sin que nadie lo pidiera, y esa modificación sin commitear
  contaminaba después los avisos de git y de Stop. Ahora lo anuncia en una línea y se genera a
  petición con `harness.js informe-semanal` (o `/faro:reportar semanal`).
- **Todas las skills y agentes de faro vuelven a ser visibles para el modelo, con un catálogo más
  ligero** (#128). Ocho skills (auditoria, estado, forja, observabilidad, pendientes, sincronizar,
  sync, triaje) no salían en el listado y dos agentes aparecían como «Agent from faro plugin»: su
  descripción llevaba `: ` sin comillas, el YAML era inválido y el cliente las descartaba sin avisar.
  Ahora todas van entre comillas, empiezan por el caso de uso y caben en 200 caracteres (skills) y
  250 (agentes): el catálogo baja de 12.502 caracteres medidos, sin contar las rotas, a 8.370 con las
  50 visibles. `renombrar` solo la lanza el humano (`disable-model-invocation`). El nuevo
  `test/catalogo-ligero.test.mjs` vigila el YAML, los límites y el presupuesto (≤ 10.000);
  `node test/catalogo-ligero.test.mjs --tabla` imprime el inventario.
- **Modo monorepo: el repo declara sus apps y FARO gobierna desde la raíz sabiendo qué es cada una**
  (#129). Con `"monorepo": { "apps": { "<app>": { "rol", "funcional", "equipo" } }, "tag": "{app}@{version}" }`
  en `.faro.json`, la gestión sigue siendo única en la raíz y el motor conoce cada app. Lo técnico no
  se declara: se deduce del workspace (`pnpm-workspace.yaml` o `workspaces` de `package.json`). De
  cada app saca paquete y versión, worker, front, contrato (`ARCHITECTURE.md`), changelog y tests.
  Nuevo `lib/apps.js`, el módulo único que consultarán gates, release, skills e issues por app
  (`apps`, `appDeRuta`, `appsAfectadas`, `tagDe`). Nuevo `harness.js apps [--json]`. `validate`
  avisa, sin bloquear, de apps sin declarar, apps declaradas que no existen y apps sin `CLAUDE.md`
  propio. El modo de código pasa a `monorepo` y deja de recomendar back y front en repos separados.
  El reconocimiento ve las apps y su stack. El adoptador ya no adopta carpeta a carpeta. Un repo sin
  `monorepo` se comporta igual que antes.
- **Gates por app en un monorepo: se prueba lo que toca el cambio, y todo al publicar** (#130). Cada
  app corre sus scripts (typecheck, lint, test, build) en su carpeta, y las que tienen worker, su
  simulacro de despliegue. Por defecto solo las apps afectadas: el diff contra `develop` más lo que
  esté sin commitear, más las apps que dependen de ellas en el workspace (`workspace:`). Un cambio
  solo de raíz o gestión no corre gates de apps; uno que toca el `package.json`, el lockfile o el
  `pnpm-workspace.yaml` de la raíz, todas. `consolidar` y `publicar` validan con `--todas`; a mano,
  `gates --todas` o `gates --app <id>`. La salida dice qué apps corrieron y por qué. Cada app tiene
  su presupuesto de tiempo (300 s, `git config faro.timeout-app`). `deps` ya no propone instalar en
  la raíz del workspace (`pnpm add` fallaba allí): usa `--filter` por app, `-w` para el tooling común,
  `outdated -r` y `cf-typegen` en cada worker. La guarda de despliegue falla cerrada y sin
  exenciones: toda orden de despliegue, también de pruebas o simulacro (`deploy:dev`,
  `wrangler deploy --dry-run`), pide aprobación; se detecta aunque venga partida en varias líneas o
  dentro de `$(…)`, `eval` o `sh -c`. Los simulacros que lanzan los propios gates no pasan por ella.
  `harness.js ci` genera un único job que instala en la raíz y filtra
  con `pnpm --filter "...[origin/<destino>]"` en cada petición (todas en push a develop/main). Un repo
  simple se comporta igual que antes.
- **Release por app en un monorepo: cada app publica su versión, su CHANGELOG, su tag
  `{app}@{version}` y su Release** (#131). Antes `release.js` solo leía la raíz: en un monorepo pnpm
  la raíz no tiene versión y `publicar` no tageaba nada. Ahora cada app se mide desde SU último tag
  (`git log <tag>..develop -- apps/<x>`), `harness.js release` dice por app cuántos cambios lleva y
  qué versión toca (desde su `[Unreleased]`), y `publicar` cancela si una app cambiada no tiene su
  versión en `apps/<x>/CHANGELOG.md`; tras el merge crea un tag y un Release por app cambiada. Una app
  sin cambios no se toca. Un tag `v0.x` heredado de antes del monorepo se informa como ambiguo, sin
  romper. El gate de «solo gestión» reconoce el CHANGELOG de una app y su bump de versión, pero ya no
  da por gestión un cambio de dependencias en el `package.json` de una app. Las skills `changelog` y
  `publicar` piden elegir la app. Repo simple y motor: igual que antes.
- **Revisores, contrato, enlace con el ADR y `/faro:code` trabajan por app en un monorepo** (#132).
  Todo eso miraba la raíz, y en un monorepo el código vive en `apps/<x>/src`, así que se apagaba sin
  avisar. Ahora `validate` exige la decisión (ADR) a un cambio de código si alguna app tiene `src/`.
  `harness.js contrato <app>` contrasta `apps/<x>/ARCHITECTURE.md` con `apps/<x>/src`, y sin app
  revisa todas las que tienen contrato. `/faro:pr`, `/faro:consolidar`, `/faro:publicar` y
  `/faro:revisar-code` cruzan `harness.js apps --json` con el diff y lanzan `revisor-code-worker` una
  vez por cada app worker afectada. `revisor-code` busca el contrato en cada app: si falta, avisa, y
  solo bloquea si la app expone API. `/faro:code` crea la app nueva en `apps/<nueva>` con pnpm, con
  su `CLAUDE.md`, y la registra en `.faro.json`. La disciplina de tests acepta, en cada app,
  `tests/`, `test/` o tests junto al código, y nombra las apps que no tienen. En un repo simple no
  cambia nada.
- **Issues y tareas para monorepo y agentes: etiqueta `app:`, CODEOWNERS, ficha por issue y formato
  de `tasks.md`** (#134). `asignar-tarea … --app <app>` pone la etiqueta `app:<app>` (la crea si
  falta, con color fijo) tras comprobar que la app existe. En un monorepo sin `--app` avisa y propone
  la app. Nuevo `harness.js codeowners`: genera `.github/CODEOWNERS` por app (`@<org>/<team>` desde
  `equipo`) y `.github/labeler.yml` (actions/labeler v5) en un bloque marcado que respeta lo manual;
  `--comprobar` sirve de paso de CI. Nuevo `harness.js ficha <N>`: issue, app y sus rasgos, cambio
  vinculado y rutas en menos de 2.000 tokens, para pasárselo a un subagente. `/faro:aplicar`
  documenta el formato de `tasks.md`: historias `US-n` con el issue, `[P]` en lo paralelizable, el
  test que debe fallar antes y un checkpoint por historia. La plantilla de bug pasa a Comportamiento
  actual / esperado / Lo que NO debe cambiar / Pasos (`Comportamiento obtenido` sigue valiendo). En
  el motor, el issue cuelga solo del hito de la versión en curso: el abierto más próximo igual o
  posterior a la de `plugin.json`, o `X.Y` si no hay ninguno.
- **TDD verificable: el harness comprueba que el test falló antes del código y que no se debilita
  para pasar** (#133). Configurable en `.faro.json > tdd: { modo: "aviso"|"bloqueo"|"off", codigo,
  tests }`; por defecto `aviso`, código en `src/**`, `apps/*/src/**`, `packages/*/src/**` y
  tests en `test/**`, `tests/**`, `*.test.*`, `*.spec.*`. Cuatro hooks propios en `lib/tdd.js`:
  `tdd-post` registra qué tests quedan en rojo cuando el agente los ejecuta (con el hash de su
  contenido, por repo y sesión, en `CLAUDE_PLUGIN_DATA`); `tdd-pre` avisa una vez por módulo, o
  bloquea en modo `bloqueo`, si se edita código sin un test en rojo de ese módulo, y si se toca un
  test en rojo antes de que pase a verde («no debilites el test»); `tdd-stop` no ejecuta nada:
  si una app tiene código editado sin una ejecución de tests posterior en verde, devuelve el control
  al agente con la orden exacta (`pnpm --filter <paquete> test`, `npm test`…) para que la lance con sus
  permisos (tras 3 veces lo mismo, avisa al humano). Los `tdd-*` se despachan al principio de
  `harness.js`, sin cargar el motor. Nuevo `harness.js tdd-revisar [base]`: aserciones
  eliminadas, `.skip`/`.only`/`xit`, mocks del propio módulo y tests sin aserciones en el diff; lo usa
  `revisor-code`. Sin nada que decir, los hooks callan.
- **El CI generado para repos pnpm instala pnpm en el runner** (#143). Antes, `harness.js ci` dejaba
  un `pnpm install --frozen-lockfile` que fallaba en un runner limpio con «pnpm: command not found».
  Ahora, solo cuando el repo usa pnpm (simple o monorepo): en GitHub, un paso `pnpm/action-setup@v6`
  antes de `actions/setup-node`, que pasa a cachear con `cache: pnpm` (sin `version:` si
  `package.json` declara `packageManager`, porque la acción la lee de ahí); en GitLab,
  `before_script` con corepack y el store de pnpm cacheado por `pnpm-lock.yaml`. El CI de npm y yarn
  y el filtro de apps cambiadas del monorepo no cambian.
- **La salud de código deja de contar ficheros generados** (#126). ATOMICIDAD listaba
  `worker-configuration.d.ts` (15.292 líneas que genera `wrangler types`) y el detector de ciclos
  señalaba `routeTree.gen.ts` (TanStack Router), dos ficheros que nadie del equipo escribe. Ahora
  atomicidad y grafo comparten una sola lista de exclusión (`lib/generados.js`): `node_modules/`,
  `dist/`, `build/`, `.wrangler/` y `.tanstack/` a cualquier profundidad, también en `apps/<x>/` de un
  monorepo; `*.gen.*`; `worker-configuration.d.ts`; los `.d.ts` con cabecera de generado; y lo que git
  ignora. La lista se aplica aunque el repo declare su propio `excluir`. Los umbrales no cambian.
- **Los hooks de escritura funcionan en los git worktrees** (#136). Un agente aislado en
  `.claude/worktrees/<x>` no podía crear el `tasks.md` de su cambio: `pre-doc` buscaba la proposal en
  el checkout principal (el directorio del proceso del hook), no en el worktree donde se editaba.
  Ahora `pre-doc` y `doc-check` resuelven la raíz a partir del fichero editado y, si es otro worktree
  del mismo repositorio, evalúan las reglas contra él. En el checkout principal nada cambia y un repo
  ajeno sigue fuera del gobierno.

## 0.59.3 — 2026-10-06

- **`release` ya no cuenta como pendiente lo que ya está publicado** (#116). Buscaba el último tag desde
  la rama actual, pero los tags de versión se crean en el merge de main, que no es antecesor de develop.
  Justo después de publicar la v0.59.1 decía «15 cambios sin publicar desde v0.55.2». Ahora mide contra
  main: el último tag de main y los commits que hay aquí y no en main. Si no hay nada, «Nada que publicar».

## 0.59.2 — 2026-10-06

- **`consolidar` y `publicar` ya no meten en el repo ficheros sin versionar** (#117). Antes de integrar,
  `consolidar` hacía `git add -A` de todo lo pendiente, incluidos ficheros que nadie había decidido
  versionar. Así entraron en develop, y luego en main, unos exports locales de n8n. Ahora, si hay ficheros
  sin versionar, ambos comandos se paran, los listan y dicen qué hacer (commitearlos en una rama o
  `.gitignore`). Lo ya versionado se sigue recogiendo (`add -u`). `publicar` lo comprueba antes de
  archivar, porque el archivado sí crea ficheros nuevos a propósito.

## 0.59.1 — 2026-10-05

- **`validate` ya no avisa en falso de ADR sustituidas «sin superseded-by»** (#110). El lector de
  cabeceras solo aceptaba claves sin guion: `superseded-by` se descartaba en silencio, y con ella la
  comprobación cruzada del linaje `supersedes` ↔ `superseded-by`. Ahora reconoce claves con guion.

## 0.59.0 — 2026-10-05

- **El triaje lee lo que lleva adjunto el issue: capturas, PDF, logs, documentos** (#108). Antes solo
  detectaba que había una captura, sin abrirla. Nuevo `harness.js triaje adjuntos <N>` (o
  `<org>/<repo>#<N>`): extrae los adjuntos del cuerpo y de los comentarios (distingue el visor de
  Userback, el commit o la página de la app, que no son adjuntos), los descarga con límites de número y
  tamaño (el token solo viaja a GitHub) y dice cómo abrir cada uno. La skill `triaje` pide abrirlos
  antes del veredicto y avisar si alguno no se pudo leer. Caso real: partner-portal#67, cuyas 5
  pantallas solo estaban en el PDF adjunto.
## 0.58.0 — 2026-10-05

- **La épica padre de ClickUp, siempre al día: fecha y resumen de lo entregado** (#107). Hasta ahora FARO
  no escribía nada en la épica y, para saber cómo iba el proyecto, había que abrir las tareas una a una.
  Ahora `clickup push` mantiene en su descripción un único bloque «Estado de la entrega» que se
  reemplaza en cada sincronización, sin acumularse. Incluye objetivo, avance, plazo, en qué se está,
  bloqueos y una línea por entregable con su estado y el valor que aporta, sin listar tareas. El
  texto del PM fuera del bloque no se toca. La épica recibe `due_date` (el último `Objetivo:` del
  faseo) y `start_date` (`fecha_inicio:` del frontmatter), y si falta la fecha se avisa. Nuevo
  `clickup adjuntar <fichero> [fase N|taskId]` para subir el reporte de negocio de marca a la épica.
## 0.57.0 — 2026-10-05

- **Al arrancar cada sesión, FARO valida que lo local coincide con el remoto** (#106). El vigilante de
  arranque, en segundo plano, hace `git fetch --all --prune` (antes `fetch origin`, sin podar), pone al día
  main/develop cuando es seguro (solo avance, sin fusionar; la rama con checkout solo con el árbol limpio),
  avisa si tu rama de trabajo va por detrás de su remoto y lista las ramas remotas con trabajo que aún no
  está en develop (reconoce las ya integradas por squash), con la acción a tomar: `/faro:consolidar` o
  `/faro:ramas`. Sin red lo dice, en vez de dar por bueno lo que no pudo comprobar.
## 0.56.6 — 2026-10-05

- **La presentación generada ya no mete una slide en blanco tras la portada** (#105). `docgen --presentacion`
  ponía el índice al principio del cuerpo; en la presentación el índice está oculto, pero el reparto en
  slides le abría una propia, que salía vacía en pantalla y en el PDF. Ahora la presentación no lleva
  índice (cada slide ya es un apartado), la plantilla descarta cualquier slide sin contenido visible y
  la última slide no fuerza otra página en blanco al final del PDF. La vista documento conserva su índice.

## 0.56.5 — 2026-10-03

- **El admin u owner consolida y publica sin que se le pida confirmación** (#99). Si quien lanza
  `/faro:consolidar` o `/faro:publicar` es admin u owner del repo, lanzarlo ya es su aprobación: tiene la
  legitimidad, y preguntarle «¿publico?» por algo que acaba de ordenar era una vuelta de más. Se valida
  y se ejecuta, contando qué entró. El control no cambia (rol, develop por delante y `validate`, en el
  harness). Se sigue preguntando si el rol es maintainer, si hay varios admin y la revisión podía ser de
  otro, si la validación saca algo que cambia la decisión, si hay PRs de otras personas o si el agente
  actúa en un loop autónomo sin que se lo hayan pedido.

## 0.56.4 — 2026-10-03

- **El triaje explica cada issue antes de pedir la decisión** (#96). Quien confirma un veredicto no
  tiene por qué haber leído el issue: puede llevar semanas en la bandeja o venir de fuera. Ahora
  `/faro:triaje` cuenta antes de preguntar, para cada issue, qué es en llano y de dónde viene, qué se ha
  comprobado (con la evidencia), el veredicto propuesto con lo que lo respalda y qué pasa con cada opción.
  Además, cada opción de la pregunta describe su consecuencia concreta.

## 0.56.3 — 2026-10-02

- **`Refs #N` ya no cierra la tarea aunque la rama lleve su número** (#91). Una rama `docs/96-…` cerraba
  la #96 al integrarse aunque el PR dijera `Refs #96`. Lo hacían tres caminos, cada uno por su lado:
  `pr crear` añadía `Closes #96` al cuerpo, el reconciliador contaba el número de la rama como resuelto,
  y el cierre activo de `consolidar` cerraba por el nombre de la rama sin mirar el PR. En un repo de
  trabajo hubo que anclar la rama a una tarea ya cerrada para no cerrar dos abiertas. Ahora una sola
  regla (`soloReferencia`, `lib/tarea.js`) decide para los tres: si el PR cita su número con `Refs`, `Ref`,
  `Parte de`, `Part of` o `Relates to`, la tarea sigue abierta. Una palabra de cierre explícita gana
  siempre, y sin `Refs` todo funciona como antes. `pr crear` acepta ese `Refs` como ancla y avisa de que
  no cerrará. Un merge directo sin PR sigue cerrando por el número de la rama.

## 0.56.2 — 2026-09-24

- **El simulacro de despliegue compila antes** (#89). En proyectos que construyen con Vite antes de desplegar
  (TanStack Start, React Router, Astro con `@cloudflare/vite-plugin`), `wrangler deploy --dry-run` a secas fallaba:
  wrangler apunta a lo que genera la compilación. Ahora `gates` y el plan de CI eligen, del más al menos concreto:
  el simulacro propio del proyecto (`deploy:dry` o `deploy:dry-run` en `package.json`); si hay `build`, compilar y
  después `--dry-run`; si no, `--dry-run` como hasta ahora.

## 0.56.1 — 2026-09-24

- **Userback: los logs de consola y el adjunto llegan al issue** (#86). Vienen en el propio webhook
  (`console_logs`, `attachment`), así que no hace falta la API de Userback: su `GET /feedback/{id}` no trae
  logs ni red. Los logs van en **Evidencia**, en un bloque plegable, con las últimas líneas (el cuerpo de
  un issue tiene límite) y los **secretos tapados**: `Bearer`, JWT, `api_key`/`token`/`password`=…, claves
  `sk_live_`/`ghp_`. Las peticiones de red y la grabación de la sesión no las da Userback ni por webhook
  ni por API: el issue lo dice y enlaza a Userback.

## 0.56.0 — 2026-09-24

- **Bandeja de entrada: lo que llega de fuera va sin hito, y el harness lo recupera para el triaje** (#84).
  Bugs, ideas y sugerencias de usuarios entran por un canal (Userback, formulario, web) sin que nadie
  haya decidido nada. La bandeja son los issues **abiertos sin hito**, más cualquiera con `reporte`: no
  depende de ningún hito ni del canal.
  - `harness.js triaje --bandeja` la lista, la más antigua primero, con tipo sugerido (también por
    etiqueta nativa), origen, votos y si viene de fuera. Visto en este repo: un bug de hace 56 días que
    nadie tenía localizado.
  - La sesión y `validate` dicen cuántos esperan triaje. «Sin hito» deja de avisarse como fallo de la
    coherencia PM.
  - Un `reporte` nace **sin hito**. Esto sustituye a 0.54.1, que lo mandaba al Backlog: el hito es la fase,
    y decidirla es el triaje.
  - `mover-tarea` desde la bandeja a una fase exige el formato del tipo, igual que desde el Backlog.
  - **Completar sin reescribir**: `reparar-tarea` conserva las secciones que ya trae el issue (las de
    Userback) y solo añade las que faltan de su plantilla (`completarPlantilla`). Antes lo metía todo en
    «Contexto».
- **Contrato de entrada** documentado en `n8n/README.md`, y **flujo Userback → GitHub** nuevo
  (`n8n/userback_github_issues_n8n.json`):
  - crea el issue en el repo que trae el JSON (`custom_data.repo`, admite `org/repo`); sin repo, se
    invalida, sin destino por defecto;
  - sin hito;
  - etiquetas `reporte` + tipo sugerido + `userback` + `origen:<repo>`;
  - secciones de FARO, con capturas y vídeo en Evidencia;
  - deduplica por id de Userback;
  - token opcional.
- **n8n (eventos de GitHub)**: `enBandeja` en cada evento. Un issue sin hito y sin tarjeta no genera
  operaciones en el gestor, y al recibir hito, si aún no tiene tarjeta, `crear-tarea`.
- La skill `/faro:triaje` empieza por recuperar la bandeja y explica qué hacer tras cada veredicto.

## 0.55.5 — 2026-09-24

- **Fix: el tipo de un issue se reconoce también por su etiqueta nativa de GitHub** (#81). Una `mejora` lleva
  la nativa `enhancement`, pero el código buscaba la nativa en un campo `nativo` que el contrato no tiene
  (se llama `github`). Resultado: se validaba como `tarea` y se le exigía otra plantilla (visto con #80 en
  `reparar-tarea`). Ahora un único `tipoDeEtiquetas` (`lib/ciclo.js`) reconoce `slug`, `faro:slug` y la
  nativa, en `mover-tarea`, en la auditoría de issues y en `reparar-tarea`. El flujo n8n traduce también las
  nativas (`enhancement` → mejora, `documentation`, `question`, `wontfix`, `duplicate`).

## 0.55.4 — 2026-09-24

- **n8n: cada evento de GitHub sale con la tarjeta del gestor y todo lo necesario para aplicarlo** (#73).
  El nodo 5 lee el bloque `faro:pm` del issue y de su hito (`pm`, `pmHito`, `sinVinculoPm`): el destino ya
  no busca la tarjeta por título. La salida añade:
  - `actor` (login, id, persona o bot) y `autorRecurso`;
  - `hito` con número y URL;
  - `fechas` reales (creado, actualizado, cerrado);
  - `pr` (quién lo fusionó y cuándo, commit, rama origen y destino, revisores e issues que cierra con la
    misma regla que el harness);
  - `cambios` de una edición y `asignadoAfectado`;
  - `push` (quién empujó, commits y enlace de comparación);
  - `tipo` también con prefijo `faro:`.
  Antes solo salía `sender.login`, el título del hito y la hora de proceso.
- **Sin doble escritura**: los comentarios del propio harness («Cerrada por el harness…», «Publicada en vX»)
  salen con `delHarness` y el nodo 6 los ignora.
- El nodo 7 (**TU GESTOR**) documenta las operaciones **reales** del nodo 6 (hitos, no épicas) y cómo usar
  `$json.pm`. El README y la guía de gobierno se ponen al día (nodos 4 y 6). Tests: el código real de los
  nodos se ejecuta con eventos simulados (`test/n8n-componer-estado.test.mjs`).
- Los eventos de incidencias de GitLab pasan a su propio issue (#80): son un flujo nuevo.

## 0.55.3 — 2026-09-24

- **Fix: el tag del release apunta a `main`, no a la rama desde la que se lanzó `publicar`** (#78).
  `publicar` volvía a la rama de origen **antes** de etiquetar, y el tag caía sobre `HEAD`. Al publicar
  v0.55.2 desde `feat/72`, el tag quedó en el commit de esa rama y «Publicada en v0.55.2» no llegó a #72.
  El contenido coincidía porque la rama ya estaba integrada, pero desde una rama con trabajo sin integrar
  el tag habría apuntado a código no publicado. Ahora `tagVersionSiProcede(ref)` etiqueta la referencia
  que recibe y `publicar` le pasa la rama principal.

## 0.55.2 — 2026-09-24

- **Vínculo PM en la forja: cada issue y cada hito dicen qué tarjeta del gestor son** (#72). `clickup push`
  escribe en cada issue, y en la descripción de cada hito, una sección `## Vinculo PM`. Lleva un comentario
  HTML con el JSON (`sistema`, `tarea`/`tarea_ref`, `hito`/`hito_ref`, `epica_ref`, `url`), que leen n8n y
  el harness, y una línea legible con los custom id. Es idempotente, y la tarjeta copia el issue sin el
  bloque. Antes el vínculo solo vivía en `ESTADO.md` y un evento de GitHub no sabía qué tarjeta tocar.
- **Nomenclatura genérica `pm`**: `pm_sistema` + `pm_epica` en la cabecera (`clickup_epica` sigue valiendo) y
  marcador `[pm:ID]` o `[pm:<sistema>:ID]` en `ESTADO.md` (los `[cu:ID]` se siguen leyendo).
  **Un solo reconocedor** de marcadores para todo el harness: con el anterior, un `[pm:…]` hacía
  desaparecer la fase en silencio y se colaba en el nombre de la tarjeta.
- **`consolidar` sincroniza el gestor** cuando hay épica anclada: tarjetas, bloque `pm` y enlaces en
  `ESTADO.md`, con commit propio. Sin token de ClickUp, avisa y sigue.
- **Coherencia PM** en la sesión y `validate` (desde la caché del vigilante): tareas abiertas sin hito, hitos
  sin tarjeta e issues de fase sin vínculo. El Backlog queda exento.
- **Salir del Backlog exige formato**: `mover-tarea` a una fase se niega si al issue le faltan las secciones
  de su tipo (remite a `reparar-tarea`), y un `reporte` necesita triaje antes.
- El contrato y `asignar-tarea` ya no dicen que `--fase` es opcional para los tipos `surge`: todo issue
  cuelga de un hito.

## 0.55.1 — 2026-09-24

- **Cierre determinista de tareas: el harness sabe qué está hecho y lo cierra** (#71). Una sola regla,
  `lib/tarea.js` (`evaluarTarea`, pura), decide el estado de cada tarea a partir de hechos de la forja: un
  PR que la referencia (número de la rama o `Closes #N`) fusionado en `develop`/`main` = **hecha**. Además:
  descartada, cerrada sin evidencia, mencionada (un PR integrado la cita sin cerrarla), en revisión, en
  curso y abierta. Antes había cinco sitios con su propia lógica y los issues se quedaban abiertos:
  `Closes #N` solo cierra si el PR va a la rama por defecto, y `consolidar` solo cerraba lo que él fusionaba.
  - `consolidar` y `publicar` **cierran** por la API toda tarea hecha, venga el merge de la web, de la API o
    de `consolidar`, con un comentario de trazabilidad (PR, rama, commit, fecha). En un **bug**, añade
    «Causa · Arreglo · Test» sacados del PR (si no están, lo dice). Una tarea hecha que sigue en el Backlog
    no se cierra: se avisa de que hay que moverla a su fase.
  - **La forja manda:** los `[x]` de `ESTADO.md` los marca el harness, con commit propio en `develop`.
  - `publicar` cierra lo hecho **antes** de comprobar la ligadura cambio ↔ tarea (ya no cancela por un issue
    que sí tenía su PR) y anota «Publicada en vX» en las tareas del release.
  - `vigilar` solo detecta y deja una caché; la sesión y `validate` avisan desde ella (`[tareas]`), sin red.
  - `hito verificar` usa la misma regla: ya no busca el número como texto libre.
- **`pr crear` no abre una petición sin tarea**, salvo que el cambio sea solo de gestión. Se decide por el
  contenido, no por el prefijo; vale el número de la rama o `Closes #N`, no una mención suelta. Se comprueba
  antes de publicar la rama y es igual para GitHub y GitLab. En una rama de bug, el cuerpo lleva
  `## Causa`, `## Arreglo` y `## Test`.

## 0.55.0 — 2026-09-24

- **Formato estándar por tipo de issue, en el contrato** (#74). `faro-schema.json > enums.plantillas_issue`
  define, por tipo, sus secciones en orden, con el marcador guía y si es obligatoria: bug (reproducir,
  esperado/obtenido, entorno, evidencia), requerimiento (a quién sirve), mejora (situación actual, mejora,
  impacto), tarea (entregable), documentación (documento, audiencia), investigación (pregunta, hipótesis,
  límite de tiempo, resultado esperado), diseño (opciones), infra (entorno, riesgo y vuelta atrás), datos
  (origen y destino, volumen y calidad) y pregunta. Con alias (`hotfix`→bug, `spike`→investigación);
  `reporte`, `duplicado` y `descartado` quedan exentos. `asignar-tarea`, `huecosDeIssue` y `reparar-tarea`
  usan la plantilla del tipo. Para añadir o cambiar un tipo basta con editar el contrato.
- **Nuevo `harness.js ampliar-tarea <N> --subtarea "…"`.** `/faro:migrar-tareas` mandaba ampliar un issue en
  vez de crear hermanos, pero el comando no existía.
- **Fix: las subtareas van a su sección.** `ampliar` las insertaba tras la última casilla del cuerpo, que en la
  plantilla es «Criterios de aceptación», y `asignar-tarea --subtarea` creaba un segundo `## Subtareas`.
  Ahora van dentro de `## Subtareas` y sustituyen el marcador de ejemplo.
- La lista de subcomandos del error de comando desconocido incluye `ampliar-tarea`, `mover-tarea`,
  `cerrar-tarea` y `reparar-tarea`.

## 0.54.2 — 2026-09-23

- **Fix: `publicar` reconoce los encabezados de Keep a Changelog** (#68). Con `## [0.7.0] — fecha` en el
  CHANGELOG, el gate de coherencia cancelaba la publicación con «no tiene una entrada '## 0.7.0'», sin
  tocar main: solo aceptaba `## 0.7.0` literal. Ahora un único reconocedor (`reEncabezadoVersion`,
  `lib/release.js`) acepta `## 0.7.0`, `## [0.7.0]`, `## v0.7.0` y `## [v0.7.0]`, en el gate y en las
  notas del Release, sin confundir `0.7.0` con `0.7.01`, `0.7.0-beta` ni `10.7.0`. No hace falta
  tocar el CHANGELOG de ningún repo.
- **Fix: la versión sugerida es la que se va a publicar** (#69). `release`/`publicar` sumaban siempre sobre la
  versión declarada: con `package.json` en 0.4.0 y sin tags sugería 0.5.0, y aquí, con `plugin.json` en
  0.54.1 y último tag v0.50.0, sugería 0.55.0 — mientras el tag salía de la declarada. Ahora, si la
  declarada va por delante del último tag (o no hay tags), la sugerida es ella; solo si ya está
  tageada se propone el siguiente salto por contenido.

## 0.54.1 — 2026-09-23

- **Fix: un `reporte` va al Backlog, no a la fase activa** (#66). Tenía `ciclo: surge` desde 0.49.0, así
  que `asignar-tarea --tipo reporte` sin `--fase` lo mandaba a la fase activa como un bug, contra su
  propia definición (llega de fuera y nadie ha decidido nada hasta el triaje). Ciclo nuevo `entrada`:
  sin `--fase` va al hito Backlog, en GitHub y en GitLab. El test del reparto de ciclos, rojo desde
  0.49.0, vuelve a verde.

## 0.54.0 — 2026-09-23

- **Los bugs tienen su propia plantilla** (#65). `asignar-tarea --tipo bug` (y `bugfix`/`hotfix`) crea el
  issue con **Pasos para reproducir, Comportamiento esperado, Comportamiento obtenido** (error literal),
  **Entorno** y **Evidencia**, además de objetivo, alcance y fuera de alcance. El contexto dice dónde se
  detectó, y los criterios incluyen el test de regresión. Antes era la plantilla común con los pasos
  metidos en una línea de «Contexto».
- `huecosDeIssue` exige esas secciones cuando el issue es un bug: `asignar-tarea`, la auditoría de
  issues abiertos y `reparar-tarea` resuelven el tipo por su etiqueta (`bug` o `faro:bug`). Una
  tarea sin esas secciones no se marca incompleta.

## 0.53.1 — 2026-09-23

- **Fix: todo trabajo nace de un ISSUE, también en el motor y también con la rama creada a mano.** Un
  fallo detectado se declara como bug antes de abrir su rama. Había dos huecos: en el repo motor (sin
  `ESTADO.md`) `harness.js rama` no pedía issue, y `git switch -c fix/…` / `git checkout -b` se
  saltaban el bloqueo en cualquier repo. Ahora `rama` bloquea también en el motor, y una guarda nueva
  (`preBashRamaSinIssue`) desvía la rama a mano sin número hacia `asignar-tarea` + `rama --issue <N>`.
  Exentas, como antes: ramas `chore/` y las que ya llevan su número (`fix/12-…`). La directiva del
  motor pone el issue como primer paso del flujo.
- **Fix: a main se llega PUBLICANDO, y los avisos ya lo dicen.** Seguían enseñando el modelo retirado en
  0.37.0: `pendientes` mandaba a `git merge --no-ff develop` a mano, los avisos de merge a main hablaban
  de «la APROBACION», y `gestor-forja` abría PRs `develop → main` y atribuía a `consolidar` el merge a
  main. Ahora todo apunta a `/faro:publicar`: `pendientes`, `role`, los avisos de merge a main, el
  final de `rama`, `gestor-forja` (su flujo de ayuda a quien publica se mantiene, sin PR a main) y las
  skills `forja`, `pendientes`, `consolidar`, `documentacion`, `changelog` y `publicar`. El
  «aprobar» de specs y propuestas no cambia: ahí es el término correcto.
- Una propuesta `implementada` indica `/faro:archivar` para cerrar su ciclo, no `/faro:publicar`.

## 0.53.0 — 2026-09-23

- **Fix: lo que está `done` en el repo se cierra en ClickUp como `completado`, no como `testing`.** El
  destino de cierre era el PRIMER estado de type `done` de la lista, y en la del equipo ese es
  `testing` (también `cancelado` es `done`); `completado` es el único `closed`. Y como `testing`
  ya contaba como hecho, ningún push posterior lo corregía. Ahora el cierre va al estado `closed`
  (`estadoDeCierre`) y se mueve todo lo que no esté cerrado (`faltaCerrar`): fases y tareas en
  `testing` pasan a `completado` en el siguiente push, y `pull` ya no las da por iguales. Lo
  cancelado no se toca. Sin estado `closed` en la lista, vale el primer `done` que no sea cancelación.
- **La épica se ancla con su CUSTOM ID.** En la cabecera de `ESTADO.md` va `clickup_epica: ABC-62`,
  no el id interno (`1245xawc2ep`). Leer ya se leían los dos; ahora FARO **lo escribe y lo propone**:
  `clickup status` y `pull` avisan si el ancla está en interno, y `push` la cambia sola (misma
  épica, no reparenta nada). Sin custom id en la tarjeta, se queda el interno. `clickup epicas`, el
  aviso de sesión, la skill `/faro:clickup` y `CLICKUP.md` enseñan a anclar así. Las tareas siguen
  con `[cu:<id interno>]`: ahí da igual.
- **El push ya no manda a los repos de trabajo a buscar `n8n/`.** Una fase sin líneas de tarea
  decía que sus tareas «las mantiene el flujo de eventos (n8n/)», una carpeta que solo existe en el
  motor, y el agente se iba a buscarla. Ahora es una línea con lo que hay que hacer: añadir
  `- [ ] #N · titulo — @quien` por issue del hito y repetir el push.

## 0.52.1 — 2026-09-23

- **Fix: `/faro:migrar-tareas` ya no borra las tareas de la fase — la skill pide el mismo formato
  que exige `validate`.** El paso 1.5 mandaba sustituir los checkboxes por `Tareas: ver hito de
  esta fase`, pero el formato rigido de fases abiertas (`huecosDeFase`, `lib/ciclo.js`) necesita una
  linea por issue para contabilizar la fase y cruzarla con la forja: seguir la skill dejaba toda
  fase abierta en `Fase N: no declara ninguna tarea` (probado en una instancia real y revertido a
  mano). El formato bueno es el que el motor ya sabia leer: **`- [ ] #N · titulo — @quien` por cada
  issue del hito, `[x]` si esta cerrado**, cuadrado uno a uno con el hito. El detalle sigue en el
  issue (subtareas incluidas); `ESTADO.md` solo lo indexa.
- **Una sola regla en las dos comprobaciones.** `validateEstado` (`lib/estado.js`) solo tolera ya
  `Tareas: ver hito` en fases **cerradas**, historico de migraciones anteriores que no se reescribe.
  Su mensaje de error dejaba de recomendar el formato que el propio gate rechaza y ahora ensena la
  linea `#N · titulo — @quien`.
- **La plantilla de la skill incluye la descripcion de la fase** y `Objetivo:` como fecha: seguida al
  pie de la letra, tambien disparaba `falta la descripcion`. `CLICKUP.md` §8 y el `README` se alinean.

## 0.52.0 — 2026-09-23

- **EL DETALLE DEL TRABAJO VIVE EN EL ISSUE, y ahora el harness lo EXIGE.** `ESTADO.md`
  lleva el checkbox de una linea; el issue lleva contexto, alcance, subtareas y criterios. Un issue
  sin estructura deja el trabajo sin definir en el unico sitio donde deberia estarlo — y quien lo
  coja (persona o **agente**) rellena los huecos suponiendo, porque un agente no pregunta.
- **Antes solo AVISABA y creaba el issue tal cual.** Por eso hay issues vivos con dos lineas que
  nadie volvio a completar. Ahora **ningun issue nace sin estructura**: si el cuerpo no es
  autocontenido, se crea CON la plantilla de su tipo puesta y lo que se hubiera escrito se CONSERVA
  dentro (bajo `Contexto`). No se bloquea la creacion a proposito — obligar a redactar cinco
  secciones antes de poder anotar un bug que acaba de aparecer haria que la gente dejase de usar el
  comando. Lo que se garantiza es que el issue nunca APARENTE estar completo: los marcadores `<…>`
  dicen a la cara lo que falta.
- **`harness.js reparar-tarea`** para los que ya existen: sin argumentos AUDITA todos los abiertos y
  dice que le falta a cada uno; con numero muestra como quedaria y solo escribe con `--confirmo`.
  **Conserva integro lo que hubiera** (pasa a `Contexto`) y anade las secciones que falten con sus
  marcadores. Pone el esqueleto: **no inventa el contenido**.
- **Agente `sanador-issues`** para lo que el harness no puede hacer, que es JUZGAR: investiga el
  change spec-driven asociado, la rama, el PR, los comentarios y el hito para **reconstruir que
  pretendia** cada issue, y detecta los que no deberian seguir abiertos — ya entregado (cerrar),
  abandonado (descartar, que es `not_planned` y NO es lo mismo), duplicado, o sin decidir cuando
  (mover a `Backlog`). Regla dura suya: lo que no puede fundamentar lo deja como `<PENDIENTE: …>`,
  porque una frase plausible que nadie decidio es una decision tomada a escondidas.
- **La tarjeta de ClickUp trae el detalle REAL del issue** (cuerpo, estado, labels, subtareas,
  comentarios) en vez de enlazar a un contenido que no mostraba. Y si el issue esta vacio **lo dice
  ahi**, que es donde mira quien no entra al repo. La lectura es OPCIONAL y en un solo sentido
  (espejo -> forja): sin token, se degrada al enlace.
- **Arreglada la AUTOASIGNACION, que no funcionaba en 0.51.0.** La forma cambia segun el verbo y no
  esta documentado: `POST` quiere `assignees: [ids]` y `PUT` quiere `assignees: { add: [ids] }`.
  Mandar `add` al crear devuelve **200 OK y no asigna a nadie** — ClickUp se come el campo en
  silencio. Comprobado creando con las dos formas y releyendo.
- **Cambiar `clickup_ambito` RENOMBRA el hito, no lo duplica.** Si existe con otro prefijo, el push
  lo encuentra (un hijo de la epica cuyo nombre ACABE en `Fase N: <nombre>`: el prefijo es lo unico
  que puede variar) y lo renombra en sitio. Sin esto, poner el ambito en un repo ya sincronizado
  creaba un hito nuevo y dejaba el viejo huerfano **para siempre**, porque no hay permiso de borrado.
- **El ambito va en el HITO, no en cada tarea.** Ahi es donde evita colisiones: los hitos de varios
  repos conviven como hermanos bajo la misma epica. Las tareas cuelgan de su hito —que ya dice de que
  repo son— y se buscan solo entre sus hermanas. Ahora se PREGUNTA al anclar la epica, con los tipos
  que FARO ya usa (`api` · `proceso` · `front` · `infra`), en vez de coger el nombre del repo sin
  avisar (`mi-gateway · Fase 1: …` no cabe en una tarjeta).
- **El hito muestra QUE TRAE la fase.** Usaba el objetivo de la INICIATIVA donde debia ir la fecha
  objetivo de la FASE, y no usaba la descripcion de la fase de `ESTADO.md`: el hito era un titulo y
  una cuenta de tareas, sin decir que se pretende.
- **Vale el identificador que se VE en pantalla** (`ABC-62`) ademas del interno, tambien en los
  marcadores `[cu:id]`. El listado de epicas ofrece ese, que es el que la gente reconoce.

## 0.51.0 — 2026-09-23

- **Un proyecto grande se gobierna desde su EPICA, y ahora FARO cuelga de ella.** El problema que
  cierra: los dos modos que habia (`fases`, `tareas`) creaban tarjetas PLANAS en una lista, asi que el
  faseo de un repo se mezclaba con el de los demas y no habia forma de ver "que lleva este proyecto".
  Ahora hay tres niveles reales — **epica > hito(fase) > tarea(issue)** — que es como se gobierna de
  verdad.
- **Se declara UNA linea.** `clickup_epica: ABC-62` en el frontmatter y ya: la lista **se infiere de
  la epica** (pedir las dos era pedir el mismo dato dos veces, y abrir la puerta a que se
  contradigan). Valen los dos identificadores, el que se VE en pantalla (`ABC-62`) y el interno
  (`1245xawc2ep`): se prueba la forma que toca por la pinta del valor y, si falla, la otra — nadie
  tiene que saber cual pego.
- **La epica es del PM y FARO NO la toca.** Ni la crea, ni la cierra, ni le escribe campos. Solo
  cuelga debajo. Lo unico que le lee es `Peticionario`, que el proceso exige en cada tarjeta y **no es
  una persona** (es el area que pide: Cliente · Negocio · Data · IA…): el PM lo decide una vez en la
  epica y todo lo que cuelga lo hereda.
- **Los hitos SIEMPRE llevan el ambito del repo por delante, y no se puede desactivar.** Una epica
  puede recibir otro repo manana (`front` + `api` + `ui` es lo normal en un proyecto grande), y para
  entonces los hitos del primero ya estarian creados sin prefijo: el segundo los encontraria por
  nombre y se los quedaria, pisando estado y fechas. El coste de prefijar de mas es un titulo largo;
  el de no prefijar **no se deshace**, porque el token no tiene permiso de borrado.
- **Nunca borra: marca `cancelado`.** Comprobado contra la API — `DELETE` devuelve `401 ACCESS_081` en
  listas compartidas. Y aunque se pudiera, perder historial porque alguien edito un `.md` seria peor
  que dejar una tarjeta de mas.
- **Nunca quita asignados: solo suma** (`assignees: { add: [...] }`). Si empuja otro despues, aparecen
  LOS DOS — refleja quien participo de verdad, no una asignacion teorica.
- **La fecha objetivo viaja a los dos sitios.** El `Objetivo: AAAA-MM-DD` de la fase ya iba al
  `due_on` del milestone; ahora tambien al `due_date` del hito. Se envia **mediodia** UTC a proposito:
  ClickUp normaliza la hora a la zona del workspace, y con `00:00Z` la fecha se veria un dia antes.
  Comprobado ademas que un `PUT` sin el campo **no borra** la fecha que hubiera: quitar un dato del
  fichero no es orden de destruirlo en el gestor.
- **Una fase que delega sus tareas en el hito (`/faro:migrar-tareas`) se DICE, no se finge.** Sus
  tareas son issues, no checkboxes: el hito se sincroniza y se avisa. Leerlas exigiria cablear este
  modulo a la forja, y entonces quitar ClickUp manana dejaria dependencias cruzadas — `clickup.js`
  habla con ClickUp y con `ESTADO.md`, nada mas.
- **`clickup epicas`**: barre las listas visibles, oculta el ruido (una lista operativa de 118 tareas
  ahogaba la respuesta) y ofrece el identificador que se ve en pantalla. El onboarding
  (`/faro:iniciar`) pregunta si el trabajo se gobierna desde un gestor — y **si no aplica, no
  insiste**.
- Documentado entero en `CLICKUP.md` (raiz): modelo, reglas duras, limites reales de la API v2 (los
  milestones nativos NO se pueden crear; la v3 publica solo cubre Docs) y reparto con el flujo de n8n.

## 0.50.0 — 2026-09-23

- **El vigilante detecta si tu copia de `main`/`develop` esta DESFASADA del remoto.** El problema que
  cierra: si tu develop lleva doce commits de retraso, **estas construyendo sobre una base que ya no
  existe** — y no te enteras hasta el merge, cuando ya duele. `/faro:sincronizar` lo resolvia desde
  0.30, pero nadie lo ejecuta preventivamente: se ejecuta despues de chocar.
- **Hace `fetch` de verdad, y por eso va en el vigilante y no en el arranque.** Sin traer del remoto,
  la comparacion miente: el propio motor ya documentaba que *"sin fetch previo puede decirte 'estas al
  dia' cuando llevas doce commits de retraso"*. Y `fetch` es RED, asi que en `session` —que es
  sincrono— alargaria cada arranque; en background no cuesta espera a nadie. El `fetch` **no toca tu
  arbol ni tus ramas**: solo actualiza `refs/remotes/`.
- **Si el fetch falla, NO compara con refs viejas**: diria "estas al dia" con doce commits de retraso,
  que es peor que no decir nada. Y cuando no se puede comparar una rama, lo dice — *"no se si estas al
  dia"* no es *"estas al dia"*.
- **Solo avisa de `main` y `develop`, y solo de ir POR DETRAS.** Son ramas compartidas: ahi el desfase
  es un problema. Que TU rama de trabajo vaya por delante del remoto es lo normal —es trabajo sin
  subir— y avisarlo seria ruido en cada sesion. Hay test de que no se menciona.

## 0.49.1 — 2026-09-23

- **Un Worker desplegado tiene que decir DE QUE REPO sale.** El caso que lo motiva: alguien abre el
  dashboard de Cloudflare mirando un incidente, ve un worker llamado `api` o `worker-prod`, y **no
  tiene forma de llegar al codigo** — justo cuando mas prisa hay.
- Cloudflare **no tiene campo estandar** para esto (verificado en su documentacion de configuracion:
  existe `vars` para texto libre y nada mas), asi que la convencion la pone FARO: una variable
  `REPO_URL` en `vars` (tambien valen `GIT_REPO` y `SOURCE_REPO`).
- **El harness ya sabe cual es el remoto, asi que no se limita a pedirla: dice CUAL poner.** Un aviso
  que trae la respuesta puesta se atiende; uno que solo señala la regla da trabajo.
- **Y avisa tambien si apunta a OTRO repo**, que es peor que faltar: una url equivocada manda a leer
  el codigo que no es, y **nadie duda de un dato que esta escrito**.
- Es un aviso de `infra`, **no un gate**: bloquear por esto pararia un despliegue urgente por un dato
  de trazabilidad. Con la url correcta, silencio.

## 0.49.0 — 2026-09-23

- **Canal de reportes: FARO recoge lo que llega de fuera, sin construir la puerta.** El widget de
  feedback del producto, el formulario y el transporte que abre el issue son **automatizacion del
  producto, no del harness**. FARO empieza cuando el issue ya esta en el Backlog.
- **Nueva etiqueta `reporte`**: marca *"viene de fuera y NADIE ha decidido nada todavia"*. El catalogo
  tenia 16 etiquetas y todas eran categorias de trabajo YA aceptado (`bug`, `mejora`, `requerimiento`,
  `tarea`…): no habia forma de distinguir un reporte sin triar de una tarea mal puesta. Un issue asi
  **no lleva `#N` de fase, ni owner, ni criterios de aceptacion** — y no debe llevarlos, porque
  exigirselos lo convertiria en trabajo ANTES de decidir si merece hacerse.
- **El triaje lee el issue ENTERO, no solo el titulo.** Del cuerpo saca lo que el canal haya puesto
  (`url`, `pantalla`, `frecuencia`, `afecta a`, captura) aceptando varias formas de escribir cada
  campo: FARO **no le impone formato** a un widget que no es suyo, lee lo que venga y juzga igual si
  no viene nada.
- **Los HECHOS mandan sobre el tono.** El dato que mas cambia el veredicto es a cuantos afecta, y
  hasta ahora solo se inferia de COMO estaba redactado el texto ("en mi caso…") — lo que falla con
  cualquiera que escriba en primera persona sobre un problema general. Ahora manda, por este orden:
  los **votos y comentarios del issue** (dos personas distintas ya descartan el caso unico), luego el
  campo `afecta a` declarado, y solo al final la redaccion. Umbral deliberadamente bajo: con un voto
  no hay senal —quien abre suele votarse— y esperar a diez seria no enterarse nunca.
- **Distingue bug / idea / sugerencia**, porque cada uno se juzga contra una pregunta distinta:
  descartar una idea *"porque no esta en la spec"* es correcto; descartar un **bug** por lo mismo
  seria absurdo — un fallo no necesita estar planificado para ser un fallo. Si el canal declara el
  tipo, manda lo declarado; si no, se infiere; y si no hay senal **no clasifica**: mejor `null` que
  una clase inventada, porque de ella depende contra que se juzga.

## 0.48.1 — 2026-09-23

- **Resuelta la contradiccion spec↔test de `--force-with-lease`** que la capa 1 destapo en su primera
  pasada real. La spec `guardas-seguridad` exigia denegar el push forzado *"en cualquiera de sus
  formas"*; el gate eximia `--force-with-lease` y un test lo afirmaba con motivo explicito. **La spec
  era la que estaba mal escrita**: el comportamiento del motor era el correcto y estaba documentado
  como decision deliberada en dos sitios del codigo.
- El requisito pasa a decir lo que de verdad protege: **no la reescritura —legitima en la rama
  propia— sino el trabajo de TERCEROS.** `--force` sobrescribe el remoto sin mirar y puede borrar en
  silencio commits que otro empujo mientras tanto; `--force-with-lease` **falla en vez de
  sobrescribir** si el remoto cambio desde la ultima vez que se miro. Bloquear la forma segura solo
  empujaria a usar la peligrosa — el resultado contrario al que se busca.
- **Nuevo test del caso positivo**, que era el que faltaba: que `--force-with-lease` NO se bloquea.
  Sin el, endurecer el gate "por seguridad" pasaria desapercibido. Las cuatro formas quedan
  verificadas en ejecucion: `--force` y `-f` → deny; `--force-with-lease` y el push normal → pasan.

## 0.48.0 — 2026-09-23

- **CAPA 3 — nueva `/faro:observabilidad`: ¿lo desplegado funciona de verdad?** Los tests dicen que el
  codigo hace lo que dice el codigo; las specs, si hace lo pactado. Esto dice si ademas **funciona
  donde importa**. Lee errores, volumen y latencia del Worker desplegado via MCP de Cloudflare.
- **Nadie necesita cuenta de Cloudflare para usar FARO.** Si el MCP no esta conectado, lo dice y
  sigue: *"no puedo ver la observabilidad… eso NO quiere decir que todo vaya bien, quiere decir que no
  lo se"*. **Nunca es un gate**: no bloquea `validate`, ni `publicar`, ni el cierre de una fase. Mismo
  patron de degradacion honesta que ya usan el vigilante con la forja y el triaje con el criterio.
- **Enganchada a `cerrar-fase`, que es donde rinde**: una fase cuyo endpoint acumula errores desde que
  se dio por terminada **se cerro en falso**, y eso no lo dice ningun test. El valor no esta en
  ensenar logs, sino en cruzarlos con el faseo: trabajo cerrado que falla, rutas con trafico real que
  el funcional no recoge, requisitos entregados que nadie invoca.
- **Las 47 specs del motor pasan de 0 a 45 requisitos demostrados.** No se escribio ni un test nuevo
  para 44 de ellos: **el vinculo ya existia y nadie lo habia escrito**. `revisor-evidencia` (0.47.0)
  recorrio los 79 ficheros de test y encontro que seis de ellos estaban escritos literalmente como "un
  test por ESCENARIO de los deltas de spec" —con separadores `// ---------- spec: <capacidad> ----------`
  dentro— y resolvian 36 requisitos por si solos. Buscar por NOMBRE nunca podia encontrarlo (ya se
  intento: dio 46/47 sin evidencia); leer que comprueba cada test lo encuentra en un rato.
- Se escribio **un** test nuevo, el unico hueco real y cerrable de los cuatro sin evidencia:
  `motor-directiva-ciclo` comprueba que la directiva que el motor se inyecta A SI MISMO describe el
  ciclo vigente (`feat/<tema>` → PR a develop → consolidar → aprobar). Si dijera "PR directo a main"
  —como decia antes de que existiera develop— el agente lo intentaria, chocaria con el gate que
  bloquea main, y se quedaria entre una orden y una prohibicion que se contradicen. Un documento
  desactualizado ahi no es deuda documental: **es una instruccion que el agente obedece**.
- **Los 2 que quedan sin demostrar se quedan asi, a proposito**: uno es un hecho sobre el repo (existe
  la rama `develop`) y otro sobre pipelines externos (la CI corre sobre develop). Forzar un vinculo
  falso para llegar a 47/47 seria cerrar el hueco sin taparlo — y el indicador dejaria de significar
  nada.
- **Hallazgo pendiente de decision (no es fallo de cobertura)**: la spec `guardas-seguridad` exige
  bloquear la reescritura de historia en las TRES formas, pero hay un test que afirma explicitamente
  lo contrario para `--force-with-lease` ("no es igual de destructivo"). Los dos son deliberados, asi
  que uno de los dos esta mal escrito. Queda anotado para resolverlo: o se corrige la spec, o el gate.

## 0.47.0 — 2026-09-23

Verificacion en capas: los gates responden *"¿compila? ¿pasan los tests?"*. Faltaban las dos
preguntas que un runner no puede contestar.

- **CAPA 1 — nuevo `revisor-evidencia`: ¿los tests DEMUESTRAN lo pactado?** Un repo puede tener 500
  tests en verde y cero que prueben lo que el negocio pidio. `specs evidencia` comprobaba que el
  fichero de test **existe**; este subagente lo **abre y juzga si prueba ESE requisito**, contrastando
  contra los `#### Escenario:` de la spec. Se lanza en la MISMA tanda que `revisor-code`, con su mismo
  vocabulario (APTO / NO APTO / APTO CON RESERVAS) — un `CAMBIOS REQUERIDOS` donde la skill busca
  `NO APTO` seria un gate que no salta.
- **Tres salidas, no dos.** La tercera es la que mas rinde en repos con historia: **SIN VINCULO** — el
  requisito no declara evidencia **pero el test existe**. Ahi no dice "no demostrado": dice que
  fichero lo cubre y **propone la linea `Evidencia:` exacta** que falta escribir.
- **Reparto explicito con `revisor-code`**, que ya hacia trazabilidad de evidencia: el juzga los
  criterios del **funcional** (prosa, dominio), `revisor-evidencia` los **requisitos de las specs**
  (vinculo concreto requisito↔fichero). Dos jueces sobre el mismo material, con vocabularios distintos
  y sin arbitro cuando discrepen, es peor que uno solo.
- **BUG: la evidencia escrita despues de los escenarios era INVISIBLE.** `parseLivingSpec` corta el
  `text` del requisito en el primer `#### Escenario:`, y `contarEvidencia` leia ese `text`. Como la
  linea `Evidencia:` se escribe de forma natural **al final** del requisito —cuando ya has contado que
  hay que probar—, el comando decia *"NO declara evidencia"* con la evidencia tres lineas mas abajo.
  Es la causa mas probable de que el propio motor diera **47/47 sin demostrar** teniendo los tests
  escritos. Un indicador que dice 0% cuando la realidad no lo es no se corrige: se ignora, y con el se
  ignora la senal entera.
- **CAPA 2 — nuevo `harness.js contrato`: ¿lo que el codigo EXPONE sigue siendo lo documentado?** Es
  la que rompe integraciones AJENAS, y el caso tipico no es un fallo: alguien anade una ruta o un
  campo, actualiza SUS tests, todo verde… y el funcional que leyo el cliente ya no describe la
  realidad. Compara los endpoints del funcional/ARQ con los que `src/` registra, y separa las dos
  derivas porque **no son el mismo problema**: lo que el documento PROMETE y no existe (quien integre
  se estrella) y lo que el codigo EXPONE sin documentar (superficie invisible que se rompera sin que
  nadie lo prevea).
- Lee los endpoints **como se escriben de verdad** —prosa, lista o tabla markdown, con el metodo en
  mayuscula o minuscula— y trata `/users/{id}` y `/users/:id` como el MISMO endpoint: sin eso, cada
  repo que mezcle convenciones daria derivas falsas, y un detector que grita en falso se desactiva a
  la semana. **Avisa y no bloquea**: la deriva puede ser deliberada, y como gate se sortearia borrando
  la linea del documento — justo lo contrario de lo que se busca.

## 0.46.0 — 2026-09-23

- **`AskUserQuestion` NO funciona dentro de un subagente, y el plugin decia lo contrario en 20 sitios.**
  Confirmado en la documentacion oficial de Claude Code —*"the first filter removes these tools, even
  when listed in the `tools` field: […] `AskUserQuestion`"*— y comprobado ademas lanzando un subagente
  que intento cargarla: *"no matching deferred tools found"*. Ni siquiera los **forks**, que saltan los
  demas filtros, la reciben.
- **El diseno de FARO era correcto; la documentacion mentia.** Las 10 skills que dicen *"ejecutalo TU,
  NO como subagente"* tenian razon. Lo que estaba mal: **10 agentes declaraban `AskUserQuestion` en
  sus `tools`** (promesa vacia: la plataforma la filtra igual), **10 ficheros afirmaban** *"como
  subagente tambien funciona"*, y los **4 agentes que SI corren como subagente** decian *"`AskUserQuestion`
  SI esta disponible — usala"*. El peligro no era estetico: un agente que CREE que puede preguntar,
  no puede, y acaba **adivinando** — justo lo que el resto del diseno evita.
- Balance: **10 agentes inline** (los que preguntan) + **5 subagente** (los que solo leen y emiten
  veredicto). Cero afirmaciones falsas en todo el plugin.
- **`redactor-tecnico` pasa a subagente** y `redactar` recupera su paralelismo: es solo lectura y quien
  habla con el usuario es `redactor-documento`. Lo que no pueda derivar del codigo lo marca como
  `> PENDIENTE DE CONFIRMAR` en su salida, en vez de inventar doc tecnica.
- **`iniciar` lanzaba TRES roles que entrevistan como subagentes en paralelo** — y arrancar es
  literalmente una entrevista. Habrian adivinado alcance, requisitos y riesgos del trabajo recien
  creado. Ahora esos roles se adoptan inline; lo que se delega es la **lectura** (barrer `fuentes/`,
  inventariar), que no pregunta nada.
- **`delegacion` sube la regla de preferencia a RESTRICCION**: no es que sea mejor preguntar en el hilo
  principal, es que **no se puede** en ningun otro sitio. Con la regla practica: si el rol pregunta va
  inline; si solo lee y emite veredicto, va como subagente.
- **7 descripciones reescritas** con el patron "usala cuando…": el frontmatter `description` es lo que
  decide si el modelo invoca la skill correcta, y `estado`, `auditoria`, `pendientes`, `ramas`, `sync`,
  `sincronizar` y `forja` describian su implementacion en vez de su caso de uso.
- **Resuelta la colision `sync` / `sincronizar`**: son cosas sin relacion (deltas de specs vs git
  local↔remoto) con nombres casi identicos. Ahora cada una avisa explicitamente de la otra.
- **Afinado el corte de "repo sin adoptar" de 0.45.0**: no basta con que falte `ESTADO.md`, porque un
  repo RECIEN CREADO por el CLI tampoco lo tiene — y ahi el onboarding SI es la tarea. Lo que exime es
  tener **trabajo propio previo** (codigo, paquetes, docs, o mas de un par de ficheros). Sin ese matiz,
  la version anterior dejaba mudo el onboarding de los repos nuevos, que es para lo que existe.

## 0.45.0 — 2026-09-22

- **Un repo que aun NO ha adoptado FARO deja de ser tratado como suyo.** Abrir un repo con historia
  propia y el plugin instalado bastaba para que el harness se considerase duenno: creaba **14
  carpetas** encima (`gestion/`, `documentos/`, `src/`, `borrador/`…) en CADA arranque y sin
  preguntar, e inyectaba en el contexto del modelo *"ONBOARDING — OBLIGATORIO completarlo ANTES de
  cualquier otra tarea: crea ESTADO.md"*. Eso ultimo **se repetia en cada prompt**: el agente no
  decidia adoptar nada, obedecia una instruccion de sistema martilleada turno tras turno.
- **La cadena completa acababa en un callejon sin salida**: el agente creaba `ESTADO.md` estando en
  `develop` → el gate de Stop bloqueaba el turno exigiendo commitearlo → y el propio motor PROHIBE
  commitear en `develop`. El motor creaba el fichero, exigia el commit y lo impedia donde estabas.
- **Faltaba el concepto de "repo adoptado"**, y esa era la causa raiz: solo existian *motor*,
  *template* y **todo lo demas**, que se trataba como instancia de pleno derecho desde el primer
  segundo. Ahora la marca es EXPLICITA y versionada (`.faro.json` o un `ESTADO.md` ya existente).
  Deliberadamente **no** cuenta tener el plugin instalado: eso dice que el USUARIO usa FARO, no que
  ESTE repo quiera ser gobernado por el. Adoptar tiene consecuencias (estructura, faseo, ciclo de
  ramas), asi que es una decision — no un efecto secundario de abrir una sesion.
- **Sin adoptar: no se escribe nada y se OFRECE.** Cero carpetas, cero ficheros, y en vez de la orden
  imperativa una linea que dice lo contrario de lo que decia antes: *"NO es una tarea pendiente y NO
  hay que arreglarlo… si el usuario pide gobernar este repo con FARO, el camino es `/faro:adoptar`"*.
  Tampoco se le dice ya que "falta el funcional" ni que es un "workspace de documentacion, NO de
  codigo" — a un repo con su codigo no le falta nada y no es eso.
- **Pero el analisis NO se pierde: se mueve a BACKGROUND** (`lib/reconocer.js`, via el vigilante).
  Mirar el repo para saber con que se trabaja era util y se queria; lo que sobraba era hacerlo
  BLOQUEANDO el arranque. Ahora el arranque devuelve el control al instante y el retrato llega
  despues como aviso: stack, tamano, estructura, historia (commits/autores/desde) y que trae ya
  (CI, tests, README, licencia). Con eso se puede proponer un plan de adopcion con criterio, en vez
  de a ciegas. Se cuenta **una sola vez por repo**: repetirlo cada sesion seria el mismo martillo con
  otro tono. Y es DESCRIPTIVO por contrato (hay test): dice lo que ve, nunca lo que hay que hacer —
  su salida entra en el contexto del modelo, y ahi un imperativo se ejecuta aunque nadie lo pidiera,
  que es exactamente como empezo este problema.
- **El informe semanal deja de bloquear el turno.** Lo escribe el harness SOLO en cada `SessionStart`,
  asi que bloquear por el es castigar al usuario por algo que hizo el motor — y cerraba un bucle
  perfecto: auto-generar → auto-bloquear → commitear → auto-generar. Sigue apareciendo en el aviso de
  documentos sin commitear, que es donde le toca.
- **Un gate que se saltaba solo, en silencio**: `git status --porcelain` COLAPSA una carpeta nueva
  entera en una linea (`?? gestion/`) en vez de listar sus ficheros, asi que un **informe de cierre de
  fase recien creado no casaba con el filtro y no bloqueaba nada** — justo en el caso mas probable, el
  primer informe del repo. Corregido con `-uall` en `docsSinCommitear()` y en `gitInfo()` (donde
  ademas hace que `dirty` cuente ficheros, que es lo que decia contar).
- El bloqueo del Stop dice ahora **como salir segun la rama**: en `develop`/`main`/ramas de entorno
  avisa de que hay que crear la rama primero (con el comando exacto), porque ahi el motor va a
  rechazar el commit que el propio mensaje esta pidiendo.

## 0.44.0 — 2026-09-22

- **Nuevo `harness.js vigilar --ahora`: comprobar el desajuste `ESTADO.md` ↔ forja a mitad de sesion,
  sin bloquear.** El vigilante solo corre en `SessionStart`, asi que preguntarlo despues obligaba a
  lanzar `session` ENTERO y filtrar su salida con `grep`: **~14s bloqueando el hilo** para sacar dos
  lineas, recalculando todo lo demas por el camino. Ahora la misma comprobacion tarda **~0,8s** y no
  recalcula nada mas. Caso que lo motivo: un repo LEGACY recien adoptado, donde ademas el primer
  arranque no tiene foto anterior con la que comparar, asi que el vigilante calla — y quien pregunta
  se queda sin respuesta.
- A peticion sale **siempre con 0** (lo pide un humano; un exit 2 se leeria como fallo del comando) y
  **siempre responde**, aunque la respuesta sea *"no pude consultar"*. Y lo dice con esas palabras:
  "no lo se" NO es "cuadra" — dar a entender lo segundo seria peor que no contestar.
- **`ramaEsSoloGestion()` deja de ser codigo huerfano.** Existia desde hacia versiones, bien hecha y
  con 8 tests en verde… y NADIE la llamaba: una regla que nadie aplica no es una regla, es codigo que
  promete algo y no lo cumple, con los tests tapandolo. Ahora avisa al abrir el PR si la rama toca
  trabajo (codigo o documentos controlados) y no cita ningun issue. **Avisa, no bloquea**: el PR es el
  final del trabajo, y negarse ahi dejaria algo ya terminado sin poder subirse — el sitio de exigir la
  tarea es al EMPEZAR. Dos tests nuevos vigilan el CABLEADO, no la logica, para que no vuelva a
  quedarse suelta sin que nadie se entere.
- **`stop-check` deja de pagar tres lecturas de git para usar una.** Llamaba a `gitInfo()` (rev-parse
  + config user.name + status) cuando solo usa `dirtyDocs`, y corre al cerrar CADA turno. Ahora usa
  `docsSinCommitear()`: una sola lectura. Misma optimizacion que se hizo en `pre-doc` con
  `ramaActual()`.
- **La suite se queda sin rojo cronico**: los 3 tests de `digestion.test.mjs` que fallaban lo hacian
  porque su `ESTADO.md` de prueba no cumplia reglas de faseo endurecidas DESPUES de escribirlos
  (descripcion de fase, `#N` y `@owner`), no por el ciclo de digestion. Se arregla el helper, no se
  bajan las aserciones. Una suite con rojo permanente ensena a ignorar el rojo.

## 0.43.0 — 2026-09-22

- **Nuevo `harness.js triaje` y `/faro:triaje`: lo que llega de fuera se JUZGA, no se clasifica.**
  Etiquetar un reporte como bug/idea/sugerencia no decide nada. La pregunta cara es la segunda —
  *¿merece la pena hacerlo, y por que si o por que no?*— y sin esa respuesta ESCRITA el Backlog solo
  crece: descartar sin motivo se siente arbitrario, asi que nadie descarta, y un backlog que solo
  crece deja de leerse. Ahora cada reporte recibe un veredicto **con el motivo publicado en el propio
  issue**, incluidos —sobre todo— los que NO se van a hacer.
- **El veredicto se justifica contra algo escrito, nunca contra la opinion del agente**: el fuera de
  alcance del funcional, los requisitos (REQ-NN con estado) y los ADR. Y cuando no hay nada escrito
  que aplique, el veredicto **no es "no aplica": es "falta decidir"**. Esa tercera salida es lo que
  impide que el agente invente un criterio con tal de no quedarse callado.
- **Los ADR pasan a validarse por CONTENIDO, no solo por la ficha.** Hasta ahora se comprobaba el
  frontmatter (`status`, `deciders`, linaje) y nada mas, asi que un ADR de dos lineas pasaba. Se
  exigen las **4 secciones** (las 3 obligatorias de MADR + **Consecuencias**): sin *Alternativas
  consideradas* no se puede saber si algo se valoro y se descarto o si nadie lo penso —son opuestos—,
  y sin *Consecuencias* no se distingue un fallo de un precio aceptado a sabiendas. Las otras 5 de
  MADR quedan opcionales a proposito: un ADR de 9 secciones cuesta media hora y a la tercera decision
  nadie lo escribe. Plantilla nueva en `docs/plantilla-adr.md`.
- **Lo legacy no se rompe.** Los ADR anteriores al 2026-09-22 (fecha que ya viaja en el nombre del
  fichero: cero estado que guardar) **avisan pero no bloquean**. Si al actualizar el motor un repo con
  historia viera `validate` en rojo por decisiones de hace meses, el reflejo seria desactivar la regla
  — y se perderia tambien para las nuevas. Se completan PREGUNTANDO, en los dos momentos en que sale
  barato: al editar ese ADR, y cuando el triaje necesite citarlo.
- **Con un ADR incompleto el triaje no finge un veredicto: PIDE lo que falta** (`falta-criterio-adr`),
  con la pregunta ya redactada. Se responde una vez y el proximo reporte parecido ya no pregunta.
- **Repos que adoptan FARO con historia previa**: ahi el problema no es que los ADR esten incompletos,
  es que no hay ninguno —las decisiones se tomaron, el codigo las demuestra, pero nunca se
  escribieron—. `triaje --criterio` diagnostica cuanto criterio hay y trae las preguntas hechas;
  `adoptar` las usa para sembrarlo. Sin eso, el triaje solo puede responder "falta decidir" a todo.
- **El `Fuera de alcance` del funcional deja de ser un encabezado vacio.** El contrato del tipo FUN ya
  lo exigia como seccion (y lo listaba como error tipico no declararlo), pero nadie comprobaba que
  tuviera algo debajo. Ahora `validate` avisa si falta o esta vacio, y los marcadores (`TBD`,
  `pendiente`) no cuentan como criterio. Es la exclusion mas barata de escribir —tres lineas— y la que
  mas veredictos justifica.
- **Ni el fuera de alcance ni los ADR los rellena el agente.** Dicen que se decidio y por que, y eso
  solo lo sabe quien estuvo: `redactor-documento` PREGUNTA el fuera de alcance al escribir un FUN, y
  `adoptar` pregunta las decisiones. Un apartado vacio es honesto; uno fabricado convierte en decision
  algo que nadie decidio, y encima lo hace citable.

## 0.42.0 — 2026-09-22

- **Nuevo `harness.js vigilar`: el harness ya puede avisar de lo que necesita RED, sin bloquear.** Era
  un muro con el que se choco tres veces: `session` y `validate` son SINCRONOS y no tocan la red a
  proposito (volverlos asincronos los haria lentos y fragiles en CI y en cada hook de escritura), asi
  que el aviso de desajuste `ESTADO.md` ↔ forja acabo desterrado a `consolidar`/`publicar` — donde
  solo se ve si alguien invoca esos comandos. Ahora corre en **background** desde `SessionStart` con
  el campo `asyncRewake` del handler: consulta la forja por detras y **despierta al agente** (exit 2 +
  stderr) solo si encuentra algo.
- **Silencio cuando todo cuadra**, y es lo mas importante del diseno: un aviso que salta siempre se
  aprende a ignorar, y entonces deja de avisar de nada — la evidencia sobre *alert fatigue* es dura
  (~62% de las alertas se ignoran por volumen). Sin desajustes sale con 0 y nadie se entera de que
  esto corrio.
- **Y no avisa en falso**: sin red, sin token o sin forja no se puede saber nada del estado real, y
  "no pude mirar" NO es "esta mal". En ese caso calla. Hay test para cada uno de esos casos.
- El calculo se extrae a `calcularDesajustes()` y lo comparten las dos vias: el vigilante en
  background y el aviso de `consolidar`/`publicar`, que se mantiene. Doble via a proposito — si
  `asyncRewake` no estuviera disponible en una version, el aviso sigue llegando por donde ya llegaba.



## 0.41.0 — 2026-09-22

- **Escribir un fichero deja de costar el doble de lo necesario.** El hook que corre en CADA
  `Write`/`Edit` (`pre-doc`) llamaba a `gitInfo()`, que hace TRES lecturas de git —`rev-parse`,
  `config user.name` y `status --porcelain`— cuando lo unico que necesita es saber **en que rama
  estas**, para decidir si esa rama esta protegida. Las otras dos se pagaban en cada escritura sin
  usarse. Nuevo `ramaActual()` (`lib/git.js`): una sola llamada, y si alguien ya pidio `gitInfo()`
  reutiliza su resultado en vez de preguntar otra vez.
  Medido en la maquina de desarrollo: escribir un fichero pasa de **583 ms a 332 ms**; descontando el
  suelo de arrancar Node, el trabajo real cae de ~414 ms a ~196 ms — **menos de la mitad**. En una
  sesion de trabajo intensivo son decenas de segundos. En maquinas con antivirus de endpoint (donde
  arrancar Node ya cuesta ~550 ms) el ahorro absoluto es mayor.
  El gobierno NO se relaja: lo que bloqueaba sigue bloqueando (verificado con los tests de ramas
  protegidas y de guardas).
- **Quitado un aviso duplicado.** El de nombrado fuera de convencion se emitia DOS veces por la misma
  escritura: en `pre-doc` (antes de escribir, que es cuando sirve — "corrige el nombre antes") y otra
  vez en `doc-check`, ya con el fichero en disco. Se queda solo el primero. Las tres carpetas con
  regla de nombrado (`brainstorming/`, `decisions/`, `informes/`) pasan siempre por el aviso previo,
  asi que no se pierde cobertura.

- **Fix: el almacen de credenciales PERDIA TOKENS.** Reproducido, no teorico. `~/.faro.json` lo
  escriben varios sitios con el patron leer → modificar → escribir (tokens, cache de rol, resumen de
  la forja, identidad, agregado de ramas), y entre la lectura y la escritura pueden pasar **segundos**
  — el refresco en background invoca `ramas.js --json`, 6,6s medidos. Si el usuario se autenticaba en
  esa ventana, el refresco terminaba y escribia **su** copia del objeto, leida antes de que el token
  existiera: **la credencial desaparecia**. El sintoma en produccion seria *"me desconecta cada dos
  por tres, tengo que volver a autenticarme"*, y nadie lo relacionaria jamas con el resumen de ramas
  del arranque de sesion. Paso todos los tests existentes: no habia ninguno de concurrencia.
- **Nuevo `lib/json-seguro.js`: utilidad GLOBAL de escritura segura de JSON compartido.** No vive
  escondida en credenciales porque el problema no es exclusivo suyo — cualquier fichero que compartan
  varios procesos lo tiene. Resuelve los dos fallos, que son distintos aunque se den juntos:
  - **Fichero a medias**: un `writeFileSync` interrumpido dejaba el JSON truncado y se perdia TODO,
    no solo lo que se escribia. Ahora se escribe a temporal y se **renombra** (atomico en el mismo
    volumen): o esta el fichero viejo entero, o el nuevo entero.
  - **Perdida por copia obsoleta**: se **relee justo antes de escribir** y se fusiona, asi lo que el
    escritor no conocia se conserva. Conservador a proposito: fusion solo al primer nivel de claves,
    nada de merge profundo — mezclar en hondo objetos que no conoces inventa estados que nadie diseno.
  - Y sigue siendo posible **borrar**: se distingue "esta clave no estaba cuando lei" (de otro, no se
    pisa) de "la lei y la quite" (borrado querido). Sin esa distincion, la fusion haria imposible
    eliminar un token.
- Tests de **concurrencia**, que no existian: es el unico estado global mutable del motor y por eso
  el bug paso desapercibido. 6 sobre el almacen (incluida la carrera exacta que perdia el token) y 13
  sobre la utilidad global.

## 0.40.0 — 2026-09-22

- **Nuevo `harness.js cerrar-fase <N>` y `/faro:cerrar-fase`: la ceremonia de cierre, cableada.** Era
  el ULTIMO hueco del ciclo: todo lo demas esta atado punta a punta (`rama` -> `terminar` ->
  `consolidar` -> `publicar`), pero cerrar una fase eran cuatro pasos manuales que nadie ataba —
  marcar los checkbox, escribir el informe, editar `ESTADO.md` a mano (estado `done` + avanzar
  `fase_actual`) y taguear. El propio `publicar` terminaba pidiendole al humano que lo hiciera.
  Ahora es un acto: **valida primero** (tareas cerradas, informe presente, y que la FORJA confirme que
  esas tareas estan realmente cerradas — un `[x]` con su issue abierto no cuela), **dice de una vez
  TODO lo que falta** en vez de mandarte a arreglar de uno en uno, y solo con `--confirmo` escribe.
- **Primer comando que ESCRIBE el faseo.** Hasta ahora el harness solo leia `ESTADO.md` (solo el
  onboarding lo creaba), y es la fuente de verdad del trabajo: una reescritura torpe lo destruye todo.
  Por eso `cerrarFaseEnTexto` (`lib/estado.js`) es una funcion PURA fijada con tests que comprueban
  que **cambia exactamente dos lineas** —la cabecera de la fase y `fase_actual`— y deja el resto byte
  a byte: tareas, checkbox, resumenes, descripciones, objetivos, `[cu:...]` y el resto del
  frontmatter. Tambien se verifica que el `ESTADO.md` resultante sigue pasando `validate`.
- El tag `fase-N` pasa a crearse de verdad: se anunciaba como requisito de cierre en el codigo pero
  `validateEstado` no lo validaba — era solo un recordatorio. El hito lo cierra `syncHitos`, que ya
  sabia hacerlo y trae su cierre forzoso (no cierra un hito con tareas abiertas dentro: avisa).
- **No reabre fases ni crea fases nuevas**, por diseno: una fase cerrada es historico y reescribirla
  falsearia lo que paso. El trabajo que llegue despues va a la fase actual (con `--origen-fase <N>`
  para dejar constancia de donde viene) o al `Backlog`.

## 0.39.0 — 2026-09-22

- **Fix: la documentacion citaba `aprobar`, un comando que ya no existe.** Al renombrarse a `publicar`
  (0.37.0) se retiro del despachador sin alias, pero quedaron citas vivas: la skill `/faro:publicar`
  llegaba a afirmar que *"aprobar sigue funcionando como alias"* (falso, y ademas la frase se
  autocontradecia al decir que "antes se llamaba `/faro:publicar`"), y `faro-schema.json` citaba
  "harness.js hito sync y aprobar". Quien las siguiera al pie de la letra ejecutaba un comando
  inexistente justo en el ultimo paso del ciclo.
- **Nuevo test de coherencia documentacion <-> despachador** (`test/coherencia-docs-comandos.test.mjs`):
  extrae los `harness.js <cmd>` citados en `skills/*/SKILL.md`, `agents/*.md` y `faro-schema.json`, y
  falla si alguno no existe entre los subcomandos reales. Es la causa raiz de lo anterior: nada
  impedia que un renombrado dejara la documentacion apuntando al vacio. Cubre tambien las citas
  encadenadas ("harness.js X y Z", donde Z se colaba sin revisar) y fija que no se vuelva a prometer
  el alias retirado.

- **`consolidar` y `publicar` avisan cuando ESTADO.md y la forja NO dicen lo mismo.** Un checkbox
  marcado `[x]` cuyo issue sigue ABIERTO es trabajo que se dio por hecho sin salir; un issue CERRADO
  sin marcar es trabajo hecho que el faseo no refleja. Las dos direcciones enganan a quien lee el
  estado. `contabilidadFase` ya detectaba esto y tenia 6 tests, pero **ningun comando la invocaba**:
  era codigo muerto. Nuevo `desajustesDelFaseo` (`lib/ciclo.js`) que recorre las fases ABIERTAS (las
  cerradas son historico) y agrupa lo que no cuadra; se asoma en los dos momentos donde aun se puede
  corregir. AVISA, nunca bloquea: detectar no es decidir, y puede haber motivos legitimos. Sin
  token/red/forja no se inventa nada — un issue que no se pudo consultar simplemente no cuenta.
  (Se descarto ponerlo en `validate` y en el resumen de sesion: ambos son sincronos y sin red, y
  volverlos asincronos por esto los haria lentos y fragiles en CI y en cada hook de escritura.)
- **Retirado el aviso "develop lleva N commit(s) sin pasar a main".** Publicar es BAJO DEMANDA — `main`
  es el RELEASE y puede agrupar varios ciclos —, asi que no haber publicado NO es una deuda: es el
  estado normal. El aviso venia del modelo viejo (cuando aprobar iba pegado a cada ciclo) y su
  lenguaje de "pendiente" empujaba a publicar por quitarselo de encima, justo lo que 0.37.0 quiso
  evitar. La senal util no es CUANTOS commits llevas sin publicar, sino si lo acumulado esta APTO para
  promocionar — y eso se responde cuando alguien lo pregunta (`release`, `publicar`), no dando la lata
  en cada `validate`.

- **Fix: "no pude consultar" se trataba como "ya esta cerrada", y en silencio.** El cierre activo de
  tareas hacia `if (est !== 'open') continue`, y ese `continue` tragaba por igual la tarea ya cerrada
  (lo normal) y la que NO se pudo consultar — sin red, con el token caducado o con el limite de la API
  agotado. Resultado: la tarea se quedaba ABIERTA indefinidamente y nadie se enteraba. Nuevo
  `planCierreDeTarea` (`lib/ciclo.js`) que separa los tres casos: abierta -> cerrarla; cerrada -> nada
  y en silencio (es lo normal, anunciarlo seria ruido); **no se pudo mirar -> NO cerrarla, pero
  DECIRLO**, nombrando la tarea y como cerrarla a mano. Ante un estado inesperado avisa, nunca da por
  cerrada: dar por cerrada una tarea viva es el error caro.
- Mismo criterio en los otros dos puntos que consultan la forja: la deteccion temprana de `consolidar`
  ahora dice que la ligadura **no queda comprobada** en vez de dejar creer que salio limpia, y la
  guarda de `publicar` avisa de lo que no pudo verificar **sin cancelar** — cancelar por estar sin red
  dejaria sin publicar, y publicar es la accion que mas cuesta reintentar.
- **README al dia.** Citaba `/faro:aprobar` (retirado en 0.37.0) tres veces, una de ellas en el **flujo
  central** — lo primero que lee alguien nuevo, con el ultimo paso inexistente. Ademas: el flujo ahora
  distingue consolidar (cierra el ciclo en develop) de publicar (el release, agrupa ciclos, bajo
  demanda); el ciclo git rigido documenta que bloquea **al editar** y que aplica **tambien al propio
  motor**; y nueva seccion del faseo con el formato que exige `validate` — `Objetivo:` obligatoria y el
  estado `draft` de fase, distinguido del `draft` de documento.

## 0.38.0 — 2026-09-20

- **Fix: editar con Edit/Write en `develop`/`main` del propio MOTOR pasaba sin ningun aviso.** El gate
  de ramas protegidas (`deny()` + auto-crea la rama correcta) y la exencion de ESTADO.md/onboarding del
  modo motor vivian fusionados en un solo `esInstancia`: sin querer, el motor quedaba exento de AMBOS,
  no solo del segundo (que es lo unico que no le aplica — el motor no gestiona un trabajo propio con
  fases). El gate solo actuaba mas tarde, en `git commit` — con cambios ya acumulados en la rama
  equivocada. Separados los dos criterios: el motor SIGUE exento de ESTADO.md/onboarding, pero ahora
  protege sus ramas igual que cualquier repo de trabajo (solo el modo TEMPLATE queda exento de esto,
  por diseno: los `template-*` SON el estandar y se editan directo).
- **`harness.js consolidar` declara el ESTADO "listo para publicar" en una linea inequivoca, en vez de
  una sugerencia perdida en prosa.** El unico rastro de que `develop` estaba listo para pasar a `main`
  era "Estados actualizados... /faro:publicar." en medio de mucho output — facil de saltarse en un loop
  autonomo o una consolidacion ruidosa (reportado: un agente en loop paro el trabajo sin que el usuario
  llegara a ver la senal con claridad). Ahora, tras integrar y subir, si `develop` queda por delante de
  `main` y `validate` pasa en verde, imprime `ESTADO: develop LISTO para publicar (...)  `. NO pregunta
  ni ejecuta `publicar`: sigue siendo una decision del usuario, bajo demanda — solo hace el aviso
  imposible de pasar por alto. `publicar` sigue exigiendo su propio `AskUserQuestion` (accion
  irreversible sobre produccion); en loop autonomo, ese punto de espera ahora usa `PushNotification`
  para avisar activamente en vez de dejarlo solo en texto de chat.
- Nuevo `invalidarFlow()` en `lib/git.js`: `gitFlow()` cacheaba el estado de las ramas y, tras un merge
  o push dentro de la misma invocacion, seguia devolviendo el estado de ANTES — mismo patron que
  `invalidarEstado()` ya tenia para `ESTADO.md`.
- **La fecha objetivo de una fase pasa a ser OBLIGATORIA (`Objetivo: AAAA-MM-DD`), y la estimacion por
  tarea de PLAN se AVISA cuando falta.** Ninguno de los dos dato se pedia antes en ningun flujo: el
  `due_on` del hito solo se reflejaba SI ya estaba escrito a mano en ESTADO.md, y `--estimacion` (nativo
  de GitLab) era opcional y silencioso. `huecosDeFase` ahora exige 'Objetivo:' en toda fase abierta
  (tambien en `draft`: la fecha no depende del hito, la decide el equipo antes de que exista). La fecha
  NO es rigida en su VALOR — se reajusta libremente si cambia el alcance ('hito sync' actualiza el
  `due_on` cuando difiere) — solo se exige que EXISTA. La estimacion sigue siendo 100% opcional y
  flexible: solo se avisa (nunca bloquea) cuando una tarea de tipo PLAN nace sin `--estimacion`; una
  tarea que SURGE (bug/infra/pregunta) no la pide, porque no estaba planificada.

## 0.37.1 — 2026-09-20

- **Fix: el onboarding pedia escribir el faseo SIN #N, pero `validate` bloqueaba (exit 1) cualquier
  fase abierta sin #N — dependencia circular real (no se podia pasar `validate` del PR de arranque sin
  #N, y no habia #N sin ese PR ya integrado y `hito sync` corrido). Nuevo estado de fase `draft`: la
  fase existe en el papel pero su hito aun no se ha creado en la forja; `huecosDeFase` exime #N/@usuario
  ahi (no pueden existir todavia) pero sigue exigiendo descripcion y >=1 tarea. El onboarding ahora
  pide `— draft` en vez de `— pending`, y avisa de pasar a `pending` al asignar las tareas (`hito sync`
  -> `asignar-tarea`). `pending`/`backlog` siguen exigiendo #N como antes (RIGIDO, sin cambios).

## 0.37.0 — 2026-09-19

- **Un requisito de spec viva se DEMUESTRA, no se declara: nuevo `harness.js specs evidencia`.**
  `validate` comprobaba coherencia DOCUMENTAL (que el proposal cite una fase que existe, que el cambio
  traiga deltas...) pero nadie comprobaba que el codigo cumpla lo que la spec dice. Cada requisito
  declara su prueba con una linea `Evidencia: test/<fichero>` bajo el; el comando audita cuales faltan
  o apuntan a un fichero que no existe. Va aparte de `validate` a proposito, sin bloquear: un repo con
  specs maduras y sin tests aun veria su CI roto de golpe, y eso empuja a borrar requisitos en vez de
  escribir tests. El recuento se asoma en el resumen de sesion y en `specs validar`.
- **El cambio queda LIGADO a su decision (`decision:` en el proposal) — y es OBLIGATORIA si toca codigo.**
  Eran dos piezas que ya existian y no se hablaban: el `proposal.md` dice el QUE, y el ADR de
  `gestion/decisions/` dice el POR QUE tecnico (que enfoque se eligio y contra cuales). Sin enlace, ese
  razonamiento se perdia entre los dos y quien retomaba el trabajo — persona o agente — lo reinventaba,
  o lo contradecia sin saberlo. `validate` lo exige y comprueba que el ADR existe (cita corta admitida;
  si resulta ambigua, lo dice en vez de elegir por su cuenta). Un cambio documental u organizativo, o
  con `sin_spec: true`, queda fuera: no toda edicion arrastra una decision de arquitectura.
- Limpieza de nomenclatura: varios comentarios describian el motor spec-driven como "openspec" y
  contradecian al propio manifiesto ("spec-driven es NATIVO del harness; NO hay openspec"). El motor es
  PROPIO — se corrige el texto. (La deteccion de una carpeta `openspec/` en repos ajenos se mantiene:
  eso es funcional, sirve para adoptarlos.)

- **`aprobar` pasa a llamarse `publicar` — y el release deja de ir pegado a cada ciclo.** El nombre viejo
  describia el PERMISO, no el acto: lo que ocurre es que el trabajo sale a produccion. `/faro:aprobar` y
  `harness.js aprobar` **ya no existen** (sin alias ni codigo muerto: la skill vieja se borra y el
  subcomando desaparece del despachador).
- **Publicar es BAJO DEMANDA, nunca automatico.** Los ciclos se cierran del todo en `develop` — ahi se
  integran las ramas, se cierran las tareas y se archivan los cambios — y `main` es el RELEASE, que
  puede agrupar varios ciclos y se hace cuando alguien lo decide. Antes 'aprobar' hacia cinco cosas a la
  vez (validar, archivar, mergear, taguear, publicar), asi que no se podia cerrar un ciclo sin publicar.
- **Nuevo `harness.js release`: el REGISTRO de desde donde se publico lo anterior.** Solo lee, y dice
  desde que tag, cuantos cambios lleva acumulados, cuales, y que version tocaria — MAJOR si algo rompe,
  MINOR si hay funcionalidad, PATCH si solo son correcciones. Publicar a produccion sin esto es a
  ciegas: nadie sabe que lleva encima ni desde cuando. `publicar` lo imprime antes de tocar nada.
- Soporte de la seccion `[Unreleased]` del estandar Keep a Changelog: cada ciclo deja ahi su nota y al
  publicar ese bloque pasa a ser la version, dejando la seccion lista para el siguiente. Es el mismo
  patron del "release PR" (release-please) y de changesets: **releases intencionales**, no una por cada
  cosa que se integra.

## 0.36.4 — 2026-09-19

- **Una tarea es un ENTREGABLE DE VALOR y ALBERGA su desglose: `--subtarea "<texto>"` (acumulable).**
  El trabajo es agentico — un agente se come un bloque entero de una sentada —, asi que la unidad
  natural es la tarea amplia con sus subtareas DENTRO (checkboxes en el cuerpo del issue), no once
  issues de un rato que ensucian el hito y dejan ramas que nadie cierra. El marco amplio es lo que
  permite al agente afrontar el bloque sin perder el hilo: que entrega, que lleva hecho y que falta,
  todo en un sitio. Si el trabajo nuevo encaja en una tarea ABIERTA se AMPLIA esa, en vez de crear
  otra — sobre todo cuando lo unico que cambia es quien la hace.
- **El criterio se aplica en los DOS caminos, no solo en uno.** Al MIGRAR un repo existente
  (`skills/migrar-tareas` agrupa los checkboxes en bloques ANTES de crear, y una fase de 11 pasos son
  2-4 issues, no 11) y al CREAR desde cero (`skills/iniciar` y `skills/gestion-proyectos`: cada
  checkbox de `ESTADO.md` nace ya como entregable, porque es la semilla del issue).
- **RIGIDO en los estados: el formato de `ESTADO.md` pasa de convencion a ERROR de `validate`.** Toda
  fase ABIERTA debe traer su **descripcion** (que trae la fase — sin ella es solo un titulo) y, por
  entregable, su **id** (`#N` o `[gh:N]`/`[gl:N]`; sin el no esta en la forja y nadie lo ve ni lo cierra),
  su **responsable** (`@usuario`) y un **titulo GENERAL** (un titulo que es un paso delata troceo). Las
  fases cerradas quedan fuera: son historico y reescribirlas seria falsear lo que paso.
- **Y llega al CONTEXTO DEL AGENTE en cada prompt, no solo a quien ejecute `validate`.** Si el agente no
  lo ve, no lo rectifica — y el `ESTADO.md` se degrada sin que nadie lo note. El aviso trae el formato
  exacto a seguir, agrupado por fase con su recuento (un `ESTADO.md` con 5 tareas sueltas daba 10 lineas
  de ruido; ahora da una por problema).
- **La rigidez es del GOBIERNO, no del contenido.** El issue es flexible a proposito: el agente que
  trabaja un entregable amplio y encuentra algo mas lo anade como subtarea a ESE issue, sin abrir otro.
  Lo que no se negocia es el faseo: id, responsable, descripcion y ciclo.
- **REPARTO `ESTADO.md` <-> forja: cada cosa en UN solo sitio.** `ESTADO.md` RESUME (que se pretende en
  la fase + una linea por entregable con id y dueno) y el issue guarda TODO el detalle. Lo duplicado se
  desincroniza — exactamente lo que paso: checkbox marcado, issue abierto.
- **Estructura del issue, validada al crearlo (`asignar-tarea`).** Un issue lo coge una persona **o un
  agente**, y un agente no pregunta: lee lo que hay y rellena los huecos suponiendo. Se avisa si el
  cuerpo no trae objetivo, contexto, alcance, **fuera de alcance** (lo que evita que se expanda solo),
  subtareas y criterios de aceptacion observables — y se imprime la plantilla del tipo para
  completarlo. Mismo esqueleto para bug, feature y tarea, con el acento propio de cada uno: el bug se
  reproduce, la feature sirve a alguien, la tarea entrega algo.
- **Los tipos que SURGEN estan exentos de la regla de amplitud.** Un bug que llega es un bug y ya esta:
  no se agrupa ni se fuerza a ser amplio. Agrupar solo tiene sentido donde el troceo es una DECISION
  (lo que se planifica); en lo que aparece, el alcance lo fija el propio hallazgo.
- **Contabilidad por fase contra la forja, no contra el fichero.** Cuantos entregables trae, cuantos
  estan creados, abiertos y cerrados — y los DESAJUSTES: un `[x]` con su issue abierto, o un issue
  cerrado que sigue sin marcar.
- **El cambio spec-driven queda LIGADO a su tarea (`issue:` en el frontmatter del proposal).** Eran dos
  mundos sueltos: el cambio conocia su fase y sus tareas de `ESTADO.md`, pero no QUE tarea lo ejecuta —
  asi se podia archivar un cambio con su tarea todavia abierta, o darlo por `implementada` con solo los
  checkboxes marcados. Lo escribe `asignar-tarea <slug>` sola, al crear la tarea del cambio.
- **El ciclo se cumple en DEVELOP, y ahi se cierra de verdad.** `/faro:consolidar` deja de confiar en que
  la forja hiciera su parte: por cada rama integrada, si su tarea sigue abierta la CIERRA (con nota de
  que su trabajo ya esta en develop). El `Closes #N` solo cubre la peticion de SU rama — una integrada
  por merge directo, o varias consolidadas de golpe, dejaban tareas vivas con el trabajo ya dentro.
  Ademas avisa alli mismo de los cambios `implementada` cuya tarea no cuadra: barato de arreglar en
  develop, caro cuando ya estas aprobando.
- **Y el ultimo cierre es estricto: `/faro:aprobar` NO archiva un cambio con su tarea abierta.** Archivar
  es declarar el trabajo terminado; si la forja dice que sigue vivo, se cancela la aprobacion sin tocar
  `main`. Si no se pudo consultar la forja (sin red, sin token) no se bloquea nada: "no pude mirar" no
  es "esta mal".
- **`harness.js terminar`: UNA orden cierra el ciclo de la rama, en vez de cuatro encadenadas de memoria.**
  Commitea lo que quede sin guardar, valida y abre la peticion (con su `Closes #N`, asi que la tarea se
  cierra sola al integrarse). Sin `--confirmo` solo ENSENA el plan y no toca nada — abrir una peticion
  se ve fuera. Cancela si la validacion falla, y se niega cuando no hay ciclo que cerrar: rama
  protegida, ya integrada, o con peticion ya abierta (te da su enlace en vez de abrir otra).
- **Aviso nuevo `⚠ CICLO SIN CERRAR`: el harness deja de MARCAR sin LIMPIAR.** Si la fase se queda sin
  tareas abiertas pero su rama no se ha integrado, el trabajo esta hecho y no ha salido: la tarea
  sigue abierta y la fase sin cerrar, indefinidamente. Paso de verdad en un repo y nadie lo noto
  (11 tareas en `[x]`, rama sin PR, issue abierto). Ahora salta en cada prompt y dice como cerrarlo.

## 0.36.3 — 2026-09-19

- **El PR CIERRA su tarea solo: `Closes #N` lo pone el harness, no tu.** `rama ... --issue N` bautiza
  la rama `<tipo>/<N>-<slug>`, asi que el numero ya viaja en el nombre — `pr crear` lo extrae y lo
  inyecta en el cuerpo. Hasta ahora el harness te RECORDABA escribirlo y, si nadie lo hacia, el PR se
  fusionaba, el trabajo entraba en develop y la tarea se quedaba abierta para siempre (paso de verdad:
  hubo que cerrar una a mano). Es idempotente (no duplica si ya estaba) y, si la rama no esta anclada
  a ninguna tarea, avisa de que ese PR no cerrara nada.
- **Un issue es un ENTREGABLE DE VALOR: no atomizar.** La jerarquia queda escrita donde se usa
  (`asignar-tarea`, directiva de faseo del onboarding y skill `tareas`): fase = hito (meses) → issue =
  entregable con SU rama y SU peticion (dias) → subtarea = checkbox dentro (horas). "Personalizacion e
  identidad" es UN issue con la marca, los colores y las traducciones dentro; no tres issues de un
  rato que ensucian el hito y dejan ramas que nadie cierra. Ante la duda, agrupar — y si el trabajo
  encaja en un issue ABIERTO, ampliar ese en vez de crear otro, sobre todo cuando solo cambia quien
  lo hace. Los bugs quedan fuera de la jerarquia, como ya estaban (`--fase` opcional, `--origen-fase`).

## 0.36.2 — 2026-09-19

- **El onboarding ABRE SU RAMA y dice DONDE TERMINA.** Escribe `ESTADO.md` y `risks.md`, asi que
  necesita rama antes de empezar: si arrancas en `develop`/`main`, el paso 0 es ahora
  `rama chore "inicial"`. Sin eso el agente empezaba la entrevista en `develop` y el gate le frenaba
  a media faena, con el faseo ya a medio escribir. `chore` porque el arranque es andamiaje — y es el
  unico prefijo exento de `--issue`: todavia no hay issues, ni puede haberlos.
- **Y un final explicito: el onboarding acaba en `ESTADO.md` + `risks.md` + PR a develop.** Nada de
  cambios, specs, `tasks.md` ni issues hasta que el arranque se integre y corra `hito sync`: las fases
  NO existen como hitos antes de eso. Sin ese corte el agente encadenaba de largo y abria un cambio
  anclado a una fase que aun no estaba en la forja.
- **Nuevo gate `[ciclo]`: un cambio no puede declarar una fase que no existe.** `validate` contrasta
  la `fase:` del `proposal.md` contra el faseo de `ESTADO.md` y falla si no esta, diciendo que fases
  hay. Es el hermano local de `hito auditar`: si la fase no existe en `ESTADO.md`, tampoco tendra
  hito donde anclarse. `fase: backlog` sigue siendo valido (es la sala de espera declarada) y un
  cambio sin fase no dispara nada.

## 0.36.1 — 2026-09-19

- **Nuevo `hito auditar`: barrido de TODO el trabajo abierto, no solo lo que crea el harness.** Un
  issue abierto desde la web, por un bot o por integracion externa no pasa por `--fase`/`--issue` y
  nace huerfano sin que nadie lo note. Recorre TODOS los issues abiertos (paginando hasta agotarlos)
  y los reparte en dos secciones, ordenadas de menor a mayor numero, bajo el mismo principio: una
  tarea se debe CERRAR, no olvidarse.
  - **Huerfanos** (sin hito): `mover-tarea <N> --fase <M|backlog>` para anclarlos.
  - **Olvidados** (con hito, pero >=30 dias sin tocarse): bien anclado no basta si nadie lo cierra.
    `cerrar-tarea <N>` si esta hecho, `descartar-tarea <N> "<motivo>"` si no se hara.
  Los de tipo cierre (duplicado/descartado) no cuentan como huerfanos: cerrar no es planificar.
- **Verificado y fijado con tests: cada comando opera SOLO sobre el repo del directorio actual.**
  `ghRepo()` deriva siempre de `git remote get-url origin` leido en el momento — sin cache entre
  invocaciones ni parametro que permita apuntar a otro repo. Tres tests fijan la garantia: dos
  invocaciones consecutivas con remotos distintos no se mezclan, y `forge.detect()` se recalcula en
  cada llamada sin memorizar el remoto anterior.
- Documentado en `skills/tareas` y `agents/gestor-forja`, corrigiendo de paso una referencia a
  `--fase` opcional que habia quedado desactualizada tras 0.35.0/0.36.0.
- Cubierto por `test/auditar-issues-sin-hito.test.mjs` (8) y
  `test/hito-auditar-repo-correcto.test.mjs` (3). Suite completa: 394/394.


## 0.36.0 — 2026-09-19

- **Un repo SIN version no podia aprobar.** Caso real: un repo de gestion/documentacion —la raiz
  autonoma de un trabajo, sin `package.json` ni `.claude-plugin/plugin.json` porque no es un paquete
  ni un plugin— quedaba atascado: `versionActual()` devolvia null y el gate de coherencia
  CHANGELOG<->version **cancelaba la aprobacion entera** con el mensaje *"nada que comprobar"*, que se
  contradecia a si mismo. Ahora sin version el chequeo **NO APLICA**: el ciclo sigue, no se tagea
  (`tagVersionSiProcede` ya lo trataba bien) y se **avisa** de que sin version no habra tag ni Release
  —no quedara un punto al que volver— con la via para activarlo. Lo que SI sigue bloqueando: hay
  version y el CHANGELOG no la documenta.
- **Una rama solo existe si hay un issue detras: ahora se BLOQUEA, no se avisa.** Primero se define
  QUE se quiere (el issue, con su tipo y su fase) y luego se abre la rama para atenderlo. El mensaje
  da los dos comandos listos: crear la tarea y abrir la rama con `--issue <N>`. Dos exenciones, por
  imposibilidad y no por comodidad: los prefijos de GESTION (`chore/`) y los repos sin `ESTADO.md`
  (nivel 0), donde no hay fases a las que anclar nada.
- **TRABAJO vs GESTION.** Archivar un cambio, bumpear la version o actualizar `ESTADO.md` tras aprobar
  son CIERRE DE CICLO: el final de trabajo que YA tuvo su issue. Pedirles uno propio seria una tarea
  para cerrar otra tarea. `chore/` no lo pide, y se dice POR QUE para que no parezca un olvido.
- `ramaEsSoloGestion()`: decide por lo que CAMBIA, no por el prefijo — un `chore/` puede acabar
  tocando `src/` (y entonces es trabajo) y un `docs/` puede ser solo un informe de fase (y entonces
  no). Gestion = `gestion/`, `CHANGELOG.md`, `ESTADO.md` y el fichero de version; todo lo demas
  —codigo, hooks, tests, documentos controlados— es trabajo. Sin diff no se exime: no hay evidencia.
- **`/faro:aprobar` PREGUNTA antes de lanzar la revision de coherencia** en vez de darla por hecha:
  tarda varios minutos y un cambio que solo toca gestion no la necesita. Se recomienda cuando el
  cambio toco `src/`; un NO APTO sigue impidiendo aprobar.
- Test de seguridad `aprobar --confirmo`: la ventana de inspeccion pasa de 6.000 a 20.000 caracteres.
  Empezo a fallar solo porque `cmdAprobar` crecio, sin que el gate se moviera — un falso positivo que
  habria hecho dudar de la seguridad en vez del test. Lo que se comprueba es el ORDEN, no la cercania.
- Cubierto por `test/repo-sin-version-aprueba.test.mjs` (6), `test/gestion-no-pide-issue.test.mjs` (9)
  y `test/pr-exige-issue-si-toca-codigo.test.mjs` (8, con repos git reales en disco).


## 0.35.0 — 2026-09-19

- **El gate CONTRADECIA a la propia skill de migracion.** `/faro:migrar-tareas` manda sustituir los
  checkboxes de cada fase por un puntero a su hito, pero `validate` exigia que toda fase tuviera al
  menos una tarea `- [ ]`: seguir la skill publicada dejaba el repo en `VALIDACION: 1 error`. Ahora
  las tareas deben estar **en algun sitio** —checkboxes (modelo clasico) o el hito de la fase (modelo
  migrado, declarado con `Tareas: ver hito...` o `Hito: #N`)—, y una fase sin tareas en NINGUNO sigue
  siendo un error.
- **Regla dura: TODO issue cuelga de un hito, tambien los que SURGEN.** Hasta ahora `--fase` era
  opcional para bug/infra/pregunta; un bug sin hito no cuenta en ninguna fase, no sale en los
  informes y nadie lo mira al cerrar el ciclo. Lo que cambia segun el `ciclo` del tipo ya no es SI
  lleva fase, sino CUAL se propone: un tipo de PLAN se decide; uno que SURGE va a la fase ACTIVA, que
  es donde aparecio — y el mensaje ya la sugiere, no hay que decidirlo.
- **`rama` ACOMPAÑA en vez de crear en silencio.** Nueva opcion `--issue <N>`: la rama nace anclada,
  se llama `<tipo>/<N>-<slug>` (de un vistazo se sabe a que responde) y recuerda el `Closes #N`. Sin
  `--issue` la rama se crea igual —bloquear ahi empuja a trabajar fuera del sistema— pero se avisa de
  que el trabajo no contara en ningun hito y se da el **comando exacto**: el tipo que corresponde al
  prefijo (`fix/` -> bug, `docs/` -> documentacion, `spike/` -> investigacion...) y la fase activa.
  Un `hotfix/` ademas propone `--extra urgente`: el prefijo ya lo dice, no hay que acordarse.
- **Aviso de trabajo duplicado**: si el issue de `--issue <N>` ya tiene otra rama publicada, se dice
  con quien hizo el ultimo commit y cuando. (Lo que NO puede saberse es si alguien la tiene abierta
  ahora sin haber subido nada: el trabajo local ajeno es invisible hasta que se publica.)
- **El hito `Backlog` se crea siempre**, no solo cuando alguien usa `--fase backlog`. Es el UNICO
  hito que no caduca (ni lleva fecha ni se cierra al cerrar fases); todos los demas son fases.
- Arreglado: las notas del Release arrastraban la cabecera `## version — fecha` en ficheros con
  finales de linea CRLF (Windows), porque la regex usaba `.*
`. Detectado al publicar la 0.34.0.
- **CI: la matriz completa solo donde importa.** En un repo PRIVADO los minutos de Actions se
  facturan y no cuestan igual (Ubuntu 1x · Windows 2x · macOS 10x): correr los tres sistemas en cada
  push de cada rama multiplicaba el gasto por ~13 sin aportar. Ahora Ubuntu en cada PR (red rapida y
  barata, es donde se trabaja) y los TRES al integrar en develop/main — que es cuando de verdad
  importa, porque el equipo mezcla sistemas y hay guardarrailes propios de Windows que probar antes
  de publicar.
- **Vocabulario fijado en el schema** (`enums._nota_vocabulario`), para que ningun agente se invente
  equivalencias: FASE = HITO (1 a 1, por el titulo) y en vocabulario agil es la EPICA; el ISSUE es la
  HISTORIA DE USUARIO (se escribe asi en su titulo, no es un nivel aparte) y sus checkboxes son las
  subtareas. Un CICLO **no** es un hito y no debe serlo: la palabra nombra dos procesos que ATRAVIESAN
  el trabajo (el ciclo de vida de un cambio y el ciclo git), no algo que lo agrupe — un hito por ciclo
  no agruparia nada. Y no se crean hitos por tipo de trabajo ("Bugs", "Infra"): para eso estan los
  labels; un hito que nunca cierra es una etiqueta disfrazada.
- Cubierto por `test/rama-acompana.test.mjs` (12), `test/estado-migrado-valida.test.mjs` (4) y
  ampliaciones en tareas-ancladas / cierre-forzoso / release. Tests afectados: 87/87.


## 0.34.0 — 2026-09-19

- **`pr crear` fallaba SIEMPRE la primera vez, y no era la red.** La secuencia rama -> commit ->
  `pr crear` daba error, y funcionaba tras un `git push -u` manual: se vivia como *"error
  transitorio, reintento"*, pero lo que lo arreglaba no era repetir — era el push que se colaba en
  medio. La forja no puede abrir una peticion desde una rama que nunca ha visto, y el harness
  llamaba a la API sin publicarla. Ahora la publica como parte del flujo (y tambien empuja los
  commits locales pendientes: el PR debe ver el trabajo completo, no el de hace tres commits).
- **El RELEASE de la forja se crea al aprobar, con las notas del CHANGELOG.** El motor validaba
  version <-> CHANGELOG y creaba el tag, pero no el Release: el resultado real eran 11 tags
  publicados y **0 releases** — las notas estaban escritas y no llegaban a nadie. Es un paso
  obligatorio del ciclo, no opcional. La coherencia se mantiene por construccion: las notas salen de
  la MISMA entrada del CHANGELOG que el gate ya exigio, asi que no pueden divergir.
- **Solo hacia adelante, y solo si el push fue bien.** No se recrean los releases de tags anteriores
  (un release es un hecho publicado en un momento; reconstruirlo despues pondria fechas falsas), y no
  se intenta si el push fallo (un release necesita un tag que la forja ya tenga). Si el Release falla,
  se avisa sin romper la aprobacion: el tag ya esta creado, que es lo irreversible.
- `release.js` gana `notasDeVersion` (el bloque del CHANGELOG de una version, sin arrastrar la
  siguiente), `agruparCambios` (features / correcciones / otros, desde los prefijos convencionales de
  los commits, descartando el ruido de proceso) y `tareasCerradas` (los issues que el rango
  referencia: el mismo dato que los cierra alimenta las notas).
- Cubierto por `test/release-en-la-forja.test.mjs` (15 casos) y `test/pr-crear-publica-rama.test.mjs`
  (5 casos, con un remoto git real en disco). Tests de publicacion y aprobacion: 47/47.


## 0.33.2 — 2026-09-19

- **El cierre forzoso se saltaba por la puerta de al lado.** Vivia solo en `hito sync`:
  `hito cerrar <titulo>` cerraba el hito aunque tuviera 20 tareas abiertas dentro. Ahora valida
  igual — si queda trabajo abierto en la fase, la fase no se cierra — y dice como resolverlo
  (`cerrar-tarea` / `mover-tarea` / `descartar-tarea`).
- **Nuevo `hito verificar <titulo>`: comprueba si un cierre fue ADECUADO, no lo impide.** Cerrar
  desde la web puede ser legitimo, pero no puede quedar sin verificar. Por cada tarea del hito busca
  evidencia DETERMINISTA (un PR fusionado que la referencie) y dicta: abierta con PR fusionado = se
  hizo, solo falto cerrarla · abierta sin PR = quedo colgando · cerrada con PR = correcto · cerrada
  SIN PR = cerrada a mano, que alguien lo confirme · descartada = decision explicita, no pide
  evidencia. Vale igual para un hito cerrado a mano y para un issue cerrado a mano.
- **El aviso es PROACTIVO**: `hito sync` (que corre en `/faro:aprobar`) detecta solo el hito ya
  cerrado que dejo tareas abiertas dentro y apunta a `hito verificar` — sin que nadie lo pida.
- `/faro:migrar-tareas`: la limpieza de `ESTADO.md` ahora es inequivoca — se borran TODOS los
  checkboxes de la fase migrada, tambien los `[x]`. Un bloque "Completado" duplicado es una segunda
  verdad que envejece; el historico vive en los issues cerrados del hito, con mas detalle. Unica
  excepcion: una tarea hecha que nunca llego a tener issue.
- Cubierto por `test/hito-cerrar-valida.test.mjs` (10 casos). Tests de gestion de hitos: 53/53.


## 0.33.1 — 2026-09-19

- **La fecha objetivo de una fase viaja al hito.** `ESTADO.md` ya permitia una linea
  `Objetivo: AAAA-MM-DD` por fase y el harness ya la parseaba, pero `hito sync` creaba los hitos SIN
  fecha: se tiraba un dato que ya estaba escrito. Ahora el hito la refleja (`due_on` en GitHub,
  `due_date` en GitLab), asi que la forja muestra el vencimiento y avisa de hitos pasados de fecha
  sin mantener la fecha en dos sitios.
- **ESTADO.md manda, pero omitir no es ordenar borrar.** Si la fecha del fichero cambia, el hito se
  actualiza; si la fase no declara objetivo, no se inventa ninguna; y **quitar** el objetivo del
  fichero NO borra la fecha que el hito ya tenia — destruir un dato por omision seria peor que
  dejarlo desactualizado.
- Cubierto por `test/fecha-objetivo-en-hitos.test.mjs` (5 casos: con fecha, sin fecha, fecha
  cambiada, fecha ya coincidente —sin llamadas de mas— y objetivo retirado).


## 0.33.0 — 2026-09-19

- **El Backlog es la SALA DE ESPERA, y solo se sale de el a una fase.** Nuevo `mover-tarea`: saca una
  tarea del Backlog a su fase cuando se decide CUANDO se hace, y sirve tambien entre fases si cambia
  el alcance. **Siempre deja constancia en el propio issue** (de donde viene, a donde va, por que):
  mover trabajo entre fases es una decision de gestion, no un ajuste silencioso — dentro de tres
  semanas se sabra por que esa tarea acabo en la Fase 4 y no en la 2.
  `mover-tarea --listar backlog` enseña que espera y hace cuanto, para decidir que sacar.
- **Regla dura: una tarea NO se cierra como completada desde el Backlog.** Si se hizo, pertenecia a
  alguna fase. Nuevo `cerrar-tarea <N>` cierra como completada y **se niega** si la tarea sigue en la
  sala de espera, diciendo como resolverlo (moverla primero, o descartarla si no se va a hacer). Lo
  que no se hara no es un cierre por completado: eso siempre fue `descartar-tarea` (`not_planned`).
- El hito `Backlog` se crea solo la primera vez que hace falta, igual que los de fase. Un issue en el
  Backlog no cuenta como huerfano en la vigilancia: esta ahi a proposito, visible y contado.
- Cubierto por `test/mover-tarea.test.mjs` (11 casos: mover, constancia, motivo, vuelta al backlog,
  fase inexistente, listado vacio y lleno, y las tres reglas de cierre).


## 0.32.2 — 2026-09-19

- **Las fases de ESTADO.md no llegaban al adaptador de GitHub.** `ghMod()` construia `github.js` con
  solo `{ROOT, git, IS_TEMPLATE, specBase, forge}`: la rama de GitLab de `forjaMod()` si inyectaba
  `fases`/`isDone`/`isActive`, la de GitHub no. Como `github.js` los reenvia a `github-gestion.js`
  (hitos = fases) y a `github-tareas.js` (`asignar-tarea --fase`), en GitHub `hito sync` decia
  *"ESTADO.md sin fases: nada que sincronizar"* con el fichero lleno de fases, y `--fase N` rechazaba
  cualquier numero como inexistente — dejando sin poder anclar los tipos de PLAN, justo lo que
  0.31.1 habia construido. Faltaba tambien `faroSchema` (catalogo de labels). Tercer corte del mismo
  patron de cableado incompleto tras 0.30.1.
- **Test de CABLEADO, no solo del sintoma**: `test/fases-llegan-al-adaptador.test.mjs` compara lo que
  `github.js` LEE de su contexto (`ctx.X`) contra lo que `ghMod()` le ENTREGA de verdad, y falla
  nombrando cada pieza que falte. Cubre las dos forjas, asi que arreglar una no puede romper la otra.
  Verificado en un repo real: `hito sync` paso de *"sin fases"* a crear los 7 hitos y cerrar el de la
  fase terminada.


## 0.32.1 — 2026-09-19

- **El harness gobernaba el DIRECTORIO donde se tecleaba, no el repo.** `ROOT` era
  `CLAUDE_PROJECT_DIR || process.cwd()`: sin esa variable de entorno (invocacion manual desde una
  terminal, un hook que no la propaga, un script), trabajar desde `src/` dejaba al harness buscando
  `ESTADO.md` en `src/` — reportaba `fases: []` y todo a `null` sobre un `ESTADO.md` perfectamente
  valido en la raiz. El faseo, `validate` y el gobierno entero quedaban ciegos **en silencio**, sin
  que nada dijera por que. Ahora, sin `CLAUDE_PROJECT_DIR`, se sube hasta la carpeta con `.git`
  (donde vive `ESTADO.md` por convencion FARO); la variable sigue mandando cuando esta, y fuera de
  un repo git se cae a `cwd` como antes. Cubierto por `test/root-desde-subdirectorio.test.mjs`.
- **`/faro:migrar-tareas` recorre las fases una a una, en orden, en vez de hacer un barrido global.**
  Por cada fase: consulta los issues de su hito, cruza con los checkboxes (crear / crear-y-cerrar si
  ya estaba hecha / enlazar si el issue ya existe / preguntar si los estados no cuadran), crea lo que
  falte, valida que el recuento del hito coincide con la realidad, y actualiza el estado de esa fase
  en `ESTADO.md` antes de pasar a la siguiente — asi el desajuste de una fase no se arrastra.
- **Lo que se da por hecho se VERIFICA antes de cerrarlo.** Un `[x]` es la afirmacion de alguien, no
  una prueba: en un repo con codigo, un subagente por fase (solo lectura, en background mientras se
  procesa la siguiente) contrasta cada tarea marcada como hecha contra commits, ficheros, PRs que la
  citen y tests que la cubran, y devuelve **confirmada / sin evidencia / contradicha**. Solo las
  confirmadas se cierran; una fase no se cierra sin su veredicto.


## 0.32.0 — 2026-09-19

- **Nueva skill `/faro:migrar-tareas`.** Para repos con faseo ya en marcha (`ESTADO.md` con fases y
  checkboxes detallados) cuyas tareas nunca pasaron a la forja — el caso real que motivó todo el
  sistema de anclaje (`--fase`, cierre forzoso, vigilancia) de 0.31.1/0.31.2: 41 issues sin hito
  mientras `ESTADO.md` tenia 7 fases y 39 tareas escritas a mano. La skill lee `ESTADO.md`, propone
  tipo+fase por cada tarea abierta (nunca a ciegas: si la fase ya avanzo, pregunta si sigue vigente,
  pasa a otra fase o se descarta), confirma la lista completa con el usuario ANTES de crear nada,
  crea los issues con `asignar-tarea --fase` (que ya ancla al hito), y adelgaza `ESTADO.md` a
  objetivo+contador sin perder el histórico de lo ya hecho.
- **Aviso proactivo de tareas sin migrar, al arrancar sesión.** Sin esto, un repo que actualiza el
  plugin no se entera de que `asignar-tarea --fase` existe hasta que alguien tropieza con el
  bloqueo al crear una tarea NUEVA — demasiado tarde. Detector 100% local (solo lee las fases ya
  parseadas de `ESTADO.md`, sin red): una fase con ≥2 tareas abiertas de texto largo (≥60
  caracteres — señal de detalle operativo real, no un placeholder) sugiere `/faro:migrar-tareas`.
  Vive en el mismo punto donde ya se avisa de `ESTADO.md` ausente; no bloquea nada, solo sugiere.
- Cubierto por `test/aviso-migrar-tareas.test.mjs` (8 casos, incluidos 2 de extremo a extremo con
  `harness.js session` real).

## 0.31.2 — 2026-09-19

- **Cierre forzoso de fase.** Una fase `done` ya NO puede cerrar su hito con tareas SUYAS abiertas
  dentro — antes se cerraba igual y esas tareas se perdian de vista (el conteo de abiertas seguia
  positivo con el hito ya cerrado). `hito sync` (disparado tambien por `/faro:aprobar`) DETECTA y
  avisa cuantas quedan; nunca las mueve ni las cierra por su cuenta — mover una tarea de fase es una
  decision de gestion, no del harness (mismo principio que `validate` ya aplica al ciclo
  spec<->tasks<->fase). En GitHub, sin llamada extra (`open_issues` viaja ya en la respuesta de
  listar hitos); en GitLab, una llamada extra SOLO cuando toca cerrar.
- **`--fase backlog`.** Un requerimiento ya aceptado pero sin fecha decidida no tiene por que quedar
  bloqueado ni fuera del sistema: vive en un hito unico `Backlog` (no ligado a ninguna fase de
  `ESTADO.md`), visible y contado igual que cualquier otro, hasta que se le asigna una fase real.
- **`--origen-fase <N>`.** Documenta de que fase VIENE un hallazgo (p. ej. un bug de la Fase 1
  encontrado trabajando en la Fase 3) SIN anclarlo a ella — una fase ya cerrada no se vuelve a
  revisar, asi que colgarlo ahi lo dejaria tan invisible como no ponerle fase. Independiente de
  `--fase` (que dice donde SE ATIENDE): pueden coincidir, pero casi nunca es lo mismo.
- Coherencia agnostica de forja: las skills/agente que documentaban el anclaje fase<->hito solo
  "en GitLab" ahora dicen que `--fase` (GitHub) y `--hito` (GitLab) son la MISMA idea con dos
  transportes — el nucleo funciona igual en las dos, GitLab conserva ademas sus extras nativos
  (tiempo, enlaces de bloqueo, peso) que GitHub no tiene.
- Cubierto por `test/cierre-forzoso-fase.test.mjs` (4 casos) y ampliaciones en
  `test/tareas-ancladas-al-ciclo.test.mjs` (+5 casos: backlog, origen-fase con y sin --fase, y que
  un issue en Backlog no cuenta como zombi en la vigilancia).

## 0.31.1 — 2026-09-19

- **Una tarea de PLAN ya no puede nacer huerfana.** Visto en un repo real: 41 issues abiertos, NINGUNO
  con hito, y 7 fases definidas en ESTADO.md sin ninguna atadura entre ambos — al cerrar una fase,
  nadie sabia que tareas suyas quedaban abiertas. `asignar-tarea --fase <N>` ancla el issue al hito de
  esa fase (lo crea si falta, reusando la misma logica que `hito sync`); sin `--fase`, un tipo de PLAN
  (requerimiento, mejora, tarea, documentacion, investigacion, diseno, datos) NO se crea.
- **El criterio es DETERMINISTA, leido del schema — no del juicio del agente.** Nuevo campo `ciclo` en
  cada label de `faro-schema.json > enums.labels`: `'plan'` exige `--fase`, `'surge'` (bug, infra,
  pregunta) la deja OPCIONAL — un bug no tiene que fingir que estaba planificado — y `'cierre'`
  (duplicado, descartado) no aplica. Un repo SIN `ESTADO.md` (nivel 0, sin faseo) no puede exigir fase:
  no bloquea.
- **Vigilancia sin gastar contexto ni tocar `validate`.** `cmdValidate()` es sincrono (sin red, corre en
  CI/hooks locales) — no se le mete una llamada a la API ahi dentro. El conteo de tareas de plan sin
  hito (y cuantas de esas llevan >30 dias sin tocarse) vive donde ya vivia el patron de dato agregado
  cacheado y refrescado en background (`agregado.js` + `gh_resumen`): un query mas de `total_count`
  (barato, no trae los issues), compuesto en el MISMO refresco que ya hacia `mis_tareas`. El resumen de
  sesion lo dice solo si hay algo que decir (silencioso en 0); `harness.js resumen-json` lo dice siempre,
  por ser consulta explicita.
- Cubierto por `test/tareas-ancladas-al-ciclo.test.mjs` (12 casos: el contrato del schema, cada rama
  de `asignar-tarea --fase`, y el query de vigilancia) y ampliaciones en
  `test/agregado-resumen.test.mjs` (8 casos nuevos: composicion del snapshot y los dos puntos donde se
  muestra al usuario). Suite completa: 268/268.

## 0.31.0 — 2026-09-18

- **Las revisiones ya no se pagan con el contexto de la sesion.** `/faro:revisar-code` y
  `/faro:revisar-spec` pasan a lanzarse **en background**, como ya hacia `/faro:auditoria`. Una
  revision LEE mucho (arquitectura, funcional, specs, codigo) y devuelve POCO (un veredicto y sus
  hallazgos): en background esa lectura se queda en el subagente y a la sesion solo vuelve la
  conclusion. De 15 agentes, solo 1 corria asi; los revisores son el caso de libro para el resto.
- **El gate sigue siendo gate.** Background ahorra contexto, NO relaja el control: el veredicto se
  espera igual y un NO APTO sigue impidiendo abrir el PR, consolidar o aprobar. Se dice explicito en
  `pr`, `consolidar` y `aprobar` para que no se lea como "lanzalo y sigue".
- **`revisor-code` + `revisor-code-worker` se lanzan en la MISMA tanda.** Son independientes entre si,
  asi que corren en paralelo en vez de esperarse: mismo veredicto, la mitad de espera.
- **Nueva directiva `/faro:delegacion`** (tercera skill-directiva, junto a `documentacion` y
  `gestion-proyectos`). Fija cuando repartir trabajo entre subagentes y —igual de importante— cuando
  NO: la regla es **delegar cuando la lectura es ancha y el resultado estrecho**, no el paralelismo
  por el paralelismo. Cubre el caso que hasta ahora dependia del criterio del modelo de turno (el
  barrido ancho: "¿este patron esta en mas sitios?"), el orden correcto de las preguntas al usuario
  (ANTES y en el hilo principal, nunca dentro de un subagente en background), que lo que devuelve un
  agente es material de trabajo y se VERIFICA antes de actuar, y por que quien escribe el codigo no
  es buen juez de su propio codigo.
- README: registrada la nueva directiva y corregido el conteo de skills (decia 27, eran 28 antes de
  este cambio; ahora 29).

## 0.30.1 — 2026-09-18

- **`asignar-tarea` estaba roto entero: `ReferenceError: labelsCatalogo is not defined`.** Al extraer
  `cmdAsignarTarea` a `lib/github-tareas.js` (0.29.0), el modulo padre no le paso tres simbolos que el
  codigo movido seguia usando: `labelsCatalogo`, `resolverLabel` y `ctx` (para `ctx.specBase`). Reventaba
  con CUALQUIER invocacion —incluso sin argumentos, porque el catalogo se consulta ANTES de validar el
  uso—, asi que ni siquiera se podian listar los tipos de tarea. Esto bloqueaba el paso 5 de
  `/faro:cambio` (crear el issue asignado al responsable). Es el segundo corte seguido del mismo comando:
  en 0.9.5 fue la ruta de `faro-schema.json`.
- **El hook `doc-check` moria al editar ESTADO.md: `ReferenceError: _ini is not defined`.** Mismo patron.
  Al mover `parseEstado()` a `lib/estado.js`, su cache `_ini` paso a ser privada del modulo, pero la linea
  que la invalidaba se quedo en `harness.js`. Bajo `'use strict'` eso no crea un global: lanza. El hook
  `PostToolUse(Write|Edit)` moria justo despues de escribir ESTADO.md o INICIATIVA.md, perdiendo en
  SILENCIO la validacion de faseo y el aviso de replanificacion — los dos controles que ese hook existe
  para aplicar. `lib/estado.js` ahora EXPONE `invalidarEstado()` y el harness la llama: la cache se tira
  de verdad, asi que se valida el archivo recien escrito y no el anterior.
- **Barrido sistematico del patron, no solo de los dos sintomas.** Analisis estatico de scope sobre AST
  (no regex) de `harness.js` y los 34 modulos de `hooks/lib/`, buscando identificadores libres: nombres
  que el codigo usa pero que no estan ni definidos localmente ni en la desestructuracion del ctx
  inyectado. Los dos fallos de arriba eran los unicos; el resto del cableado esta limpio.
- Cubierto por `test/asignar-tarea-cableado.test.mjs` (6 casos: catalogo sin red, cada rama de validacion,
  alta con label nativo reutilizado y con `faro:<slug>` creado) y `test/doc-check-invalidar-estado.test.mjs`
  (3 casos, incluido el que exige que invalidar RELEA de disco — sin el, un faseo recien roto pasaria por
  bueno en silencio).

## 0.30.0 — 2026-09-16

- **No habia forma de poner el local al dia con criterio.** El motor sabia COMPARAR ramas
  (`gitFlow()`, `ramas.js`), pero siempre contra refs locales cacheadas: sin un `fetch` previo podia
  decir "estas al dia" llevando doce commits de retraso. Y no existia ningun comando que TRAJERA el
  estado del remoto — las unicas menciones a `git fetch` en todo el motor eran mensajes mandando al
  usuario a hacerlo a mano. Nuevo `harness.js sincronizar` (`lib/sincronizar.js`) + skill
  `/faro:sincronizar`: trae el remoto, informa del estado real rama a rama y deja claro que decide
  el usuario.
- **Frontera de seguridad explicita: solo se aplica lo que NO puede perder trabajo.** `fetch`
  siempre (solo trae informacion, no toca el arbol); fast-forward SOLO si el arbol esta limpio y la
  rama no ha divergido (git unicamente avanza el puntero a algo que ya contiene todo lo tuyo: no
  fusiona nada, no hay conflicto posible); merge, rebase y resolucion de conflictos NUNCA son
  automaticos, se proponen. Con cambios sin commitear no se toca ninguna rama y se explica por que.
- **Conflictos detectados EN SECO, antes de abrir la peticion de integracion.** `merge-tree
  --write-tree` fusiona en el almacen de objetos y nombra los ficheros que chocarian SIN tocar el
  arbol de trabajo ni dejar un merge a medias. Responde "¿mi rama choca con develop?" cuando aun
  sirve de algo: antes del PR, no despues. En git < 2.38 lo dice en vez de fingir "sin conflictos".
- **No duplica competencias.** No borra ramas: informa de cuantas hay muertas y remite a
  `/faro:ramas` (un solo sitio que borra, no dos). No abre ni fusiona peticiones (`/faro:pr`,
  `/faro:forja`). Es git puro contra `origin`, asi que funciona igual en GitHub y en GitLab, sin
  depender de credenciales de API.
- `--solo-informe` para mirar sin tocar nada y `--json` para consumo por maquina (resumen de sesion).
  Cubierto por `test/sincronizar.test.mjs`: 9 casos con remoto real (bare local), incluidos los dos
  que mas importan — arbol sucio y rama divergida NO se tocan.

## 0.29.0 — 2026-09-14

- **`aprobar` podia tagear una version que el CHANGELOG no documentaba.** `tagVersionSiProcede()`
  leia la version de `package.json`/`plugin.json` y creaba el tag sin comprobar que `CHANGELOG.md`
  tuviera una entrada para ella — si alguien subia la version sin correr `/faro:changelog`, el tag
  y el CHANGELOG dejaban de decir lo mismo, justo el desajuste que esa skill pide evitar (hasta ahora
  solo como instruccion, no como gate). Nueva `changelogTieneVersion()` en `lib/release.js`: busca una
  cabecera `## <version>` en `CHANGELOG.md`. `cmdAprobar()` la comprueba ANTES del merge `develop ->
  main` (no despues, para no dejar `main` a medias si falta) y cancela la aprobacion si no la
  encuentra, con el mismo criterio que ya usa el gate `validate`.
- **El propio motor (este repo) no tenia ese mismo gate.** Aqui no habia `develop` (ver mas abajo): se
  aprobaba por PR directo a `main`, y nadie ejecutaba `cmdAprobar()` — el mismo desajuste seguia siendo
  posible sin que nada lo detectara. Nuevo `test/motor-changelog-coherencia.test.mjs`, que corre dentro
  de `npm test` (la red de seguridad de cada MR y de `main`): falla si la version de `plugin.json` no
  tiene su entrada en el CHANGELOG.
- **Bug real descubierto al escribir ese test:** `versionActual()` solo buscaba version en la RAIZ del
  repo (`package.json` o `.claude-plugin/plugin.json`) — en un repo MARKETPLACE como este, donde el
  plugin vive anidado en `plugins/faro/.claude-plugin/plugin.json`, no encontraba ninguna version y
  devolvia `null` en silencio (si este repo tuviera `develop`, `aprobar` nunca habria tageado nada).
  Ahora busca tambien ahi como ultimo recurso, y solo si hay EXACTAMENTE UN plugin en `plugins/`
  (con varios, no adivina).
- **El motor adopta su propio ciclo `develop -> main`** (el mismo que exige a los repos de trabajo), en
  vez del PR directo a `main` de arriba: crea la rama `develop`, extiende la CI a ella, y
  `engineDirective()` describe `feat -> PR a develop -> /faro:consolidar -> /faro:aprobar`. Motivo
  directo: sin esto, varios cambios en vuelo a la vez colisionaban en la misma version por partir todos
  de `main` — con `develop` de por medio, la version se decide UNA vez, al aprobar.
- **Resumen agregado de sesión: ramas y tareas en una línea, cacheada y auto-actualizada.** Saber
  "cómo está" un repo (ramas vivas/muertas, tareas propias abiertas) exigía correr comandos sueltos o
  leer `ESTADO.md` entero. Nuevo `lib/agregado.js`: cachea `{ramas, tus_issues_abiertos, ts}` en
  `~/.faro.json` (misma clave que el resumen de GitHub ya existente) y lo refresca en segundo plano —
  mismo patrón que `ghResumenLines()`, sin abrir dependencias nuevas: reutiliza `ramas.js` (nuevo flag
  `--json`, solo conteos) y el `gh_resumen` ya cacheado (`mis_tareas`, que es un número, no un array —
  se descubrió al escribir el test que asumía lo contrario). Nuevos `harness.js resumen-json` (bajo demanda)
  y `harness.js resumen-json-refresh` (background); línea nueva en el contexto de sesión, silenciosa hasta
  que hay datos. V1 acotado a este repo (sin cross-repo, sin issues totales del repo, sin ClickUp — ver
  `gestion/cambios/changes/resumen-agregado-sesion/proposal.md`).

## 0.28.0 — 2026-09-14

- **Cada gancho cargaba los 15 modulos del motor, tambien los que no iba a usar.** Medido modulo a
  modulo: cargarlos cuesta ~1325 ms, y se pagaba ENTERO en cada invocacion — incluida la de `pre-bash`,
  que corre en CADA accion del agente y solo necesita comparar una cadena contra los patrones de orden
  destructiva. Seis pasan a carga perezosa (atomico 152 ms · digestion 114 · tipos 77 · grafo 60 ·
  release 57 · kpis 54 = ~514 ms) y se cargan en su primera llamada real. Las envolturas conservan
  nombre y aridad: ningun sitio de llamada cambia.
- Verificado de forma DETERMINISTA, contando lo que acaba en `require.cache`: `pre-bash` pasa de **13 a
  7** modulos; `status`, que si los necesita, sigue cargando los 21 suyos. La salida del gancho de sesion
  es la misma salvo el numero de lineas que el propio fichero se autorreporta.
- **No se publica una mejora en segundos porque no se pudo medir con honestidad.** En la maquina de
  referencia la varianza entre ejecuciones identicas (3,5 s a 11,3 s) es unas veinte veces mayor que la
  ganancia buscada; quedarse con la vuelta favorable habria sido hacer trampa. Lo que se afirma es lo
  que se puede demostrar: se hace menos trabajo, y el trabajo que se evita esta cuantificado.
- **El limite de proceso de los tests sube de 30 s a 120 s (18 sitios).** No se relaja ninguna asercion:
  esos tests lanzan el harness y comprueban su SALIDA, no su velocidad. Con 30 s fallaban de forma
  intermitente en maquinas lentas (aqui: 29,5 / 30,1 / 28,7 s contra el limite) dando `actual: ~`
  — proceso matado —, que se lee como fallo de codigo y manda a depurar donde no es.

## 0.27.0 — 2026-09-14

- **Un plan de implementacion es el `tasks.md` de un cambio, y ahora el motor lo hace cumplir.** Otros
  plugins escriben su plan donde dice SU convencion (superpowers: `docs/superpowers/plans/AAAA-MM-DD-<x>.md`).
  Ese plan no compite con el cambio de FARO: compite con su `tasks.md` — son lo mismo, el COMO troceado en
  tareas verificables. Lo que al plan le falta es la PROPUESTA (el porque, la fase, el dueno, la aprobacion).
  Dejarlo fuera parte el trabajo en dos sitios que no se hablan: el harness cuenta el avance de `tasks.md`
  mientras el plan de verdad vive en otro lado.
- **Deliberadamente NO se crea `gestion/plans/`**: seria un TERCER artefacto diciendo lo mismo que `tasks.md`,
  en otro sitio y desincronizandose. El plan aterriza como `tasks.md` del cambio y se lleva gratis lo que ya
  existe: validacion, inventario, avance por sesion, cobertura de fase y archivado al cerrar.
- El gate NO adivina a que cambio pertenece un plan (eso es criterio, no automatismo): bloquea y dice donde
  va. Con cambios declarados, los lista para elegir. Sin ninguno, exige antes la propuesta — que es la regla
  que el protocolo del motor YA pedia para cualquier trabajo sustantivo; aqui solo se le hace cumplir a un
  plugin que no la conoce.
- Cinco pruebas nuevas (`test/gate-planes.test.mjs`) fijan las dos ramas del gate y, sobre todo, que NO se
  cuela donde no debe: escribir dentro del cambio pasa, y un documento controlado normal no se ve afectado.

## 0.26.1 — 2026-09-13

- **"Git: repo sin git" podia ser MENTIRA, y de las caras.** `git()` envolvia toda lectura en un
  `catch { return null; }`, y quien recibia ese null concluia siempre lo mismo: que el repo no tiene
  git. Pero ahi caian tres casos distintos — no hay repo, git no esta en el PATH, o git NO RESPONDIO a
  tiempo — y solo uno justificaba ese mensaje. En los otros dos mandaba a investigar donde no era.
  Ahora se distingue el motivo y se dice el verdadero; en el caso del timeout se dice explicitamente
  que NO significa que falte git, y se sugiere como medirlo.
- **El timeout de lectura sube de 5 s a 15 s.** En una maquina con antivirus de endpoint, arrancar git
  cuesta ~500 ms y un `git rev-parse` en una carpeta sin repo tarda 2,7 s medidos: con varios ganchos a
  la vez, 5 s se agotaban sin que pasara nada anormal. Las ESCRITURAS ya tenian su propio margen de
  10 min y no se tocan.
- Nota de entorno: en esta maquina la suite es INESTABLE por carga, no por codigo — `onboarding` agota
  su limite propio de 30 s de vez en cuando y pasa al reintentar. Si vuelve a fallar en verde-rojo-verde,
  mirar la carga antes que el codigo.

## 0.26.0 — 2026-09-13

- **El arranque de sesion lanzaba 16 procesos git; ahora lanza 6.** Medido con `GIT_TRACE`, no estimado.
  Ocho de los dieciseis eran la MISMA orden repetida (`git log -1 --format=%cI` una vez por documento) y
  cinco preguntaban rama por rama con `rev-parse --verify` algo que `for-each-ref` contesta entero. Se
  agrupan en una llamada cada grupo, con respaldo por fichero para lo que la tanda no resuelva. Antes de
  sustituir nada se comparo fichero a fichero contra la forma antigua: identico en los 8. La salida del
  gancho es byte a byte la misma. **13,3 s -> ~6,3 s** en la maquina de referencia.
- **El aviso de documentos sueltos era texto, y el agente lo ignoraba.** Lo reporto el usuario viendo al
  agente leer el aviso y seguir de largo. Era un `systemMessage`: compite con miles de caracteres de
  contexto y no obliga a nada. Pasa a ser un GATE real (codigo de salida 2, el motivo por stderr), la
  misma regla que el motor ya aplicaba al binario `gh`: un texto se desobedece, un bloqueo no. Bloquea
  SOLO por los artefactos que el propio harness GENERA (informe semanal, ESTADO, CLAUDE, reporting);
  dejar trabajo propio a medias sigue siendo legitimo y solo avisa. La guarda `stop_hook_active` evita
  el bucle. Probado en real: arbol limpio -> 0; artefacto generado suelto -> 2.
- **Por que tardaba, en corto** (diagnostico completo, por si vuelve a pasar): en una maquina con
  antivirus de endpoint (WatchGuard/Panda gestionado por consola), arrancar CUALQUIER proceso cuesta
  ~500-600 ms medidos, frente a los ~40 ms de una maquina sana. El harness no puede evitar ese peaje,
  pero si dejar de pagarlo 16 veces. Los ganchos por accion (`pre-bash`, `prompt-context`) cuestan ~800 ms
  y NO hacen ninguna llamada a git: su coste es integramente arrancar node, y no es optimizable desde el
  codigo. La exclusion del antivirus, si la organizacion la concede, es lo unico que arregla esa parte.

## 0.25.0 — 2026-09-12

- **GitHub pasa a ser la forja PRINCIPAL.** El marketplace por defecto para una forja desconocida deja
  de ser GitLab y pasa a el repo privado original. Cada forja conocida sigue recomendando su propio espejo,
  y `git config faro.marketplaceUrl` manda sobre ambos: un cliente con espejo propio no toca el motor.
- **El arranque de sesion salia a la red para averiguar quien eres, teniendolo en disco.** `authIdentity()`
  encadenaba tres sondas — `gh api user` (6s), `ssh -T` (8s) y un `curl` a los eventos de GitHub (8s) —
  en CADA sesion. Con `gh` sin instalar, la primera fallaba y el arranque se iba a las dos que salen a
  internet. El CLI ya guarda login y correo por forja en el almacen al autenticarte,
  asi que ahora el almacen manda y las sondas quedan como respaldo para quien no se haya autenticado.
  Medido despues: **3,8 s**. Ningun comportamiento perdido; lo unico que cambia es a quien se pregunta.
  (Correccion: la primera version de esta entrada publico 12,7 s -> 4,5-7 s. Esas cifras se tomaron
  cronometrando con `date` DENTRO de la consola Bash, donde cada `date` es otro proceso: inflaban la
  medida unas 4 veces. Las buenas se toman con Measure-Command, fuera del proceso medido.)

## 0.24.0 — 2026-09-12

- **Atomicidad saldada en GitHub.** `lib/github.js` tenia **823 lineas**, el doble del umbral que el
  propio motor exige (400) y que los modulos de GitLab ya respetaban. Se parte en cinco, ninguno por
  encima de 300: nucleo (293), `github-identidad.js` (identidad y login por codigo), `github-tareas.js`
  (issues y el resumen cacheado de sesion), `github-clave.js` (clave de proyecto por topic) y
  `github-gestion.js` (hitos, miembros, peticiones, pipeline, renombrar).
- **Tres fallos reales que destapo la extraccion**, ninguno detectable leyendo el codigo: al separar los
  modulos, `IS_TEMPLATE`, `readCfg`/`writeCfg`/`ghToken` y la identidad cacheada `_authId` dejaron de
  viajar con su bloque. Con un repo de GitHub sin credencial, `harness.js status` reventaba. Corregido
  y comprobado uno a uno sobre los 16 comandos.
- Cinco pruebas afirmaban comportamientos que se cambiaron a proposito y se ponen al dia: el equipo son
  los miembros DIRECTOS (0.22.0), y `hito` y `renombrar` existen tambien en GitHub (0.23.0).
- Verificado que cada forja pide SOLO lo que tiene: el resumen de GitHub no llama a nada de tiempo ni
  de hitos, el de GitLab si calcula el progreso de la fase activa, y la linea de sesion tolera que ese
  dato no exista.

## 0.23.0 — 2026-09-11

- **GitHub alcanza a GitLab en todo lo que GitHub permite** (`lib/github-gestion.js`):
  `hito [listar|crear|cerrar|reabrir|sync]` (fase = milestone, gratis), `miembro [listar|anadir|quitar]`
  (colaboradores; distingue invitacion PENDIENTE de colaborador ya existente), `pr ver|aprobar|mergear`
  por intencion (fusiona, RELEE y borra la rama), `exigir-pipeline` (en GitHub son las comprobaciones
  requeridas DENTRO de la proteccion de rama, y se leen de las que de verdad corrieron) y `renombrar`.
- **Deteccion HONESTA del limite de plan.** En GitHub **Free con repositorio PRIVADO no existe la
  proteccion de ramas** — ni clasica ni rulesets — ni las revisiones requeridas: exigen Team o superior.
  `proteger` y `exigir-pipeline` lo detectan por el mensaje de la API y lo explican en llano, diciendo
  ademas lo incomodo: ahi el unico gobierno son los gates LOCALES del harness, y **el servidor no impide
  que alguien con permiso de escritura empuje a main saltandose el plugin**. Antes fallaban con un error
  tecnico y se podia creer que `main` estaba protegida sin estarlo.
- **`tiempo` y `enlazar` dicen la verdad en GitHub** en vez de "no hay adaptador": GitHub no tiene
  estimacion ni horas por incidencia, ni enlaces de BLOQUEO entre tareas, en ningun plan. Son nativos
  solo de GitLab.
- Corregido un fallo real que destapo una prueba: al borrar la rama tras fusionar se codificaba la barra
  del nombre (`feat/x` -> `feat%2Fx`) y GitHub no habria encontrado la referencia.

## 0.22.0 — 2026-09-11

- **El EQUIPO de un proyecto son sus miembros DIRECTOS.** `collaborators()` leia `/members/all`, que
  incluye a quien HEREDA acceso del grupo: en el repo real, 13 personas ajenas al proyecto que salian
  como asignables y como posibles revisores. Ahora el equipo son los directos, y los heredados se
  listan aparte diciendo lo que son. Nuevo `harness.js miembro [listar|anadir|quitar]` para
  construirlo; `asignar-tarea` a un heredado se niega y dice como incorporarlo.
- **Quien APRUEBA pasa a ser un criterio ADAPTATIVO** (y es un cambio obligado por la realidad):
  1) Maintainers/Owners DIRECTOS del proyecto — el criterio fino; 2) si no hay ninguno, herencia del
  grupo: primero Owners, y si tampoco, Maintainers. `harness.js equipo` dice SIEMPRE cual se aplico.
  · **Por que:** en la organización los grupos `org-a` y `org-b` tienen `membership_lock` activado
    y se HEREDA, asi que ningun proyecto puede tener miembros directos — desmarcarlo en la organización no basta
    y cambiarlo en los padres da 403. Con el criterio fino a secas, TODOS los repos se quedaban sin un
    solo aprobador posible. Verificado contra el proyecto real: aprueban los 4 owners de la organización.
- **Atomicidad:** el equipo se extrae a `lib/forge-gitlab-equipo.js`; cuatro modulos, ninguno sobre 400.
- El flujo n8n adopta el mismo criterio adaptativo, y sus dos nodos de membresia pasan a tolerar el
  error 405 del bloqueo: la configuracion del resto del proyecto no debe caerse por eso.

## 0.21.0 — 2026-09-11

- **Los tokens OAuth de GitLab se renuevan solos.** El wizard del CLI ya dejaba en `~/.faro.json >
  tokens[host]` el `refresh_token`, la caducidad (`expira`, ms) y el `client_id`, pero
  `credenciales.js` devolvía el token tal cual: a las dos horas, 401 y vuelta a conectar. Ahora
  `tokenPara(host)` renueva cuando el token está caducado o a menos de 5 minutos de caducar
  (`grant_type=refresh_token`, refresh rotatorio guardado), de forma SINCRONA (proceso hijo de node,
  porque los gates que lo llaman no pueden esperar). Si está caducado y no se puede renovar, devuelve
  `null`: `SIN_TOKEN` honesto en vez de un 401 críptico. Sin `refresh_token` (token personal) no
  cambia nada.
- `harness.js auth` por código en GitLab guarda también `refresh_token` y `expira`, en la misma forma
  que el wizard: las dos vías de conexión son intercambiables.
- Override `FARO_OAUTH_TOKEN_URL` para pruebas y proxies.
- **`harness.js pr ver|aprobar|mergear <n>` por la API de GitLab.** `main` está protegida contra push
  directo, así que la única entrada real es la propia petición: `ver` muestra pipeline, conflictos,
  aprobaciones requeridas/faltantes y quién es elegible; `aprobar` registra tu aprobación y relee;
  `mergear` exige rol 40+ y `--confirmo` (fusionar ES la aprobación), fusiona borrando la rama, y
  relee para confirmar que quedó `merged`. Cuando GitLab se niega (autor sin autoaprobación,
  aprobaciones incompletas, pipeline en rojo) lo dice con el estado real, sin adivinar.
- **Incidente y cortafuegos: un test borró los tokens reales del desarrollador.** Tres módulos
  escribían `~/.faro.json` resolviendo la ruta por su cuenta, y los tests confiaban en cambiar `HOME`
  (no fiable en Windows). Un test de migración escribió sus fixtures en el fichero REAL y pisó el
  token de GitHub y el de GitLab recién conectado. Ahora hay UNA ruta (`credenciales.rutaCfg()`),
  resuelta en cada llamada: `FARO_CONFIG_PATH` si está definida; en contexto de test sin override,
  un temporal por proceso (la ruta real es INALCANZABLE desde un test); si no, `~/.faro.json`.
  `github.js` y `forge-gitlab.js` delegan en `credenciales.js`: un solo escritor. Todos los tests que
  tocan credenciales fijan `FARO_CONFIG_PATH`, y una prueba nueva verifica que desde un test no se
  puede llegar al fichero real ni leyendo ni escribiendo.

## 0.20.0 — 2026-09-11

- **Gestión NATIVA de GitLab para el trabajo faseado: hitos, tiempo y enlaces.** Hasta ahora las fases
  de ESTADO.md y las incidencias de GitLab vivían en mundos separados, y "estimación y consumo" eran
  cifras a mano. Nuevo módulo `lib/forge-gitlab-gestion.js` (atomicidad: el nucleo no crece):
  · `harness.js hito [listar|crear|cerrar|reabrir|sync]` — **una fase = un hito** ("Fase N — nombre").
    `sync` los crea/cierra/reabre desde ESTADO.md, idempotente; **`aprobar` lo ejecuta solo** al cerrar
    ciclo. El listado muestra tareas cerradas/total y horas estimadas/consumidas por hito.
  · `harness.js tiempo [<tarea> [<2h> | --estimar <1d> | --reset]]` — estimación y consumo por
    incidencia con la API de tiempo de GitLab; sin argumentos, **agregado por hito** (la base real del
    informe de fase). Duraciones validadas (`30m`, `2h`, `1d`, `"1h 30m"`).
  · `harness.js enlazar <t> <bloquea|bloqueada-por|relaciona> <t2>` — enlaces entre tareas. El bloqueo
    es Premium/Ultimate: se pide, se RELEE y si GitLab lo guardó como "relacionada", se dice.
  · `asignar-tarea` acepta `--hito --estimacion --vence --peso --bloqueada-por`: la tarea nace dentro
    del hito de su fase, estimada y con plazo. Peso y bloqueo (Premium) se verifican tras crear.
  · **Etiquetas de tipo con ámbito** (`tipo::bug`): en Premium/Ultimate GitLab las hace EXCLUSIVAS —
    una incidencia, un tipo, que es la regla del harness; en Free es una etiqueta normal.
    Desactivable con `enums.gitlab.etiquetas_con_ambito=false` en faro-schema.json.
  · **El arranque muestra el progreso de la fase activa leído de su hito** (tareas y horas), a coste
    cero: lo calcula el refresco en segundo plano que ya existía y lo deja en la caché del resumen.
- **Atomicidad:** `forge-gitlab.js` pasaba de 400 líneas; renombrar, proteger, exigir pipeline, reglas
  de push y bloqueo de peticiones se extraen a `lib/forge-gitlab-proyecto.js`. Tres módulos, ninguno
  por encima del umbral. Sin cambios de comportamiento.
- Skills `tareas`, `cambio`, `gestion-proyectos`, `aprobar` y el agente `gestor-forja` documentan la
  capa; la regla de plataforma inyectada en sesión lista los comandos nuevos.

## 0.19.0 — 2026-09-11

- **El rol del gate de merge/push deja de depender de los CLI `gh`/`glab`.** Cuando el archivo de estado
  no declara mantenedores, `lib/git.js` intentaba averiguar el rol lanzando esos binarios — que el
  propio motor prohíbe y que en un GitLab privado no están — así que el rol quedaba siempre
  indeterminado. Ahora `harness.js role` (en las dos forjas) guarda el rol en `~/.faro.json` bajo
  `rol_cache` con clave host/ruta, y el gate lo lee de ahí (fresco 24h; caducado = indeterminado,
  nunca deniega a ciegas). Developer en caché → push a main DENEGADO; maintainer → confirmación.
- **La identidad se valida contra la credencial guardada del host, también en GitLab.** La comprobación
  "tu correo de git coincide con tu cuenta" preguntaba al CLI `gh` (GitHub-only, prohibido). Ahora lee
  la cuenta de `~/.faro.json > tokens[host].user`, en las dos forjas, y nombra la forja real. La
  detección de teams de GitHub ya no se lanza en otra forja.
- **`harness.js renombrar "<Nombre>" [--path <slug>]` en GitLab.** Renombra por la API (GitLab conserva
  la redirección desde la ruta vieja), relee el proyecto para confirmar, y actualiza el `origin` local.
  `renombrador-faro` lo usa según la forja; en GitHub sigue el transporte `gh` con `PATCH`.
- **Tope en las tres listas de arranque que crecían sin límite** (bloqueadas, ciclos abiertos,
  decisiones propuestas): 8 entradas y "… y N más (detalle completo: <dónde>)". Lo que se inyecta en
  cada sesión debe ser constante con la edad del proyecto; el detalle completo siempre está en el repo.

## 0.18.0 — 2026-09-11

- **El agente y la skill de plataforma dejan de llamarse GitHub.** El motor ya elegía el adaptador por
  el remoto, pero por fuera seguía diciendo `gestor-github` y `/faro:github` — incoherente en un plugin
  que hoy es GitLab primero, y confuso para quien abre el repo sin contexto.
  · `plugins/faro/agents/gestor-github.md` → **`gestor-forja.md`**
  · `plugins/faro/skills/github/` → **`plugins/faro/skills/forja/`**, es decir **`/faro:forja`**
  · **CAMBIO QUE ROMPE COSTUMBRE**: el comando `/faro:github` ya NO existe. Se usa `/faro:forja`.
- **El contenido del agente se reescribe de GitHub-primero a forja-primero.** Antes daba por hecho el
  transporte `harness.js gh` y hablaba de PRs, topics y colaboradores; ahora manda el comando por
  INTENCIÓN (`pr crear`, `role`, `approvers`, `proteger`, `exigir-pipeline`, `ci`, `equipo`,
  `asignar-tarea`), que funciona igual en las dos forjas, y el transporte crudo queda como lo que es:
  una vía exclusiva de GitHub para lo que no tiene comando propio.
  · Recoge lo aprendido en 0.16/0.17: GitHub Enterprise autoalojado necesita su propia aplicación
    OAuth; en GitLab un Maintainer HEREDADO del grupo no aprueba en el proyecto (lo dice `approvers`);
    un repo con código y sin pipeline se arregla con `ci` y luego `exigir-pipeline`, porque sin exigirlo
    el pipeline solo informa y se puede fusionar en rojo.
  · Se cae la nota de "la automatización por GitHub Actions está fuera de alcance": desde 0.17.0 el
    motor genera el pipeline de la forja a partir de los gates del propio repo.
- Vocabulario coherente en toda la ruta: "petición de integración" en vez de PR, "tarea" para issue o
  incidencia según la forja, "miembros" en vez de colaboradores.

## 0.17.0 — 2026-09-11

- **`harness.js ci`: el ciclo de validación deja de vivir solo en la máquina de cada uno.** El harness
  ya sabía qué comandos son los gates de un repo (scripts de `package.json` o `git config faro.gates`)
  pero solo los corría en local, a voluntad de quien se acordara. Ahora los traduce al fichero de CI
  de la forja del repo — `.gitlab-ci.yml` en GitLab, `.github/workflows/ci.yml` en GitHub — para que
  se ejecuten sobre una copia limpia en cada petición de integración, igual para todos, dejando
  constancia para quien aprueba y pudiendo BLOQUEAR la fusión, que es lo que una ejecución local nunca
  puede hacer.
  · **Runtime según el lenguaje detectado**: Node, Python, Go, Rust, Java, Ruby, PHP y .NET, cada uno
    con su imagen (GitLab) o su acción de preparación (GitHub). Un front y un back se tratan igual: lo
    que manda es el manifiesto del repo, no si es cliente o servidor.
  · **Determinista, no improvisado**: tabla fija de runtimes más los comandos que el repo ya declara.
    El modelo no inventa YAML — misma filosofía que el resto de gates del harness.
  · **Nunca sobrescribe** un CI existente: si ya hay uno, dice qué comandos incorporar a mano. Sin
    gates declarados no genera un fichero vacío: explica qué declarar primero. Versiones
    ENTRECOMILLADAS en Actions (sin comillas, `20.10` se lee como el número 20.1).
  · El skill `/faro:code` lo incorpora como paso obligatorio del scaffold, y el agente de plataforma
    lo propone en repos con código y sin CI.
- **`harness.js exigir-pipeline`: que el pipeline PASE deja de ser opcional, sin romper los repos que
  no tienen.** Tener pipeline es opcional (un repo documental no lo tendrá nunca), y por eso el ajuste
  no puede fijarse al crear el proyecto: exigirlo sin pipeline bloquea TODA fusión. Va por proyecto y
  en el momento en que ese repo ya tiene su fichero de CI — el comando se NIEGA si no lo encuentra,
  relee el ajuste tras escribirlo (GitLab acepta el PUT sin cambiar nada) y admite `--no` para
  revertir. `harness.js ci` lo encadena al terminar de generar el pipeline; en GitHub el equivalente
  es marcar el workflow como comprobación requerida en la protección de rama, y el comando lo dice.
- **`proteger` ahora sí deja `main`/`develop` a prueba de todos.** En GitLab el nivel de subida pasa de
  "Maintainer o superior" a **nadie**: la rama solo se toca por petición de integración, que fusiona un
  Maintainer/Owner. Con el nivel anterior, un Maintainer todavía podía empujar directo, que es
  justo lo que el gobierno del harness prohíbe.
  También fija `unprotect_access_level: 40`, para que un Developer no pueda QUITAR la protección y
  dejar el gobierno en decorativo.
- Las dos forjas avisan ahora de un límite real que ninguna sabe imponer: **no existe restricción por
  rama ORIGEN** ("a `main` solo se entra desde `develop`"). Eso lo sostienen el flujo y quien aprueba,
  no el servidor — mejor decirlo que dejar creer que hay una garantía técnica que no existe.

## 0.16.0 — 2026-09-11

- **El plugin vive en GitLab: pipeline propio y el motor deja de dar por hecho GitHub.** El clon del
  motor se migró a GitLab (historial y 50 tags intactos); esta versión pone al día todo lo que aún
  asumía GitHub sin comprobarlo:
  · **`.gitlab-ci.yml` nuevo**: la suite corre en serie sobre Linux en cada petición de integración y
    en `main` (GitHub Actions no se ejecuta en GitLab). Windows/macOS quedan en local y en el flujo
    de GitHub del remoto secundario.
  · **El bloque de instalación recomendado ya no trae GitHub cableado.** Cuando un repo de trabajo no
    declara `faro-marketplace` en su `settings.json`, el harness recomienda el marketplace que
    corresponde a SU forja: fuente `url` (GitLab) o `github` — configurable con
    `git config faro.marketplaceUrl` para un cliente con su propio espejo (`lib/forge.js` →
    `marketplacePara`/`bloqueSettings`/`diagnosticoDescarga`). Un bloque ya declarado con
    cualquiera de las dos fuentes se acepta.
  · **Otro GitHub, autoalojado (GitHub Enterprise Server), deja de romperse.** `forge.detect()` ya
    reconocía ese host como `github` + `selfHosted`, pero `lib/github.js` seguía llamando SIEMPRE a
    `api.github.com` — en un repo de GHE hablaba con el GitHub equivocado. Ahora resuelve la API
    (`/api/v3/`) y el login por dispositivo por el HOST real del remoto; el `client_id` de la organización
    solo aplica a github.com, un GHE propio necesita su propia app OAuth
    (`git config faro.githubClientId`).
  · **Funciones de GitLab, incluidas las de pago (Premium/Ultimate).** `harness.js proteger [rama]`
    ahora existe en las dos forjas (antes solo se proponía a mano en GitHub): protección de rama
    (Maintainer+, sin force-push, disponible en TODOS los planes) y, en GitLab, intenta además exigir
    1 aprobación mínima — función de pago que se aplica si el plan la trae y se explica en llano si
    no, sin que lo primero se vea afectado. Nuevos `harness.js reglas-push` (reglas de push del
    proyecto) y `harness.js bloquear-pr <iid> <iid-que-bloquea>` (enlaces de bloqueo entre peticiones
    de integración), ambos exclusivos de GitLab Premium/Ultimate: en GitHub el comando lo dice sin
    fallar. Mismo criterio ya validado para `clave`: se intenta y se lee el resultado real, GitLab no
    gatea sus respuestas por plan de forma uniforme.
  · Vocabulario de plataforma neutral en los skills/agentes que aún hablaban solo de GitHub (token,
    login, issues, aprobación) — dicen "la forja" o nombran las dos donde aplica.

## 0.15.0 — 2026-09-11

- **Cimiento de la integración profunda con GitHub y GitLab, elegida por el remoto del repo.** La
  detección de forja existía desde 0.10.0 pero nada *hacía* algo en GitLab. Ahora sí:
  · **Credenciales por host** (`lib/credenciales.js`): `~/.faro.json` pasa de un `token` plano a
    `tokens[host]`, para tener sesión a la vez en GitHub, en `gitlab.com` y en el GitLab de un
    cliente. El token antiguo se migra a `tokens["github.com"]` al primer uso, sin reconectar, y se
    **mantiene espejado** en el campo plano mientras el CLI `<marca>-faro` lo lea (issue
    el issue del CLI anterior recoge su migración).
  · **`auth` sabe en qué forja está.** GitHub: el login de siempre. GitLab: el mismo login por código
    de seis dígitos (GA desde GitLab 17.9) si la instancia tiene aplicación OAuth (`git config
    faro.gitlabClientId`), o `auth --token <token personal>` si no. Sin ninguna de las dos, el comando
    explica ambas vías en vez de fallar.
  · **Adaptador de GitLab** (`lib/forge-gitlab.js`) con el mismo contrato que el de GitHub: rol,
    peticiones, revisores, tareas, etiquetas, clave y resumen de sesión, contra la API v4 y con la
    **ruta completa del proyecto** como identificador (los subgrupos anidan; recortar a dos segmentos
    era el bug que rompió el parseo en GitHub). Menciones por la API de pendientes, que GitLab tiene y
    GitHub no.
  · **Selector por forja** (`forjaMod()`): `role`, `pr`, `mis-tareas`, `asignar-tarea`, `equipo`,
    `clave`, `auth`, `consolidar` y `aprobar` funcionan con la **misma invocación** en las dos forjas.
    En una forja desconocida lo dicen, en vez de intentar la API de GitHub. El transporte `gh <ruta>`
    sigue siendo solo de GitHub y en GitLab reconduce a los comandos por intención.
  · **Nuevo `pr crear` por intención**: `pr crear --base develop --titulo "…" [--cuerpo "…"]
    [--revisor <login>]…`. `/faro:pr` deja de conocer la forma de la API; en GitLab abre el merge
    request con `remove_source_branch`.
  · **Decisión validada que gobierna el adaptador: nada se gatea por plan.** El campo `plan` de la API
    solo lo ven propietarios, un subgrupo devuelve `null` aunque el padre pague (issue abierto), y
    GitLab responde a funciones no incluidas con 400 vacío, 404 o **silencio**. Ninguna herramienta
    madura comprueba el plan (verificado en el código de Renovate). Se intenta y se lee el resultado
    real; para lo silencioso, se relee el recurso tras escribir (así se estampa la clave).
- **`UserPromptSubmit` lleva timeout explícito de 120 s, y es la única excepción documentada.** En
  ese evento el defecto de la plataforma **no** son 600 s sino 30, y 30 se agotan bajo carga real:
  con la suite de tests corriendo en paralelo, un `prompt-context` de 1,6 s tardó más de 30 y la
  plataforma **descartó el bloque de gobierno del turno** (`UserPromptSubmit hook timed out after
  30s — output discarded`). Un hook que tarda no cuesta nada; uno que expira deja el turno sin reglas.
- **`hooks.json` sin la clave `_comment`**: Claude Code la marcaba como desconocida. La justificación
  de cada timeout vive ahora en `hooks/HOOKS.md`, al lado.
- Skills y agente de plataforma actualizados: GitLab es forja de primera; solo la **desconocida** para.
  README documenta `auth` por host y `pr crear`.
- **12 tests nuevos** (suite: 138), todos sin red: almacén de credenciales con HOME aislado, enrutado
  por forja, traducción de niveles de acceso, identificador con subgrupos, y el cableado de skills.

## 0.14.0 — 2026-09-10

- **Los requisitos de los deltas pasan a sintaxis EARS: la condición va DELANTE.** El motor ya exigía
  texto normativo (DEBE/SHALL/MUST) y al menos un escenario, pero no decía nada de la **condición**.
  Con eso, *"el sistema DEBE validar correctamente los documentos"* pasaba el gate: lleva DEBE, tiene
  escenario, y no dice ni cuándo aplica ni qué es "correctamente". Nuevo `lib/ears.js` con las cinco
  formas de Mavin — ubicua · CUANDO (evento) · MIENTRAS (estado) · DONDE (opcional) · SI…ENTONCES (no
  deseado) — y su chequeo en `specs validar`.
  · **Lo que de verdad detecta no es que copies la plantilla**, sino la **condición enterrada**:
    *"el harness DEBE rechazar el commit si contiene un secreto"* esconde el disparador detrás del
    DEBE, y entonces su escenario no se puede derivar. Sacarla al principio obliga a decidir cuál es
    el disparador exacto, que es donde se cae la ambigüedad.
  · **AVISA por defecto**, a propósito: un gate duro invalidaría de golpe las specs ya escritas en
    todos los repos, y un equipo no puede reescribir su historia para actualizar el plugin. Un repo
    que lo quiera como gate pone `enums.ears.modo: "gate"` en su `faro-schema.json`.
  · **Falso positivo del español, cubierto:** *"DEBE comprobar **si** la rama está integrada"* es una
    pregunta indirecta, no una condición, y no se avisa. Un aviso que es ruido acaba desactivando el
    gate entero.
  · Se estrenó contra las specs de este mismo repo y **cazó 7 casos reales** escritos días antes,
    uno de ellos un requisito que hacía dos cosas en dos frases. Reescritos todos: el motor ya valida
    sin avisos. La skill `/faro:cambio` enseña las cinco formas con su tabla y un ejemplo mal/bien.
- **La suite era intermitente por la firma de commits, no por el código.** Los repos de prueba heredan
  la configuración **global** de git del desarrollador. Si esa configuración firma commits (gpg,
  1Password, ssh-sign) y el agente de firma no responde, `git commit` **falla**: el repo se queda sin
  commits, `gitInfo()` devuelve null y el harness —correctamente— no dice nada. El test falla por el
  entorno. Diagnosticado sobre un caso real (`error: 1Password: failed to fill whole buffer`) y
  corregido en **los 9 ficheros de test que crean repos**: la firma se apaga en el repo de prueba, sin
  tocar la configuración del usuario. Una suite que a veces sale roja deja de leerse, y así es como un
  fallo real puede sobrevivir versiones.
- **8 tests nuevos de EARS**, incluidos los del "si" ambiguo del español y los dos modos del contrato.

## 0.13.1 — 2026-09-10

- **Un remoto que NO es de GitHub se trataba como si lo fuera, y abortaba la operación.** `ghRepo()`
  aplicaba su expresión regular a **cualquier** cosa que devolviera `git remote get-url origin`. Con
  un remoto que es una **ruta local** —un repo `--bare` en disco, un montaje de red— y barras
  normales, colaba: `/tmp/proyecto-bare` se leía como org `tmp` y repo `proyecto-bare`. El harness
  llamaba entonces a la API de GitHub por un repositorio inexistente, recibía `SIN_TOKEN` y **salía
  antes de hacer su trabajo**: `consolidar` terminaba sin avisar de que `develop` local iba por
  delante del remoto, que es justo el aviso que existe para que nadie se deje trabajo sin subir.
  · **Por qué no se veía**: en Windows las rutas locales llevan contrabarras, la expresión no casaba
    y el flujo seguía correcto por accidente. El fallo solo aparecía en Linux y macOS — y ahí la
    integración continua llevaba **en rojo desde antes de la 0.13.0**, con una sola prueba fallando
    en dos de las tres plataformas.
  · La detección de forja (0.10.0) ya sabía distinguirlo: dice `desconocida` para una ruta local.
    Ahora `ghRepo()` se apoya en ella y solo devuelve org/repo si el remoto es **de verdad** de GitHub.
- **2 tests nuevos** (suite: **118 en verde**), uno por las tres formas que toma una ruta temporal en
  cada sistema, y otro que reproduce la consolidación con remoto local de extremo a extremo.

## 0.13.0 — 2026-09-10

- **Guardas de seguridad: lo que el harness no veía y la industria bloquea por defecto.** Nuevo
  `lib/guardas.js` con detectores puros (sin efectos, testeables sueltos) y su cableado en los hooks:
  · **Secretos en el área de preparación.** Un `git commit` que publicaría una clave privada, un token
    de plataforma o una cadena de conexión con contraseña se **deniega**. Es el único fallo de esta
    lista que es **irreversible**: publicada la clave, hay que rotarla aunque se borre el commit. El
    motivo **nombra el fichero pero nunca reproduce el valor**, que sería filtrarlo otra vez en el aviso.
  · **Ficheros de credenciales**: ni se escriben ni se vuelcan por consola (`cat .env` y familia).
  · **Ficheros enormes**: por encima del umbral no entran en el historial, del que ya no salen.
  · Umbrales y listas en `faro-schema.json` (`enums.guardas`), no en el código.
- **Corregido un falso positivo que impedía trabajar.** El detector anterior de ficheros de secretos
  bloqueaba **`.env.example`**, `.env.sample` y `.env.template` — justo los ficheros que existen PARA
  versionarse, y que el propio harness recomienda usar. El agente no podía crear lo que se le pedía
  crear. Ahora están exentos por diseño. De paso se le escapaban `id_ecdsa`, `.netrc`, `.p12`, `.pfx`
  y los almacenes de claves: cubiertos.
- **El force push NO se ha duplicado.** Ya lo bloqueaba `DESTRUCTIVE_CMD_PATTERNS`, y con un matiz
  deliberado que se respeta: exime `--force-with-lease`, que comprueba que nadie más haya empujado
  antes de reescribir. Se auditó antes de añadir nada.
- **El gobierno sobrevive a la compactación.** La compactación **sustituye el historial por un
  resumen**, y el bloque de sesión vive al principio de ese historial: en sesiones largas se resumía y
  se perdía el detalle. Ahora el arranque lee `start_reason` y, cuando viene de compactar, emite un
  **reancla de ~480 tokens** en lugar de repetir los 4.449 del bloque completo. El resumen conserva
  DE QUÉ va el trabajo; lo que se evapora son las REGLAS, así que el reancla trae solo eso: rama y su
  regla de escritura, fase, cambios abiertos y regla de plataforma. Los catálogos no se reinyectan.
  Sin `start_reason`, bloque completo: perder gobierno es peor que repetirlo.
- **`npm test` pasa a ejecutarse en SERIE** (`--test-concurrency=1`). Con ejecución paralela, los
  tests que hacen operaciones git reales sobre Windows se agotaban bajo carga y la suite salía roja
  de forma intermitente: 8 fallos en paralelo, **0 en serie, con los mismos 116 tests**. Una suite que
  a veces sale roja entrena al equipo a ignorarla, que es peor que una suite lenta. `npm run
  test:rapido` conserva el modo paralelo para iterar.
- **13 tests nuevos** (suite: **116 en verde**).

## 0.12.0 — 2026-09-10

- **El hook de prompt inyectaba 1.809 tokens en CADA prompt, y el 94% era el mismo texto.** Medido
  sobre un repo de trabajo real: 6.511 caracteres por turno, de los que 6.098 eran **idénticos turno
  tras turno** (dos ejecuciones seguidas devolvían el mismo hash). Solo 392 caracteres cambiaban. En
  una sesión de cincuenta prompts, casi 85.000 tokens gastados en repetir texto que ya estaba en el
  contexto unas líneas más arriba.
  · **Ahora son 334 tokens por turno: un 82% menos.** En una sesión de cincuenta prompts se ahorran
    unos 74.000 tokens.
- **La causa era de reparto, no de redacción.** `gitLines(compact)` ya recibía un indicador de si lo
  llamaba la sesión o el prompt, y lo respetaba en cuatro bloques menores, pero **los cuatro grandes
  lo ignoraban**: identidad y rol, tareas asignadas, la regla de plataforma y el bloque de protección
  de la rama principal. Ninguno cambia entre el primer prompt de la sesión y el último. Ahora los
  cuatro son de arranque de sesión, donde son contexto en vez de ruido.
- **La regla más repetida no se ha retirado: se ha endurecido.** Eran mil caracteres por turno
  pidiéndole al modelo que no usara el binario `gh`. Un texto cuesta tokens aunque se obedezca, y se
  puede desobedecer. Ahora es un **`deny` de `PreToolUse`**: cuesta **cero** tokens, solo se lee
  cuando alguien se equivoca de verdad, y no se puede ignorar. Mismo patrón que el veto al commit
  directo en la rama principal, donde el harness ya no pedía sino que vetaba.
  · Cubre también el `curl` directo a `api.github.com`, que esquivaba el token del harness y acababa
    en un 401 que nadie sabía interpretar.
  · El motivo se adapta a la forja: en GitHub reconduce al subcomando con el token; fuera de GitHub
    explica que no hay adaptador, en vez de mandar a una vía que tampoco funcionaría.
  · El patrón exige `gh` en **posición de comando**, así que `git push` y `github.com` no se
    confunden con el binario (hay test de cada falso positivo).
- **El protocolo spec no estaba en el arranque de sesión, solo en el turno.** Se reemitía entero,
  doce líneas, en cada prompt. Ahora el desarrollo completo va una vez al arrancar y en el turno
  queda el recordatorio de clasificar más el inventario de cambios abiertos, que sí cambia.
- **Criterio del reparto, para que no se deshaga con el tiempo: lo que PROTEGE se queda, lo que
  EXPLICA se mueve.** El radar de rama, que evita escribir en una rama protegida, sigue emitiéndose
  en cada prompt sin tocar. Lo que se retiró es su desarrollo largo, ya dado al arrancar.
- **Regresión detectada y corregida durante el propio cambio**: al condicionar por separado cada
  rama del `if/else-if` que clasifica la rama git, la cadena caía a una rama posterior y en `main`
  aparecía el aviso de «rama fuera de convención», que es falso. La clasificación es una sola
  decisión y ahora se envuelve entera. Hay test de regresión.
- **11 tests nuevos** (suite: 103 en verde).

## 0.11.0 — 2026-09-10

- **Los comandos de 0.10.0 no los citaba nadie.** La regla de coherencia del motor obliga a mantener
  alineados `harness.js`, `hooks.json`, `faro-schema.json` y las skills/agentes que citan sus
  comandos, y 0.10.0 incumplió la última parte: añadió `forge` y `atomico` sin que **ninguna** skill,
  agente ni línea del README los mencionara. Un comando que nadie cita es un comando que el agente
  no invoca nunca. Cableados ahora, con un test que lo vigila para que no vuelva a pasar.
- **Tres piezas seguían dando por hecho que la plataforma es GitHub.** `skills/tareas`,
  `skills/gestion-proyectos` y el agente `gestor-github` operaban sin consultar la forja, así que en
  un repo de GitLab seguían dando por ahí las instrucciones imposibles que el contexto de sesión ya
  había dejado de dar. Ahora las tres consultan `harness.js forge` primero, y el agente gestor
  **para en seco** si la forja no es la suya en vez de encadenar llamadas que van a fallar.
  `skills/pr` hace lo mismo y, fuera de GitHub, guía a subir la rama y abrir el merge request por la
  web con el enlace que imprime el propio `git push`.
- **Nuevo `harness.js codigo` — el informe de salud del código.** Contar líneas dice que un fichero
  es grande, no que el diseño esté mal. Se añaden las dos señales que sí describen un defecto
  objetivo, calculadas leyendo los propios ficheros y **sin instalar nada**:
  · **Ciclos de dependencia** (`lib/grafo.js`): si `a` importa `b` y `b` importa `a`, ningún módulo
    del ciclo se entiende ni se prueba por separado. Es un defecto, no una opinión, y por eso **sí**
    se anuncia en el contexto de sesión.
  · **Módulos que nadie importa**: suelen ser código muerto. Se quedan en el informe bajo demanda
    porque exigen criterio humano. Tests y puntos de entrada se excluyen (declarados en
    `faro-schema.json > enums.atomicidad.entradas`).
  El informe compone las tres señales con el veredicto de cada una. Sigue siendo un informe: salida
  cero siempre, y no cambia el resultado de `validate`. `atomico` se conserva tal cual.
- **El propio detector nació con un fallo que él mismo destapó.** La primera versión leía solo
  literales (`require('./x')`) y daba **16 falsos huérfanos**: todo `lib/` del motor, porque el
  harness carga sus módulos con rutas calculadas (`path.join(__dirname, 'lib', 'x.js')`). Se
  contempla ese idioma, incluido el patrón de guardarlo en una variable antes del `require`. El
  motor sale ahora limpio: sin ciclos y sin huérfanos.
- **El revisor de código deja de juzgar la estructura de memoria.** `revisor-code` ejecuta el
  informe y se le dice cómo leerlo: un ciclo que cruza una frontera declarada en `ARCHITECTURE.md`
  es **NO APTO**; el tamaño es solo una señal para ir a mirar ese fichero, y una partición por la
  mitad no se acepta como arreglo. `/faro:code` lo ejecuta sobre el esqueleto recién creado, que es
  el momento barato de corregir una frontera mal puesta.
- **11 tests nuevos** (suite: 92 en verde), incluidos tres que vigilan el cableado en sí.

## 0.10.0 — 2026-09-10

- **Los timeouts de los hooks iban al REVÉS de lo que decía su propio comentario.** `hooks.json`
  razonaba que sus 60 s y 30 s «van holgados» frente a los 10 s previos, y documentaba el fallo que
  quería evitar: cuando un hook expira, la plataforma **descarta su salida en silencio** y el agente
  pierde el gobierno FARO sin que nadie se entere. Pero el defecto de Claude Code para un hook de
  tipo `command` son **600 segundos**, y la plataforma solo lo rebaja a 30 en `UserPromptSubmit`.
  Declararlos no añadía margen: lo **quitaba**, dejándolo entre 10 y 20 veces más estrecho justo en
  el escenario que el comentario describe (arranque en frío de node con antivirus). Se retira el
  campo de todos los eventos. Medición que motivó el cambio (Windows 11, media de 3, plugin 0.9.7):
  `session` 5,8–9,1 s · `doc-check` 1,2–1,8 s · el resto por debajo de 1,1 s.
- **`SessionEnd` pasa a `async: true`.** La plataforma **no aplica plazo** a un hook asíncrono, así
  que el POST de métricas deja de competir con el cierre de la sesión. El envío desacoplado por
  proceso hijo se mantiene como segunda red, no como única defensa.
- **El harness ya sabe en qué forja está, y deja de mentir en GitLab.** Nuevo `lib/forge.js`: fuente
  única que resuelve desde `origin` si el proyecto vive en GitHub, GitLab (incluido autoalojado) o
  una forja desconocida. Hasta ahora el contexto de sesión inyectaba **siempre** la regla dura de
  GitHub —«abre el PR con `harness.js gh repos/<org>/<repo>/pulls`»— sin mirar el remoto: en un repo
  de GitLab esa orden es imposible de cumplir y el agente entraba en reintentos contra una API que
  no existe. Ahora la línea de plataforma la sirve el módulo de forja: en GitHub se conserva intacta;
  en GitLab declara qué **no** está implementado y guía al usuario a abrir el merge request por la
  web; en una forja desconocida no afirma nada. La línea de tareas asignadas solo aparece donde el
  harness sabe leerlas.
  · Detalle que rompía el parseo: GitHub es **siempre** `owner/repo`, pero GitLab anida subgrupos sin
    límite (`grupo/sub/sub/proyecto`). La regex histórica de dos segmentos se quedaba con los dos
    últimos, que no identifican el proyecto. `forge.js` conserva la ruta completa, que es el id que
    usa la API de GitLab.
  · **Fuera de alcance a propósito:** esto es solo detección. El adaptador que hable la API de GitLab
    es un cambio posterior; esta pieza es su cimiento.
- **Nuevo `harness.js forge`**: imprime la forja detectada, la ruta del proyecto y qué sabe hacer el
  harness en ella. Para diagnóstico y para que las skills lo **pregunten** en vez de suponerlo.
- **Criterio de atomicidad, por fin objetivo.** No existía ninguno: lo único parecido era una frase
  en prosa dentro de `revisor-code-worker` («1 archivo = 1 funcionalidad») que juzga el modelo a ojo
  y solo se activa en repos Cloudflare. Nuevo `harness.js atomico`: informe de los ficheros de código
  por encima del umbral, ordenado y con el exceso de cada uno. **Avisa y no bloquea**, decisión
  deliberada — un umbral duro se sortea partiendo un fichero por la mitad, con lo que la cifra baja y
  el diseño empeora. El umbral vive en `faro-schema.json` (`enums.atomicidad`, 400 líneas por
  defecto), así que un repo puede declarar el suyo sin tocar el motor. La sesión avisa de los tres
  peores solo si hay deuda.
  · El informe es honesto con el propio motor: hoy canta `harness.js` (2.542) y `lib/github.js` (764).
- **`validate` sembraba 21 carpetas vacías en el repo del motor.** La exención de modo motor estaba
  en `cmdSession` pero no en `cmdValidate`, así que validar el repo del plugin le creaba
  `gestion/`, `documentos/`, `fuentes/`, `notebooks/` y compañía, que el motor no usa. Misma guarda
  en los dos sitios.
- **13 tests nuevos**, uno por escenario de los deltas de spec del cambio (suite: 81 en verde).

## 0.9.7 — 2026-08-25

Cinco fallos reportados desde producción, todos con test de regresión.

- **`asignar-tarea` estaba ROTO desde 0.9.0** (`TypeError: Cannot read properties of undefined
  (reading 'github')` en `lib/github.js:483` con cualquier `--tipo`). Al mover los módulos a `lib/`
  en 0.9.0, la ruta de fallback del contrato quedó como `path.join(__dirname, 'faro-schema.json')`
  — pero `__dirname` en `lib/` es `hooks/lib/` y el schema vive en `hooks/`. En cualquier repo sin
  copia local del schema el catálogo salía VACÍO, `tipos.find()` devolvía `undefined` y reventaba;
  el mensaje ("faro-schema.json sin enums.labels") culpaba al contrato, que sí estaba bien.
  Corregido en los 3 sitios afectados (`github.js` ×2, `clickup.js`) — **el schema del plugin es
  siempre el fallback**, el del repo solo lo pisa si existe.
- **`consolidar`/`aprobar` reportaban "conflicto" en merges limpios, y dejaban el repo A MEDIAS.**
  CAUSA RAÍZ: `git()` usaba `timeout: 5000` para TODA operación, incluido `git merge` — en un repo
  real (271 ficheros / +61k líneas) el proceso se mataba a media escritura, dejando `index.lock`
  huérfano y ~133 ficheros en estado `AD`; encima el éxito se decidía comparando HEAD antes/después,
  que no distingue "conflicto real" de "proceso muerto", y el `merge --abort` posterior ya no podía
  limpiar. Ahora: `gitWrite()` (nuevo) con **timeout de 10 min y código de salida real**, se limpia
  el `index.lock` huérfano antes de operar, y se distinguen tres desenlaces — integrado / conflicto
  real (se aborta solo, con lo que dijo git) / proceso no terminado (**no** se aborta a ciegas: se
  para y se explica qué revisar).
- **`consolidar` no empujaba si el merge venía de una invocación anterior**: el push vivía dentro de
  `if (done.length)`, así que "Nada que consolidar" dejaba develop N commits por delante en local, en
  silencio (caso real: 51 commits). Ahora se comprueba SIEMPRE contra `origin/develop` y se avisa.
- **El gate `lint` culpaba al linter de un fallo de dependencias**: `pnpm` abortando por
  `ERR_PNPM_IGNORED_BUILDS` (y otros: lockfile desincronizado, sin red, módulos ausentes) se
  reportaba como `[gates] lint: FALLA` con un stacktrace de pnpm, cuando `pnpm run lint` pasaba en
  verde. Nuevo estado `deps`: "NO EVALUADO — problema de DEPENDENCIAS, no del gate" con el arreglo
  concreto (`pnpm approve-builds --all`, etc.), y **no bloquea** validate (avisa).
- **`--help` ya es ayuda**: `consolidar --help` y `aprobar --help` ejecutaban la operación real
  (validación incluida). Ahora muestran qué hace el comando, en qué orden y con qué reglas.
- **`npm test` pasa a serie** (`--test-concurrency=1`): con 63 tests que crean repos git reales, el
  paralelismo agotaba timeouts y producía **rojos falsos** — exactamente la clase de señal engañosa
  que este release corrige. Suite 63/63.
## 0.9.6 — 2026-08-25

- **Detección de ramas integradas por SQUASH MERGE** (bug real reportado en producción: PR #46 de
  `feat/add-data-detail` → `develop`, 18 commits aplastados en uno solo por GitHub "Squash and
  merge"). `git branch --merged` compara por ANCESTRO de commit — un squash crea un commit nuevo
  con hash distinto a todos los de la rama, así que ningún commit es ancestro de `develop` y el
  harness seguía avisando "features sin integrar en develop" aunque el contenido ya estuviera allí
  (afectaba también a `/faro:consolidar`, que podía intentar re-mergear una rama ya integrada, y a
  `/faro:ramas`, cuyo detector de squash con `diff --quiet base...rama` fallaba si `develop`
  avanzaba DESPUÉS del squash con commits ajenos a la rama).
  Arreglo: `git merge-tree` (fusión de PRUEBA, no toca nada) — si el árbol resultante de fusionar
  la rama es idéntico al árbol ACTUAL de la base, mergearla no cambiaría nada → ya está integrada.
  Robusto con 1 commit, con 18, y con la base avanzada después. `git cherry` se descartó: compara
  patch a patch y falla con ramas de múltiples commits (ningún commit parcial coincide con el diff
  acumulado del squash).
- 5 tests nuevos (`test/squash-merge.test.mjs`), incluido el caso negativo (rama realmente sin
  integrar debe seguir avisando). Suite 60/60.

## 0.9.5 — 2026-08-23

- **`/faro:aprobar` exige confirmación EXPLÍCITA del usuario antes de mergear** (bug de seguridad
  real): el comentario histórico del código decía *"invocarlo ES tu aprobación"* — un agente con
  rol de maintainer podía ejecutar `harness.js aprobar` y mergear a main sin que el usuario hubiera
  confirmado en esa conversación; el único gate era el rol de GitHub, no la confirmación humana.
  Ahora, sin `--confirmo`, el comando se PARA tras mostrar qué se aprobaría (commits incluidos) y
  no ejecuta el merge. La skill `/faro:aprobar` pasa `--confirmo` solo tras el `AskUserQuestion`
  explícito al usuario (su paso 4, ya existente). El rol sigue decidiendo QUIÉN puede aprobar; la
  confirmación decide SI se aprueba ahora.
- 3 tests nuevos (`test/aprobar-confirmacion.test.mjs`): el merge nunca avanza sin `--confirmo`, un
  flag distinto no basta, y el gate está en el código ANTES de la llamada al merge. Suite 46/46.

## 0.9.4 — 2026-08-23

- **`/faro:aprobar` etiqueta la versión publicada** (`lib/release.js`, nuevo): tras el merge
  develop → main, crea el tag anotado `vX.Y.Z` (leído de `package.json` o
  `.claude-plugin/plugin.json`) sobre el commit de merge y lo sube en el mismo push — cierra el
  ciclo hasta ahora manual (versión + CHANGELOG + commit coherentes, pero sin tag automático).
  Idempotente: si el tag ya existe sobre el mismo commit, no hace nada; si existe sobre OTRO
  commit, NO lo reescribe — avisa para decidir en vez de romper a quien ya lo referencia.
- **Skill `/faro:changelog` cierra el ciclo del tag**: nuevo paso 6 (crear/verificar el tag tras
  cada salto de versión, completar los que falten en el historial) y el paso 1 (situarse) ahora
  también compara `git tag -l` contra las cabeceras del CHANGELOG.
- Suite: 5 tests nuevos (`test/aprobar-tag.test.mjs`, incluido un caso end-to-end con remoto local
  que se salta con seguridad si detecta un token real en `~/.faro.json`); 52/52 en total.

## 0.9.3 — 2026-08-23

- **Onboarding: la plantilla de ESTADO.md pide la CLAVE y deja de prescribir `tipo`** (caso real:
  un repo nuevo nacía con `tipo: core-serv`, retirado del catálogo en 0.9.0, porque la directiva
  lo listaba en el frontmatter estándar). Ahora: frontmatter (nombre, **clave**, objetivo, estado,
  fases_total, fase_actual, owner, funcional) + cómo sugerir/fijar la clave, y la instrucción
  explícita de NO añadir campos que el usuario no haya pedido. `tipo` sigue siendo opcional y un
  valor fuera de catálogo se IGNORA en silencio (sin mención alguna) — con tests de regresión que
  lo fijan, junto al de `funcional: null` (se trata como ausente).
- **Sin "flashes" de consola en Windows**: TODOS los procesos hijos del motor (git/gh/node — 19
  llamadas en harness.js, git.js, clickup.js, code.js, github.js, ramas.js) llevan ya
  `windowsHide: true` — el trabajo es el mismo, pero invisible: ningún hook abre ventanas fugaces.
  Un test-lint determinista (`test/windows-hide.test.mjs`) exige la opción en todo spawn futuro.
- **CI multiplataforma** (`.github/workflows/ci.yml`): la suite corre en ubuntu + windows + macos
  en cada PR y en cada push a main — hasta ahora los tests solo se ejecutaban en la máquina de
  quien desarrolla; toda release queda validada en los tres sistemas donde corre el plugin.

## 0.9.2 — 2026-08-23

- **Skill `/faro:iniciar`**: arranque guiado de un trabajo nuevo — entrevista (AskUserQuestion) →
  ESTADO.md + clave documental → brief (BRF, agente redactor-documento) → fuentes/ con digestión
  (agente gestor-requisitos) → RAID inicial (agente gestor-riesgos) → ciclo git (develop + rama de
  trabajo) → validate. Incentiva la orquestación: los pasos independientes (digestión, BRF, RAID)
  se lanzan como subagentes en paralelo, o como agent team si el repo lo tiene habilitado.
- **Adiós a INICIATIVA.md en los mensajes**: todos los textos al usuario citan ya ESTADO.md (aviso
  de aprobación con 'maintainers:', stats, errores de ClickUp). La compatibilidad silenciosa con
  repos legados que aún tengan INICIATIVA.md se conserva.

## 0.9.1 — 2026-08-23

- **CICLO DE DIGESTIÓN (`lib/digestion.js`)**: se cierra el lazo de vuelta de `fuentes/` (el
  material que el gestor sube — transcripciones, briefs, funcionales de cliente — dejaba de mover
  el sistema). Señal en sesión "FUENTES SIN DIGERIR": fuentes POSTERIORES a la última revisión del
  funcional/ESTADO.md (espejo inverso de frescura.js; una fuente recién soltada sin commit cuenta
  por su mtime) + DIRECTIVA para que el AGENTE orqueste: leer, extraer requisitos/decisiones/
  riesgos/fechas, confirmar con el usuario y repartir a las carpetas correctas (funcional sube
  versión citando la fuente · registro de requisitos · cambio spec-driven · RAID · ESTADO+ADR).
  La señal se apaga sola al committear funcional/ESTADO después de la fuente. En validate aparece
  como aviso `[digestion]` (no bloquea).
- **REGISTRO DE REQUISITOS (`gestion/requisitos.md`)**: RTM ligera y git-nativa (IEEE 29148 /
  DOORS/Jama, sin herramienta externa). Formato validable — `## REQ-NN · <nombre>` + `estado:`
  (propuesto|aceptado|en-cambio|entregado|descartado) + `origen:` (la fuente que lo trajo).
  El FORMATO es error de validate (`[req]`: campo ausente, estado no reconocido, id duplicado);
  el registro en sí es opcional (sin archivo no hay error). Sin registro pero CON fuentes
  históricas, la sesión sugiere la DIGESTIÓN RETROSPECTIVA (rellenar el registro con lo ya
  acordado/entregado para arrancar la trazabilidad con la historia completa).
- **TRAZABILIDAD requisito↔cambio/tarea**: aviso `[requisitos]` en validate (no bloquea, es la red
  del gestor técnico): un requisito aceptado/en-cambio debe estar citado (REQ-NN) en un cambio
  spec-driven o en una tarea de ESTADO.md; también avisa de tareas abiertas que no citan ningún
  requisito. La sesión resume el registro por estados y lista los huecos de cobertura.
- **FUENTES BINARIAS → EXTRACTO**: un pdf/docx/audio en fuentes/ pide UNA VEZ su extracto hermano
  `<fichero>.extracto.md` (resumen fiel + citas literales); desde entonces el extracto representa
  al binario en la señal y las iteraciones siguientes leen el MD sin re-procesar el binario.
- **SEÑALES ESTRUCTURADAS**: `estado-json` incorpora `requisitos` y el bloque `senales`
  (fuentes_sin_digerir, requisitos_sin_cobertura) — las mismas señales que la sesión, como DATOS
  recalculados en cada invocación para integraciones/dashboards. La telemetría (`metrics`) suma
  `reqs_total`, `reqs_sin_cobertura` y `fuentes_sin_digerir`.
- **`.metrics/` AUTOIGNORADO**: el spool local de telemetría escribe su propio `.gitignore` (`*`)
  al crearse (patrón industria: .yarn/cache, target/ de cargo) — es telemetría de la máquina del
  usuario y nunca debe viajar en commits/PRs. En este repo se des-trackea `.metrics/pending.json`.
- **CICLO GIT OBLIGATORIO también en MODO PLUGIN** (bug histórico corregido): la protección de
  ramas de `pre-bash` exigía la copia legada `.claude/hooks/harness.js` (mundo pre-plugin), así que
  los repos en modo plugin quedaban SIN el bloqueo de main/develop aunque el README lo describe
  como obligatorio. Ahora la detección de repo gobernado es TRIPLE y robusta: `ESTADO.md` o
  `.faro.json` o el plugin faro declarado en `.claude/settings.json` — cualquiera activa el ciclo
  completo (commit directo bloqueado en principales; merge/push = aprobación con rol). El MOTOR
  queda exento explícitamente (modo motor).
- **Ramas protegidas EXTENSIBLES por repo** (determinista, versionado): `.faro.json` →
  `"ramas_protegidas": ["demo", "pre"]` — cualquier rama de entorno nueva recibe el mismo trato
  que develop (solo merges; commit directo bloqueado). main/master/develop protegidas SIEMPRE.
- **Agente `gestor-requisitos`** (molde gestor-riesgos): orquesta la digestión y el registro;
  referenciado en la directiva de digestión, la línea de subagentes de sesión, la skill
  gestion-proyectos y auditor-faro (que suma la dimensión requisitos/digestión).
- **AskUserQuestion en subagentes — textos corregidos** (validado contra la doc oficial): SÍ está
  disponible también en subagentes; se eliminan las afirmaciones de lo contrario en 6 skills/agentes
  y se reescriben 11 fallbacks. Los revisores/auditor mantienen su diseño "no interrumpir": la tool
  se usa solo ante bloqueo real; lo demás va explícito en el veredicto/informe.
- **Directiva MODO MOTOR reforzada**: dicta el flujo completo del motor (rama → TDD → bump+changelog
  → PR; el merge es la aprobación del usuario) y prohíbe el commit directo a main también aquí.
- Red de seguridad: 19 tests nuevos (`test/digestion.test.mjs` + `test/flujo.test.mjs`); suite
  43/43 en verde.

## 0.9.0 — 2026-08-23

- **Modularización del motor**: `harness.js` pasa de 3353 a ~2350 líneas y queda como DESPACHADOR;
  la lógica vive en `hooks/lib/<dominio>.js` con un CTX compartido (patrón factory): `base` (emisión
  de hooks, stdin, ficheros), `git` (estado/flow/roles), `estado` (parseo y validación de ESTADO.md),
  `kpis`, `tipos`, `onepager` (+roadmap), `semanal`, `frescura` (nuevo). Los módulos que ya existían
  (`github`, `code`, `specs`, `clickup`, `ramas`, `metrics`, `paths`) se mueven también a `lib/`.
  En `hooks/` quedan solo el despachador, `self-hint.js` y los contratos (hooks.json, faro-schema,
  manifest). Respaldo del refactor: los 24 tests de `test/smoke.test.mjs` en verde.
- **MODO MOTOR (`IS_ENGINE`)**: el repo fuente del propio plugin (marketplace + plugins/faro) queda
  EXENTO del gobierno de instancia. Hasta ahora el harness se auto-gobernaba: exigía ESTADO.md y
  onboarding al repo que lo implementa, bloqueaba la edición en main de su propio código y cada
  sesión materializaba carpetas huérfanas (documentos/, gestion/…) en el repo del motor.
- **`pre-doc` con ámbito correcto (coherente con `pre-bash`)**: los gates de rama/instancia aplican
  SOLO a rutas DENTRO del repo (bug real: bloqueaba escribir la memoria del agente, fuera del repo,
  por estar la sesión en main) y SOLO si el repo es una instancia FARO (existe ESTADO.md) — igual
  que el `esFaro` de pre-bash. Además desbloquea el onboarding: crear ESTADO.md en un repo recién
  nacido ya no choca con la protección de main. El bloqueo de SECRETOS sigue siendo universal.
- **El TIPO deja de obligar**: se lee también del metadato `.faro.json` (antes solo del frontmatter
  o del prefijo del nombre), es SIEMPRE opcional, un valor que el catálogo no conoce se IGNORA en
  silencio (ni aviso ni error de validate), y desaparece el error que exigía que el tipo coincidiera
  con el prefijo del nombre del repo. Los tipos de SERVICIO (`<plataforma>-serv`) se retiran
  del catálogo: quedan funcionalidad de plataforma, proyecto e iniciativa. La cabecera de sesión y
  el onboarding se adaptan al tipo cuando está declarado (p. ej. iniciativa → funcional no bloqueante).
- **FRESCURA DOCUMENTAL (drift)**: nueva señal en sesión (lib/frescura.js, técnica estándar de
  doc-drift): un doc aprobado/en revisión cuya fuente (funcional) cambió DESPUÉS de su última
  edición se marca DESFASADO; uno aprobado sin tocar 90+ días con actividad posterior, REVISAR.
  No bloquea: pide confirmar vigencia (subir versión o marcar obsolete).
- **Archivado robusto en Windows (specs.js)**: `renameSync` de la carpeta del cambio fallaba con
  EPERM (antivirus/indexador) dejando el archivado A MEDIAS (deltas aplicados, carpeta sin mover).
  Ahora: reintentos y, si persiste, copia+borrado.
- **superpowers por el marketplace OFICIAL de Anthropic** (`superpowers@claude-plugins-official`),
  canal único; la detección cuenta también el settings de USUARIO, no solo el del repo.
- **self-hint publica la versión del motor y detecta caché desfasada**: si la sesión corre una
  versión antigua con una más nueva ya descargada (caso real: 0.4.31 activa con 0.8.5 en caché),
  avisa para actualizar (`claude plugin update faro@faro-marketplace`) y reiniciar.
- **Ciclo de commit de artefactos generados**: stop-check señala que informe semanal, ESTADO.md,
  CLAUDE.md y reporting actualizados FORMAN PARTE del commit del trabajo en curso (no quedan sueltos).
- **Disciplina de tests en modo code** (code.js): todos los tests en UNA carpeta raíz
  (test/{unit,integration,e2e}), criterios de aceptación demostrados con e2e, mejores prácticas
  vigentes consultadas (WebSearch/docs) antes de implementar, y barrido de código muerto
  (knip/ts-prune/depcheck/vulture) al cerrar cada cambio.
- **Base única del flujo spec-driven**: `gestion/cambios/` (paths.js deja de resolver carpetas
  de modelos anteriores).

## 0.8.5 — 2026-08-10

- **La nomenclatura documental pasa a vivir en el PLUGIN** (`docs/nomenclatura-documental.md`). Se
  sembraba en `documentos/` de cada repo y había acabado en **7 copias con 3 contenidos distintos**
  (16 KB / 11 KB / 2 KB). Siendo la fuente de verdad de los `doc_id`, que cada repo tenga la suya
  significa que dos proyectos pueden discrepar sobre qué es un `ANA` o qué códigos existen: la
  documentación de la organización deja de ser comparable. Mismo criterio que las plantillas de marca
  en 0.4.32 — se sirve desde el plugin y se actualiza sola.
  · Corregida una incoherencia que arrastraba el documento: decía clave de **2-6** letras cuando el
    contrato (`CLAVE_RE`) exige **4-10** desde 0.4.30.
  · Cabecera nueva que fija la jerarquía: el documento explica el PORQUÉ y las reglas; el **contrato
    ejecutable** (37 tipos con ámbito, estándar y familia) está en `faro-schema.json` y se consulta
    con `harness.js tipo`. Si discrepan, **manda el comando**.
- **Re-apuntadas las 4 referencias que señalaban al fichero del repo** (`harness.js` ×2,
  `skills/redactar`, `agents/redactor-documento`): apuntaban a
  `documentos/nomenclatura-documental.md`, que en un repo adoptado puede no existir o estar
  desfasado. Ahora remiten al contrato ejecutable y al documento del plugin.
- **El harness materializa el árbol FARO completo.** `REF_DIRS` no incluía `notebooks/`, `scripts/`
  ni las subcarpetas de `borrador/` (`data`, `scripts`, `tmp`): solo aparecían si el repo venía del
  template. Ahora un repo desnudo obtiene las **21 carpetas** en la primera sesión, sin que nadie le
  copie un andamio de carpetas vacías. `notebooks` y `scripts` se añaden a `paths.js`, que es la
  fuente de verdad de la taxonomía.

## 0.8.4 — 2026-08-09

- **Nueva skill `/faro:changelog`**: gobierna versionado y CHANGELOG para que no se vuelvan a
  desfasar (este mismo fichero se había quedado en 0.4.27 con el plugin en 0.8.3, y el README
  remitía a él como fuente de novedades). Decide el salto **major/minor/patch por IMPACTO en quien
  consume**, no por el tamaño del diff: arreglar un bug grave sigue siendo `patch`, y un flujo que
  pasa a hacer algo nuevo es `minor` aunque cambien 3 líneas. Regla explícita contra los saltos
  descoordinados: **un solo salto por publicación** (el trabajo pendiente se agrupa en UNA versión y
  manda el cambio de mayor impacto) y, ante la duda, **el menor**. Valida antes de commitear que la
  versión del manifiesto, la cabecera del CHANGELOG y el mensaje del commit dicen lo mismo, y que la
  versión sube sin saltarse números. Con `--check` solo diagnostica.
- **8 skills y agentes cargaban SIN metadata por un YAML roto.** `claude plugin validate` fallaba en
  `adoptar`, `clickup`, `documentacion`, `roadmap` (skills) y `gestor-github`, `redactor-informe`,
  `renombrador-faro`, `revisor-code-worker` (agentes): sus `description` contienen `": "` sin
  comillas, que YAML interpreta como separador clave/valor y hace fallar el parseo del frontmatter
  **entero**. El efecto no era cosmético: sin `description`, el modelo no sabe cuándo usar esa skill
  o ese agente — justo la pieza que decide si se invocan. Entrecomillados los valores; la validación
  del plugin pasa ahora sin errores.
- **Los issues se crean SIEMPRE con un label de tipo, y el contexto de sesión ya no enseña lo
  contrario.** El `--tipo` era obligatorio en `asignar-tarea` desde 0.6.x, pero las dos fuentes que
  el agente lee de verdad —la línea de "Tareas asignadas" del bloque de sesión (`harness.js`) y
  `skills/tareas/SKILL.md`— seguían mostrando la forma **sin** `--tipo`. El agente copiaba esa forma
  y el comando abortaba. Ahora ambas inyectan la firma completa con el catálogo de tipos y la
  instrucción de PREGUNTAR (AskUserQuestion) en lugar de adivinar.
- **`requerimiento` y `mejora` dejan de ser indistinguibles.** Los dos mapeaban al mismo label nativo
  `enhancement`, así que en el repo se veían igual y la taxonomía de tipos se colapsaba.
  `requerimiento` pasa a `faro:requerimiento`; `mejora` conserva el nativo. Documentado en el schema
  que un mismo `github` no debe repetirse entre tipos.
- **Dimensiones transversales separadas del tipo (`--extra`).** `urgente`, `riesgo`, `compliance` y
  `seguridad` no describen QUÉ trabajo es: son ortogonales. Antes obligaban a elegir entre `bug` y
  `urgente` perdiendo información. Ahora se marcan con `"transversal": true` en el schema, se
  rechazan como `--tipo` (con el mensaje que enseña la forma correcta) y se añaden con
  `--extra <slug[,slug]>`, acumulables. Los extras son opcionales: si uno no resuelve, el issue se
  crea igual — el label obligatorio es el tipo.
- **Se avisa de los issues abiertos SIN label.** Los que entran por la web de GitHub no pasan por
  `asignar-tarea`, así que se colaban sin clasificar y nadie lo detectaba. El snapshot de sesión
  añade el recuento (`search/issues ... no:label`, barato: solo `total_count`) y lo reporta aunque no
  tengas nada asignado.
- **Mermaid vuelve a pintarse en los HTML generados.** Las 3 plantillas de marca cargaban
  `mermaid@11` (rango FLOTANTE) con un `integrity` SRI FIJO. Al publicar el CDN cualquier 11.x nueva
  el hash dejaba de coincidir y el navegador **bloqueaba** el script: `mermaid` quedaba `undefined`,
  los diagramas no se pintaban y saltaba el aviso "sin conexión" **aunque hubiera internet**.
  Verificado: el hash servido hoy (`sha384-aBQXj4hK…`) no coincide con el fijado (`sha384-T/0lMUdJ…`).
  SRI y versión flotante son incompatibles: se fija `mermaid@11.16.1` con su hash real (se conserva la
  protección) y se documenta cómo regenerarlo al subir de versión. El aviso engañoso ahora nombra
  también el bloqueo por SRI como causa posible.
- **`clickup push` ya no rompe el write-back de `[cu:id]`.** `clickup.js` desestructuraba `INICIATIVA`
  del contexto, pero `harness.js` pasa `ESTADO_FILE`: llegaba `undefined` y el comando petaba con
  "path... undefined" **después** de haber creado las tareas. Sin los marcadores escritos, el
  siguiente push **duplicaba** todas las tareas en ClickUp. Se acepta el alias legado y se valida el
  contexto al entrar.

## 0.8.3 — 2026-08-05

- **La plantilla del plugin manda siempre**: se retira el fallback repo → plugin. Una copia local
  quedaba congelada el día que nació el repo y tapaba las mejoras (impresión, marca) que el plugin ya
  trae. Personalizar de verdad se hace con `<nombre>.custom.html`, un override explícito que no se
  hereda al copiar un repo.

## 0.8.2 — 2026-08-05

- La fase EN CURSO domina el roadmap; color sin texto redundante.

## 0.8.1 — 2026-08-05

- El roadmap distingue **BLOQUEA** de **QUEDA POR CERRAR**, con formato A3 y rediseño.

## 0.8.0 — 2026-08-05

- **El roadmap pasa a milestone chart estándar** (fuera el "cochecito"): notación reconocible en
  gestión de proyectos en lugar de una metáfora propia.

## 0.7.1 — 2026-08-04

- `plantilla` redirige al contrato (`harness.js tipo`) cuando ya no hay esqueleto que servir.

## 0.7.0 — 2026-08-04

- **Familias documentales**: 8 guías cubren los 37 tipos, con diagramas Mermaid. Sustituyen al
  esqueleto por tipo: se explica el CRITERIO de cada familia, no una plantilla a rellenar.

## 0.6.2 — 2026-08-04

- **Tres roles de persona** (`author` / `owner` / `solicitante`), cada uno con el identificador que le
  corresponde según el rol.

## 0.6.1 — 2026-08-04

- **El tipo de documento NO se pregunta aparte**: ya viaja dentro del `doc_id` (`CLAVE-TIPO-NNN`). Un
  campo `type` suelto solo añadía una segunda fuente que podía contradecir al id.

## 0.6.0 — 2026-08-04

- **El contrato documental como fuente única**: `harness.js tipo` (catálogo + secciones, criterio y
  errores típicos por tipo). El agente consulta el contrato en lugar de decidir de memoria.

## 0.5.2 — 2026-08-04

- Quitado `name` del frontmatter de las skills para recuperar el prefijo `/faro:`.

## 0.5.1 — 2026-08-04

- El carril del roadmap escala a cualquier número de fases.

## 0.5.0 — 2026-08-04

- **`/faro:roadmap`**: la hoja de ruta visual ("dónde estamos").

## 0.4.33 — 2026-08-04

- **El reporting SIEMPRE lleva fecha en el nombre**: no existe un artefacto "vivo". Misma fecha →
  actualiza ese snapshot; fecha nueva → snapshot nuevo. (El documento vivo en `documentos/` tiene su
  propio control de versiones, que es cosa distinta.)

## 0.4.32 — 2026-08-04

- **Las plantillas de marca viajan en el plugin** (`plantillas/html/`): antes vivían solo en el repo,
  copiadas al crearlo, y envejecían sin remedio — mejorar el diseño obligaba a re-aplicar la capa FARO
  repo por repo, y `faro check` ni lo detectaba. Se actualizan solas con `autoUpdate`.
- **Impresión a PDF sin desbordes**, auditadas las 4 plantillas: `print-color-adjust` global (sin él
  Chrome elimina los fondos al imprimir y el semáforo RAG, las barras de fase y los chips de severidad
  salían en BLANCO), `break-inside` en el one-pager (no tenía ninguno: cualquier card podía partirse
  entre páginas) y protección de ancho para los diagramas Mermaid del informe.

## 0.4.31 — 2026-08-04

- README al día: skill `/faro:tareas`, clave por repo, recuentos reales (las skills eran 24, no 21).

## 0.4.30 — 2026-08-04

- **Una clave documental por repo** (revierte la clave compartida de 0.4.27): `cmdDocRef` calcula el
  siguiente `doc_id` leyendo los ficheros LOCALES, así que dos repos con la misma clave emiten el
  MISMO id sin poder detectarlo. Con clave propia la colisión es imposible por diseño.
- Mínimo de la clave: 4 caracteres (con 2-3 las siglas chocan entre proyectos de la misma org).

## 0.4.29 — 2026-08-03

- **`/faro:tareas` y `mis-tareas` ven toda la organización**, priorizando la repo actual: detalla lo
  accionable aquí y de las demás da solo el recuento por repo. Antes un issue asignado en otro repo
  era invisible.

## 0.4.28 — 2026-08-03

- **Timeouts de hooks holgados**: los 10s se agotaban en la práctica (arranque en frío de node +
  antivirus + `git status` sobre repos grandes). Cuando un hook expira su salida se DESCARTA en
  silencio y el agente pierde el contexto FARO del turno sin que nadie lo note.
- `gestor-github`: el `description` decía "vía API/gh" mientras el cuerpo prohíbe usar `gh` cuatro
  veces; la contradicción le hacía intentar el binario primero.

## 0.4.27 — 2026-07-30

- **La clave documental ya NO se bloquea al estar en uso en otro repo de la org.** `cmdClave()`
  hacía `return` sin fijar nada cuando `claveEnUso()` encontraba la clave en otro repo, pero su
  propio mensaje (`CHOQUE`) ofrecía como primera salida *"es el mismo proyecto → reutilizar esa
  clave"*: la rama que recomendaba no estaba implementada, así que compartir clave era imposible
  por comando y obligaba a escribir el frontmatter a mano. Compartir clave entre repos de un mismo
  proyecto (back / pipeline / front) es un caso legítimo.
  El bloqueo tampoco protegía lo que aparentaba: `estamparClave()` solo estampa un **topic** de
  GitHub (una etiqueta), no lleva contadores ni reserva numeración — de hecho la rama
  `enOtro === undefined` (búsqueda de la org no disponible) ya estampaba claves duplicadas sin
  abortar. Ahora se valida igual, se fija siempre y el aviso pasa a llamarse `COMPARTIDA`,
  explicando la implicación REAL: los `doc_id` se numeran **por repo**, así que hay que acordar
  rangos separados o tipos que no se solapen para no emitir dos `<CLAVE>-TIPO-001` distintos.
  Alineados los otros dos puntos que describían el comportamiento anterior: la consulta sin
  argumentos de `harness.js clave` y `skills/documentacion/SKILL.md`.
- **Regla dura: los nombres de persona NUNCA se inventan.** Todo campo que identifique a alguien
  (`author`, `owner`, `responsable`, `deciders`, `aprobada_por`, Owner de un riesgo, firmas de
  informes) se rellena con el **login de GitHub** del usuario (`harness.js identity`; para terceros
  `harness.js equipo` / `approvers`); si no está disponible, el `user.name` de git; si tampoco,
  se PREGUNTA. Prohibidos los nombres plausibles, los placeholders tipo "Equipo FARO" y deducir la
  persona del nombre del repo o del cliente: un nombre inventado es un dato falso en un documento
  controlado y firma a quien no ha firmado. Añadida en `skills/gestion-proyectos` (directiva madre,
  aplica a todos los roles) y reforzada donde más se rellenan estos campos:
  `skills/documentacion` (frontmatter) y `agents/redactor-documento` (control del documento).

## 0.4.26 — 2026-07-30

- **Envío de telemetría desacoplado del proceso del hook** (patrón estándar de la industria para
  CLIs de vida corta — Homebrew: "Analytics are done in a separate background process... failures
  are silent"). Antes, `flushMetrics()` hacía `await postMetrics()` dentro del propio hook
  `SessionEnd`/`Stop`: si Claude Code cancelaba el hook (timeout de 15s agotado, o cierre de sesión
  antes de que la red terminara — visible como "Hook cancelled" en algunos cierres), el evento se
  perdía y solo se recuperaba en el catch-up de la SIGUIENTE sesión en ese mismo repo (nunca, si el
  usuario no volvía a abrir sesión ahí).
  Ahora `flushMetrics()` es síncrono: construye el payload (solo git/filesystem local, rápido) y
  spawnea `metrics-send.js` (nuevo) como proceso hijo desacoplado (`detached: true`,
  `stdio: 'ignore'`, `.unref()`) que hace el POST por su cuenta, fuera de la ventana de
  timeout/cancelación del hook. El proceso padre retorna de inmediato. `pending.json` se mantiene
  como red de seguridad de última instancia (si ni el proceso hijo llega a spawnearse).
- `cmdMetrics()` (comando interactivo `harness.js metrics`) no cambia: sigue haciendo el POST en el
  propio proceso porque el usuario espera ver el resultado en pantalla.

## 0.4.25 — 2026-07-30

- **Fix crítico de telemetría**: se detectó que un `git config --global faro.metricsUrl` residual
  (fijado antes de la migración a `faro-control-panel`, apuntando al webhook n8n legado) hacía que
  el harness siguiera enviando eventos a un destino muerto de forma silenciosa — `postMetrics()`
  reportaba `OK 200` (n8n seguía respondiendo) sin que el evento llegara nunca al panel/D1. Esto
  puede afectar a cualquier repo/usuario que haya configurado ese override antes de 0.4.24.
  `metricsUrl()` ahora valida que el override de `git config` apunte al MISMO host que
  `DEFAULT_METRICS_URL` vigente; si no coincide, lo descarta y avisa por stderr con el comando para
  limpiarlo (`git config --global --unset faro.metricsUrl`). `FARO_METRICS_URL` (variable de
  entorno) no se ve afectado — sigue teniendo prioridad total, pensado para testing/CI.
- Se elimina también el binding `wrangler.jsonc` `triggers.crons` en `faro-control-panel` (repo
  aparte) por el mismo motivo raíz de configuración obsoleta sin validar: el cron disparaba sin que
  el Worker exportara `scheduled()`, generando error en cada ejecución en logs de producción.

## 0.4.24 — 2026-07-30

- **`metrics.js` aligerado**: se elimina `PRICING`/`costUsd` (el coste se calcula ahora en el
  Worker, `faro-control-panel/src/lib/pricing.ts`, en lectura desde tokens crudos — nunca se
  persiste precalculado). El payload deja de incluir `cost_usd`. `priceKey()` se conserva solo
  para etiquetar `price_family` en el array `models`.
- `DEFAULT_METRICS_URL` pasa de un webhook n8n a `https://faro-panel.example.com/api/estadisticas`
  (endpoint propio del panel — ver `gestion/cambios/changes/estadisticas-faro/` en
  `faro-control-panel`). `DEFAULT_METRICS_TOKEN` nuevo, para autenticar el POST.
- El payload deja de incluir `concepto` (responsabilidad de Directus, ya no aplica en este flujo)
  y empieza a incluir `org` (ya se calculaba en `buildMetricsPayload` pero no se exponía).
- `faro-schema.json`: añadido `innovacion` a `enums.dominios` (el propio contrato ya declara los
  dominios como orientativos/flexibles, no una lista cerrada).

## 0.4.23 — 2026-07-30

- **Rename interno**: `INICIATIVA` (constante/nombre de fichero) y sus funciones derivadas
  (`parseIniciativa`→`parseEstado`, `iniciativaResumen`→`estadoResumen`,
  `validateIniciativa`→`validateEstado`, `isIniciativa`→`esArchivoEstado`) renombradas en todo
  `harness.js` — el nombre "iniciativa" era un residuo histórico: el fichero real es `ESTADO.md`,
  agnóstico de tipo de trabajo (servicio/proyecto/proceso...). Sin cambios de comportamiento;
  `INICIATIVA.md` sigue siendo el nombre de fichero legado reconocido para compatibilidad. El campo
  `iniciativa:` del frontmatter de `ESTADO.md` (con su alias `nombre:`) no se ha tocado.
- **Tests**: añadidos 4 tests de regresión en `test/smoke.test.mjs` para el fix de CLAVE truncada
  (v0.4.21) — cubren `docref` con clave de 7 y 10 caracteres, correlativo de `doc_id`, y que
  `validate` acepte el formato `CLAVE-TIPO-NNN` con clave larga. Primer paso hacia tener red de
  seguridad real antes de extraer módulos de `harness.js` (3070 líneas, candidato a adelgazar:
  `kpis.js`, `docs-control.js`, `onepager.js`, `metricas.js`, siguiendo el patrón ya usado por
  `github.js`/`code.js`/`specs.js`/`clickup.js`/`ramas.js`).

## 0.4.22 — 2026-07-30

- Fix: `presentador-faro.md` tenía dos modelos contradictorios para la presentación de estado —
  el frontmatter y "Dos modos" decían "siempre datada", pero "Reglas de estilo" y "Ciclo de
  versionado" describían un fichero vivo sin fecha (`presentacion-estado.html`) con snapshot
  solo al marcar "presentada". Alineado todo al modelo vigente (siempre datado, tag al presentar,
  sin fichero canónico sin fecha).
- Fix: `modelo-faro.md` describía `entidad` como declarada directamente en el metadata del
  concepto; `faro-schema.json` (`_nota_entidad`) dice que ya NO se pregunta ni valida en el alta
  del repo — se gestiona vía MCP (`faro_entities`) cuando hay señal. Corregido el texto y el
  ejemplo para reflejar el modelo v2 real.

## 0.4.21 — 2026-07-30

- **Fix crítico: la CLAVE de proyecto se truncaba a 6 caracteres al generar `doc_id`** (`cmdDocRef`)
  y el validador (`docControlIssues`) solo aceptaba 2-6, pese a que `harness.js clave` ya permitía
  fijar hasta 10 (v0.4.20). Una clave como `PLANETA` (7) generaba `PLANE-TIPO-NNN` y `validate` habría
  rechazado la versión completa aunque se corrigiera a mano. Alineado todo a 2-10.
- Fix: dos mensajes de sesión citaban el fichero de token LEGADO `~/.<marca>-cli.json` en vez del
  vigente `~/.faro.json` (migrado en v0.4.17).
- Fix: el mensaje de "subcomando desconocido" listaba ~15 comandos y omitía `docref`, `clave`,
  `identity`, `mis-tareas` y otros de uso frecuente — completado con el listado real.
- `faro-schema.json`: comentario de `doc_id` actualizado al formato vigente `CLAVE-TIPO-NNN` (antes
  citaba el legado `ORG-CONCEPTO-TIPO-NNN`).
- **Reorganización de skills documentales** (mismo patrón `revisor-code`/`revisor-code-worker`:
  especialista se SUMA, nunca sustituye al genérico):
  - `/faro:documento` renombrado a **`/faro:redactar`** (verbo imperativo, coherente con
    `aprobar`/`archivar`/`renombrar`). Ahora declara explícitamente la derivación a `redactor-tecnico`
    cuando el tipo es ARQ y detecta `wrangler.*`.
  - `redactor-tecnico` deja de ser un agente paralelo con fichero propio (`documentos/arquitectura/tecnico.md`
    sin `doc_id`): pasa a ser especialista de CONTENIDO (Mermaid/C4/endpoints) para el tipo ARQ,
    invocado por `redactor-documento`, que sigue siendo el único dueño de `doc_id`/ubicación/frontmatter.
  - **`/faro:informe` y `/faro:presentacion` fusionados en `/faro:reportar`**: un único punto de entrada
    que deriva a `redactor-informe` (cierre de fase/semanal/vista documento) o `presentador-faro`
    (estado/vista presentación) según lo pedido.
  - Fix: el modo puntual por-tema de `redactor-informe`/`presentador-faro` versionaba con SemVer
    (`<tema>-v<version>.md`), contradiciendo la regla de reporting (siempre por FECHA, nunca SemVer)
    que sus propios skills ya declaraban. Corregido a `<tema>-AAAA-MM-DD.md` en ambos agentes.
  - README: agentes actualizados de 10 a 14 (conteo real) y corregido `auditor-iniciativa` (renombrado
    a `auditor-faro` en v0.3.0, quedó citado con el nombre viejo).

## 0.4.20 — 2026-07-30

- **Clave de proyecto: límite 2-10 caracteres** (antes 2-5, estándar Jira real verificado hoy) —
  permite nombres de una palabra corta como `PLANETA` como clave COMPLETA, sin forzar una sigla
  artificial. `sugerirClave` usa la palabra completa si es ≤10 y hay una sola palabra; siglas solo
  con varias palabras o palabra >10 (`FARO Control Panel` → `FCP`).
- Fix: los regex de detección de topics (`claveDeEsteRepo`, `estamparClave`, `reposParecidos`)
  seguían acotados a 2-5 tras el cambio de `CLAVE_RE` — un topic `clave-planeta` (7 letras) no se
  reconocería al releerlo aunque se hubiera podido escribir. Alineados a 2-10.

## 0.4.19 — 2026-07-30

- **Fix: detección de `superpowers` era global, no del repo** — `superpowersDetected()` buscaba la
  carpeta en TODA la caché de plugins (`~/.claude/plugins/`), así que "detectado" solo significaba
  que existía en la caché de OTRO proyecto, aunque en ESTE repo/sesión no estuviera activo (caso
  real: "Plugin superpowers is enabled in project settings but isn't installed here"). Ahora
  comprueba lo mismo que ya hace `pluginSettingsLines` para `faro`: declarado en `enabledPlugins`
  DE ESTE repo + versión realmente instalada en la ruta exacta de la caché.
- **Mensajes distinguen los 2 casos reales**: "declarado pero no instalado en esta caché" (con el
  comando exacto: `claude plugin install ... --scope project`) vs "ni siquiera declarado en este
  repo" (con el `marketplace add` + `install` completos). El harness explica también por qué NO
  puede instalarlo él mismo: requiere reiniciar la sesión, algo que un hook no controla sobre su
  propio proceso padre.

## 0.4.18 — 2026-07-30

- **Gestión documental estricta de la CLAVE de proyecto** (comando nuevo `harness.js clave`):
  - La clave se registra como **topic `clave-<clave>` del repo** — la única superficie compartida
    real entre repos (el plugin es cache local, no puede mantener un registro propio). Verificada
    **única en toda la org** vía búsqueda de ese topic (patrón Jira: valida contra el registro antes
    de aceptar), y **estable de por vida**: renombrar el repo NUNCA la toca (mismo principio que el
    renombrado — el nombre es cosmético, la clave es identidad permanente).
  - `harness.js clave` (sin args): informa la clave actual del repo y avisa si choca con otro.
  - `harness.js clave --sugerir "<nombre>"`: propone una clave libre (siglas/6→**5** letras máx,
    sufijos numéricos si choca) y **detecta repos con nombre parecido en la org** — si aparece uno,
    el agente debe preguntar (`AskUserQuestion`) si es el mismo proyecto (reutilizar clave) o un
    microservicio/componente separado (clave propia), nunca decidirlo en silencio.
  - `harness.js clave <CLAVE>`: fija el topic; si la clave ya está en uso en OTRO repo, devuelve
    `CHOQUE` sin fijar nada.
  - **`validate` ahora BLOQUEA** si hay documentos controlados emitidos y `clave:` no está declarada
    en `ESTADO.md` (antes solo avisaba, nunca bloqueaba) — gestión documental estricta: una clave
    derivada en silencio no se puede corregir después sin romper doc_id ya emitidos.
  - Límite de clave ajustado a **2-5 caracteres** (antes 2-6, en todos los sitios que lo mencionaban).

## 0.4.17 — 2026-07-30

- **FIX CRÍTICO: `harness.js gh`/`auth` leía `~/.<marca>-cli.json`, el CLI escribe en `~/.faro.json`
  desde 0.29.1.** El harness nunca encontraba el token guardado por el CLI → `SIN_TOKEN` falso en
  cualquier máquina donde el login se hizo vía `<marca>-faro` (no vía `harness.js auth` directo).
  Ahora lee/escribe `~/.faro.json` (nombre vigente) con migración automática del legado (rename,
  contenido intacto), mismo patrón ya usado en el resto del ecosistema.

## 0.4.16 — 2026-07-30

- **`revisor-code` vuelve a ser genérico**: la sección Workers de 0.4.15 se separa en su propio
  agente **`revisor-code-worker`** — escala mejor a futuros stacks (mañana `revisor-code-python`,
  `revisor-code-<lo-que-sea>`) sin ir apilando secciones condicionales en un único archivo cada vez
  más largo. Se lanzan JUNTOS cuando el repo es Workers (nunca uno en lugar del otro): `revisor-code`
  siempre audita coherencia de negocio/`ARCHITECTURE.md`; `revisor-code-worker` suma SOLID/Workers,
  estado global, bindings, secrets, `cf-typegen` — solo si detecta `wrangler.toml`/`.jsonc`/`.json`.
- Cableado en los 3 puntos de gate (`pr`, `consolidar`, `aprobar`) y en `revisar-code`: NO APTO en
  cualquiera de los dos bloquea igual.

## 0.4.15 — 2026-07-30

- **Agente nuevo `redactor-tecnico`**: doc técnica (`documentos/arquitectura/tecnico.md`) con
  diagramas Mermaid desde el estado real (código, specs, wrangler) — antes solo vivía en
  `template-faro-worker` (nunca portado al plugin), lo traían las adopciones de repos worker.
  Ahora distribuido por auto-update a cualquier repo con código.
- **`revisor-code` fusiona criterios Workers-específicos**: mismo hallazgo — `template-faro-worker`
  tenía su propio `revisor-code` (SOLID/Workers, estado global, bindings, `cf-typegen`, secrets)
  nunca portado al plugin. Se fusiona como sección 3b, activada SOLO si detecta
  `wrangler.toml`/`wrangler.jsonc`/`wrangler.json` — un único agente, criterios que se suman según
  el stack real (mismo patrón que ya usa `code.js` para gates/infra).
- Lista de subagentes en sesión actualizada con `redactor-tecnico`.

## 0.4.14 — 2026-07-30

- **Fix "Agent teams habilitado"**: el resumen de sesión lo afirmaba SIEMPRE, sin comprobar si el
  repo lo activó de verdad (`env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` en `.claude/settings.json`)
  — mentía en repos sin el flag. Ahora comprueba de verdad y avisa si falta activarlo.
- Lista de subagentes en sesión actualizada: faltaban `revisor-code`, `analista-kpis` y
  `presentador-faro` (los tres ya existían o se crearon hoy, pero el texto fijo no los citaba).

## 0.4.13 — 2026-07-30

- **`revisor-code` es GATE duro al abrir el PR, no solo recomendación en consolidar/aprobar**:
  `skills/pr` encadena `validate` (gate estructural) → `revisor-code` (coherencia de negocio) ANTES
  de pedir integración. **NO APTO = el PR NO se abre** — se resuelve primero y se reintenta.
- **Foco explícito en evidencia de NEGOCIO, no solo cobertura de código** (`/faro:code` y
  `revisor-code`): un test unitario en verde no demuestra que se cumple un requisito — se separan
  dos niveles: técnico (código correcto) y de negocio (el sistema hace lo que el funcional pide).
  Por cada criterio de aceptación se elige el medio adecuado: **notebook** (datos/cálculos/modelos
  — estándar Cookiecutter ya usado en FARO, ejecución real con entrada/salida visible), test
  funcional/e2e (flujos), o script de validación (comprobación puntual). El plan queda en tabla
  criterio→evidencia, que `revisor-code` verifica línea a línea (ya no basta "hay tests").
- **Dependencias/API keys nuevas**: `revisor-code` verifica que estén en `.env.example`, sin
  literales en código, y con el riesgo anotado en el RAID si son de pago/cuota — para que no lo
  descubra el aprobador del PR.

## 0.4.12 — 2026-07-30

- **Fix `ramas.js`**: una rama con ref roto/inaccesible (gc agresivo, encoding raro) tumbaba el
  script COMPLETO sin informar de ninguna rama, pese a ser una herramienta "solo informa" por
  defecto. Ahora se reporta aparte (`NO INSPECCIONABLES`) y el resto del informe sigue.
- **Fix `self-hint.js`**: imprimía su aviso ("usa siempre esta ruta del plugin") incluso con copia
  legada presente, contradiciendo el mensaje de `harness.js` en la misma sesión ("el plugin está
  INHIBIDO, gobierna la copia"). Ahora se omite por completo si hay copia legada.
- **Fix `DOC_STATUS` hardcodeado**: no leía `faro-schema.json > enums.estado_documento` como el
  resto de enums (`VALID_STATES`, `tiposDocumentoValidos`) — rompía el patrón "contrato único,
  data-driven". Ahora sigue el mismo patrón.
- **Fix BOM UTF-8 en `specs.js`**: un `spec.md` guardado con BOM (común en editores Windows) hacía
  fallar el regex de sección anclado a inicio de línea, dando el falso aviso "sin secciones de
  delta" pese a tenerlas. Se limpia el BOM antes de parsear.
- **Fix timeout en `clickup.js`**: `fetch` sin límite de tiempo — una API caída/firewall dejaba el
  proceso colgado indefinidamente sin ningún aviso. Ahora 15s con mensaje claro si expira.

Detectados por auditoría de gaps dedicada (agente en background); el gap de write-back de
`[cu:id]` con tarjetas borradas en ClickUp queda pendiente de una ronda propia (toca lógica de
reconciliación, mayor riesgo de regresión).

## 0.4.11 — 2026-07-30

- **Agente `revisor-code` nuevo**: audita COHERENCIA de código contra `ARCHITECTURE.md`, el
  funcional y las specs de cambios spec-driven (invariantes, estándares API/datos/seguridad,
  entornos/gitignore, trazabilidad escenario↔test) — no es lint ni revisión de estilo, eso lo
  cubren los gates. Veredicto APTO/NO APTO/APTO CON RESERVAS, solo lectura.
- **Skill `/faro:revisar-code`**: invocación directa (mismo patrón que `revisar-spec`).
- **Cableado en `consolidar` y `aprobar`**: si el repo tiene código (`ARCHITECTURE.md` presente),
  se lanza `revisor-code` antes de marcar un PR listo (consolidar) o antes de confirmar el merge
  develop→main (aprobar) — complementa a `validate` (estructura/gates), no lo sustituye.
- Fix: `gestor-github.md` citaba `revisor-code` antes de que existiera (v0.4.10 lo había quitado
  por defecto); ahora la referencia es real.

## 0.4.10 — 2026-07-30

- **Fix: `gestor-github.md` citaba un agente inexistente (`revisor-code`)** — detectado en
  auditoría de contenido de skills/agentes. Solo existe `revisor-spec` (de specs, no de código).
  Sustituido por lo que realmente cubre ese caso: gates de código del harness + `auditor-faro`.

## 0.4.9 — 2026-07-30

- **Renombrado `presentador-iniciativa` → `presentador-faro`** (mismo patrón que
  `auditor-iniciativa` → `auditor-faro` en 0.3.0: agnóstico, un trabajo puede ser servicio,
  funcionalidad o proyecto, no solo "iniciativa"). Actualizadas las 3 referencias cruzadas
  (`analista-kpis`, `gestor-riesgos`, skill `presentacion`).
- Restos de la migración `description`/presentación-datada que quedaron sin corregir en agentes
  fuente: `presentador-faro.md` y `redactor-informe.md` seguían con `subtitle` en el frontmatter
  que instruyen generar, y con `presentacion-estado.html` sin fecha en su descripción.

## 0.4.8 — 2026-07-30

- **Directiva `documentacion`: caso "quiero un documento de gestión de proyectos"** — es la petición
  más ambigua que puede llegar (gestión NO es un doc único en FARO, vive repartida y viva en
  `ESTADO.md`/`risks.md`/`kpis.md`/`decisions/`/`reporting/`). En vez de generar algo genérico, la
  directiva ahora obliga a preguntar en llano qué necesita el usuario y enruta a 1 de 3 respuestas
  reales: ver el estado actual (`/faro:estado`), un documento para enseñar (`onepager`/`informe`/
  `presentacion`, todos versionados), o un plan PMI formal a entregar (documento controlado tipo
  `PLN`, la única excepción que sale de `gestion/` porque se firma).

## 0.4.7 — 2026-07-30

- **Fix de coherencia (auditoría final)**: `harness-manifest.json` (contrato de adopción, campo
  `remap`) y la directiva `documentacion` seguían mandando el ADR al sitio VIEJO
  (`documentos/decisiones/` como "documento controlado"), contradiciendo lo fijado en 0.4.5
  (`faro-schema.json`, 6 agentes): el ADR es artefacto de GESTIÓN → `gestion/decisions/`. Eran los
  2 últimos sitios desalineados — verificado: cero referencias vivas restantes al sitio viejo.

## 0.4.6 — 2026-07-30

- **Validación de estado de las decisiones (MADR/Nygard)**: `validate` comprueba `status` contra el
  enum (`propuesta | aceptada | rechazada | sustituida`), `deciders` con formato `@usuario`, y que
  `sustituida` venga SIEMPRE con `superseded-by` — con coherencia cruzada del linaje
  (`supersedes`/`superseded-by` enlazados en ambos ADR). No bloquea CI (higiene de gestión).
- **Radar proactivo de decisiones**: las `propuesta` sin resolver aparecen en el resumen de sesión
  (mismo patrón que ciclos spec-driven y riesgos abiertos) — `gestion/` queda monitorizada siempre,
  no solo bajo `validate`.
- Plantilla `adr-decision.md` alineada al modelo de gestión (sin `type`/doc_id, estados en español,
  `superseded-by` marcado obligatorio si `sustituida`).
- Limpieza de texto residual: presentación de estado ya no se menciona sin fecha en las convenciones
  de sesión; añadido `/faro:code` a la lista de skills.

## 0.4.5 — 2026-07-30

- **ADR realineado a GESTIÓN**: es una decisión del trabajo, no un entregable de cliente — vive en
  `gestion/decisions/<AAAA-MM-DD>-<slug>.md` (fecha, autor, estado). Corregidos 3 sitios que
  apuntaban al legado `documentos/decisiones/`; el contrato ya no lo llama "legado" al revés.
  El harness **detecta** ADR que hayan quedado en `documentos/decisiones/` y pide traerlos.
- **Presentación de estado, siempre DATADA** (skill `presentacion`): fuera el HTML "vivo" sin
  fecha (`presentacion-estado.html`) — ahora `<AAAA-MM-DD>-presentacion-estado.html` siempre,
  misma regla que ya regía informes (misma fecha actualiza, fecha nueva = snapshot; el más
  reciente es el de fecha mayor). El legado sin fecha se renombra con la fecha de su último commit.
- **(template) Plantillas HTML — responsive/anti-desborde** (auditoría cards/grids/print):
  `<marca>-informe.html` era la única sin `@media` (3 grids de columnas fijas) → fallback a
  760px + `min-width:0`; `.bp-hub`/`.bp-cards` (fases) pasan a `auto-fit`/flex-wrap con mínimo
  legible (envuelven solas con cualquier número de fases); `.bp-core` ya no se posiciona a mano
  (se solapaba al envolver). `<marca>-onepager.html`: `.dims`/`.derived` a `auto-fit`.
  `<marca>-presentacion.html`: `height:100vh` en print cortaba el PDF → `height:auto`.

## 0.4.4 — 2026-07-30

- **`description` acotada a UNA frase (≤160 car.)**: como alimenta el subtítulo de portada del
  entregable, una description larga descuadraba la maqueta. `validate` avisa también cuando es
  demasiado larga (además de cuando falta) y la directiva fija el límite. En el template, la
  portada aguanta texto largo sin romperse (máx. 3 líneas con elipsis, ancho acotado, cuerpo 18px
  en presentación) — defensa en las dos capas: el dato nace corto y la maqueta no se rompe.

## 0.4.3 — 2026-07-30

- **`description:` en documentos controlados (recomendada, NO bloquea)**: una línea de "qué va"
  que permite inventariar y enrutar sin abrir el doc. El inventario de sesión la muestra junto a
  cada doc y lista los que no la tienen; `validate` avisa (`[docs] N documento(s) sin
  'description:'`) sin romper los ya emitidos; la directiva `documentacion` la pide en docs
  nuevos. En docgen (template) hace de subtítulo si no hay `subtitle` explícito — `subtitle`
  queda como override editorial.

## 0.4.2 — 2026-07-30

- **Auditoría de coherencia agentes↔skills↔hooks**: 8 skills referenciaban a sus agentes por la
  ruta legada `.claude/agents/*.md` (ya no existe en repos plugin-nativos) — pasan a referenciar
  por NOMBRE (agente del plugin). La directiva `documentacion` enseñaba el formato de doc_id
  viejo (`ORG-PROYECTO-TIPO-NNN`) — actualizada al vigente (`CLAVE-TIPO-NNN`, clave en ESTADO.md).
  Validado además: 0 invocaciones legadas del harness en skills/agents · 11 agentes con frontmatter
  correcto · 6 hooks vía `${CLAUDE_PLUGIN_ROOT}` · `/faro:estado` plugin-nativo · enrutado
  gestión≠entregable y enfoque AI FDE vigentes en las directivas.

## 0.4.1 — 2026-07-30

- **Metadato del repo: `.faro.json`** (en sintonía con CLI 0.30): el harness lee `.faro.json`
  primero y el legado `.<marca>-template.json` como fallback (el CLI lo renombra al migrar;
  contenido intacto). `templateMeta`/`clasificacion` (harness.js), naturaleza declarada (code.js)
  y write-back de teams (github.js — escribe al vigente; solo toca el legado si es lo único que
  hay). Mensajes, manifest y docs de agentes al nombre nuevo.

## 0.4.0 — 2026-07-30

- **Skill nueva `/faro:code` — evolución natural a código** (sustituye a los roadmap
  `/faro:nuevo`/`/faro:evolucionar`, que mueren sin nacer): para el momento "vale, ahora vamos a
  codificar". Analiza lo que el proyecto ya sabe (funcional, ESTADO.md, docs técnicos, specs),
  pregunta solo lo que falta (tipo de sistema, lenguaje), **investiga en internet el tooling
  vigente** (testing tipo vitest/pytest, scaffold oficial — C3 para workers), presenta **plan de
  validación con OK explícito del usuario** antes de escribir nada, scaffoldea `src/` con
  arquitectura sólida (SOLID, módulos por dominio, shared/utils, tests espejo), **control de
  entornos obligatorio** (.env.example versionado, .env en gitignore verificado, config fail-fast,
  secretos por canal del stack), y deja el **manifiesto del código `ARCHITECTURE.md`** al estándar
  de industria (mapa de módulos, invariantes, estándares de API/datos/seguridad, testing) — el
  papel de la "constitution" del spec-driven (GitHub Spec Kit), más el contexto para agentes
  estilo `AGENTS.md`. Reclasifica el repo (topics `nat-*`), despierta los gates del harness,
  registra ADR de stack y **cuadra riesgos técnicos en el RAID con dueño**.
- README: sección "Evolución a código" en la tabla de comandos; roadmap actualizado.

## 0.3.6 — 2026-07-30

- **El MCP corporativo VIAJA con el plugin**: `mcpServers.<marca>` declarado en el manifest
  (`https://mcp.example.com/mcp`, transport http) — cualquier máquina con el plugin tiene el
  MCP disponible sin depender del `.mcp.json` por repo ni del registro a nivel usuario del CLI
  (ambos siguen valiendo; son equivalentes).
- **Aviso MCP en sesión**: el harness informa de que el MCP requiere autenticarse UNA vez por
  máquina (`/mcp` → <marca> → Authenticate) y de cómo explicárselo al usuario en llano cuando
  las tools fallen o no aparezcan. Informativo, nunca bloquea.

## 0.3.5 — 2026-07-30

- **Issue #2 (paridad completa)**: `aheadOfMain` distingue ahora `-1` = "no pude comparar" de
  `0` = "nada pendiente" — el error de comparación AVISA (con el `git fetch origin main:main`
  recomendado) en vez de dar el falso "nada que aprobar" silencioso; complementa el fallback a
  `origin/<main>` y el tracking local automático ya incluidos.
- **Auth: scope `workflow`** en el device-flow del harness (`github.js`) — sin él, GitHub rechaza
  cualquier push que toque `.github/workflows/*.yml` (reproducido en este mismo repo). Sesiones ya
  autorizadas sin el scope: revocar la app en github.com/settings/applications y reautorizar.
- **Red de seguridad de distribución (sesión)**: en modo plugin, el harness valida que el
  `.claude/settings.json` del repo lleve el bloque completo de distribución (`extraKnownMarketplaces`
  con `autoUpdate: true` + `enabledPlugins`) — sin él, un clon no sabe de dónde instalar el plugin y
  el marketplace NO se actualiza solo (desactivado por defecto en marketplaces no oficiales). Aviso
  no bloqueante con arreglo recomendado (`npx <marca>-faro` → adoptar) y bloque manual listo.
- **README**: sección nueva "Cómo se usa — comandos `/faro:*`" (los 22, agrupados por flujo, con el
  ciclo pr → consolidar → aprobar destacado); auto-update documentado con la verdad (flag
  `autoUpdate: true` necesario); aviso de instalar siempre desde la raíz del repo git (el scope
  project se ancla al directorio de la sesión); el CLI como vía recomendada de instalación.

## 0.3.4 — 2026-07-30

- **FIX de instalación (error real de la pestaña Errors)**: declarar `"hooks": "./hooks/hooks.json"`
  en el manifest hacía FALLAR la carga de hooks con `Duplicate hooks file detected` — el
  `hooks/hooks.json` estándar se carga AUTOMÁTICAMENTE por convención, y `manifest.hooks` es solo
  para archivos ADICIONALES no estándar. Eliminadas las claves `skills` y `hooks` del manifest
  (ambas rutas son las estándar y se descubren solas): el plugin.json queda mínimo
  (name/version/description), que es lo correcto cuando todo sigue la convención. Cierra la cadena
  de sobrecorrecciones 0.3.1 → 0.3.2.

## 0.3.3 — 2026-07-30

- **FIX de instalación (causa real, confirmado por comparación de plugins que sí funcionan)**:
  20 de las 22 skills (las migradas de `commands/faro/*.md` legacy) carecían de `name:` en su
  frontmatter — solo tenían `description:`. Los plugins que sí cargan skills correctamente
  (`claude-md-management`, `claude-code-setup`) SIEMPRE llevan `name:` explícito. Sin él, el
  autocompletado `/faro:` no sugería ninguna skill aunque el plugin apareciera "enabled" y el
  contenido estuviera completo en caché — reproducido y confirmado en instalación real sobre
  `un-repo-de-prueba`. Añadido `name: <slug-carpeta>` a las 20 skills afectadas.

## 0.3.2 — 2026-07-30

- **FIX de instalación (confirmado con error real)**: la clave `"agents": "./agents/"` añadida en
  0.3.1 es INVÁLIDA — Claude Code rechazó el manifiesto con `Validation errors: agents: Invalid input`
  (confirmado en instalación real sobre `un-repo-de-prueba`). Los agentes se descubren por convención de
  carpeta `agents/` SIN declaración en plugin.json (igual que `commands/` en otros plugins) — no
  existe ese campo en el schema del manifest. Eliminada la clave; se mantienen `skills` y `hooks`,
  cuyo formato sí está confirmado (ejemplo real: plugin `superpowers`).

## 0.3.1 — 2026-07-30

- **FIX de instalación (crítico)**: `plugin.json` no declaraba explícitamente `skills`, `agents` ni
  `hooks` — comparado contra plugins que sí funcionan (p. ej. `superpowers`), estos SIEMPRE declaran
  `"skills": "./skills/"` y la ruta de `hooks`. Sin esa declaración, Claude Code podía instalar el
  plugin (descarga a caché OK, `enabledPlugins` OK) sin llegar a cargar sus hooks/skills — exactamente
  el síntoma reproducido: `/plugin list` mostraba "faro · enabled" y el contenido estaba completo en
  `~/.claude/plugins/cache/`, pero ni las skills `/faro:*` ni el hook de sesión se activaban.
  Añadidas explícitamente: `"skills": "./skills/"`, `"agents": "./agents/"`, `"hooks": "./hooks/hooks.json"`.

## 0.3.0 — 2026-07-29

- **docref (issue #1)**: doc_id corto estilo Jira `CLAVE-TIPO-NNN` (sin prefijo de organización;
  `DOC_ORG` opcional vía env) — normaliza diacríticos ANTES de derivar la clave (ya no se pierden
  acentos: "Transformación" → "TRANSFORMACION", no "TRANSFORMACIN"). La CLAVE se declara en
  `clave:`/`key:` de ESTADO.md o se deriva por siglas; legado `ORG-CLAVE-TIPO-NNN` sigue válido.
  Aviso `[METADATO]` en sesión si la clave no está declarada explícitamente (pide preguntar al
  usuario antes de generar más documentos).
- **Autorrelleno**: última modificación de ESTADO.md (fecha + autor) en el resumen de sesión,
  vía `lastCommitOf` — git ya lo sabe, no hace falta preguntarlo.
- **3 guardianes de higiene en `validate`** (avisan, NO bloquean CI): cambio `implementada` al
  100% sin archivar (≥7 días) · fase activa estancada (tareas abiertas + ESTADO.md sin tocar
  ≥14 días) · fila RAID con Estado no reconocido. `validate` también autocrea la estructura de
  referencia (antes solo lo hacía `session` — gap en CI sin sesión previa).
- **Agente nuevo `gestor-riesgos`**: gestiona el RAID (mismo patrón que `analista-kpis`), atiende
  los guardianes de arriba, normaliza estados, exige dueño por riesgo.
- **Renombrado `auditor-iniciativa` → `auditor-faro`** (término agnóstico; función sin cambios).
- **Directus retirado por completo** (más allá de la v0.2.0): `cmdDocsJson`/comando `docs-json`
  eliminados; `directus_id` → `external_id` (agnóstico a cualquier catálogo externo); comentarios
  internos de harness.js/faro-schema.json/modelo-faro.md reescritos sin nombrar ningún sistema
  concreto. El modelo/schema deben migrar a un MCP externo en el futuro (hoy siguen embebidos).
- **Auditoría de cableado**: 0 gaps en comandos invocados desde skills/agents vs dispatcher del
  harness; ciclo completo de 6 hooks probado sin errores; 0 rutas legadas `.claude/hooks/` colgantes.

## 0.2.0 — 2026-07-29

- **Modo plugin consciente**: el harness detecta que corre desde la cache del plugin y reescribe
  EN UN SOLO PUNTO toda auto-referencia impresa (`node .claude/hooks/*.js` → ruta real del motor).
- **Compatibilidad con repos del flujo anterior**: si el repo aún lleva la copia local
  (`.claude/hooks/harness.js`), el plugin se INHIBE en los eventos de hook (gobierna la copia,
  sin duplicar) y deja en sesión la pista de migración (`npx <marca>-faro` → adoptar).
- **Cableado hooks→skills**: el protocolo por-prompt invoca las directivas `faro:gestion-proyectos`
  (aterrizar ideas/requerimientos, enfoque FDE) y `faro:documentacion` (qué es cada artefacto y
  dónde vive); la lista de sesión pasa de "comandos" a "skills".
- **Directiva gestion-proyectos ampliada**: riesgos como disciplina continua (PMBOK:
  identificar→analizar→responder→revisar, con dueño) y tareas en GitHub (issue + label del
  contrato + asignación vía harness).
- **Directus RETIRADO del plugin** (se reintroducirá si se necesita): fuera skill `directus` y
  agente `gestor-directus`; referencias neutralizadas en harness, agentes y code.js.
- **Red de tests** (`npm test`): 6 smoke tests (sintaxis, manifiestos JSON, session en vacío,
  reescritura de rutas, inhibición con copia legada, validate sin crash) — base para el refactor
  modular del harness.

## 0.1.0 — 2026-07-29

Primera versión del estándar FARO como plugin de Claude Code (antes: copia de `.claude/` por repo).

- **Skills** (21): migradas desde `commands/faro/*.md` del template a `skills/<nombre>/SKILL.md`
  (namespace `/faro:*` conservado por el nombre del plugin).
- **Skill nueva `documentacion`**: directiva documental (gestión vs documento controlado vs
  spec-driven, regla de rol, pautas de redacción) — la pauta manda, la plantilla solo ayuda.
- **Agentes** (11): porteados sin cambios funcionales.
- **Harness**: porteado con dos adaptaciones:
  - Resolución del contrato: `.claude/faro-schema.json` del repo (override) > copia del plugin.
  - Rutas de invocación: `${CLAUDE_PLUGIN_ROOT}/hooks/harness.js` en skills, agentes y `hooks.json`;
    hook `self-hint.js` publica la ruta real del motor en cada sesión.
- **Contrato**: `faro-schema.json` (dominios = lista cerrada) y `harness-manifest.json` viajan con el motor.

Origen: `template-faro-doc` @ commit `593dbe0`.
