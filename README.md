# FARO — Forge-Agnostic Repo Operations

**Gestor de proyectos agéntico y spec-driven como plugin de Claude Code**: harness de gobierno,
flujo spec-driven nativo, skills `/faro:*` y roles de agente — para **GitHub, GitLab y servidores
propios**. Se instala una vez por máquina y se actualiza solo desde este repo.

Código abierto (licencia [MIT](LICENSE)), sin telemetría: FARO no envía datos a ningún servicio
propio; solo habla con la forja de tu repo (GitHub o GitLab) con tu propia credencial.

## Instalación

Un solo comando, sin cuenta ni token:

```
npx faro-harness instalar
```

Deja el plugin `faro` (y `superpowers`, del que depende el ciclo de specs) instalado en Claude Code para
todos tus repos, y con `npx faro-harness instalar` de nuevo (o `update`) se pone al día. Si Claude Code
estaba abierto, recarga con `/reload-plugins`.

Para crear un repo nuevo o traer uno existente, `npx faro-harness` sin argumentos: solo entonces te pide
conectar con tu forja (GitHub o GitLab), porque crea el repo, protege ramas y abre PRs con tu cuenta.

<details><summary>Instalación manual, sin el wizard</summary>

Dentro de Claude Code:

```
/plugin marketplace add nuvaweb/faro-harness
/plugin install faro@faro-marketplace
/reload-plugins
```

Claude Code muestra un aviso de confianza (normal con cualquier plugin externo) y pregunta el scope:
`user` lo activa en todos tus repos; `project` solo en ese repo y para todo el que lo clone.

</details>

Comprueba que está activo:

- Escribe `/faro:` — deben aparecer las skills (`/faro:estado`, `/faro:pr`, `/faro:cambio`…).
- Al arrancar sesión en un repo FARO verás el bloque `HARNESS...` del hook de sesión.
- `/plugin list` confirma que quedó instalado; `/plugin` → pestaña **Errors** muestra cualquier
  fallo de carga si algo no arranca.

### Requisitos

| Requisito | Cómo comprobarlo |
|---|---|
| Claude Code reciente | `claude --version` |
| Node.js ≥ 18 (los hooks son scripts Node) | `node --version` |
| Git con acceso a GitHub | `git ls-remote https://github.com/nuvaweb/faro-harness.git` — debe listar refs |
| Cuenta en tu forja (GitHub o GitLab) | Para las operaciones de forja (PRs, issues, rol): `harness.js auth` o el login del wizard |

El repo del plugin es público: descargarlo no pide credenciales. La cuenta de tu forja solo hace
falta para operar sobre TUS repos (abrir PRs, leer issues, consolidar).

### Activación automática por repo (opcional, recomendado en instancias FARO)

Un repo puede dejar el plugin declarado en su `.claude/settings.json` — al abrirlo, Claude Code
ofrece instalarlo solo (esto lo escribe el wizard `faro` al crear/adoptar):

```json
{
  "extraKnownMarketplaces": {
    "faro-marketplace": {
      "source": { "source": "github", "repo": "nuvaweb/faro-harness" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "faro@faro-marketplace": true }
}
```

La descarga es **una vez por máquina** (cache `~/.claude/plugins/`); los demás repos solo lo habilitan.
⚠ Instala siempre desde la **raíz del repo git** (el scope project se ancla al directorio de la sesión,
no a la raíz del repo — lanzar Claude Code desde una subcarpeta deja el settings en el sitio equivocado).
El harness avisa en sesión si a un repo le falta este bloque o el `autoUpdate`.

### Actualizar

- **Automático**: SOLO si el marketplace tiene `"autoUpdate": true` (bloque de arriba) o se activa en
  `/plugin` → Marketplaces → faro-marketplace → *Enable auto-update*. ⚠ Para marketplaces no
  oficiales viene **desactivado por defecto** — sin ese flag NO se actualiza solo. Con él, Claude Code
  comprueba novedades al arrancar sesión (con hasta ~10 min de retardo aleatorio).
- **Manual/inmediato**: `/plugin update faro@faro-marketplace` (o desde el menú `/plugin`).
- La versión instalada aparece en `/plugin` → faro. Novedades: `CHANGELOG.md`.
- **De 1.x a 2.0** (layout `faro/`): desde 2.0 todo lo de FARO vive en `faro/` (`faro/gestion/`,
  `faro/ESTADO.md`, `faro/config.json`…). Un repo con el layout antiguo sigue funcionando y `validate`
  lo avisa. Para migrarlo, revisa el plan con `harness.js migrar-layout --dry-run`
  y aplícalo con `migrar-layout`: usa `git mv`, así que el historial se conserva, y deja los cambios
  en el índice para un único commit.

### Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| `marketplace add` falla con error de red/404 | Tu git no llega a GitHub: valida el `ls-remote` de arriba (proxy, firewall). Con un espejo propio: `git config faro.marketplaceUrl <url>` |
| Sesión dice `PLUGIN faro INHIBIDO` | El repo aún lleva la copia legada `.claude/hooks/` (flujo antiguo): sigue gobernando la copia, sin duplicar. Migra con `npx faro-harness` → adoptar cuando quieras |
| Skills piden token (`SIN_TOKEN`) | Ejecuta `node "<ruta del harness que indica la sesión>" auth` (device-flow, código de 6 dígitos) |
| Un repo necesita enums propios | Crea `.claude/faro-schema.json` en ese repo: el override local tiene prioridad sobre el contrato del plugin |

## Cómo se usa — comandos `/faro:*`

El flujo central es: **trabajas en tu rama → pides integrar → un responsable consolida a develop → un responsable publica a producción**.
Consolidar y publicar son actos DISTINTOS: el ciclo se cierra en `develop`, y `main` es el release — puede agrupar
varios ciclos y se publica **cuando alguien lo decide**, no en cada integración.
En comandos: `/faro:pr` → `/faro:consolidar` → `/faro:publicar`. Todo lo demás orbita alrededor.

### Día a día

| Comando | Qué hace |
|---|---|
| `/faro:iniciar` | Arranque guiado de un trabajo nuevo: entrevista → faro/ESTADO.md → clave → brief (BRF) → fuentes → RAID → validate, orquestando los roles (digestión, redacción y riesgos en paralelo como subagentes) |
| `/faro:estado` | Estado ejecutivo del trabajo: faseo, validación, git y actividad por usuario |
| `/faro:pendientes` | Panel de promoción: features pendientes de integrar y develop pendiente de aprobar |
| `/faro:documentacion` | Directiva documental: qué es cada artefacto y dónde vive (úsala antes de crear nada) |
| `/faro:gestion-proyectos` | Directiva de gestión (enfoque AI FDE): aterrizar ideas difusas, fasear, retomar |
| `/faro:delegacion` | Directiva de delegación: cuándo repartir trabajo entre subagentes (y cuándo no) para no gastar contexto |

### Ciclo de cambio (spec-driven)

| Comando | Qué hace |
|---|---|
| `/faro:cambio` | Propone un cambio: proposal.md (QUÉ) + deltas con requisitos y escenarios verificables |
| `/faro:revisar-spec` | Revisión de calidad de una spec ANTES de aprobarla (veredicto APTA / NO APTA) |
| `/faro:aplicar` | Implementa un cambio APROBADO: genera/ejecuta tasks.md marcando checkboxes |
| `/faro:sync` | Sincroniza los deltas a las specs vivas SIN archivar (cambios de larga vida) |
| `/faro:archivar` | Archiva un cambio COMPLETADO: deltas → specs vivas + mueve a archive/ |

### Digestión de fuentes y requisitos (automático, sin comando)

Todo material que llega (transcripciones, briefs, funcionales de cliente, pdfs) entra por `faro/fuentes/`.
El harness detecta en cada sesión las **fuentes sin digerir** (posteriores a la última revisión del
funcional/ESTADO.md) y dirige la digestión — el agente `gestor-requisitos` la orquesta: extrae
requisitos al registro **`faro/gestion/requisitos.md`** (`REQ-NN` + estado `propuesto|aceptado|en-cambio|entregado|descartado`
+ `origen:` la fuente), decisiones a ADR, riesgos al RAID, y lo sustantivo abre cambio spec-driven.
`validate` bloquea el formato inválido (`[req]`) y avisa de trazabilidad (`[requisitos]`: aceptado sin
cambio/tarea que lo cubra) y de fuentes pendientes (`[digestion]`). Los binarios (pdf/docx) generan una
vez su extracto hermano `*.extracto.md` y las siguientes iteraciones leen el MD. Con fuentes históricas
y sin registro, la sesión sugiere la **digestión retrospectiva**. Las mismas señales salen como datos
en `estado-json` (bloque `senales`) y en las integraciones que lo consuman.

### Integración y publicación

| Comando | Quién | Qué hace |
|---|---|---|
| `/faro:pr` | **cualquiera** | Petición de integración a develop desde tu rama, en lenguaje llano |
| `/faro:consolidar` | maintainer | Recupera y valida los PRs a develop y aplica lo que procede |
| `/faro:publicar` | maintainer/owner | **El release** develop → main, bajo demanda: valida el ciclo completo, cierra estados, tagea y publica |
| `/faro:ramas` | cualquiera | Informe de ramas muertas vs vivas; limpia las muertas con confirmación |

**No hay aviso de "llevas N commits sin publicar"**, y es deliberado: publicar es bajo demanda, así que
no haber publicado no es una deuda — es el estado normal, y avisar de lo normal es ruido. Lo que sí
dice `consolidar` al terminar, y solo si el gate está en verde, es `ESTADO: develop LISTO para
publicar`: te informa de que **puedes** si quieres, no de que deberías.

### El faseo de faro/ESTADO.md (lo que exige `validate`)

Cada fase se declara así, y el formato es **rígido** — lo valida el harness:

```
### Fase 1 · Mockup del informe — in_progress
Maquetar las tres pantallas con datos de ejemplo.   ← descripción: qué trae la fase
Objetivo: 2026-12-01                                 ← OBLIGATORIA en toda fase abierta
- [ ] #4 · Personalización e identidad — @usuario    ← una tarea por entregable, con su id y su dueño
```

- **`Objetivo: AAAA-MM-DD` es obligatoria** en toda fase abierta (desde 0.38.0): sin ella `validate`
  falla y el hito de la forja se queda sin vencimiento en silencio. **No es rígida en su valor** —
  se reajusta libremente si cambia el alcance, y `hito sync` actualiza el hito cuando difiere.
- **Estados**: `draft` · `backlog` · `pending` · `in_progress` · `testing` · `done`. Solo una fase
  activa a la vez (`in_progress`/`testing`).
- **`draft`** (no confundir con el `draft` de *documento*, que es otra cosa) es la fase escrita cuyo
  hito **todavía no existe** en la forja — el caso del onboarding, antes de correr `hito sync`. Ahí se
  eximen `#N` y `@usuario` porque aún no pueden existir, pero la descripción, las tareas y el
  `Objetivo:` se siguen exigiendo. Al asignar las tareas, la fase pasa a `pending`.

### Evolución a código

| Comando | Qué hace |
|---|---|
| `/faro:code` | El proyecto **evoluciona a código**: analiza funcional/ESTADO/docs técnicos, pregunta el stack, investiga el tooling vigente, presenta plan de validación (tests) para tu OK, scaffoldea `src/` con arquitectura sólida (SOLID/modular) y deja `ARCHITECTURE.md` (manifiesto del código: mapa de módulos, invariantes, estándares de API/datos/seguridad, testing) — reclasificando el repo sin ceremonia |
| `/faro:tests` | **Tests por dominio**: define con el usuario las funcionalidades (dominios) del repo para que el agente corra solo los tests afectados y deje la suite completa para CI y `/faro:publicar`; migra un repo existente (`harness.js tests-dominios --proponer` y `--aplicar --confirmo`) |

### Documentos e informes

| Comando | Qué hace |
|---|---|
| `/faro:redactar` | Redacta o actualiza cualquier documento (funcional, spec, guía…) con la plantilla neutra de FARO — deriva a especialistas (p. ej. `redactor-tecnico` para arquitectura de Workers) según la firma técnica detectada |
| `/faro:reportar` | Reporting de gestión, siempre datado: informe de cierre de fase/semanal, presentación de estado a dirección, o pieza puntual por tema en vista documento y/o presentación |
| `/faro:onepager` | Una sola página de decisión (estado + negocio) autogenerada — para **dirección**: *"¿qué decido?"* |
| `/faro:roadmap` | Hoja de ruta visual A4 horizontal: carril de fases, marcador de posición por avance real, fases sin cerrar y obstáculos — para **cliente y equipo**: *"¿dónde estamos?"* |

### Diagnóstico del propio repo (subcomandos del harness, sin skill)

Se invocan directamente sobre el motor: `node "<ruta del harness que indica la sesión>" <comando>`.
Los tres son **informes de lectura**: no bloquean ni cambian el resultado de `validate`.

| Comando | Qué hace |
|---|---|
| `forge` | Qué forja hay detrás de `origin` (GitHub, GitLab, autoalojada o desconocida), la ruta del proyecto y qué sabe hacer el harness ahí. **GitHub y GitLab tienen adaptador**; el harness elige uno u otro por el remoto |
| `auth` | Conecta con la forja del repo actual. GitHub: login por código de 6 dígitos. GitLab: el mismo login si la instancia tiene aplicación OAuth registrada (`git config faro.gitlabClientId`), o `auth --token <token personal>` si no. La credencial queda en `~/.faro.json` **por host** (`tokens`), así que puedes tener sesión a la vez en GitHub, en `gitlab.com` y en el GitLab de un cliente |
| `pr crear` | Abre la petición de integración **por intención**, en la forja que sea: `pr crear --base develop --titulo "…" [--cuerpo "…"] [--revisor <login>]`. Ninguna skill necesita saber la forma de la API |
| `codigo` | Salud del código en tres señales: **ciclos de dependencia** (un defecto real: ningún módulo del ciclo se entiende por separado), **atomicidad** (ficheros por encima del umbral) y **módulos que nadie importa** (posible código muerto) |
| `atomico` | Solo la señal de atomicidad, si quieres el listado a secas. El umbral vive en `faro-schema.json` (`enums.atomicidad`), así que cada repo puede declarar el suyo |
| `grafo` | Índice único de imports del repo, incremental, en `faro/.cache/grafo.json` (gitignorado). `grafo construir` lo genera; `grafo estado` dice si está al día. La sesión lo reconstruye en segundo plano salvo `faro/config.json > grafo.fondo: false` |

> El tamaño es una **señal**, no una ley: partir un fichero por la mitad baja la cifra y empeora el
> diseño. Se separa por concepto. Por eso estos comandos avisan y nunca bloquean.

### Gestión e integraciones

| Comando | Qué hace |
|---|---|
| `/faro:tareas` | Tus Issues asignados: detalle de los de ESTA repo y recuento de los de las demás (para trabajarlas, abre esa repo) |
| `/faro:migrar-tareas` | Migra tareas escritas a mano en faro/ESTADO.md a issues anclados a su fase (`asignar-tarea --hito`), dejando en faro/ESTADO.md una línea por issue (`- [ ] #N · título — @quién`, cuadrada con el hito) y el detalle dentro del issue |
| `/faro:adoptar` | Adopta un repo existente al layout FARO sin perder contexto ni tocar el stack |
| `/faro:auditoria` | Auditoría integral de salud (subagente, en background) |
| `/faro:forja` | Operaciones de plataforma en la forja del repo (GitLab o GitHub): peticiones de integracion, proteccion de ramas, exigir pipeline, releases, etiquetas, miembros |
| `/faro:renombrar` | Renombra un repo FARO con criterio (redirecciones, alias, referencias) |
| `/faro:changelog` | Versiona y registra: decide major/minor/patch por impacto, escribe la entrada del CHANGELOG y valida que versión, changelog y commit digan lo mismo (`--check` solo diagnostica) |

> Las tres consultas se confunden a menudo: **`/faro:tareas`** son Issues asignados a ti ·
> **`/faro:pendientes`** son ramas por promover o aprobar · la planificación externa (proyecto y épicas), si se declara en `faro/config.json > planificacion`, se lee con `harness.js planificacion`.

## Qué instala exactamente

| Pieza | Ruta en el repo | Qué es |
|---|---|---|
| Skills `/faro:*` (31) | `plugins/faro/skills/` | Flujos: `/faro:iniciar`, `/faro:pr`, `/faro:cambio`, `/faro:publicar`, `/faro:estado`, `/faro:tareas`… |
| Skills-directiva (3) | `skills/documentacion` · `skills/gestion-proyectos` · `skills/delegacion` | Las invoca el agente: qué es cada artefacto y dónde vive · gestión con enfoque Forward Deployed AI Engineer (etapas, requerimientos, riesgos PMBOK, tareas en GitHub) · cuándo delegar en subagentes para no gastar contexto |
| Agentes (15) | `plugins/faro/agents/` | revisor-spec, auditor-faro, gestor-forja, gestor-requisitos, adoptador-faro, redactor-tecnico… |
| Harness | `plugins/faro/hooks/` | Motor determinista por eventos, de SessionStart a Stop, vía `hooks.json` |
| Contrato | `hooks/faro-schema.json` | Enums (estados, dominios cerrados, tipos de documento, labels) — override por repo posible |

## Arquitectura y decisiones (resumen)

1. **Plugin único, 3 naturalezas** (doc / app / worker): el harness lee la naturaleza del metadato
   del repo. Los `template-faro-*` se retiran como fuente de copia.
2. **Wizard `faro` = llave de arranque** (npm `faro-harness`, vive en `cli/` de este repo): crea o
   adopta un repo (*Proyecto FARO* | *Worker Cloudflare* → nombre natural SIN prefijo), scaffold
   oficial del stack primero, capa FARO + repo en la forja (GitHub o GitLab) con topics.
   Login por token obligatorio (API); SSH opcional para push.
3. **Clasificación por topics**: `faro` + `dom-<departamento>` + `plat-*` + `gob-*` + `sys-*`.
   El wizard filtra por topic `faro`, nunca por nombre. Las **plataformas** de producto (tipo
   `<id>-func`) no vienen de serie: cada organización las declara en `faro/config.json > plataformas`.
4. **Compatibilidad con el flujo anterior**: si un repo lleva copia local `.claude/hooks/`, el
   plugin se inhibe en los hooks (gobierna la copia) y guía la migración. Nada se rompe.
   **El ciclo git es RÍGIDO y aplica SIEMPRE** (también en modo plugin, desde 0.9.1): un repo con
   `faro/ESTADO.md`, `faro/config.json` o el plugin faro declarado en su settings tiene bloqueado el commit
   directo en `main`/`master`/`develop` — el trabajo va en rama `<tipo>/<slug>` y llega por PR/merge.
   Desde 0.38.0 el bloqueo actúa **al editar**, no solo al commitear, y aplica **también al repo del
   propio motor**: lo único que el motor no hereda es el gobierno de instancia (faro/ESTADO.md/onboarding),
   no la protección de ramas. Solo los repos `template-*` quedan exentos, por diseño. Las ramas
   protegidas son **extensibles por repo** vía `faro/config.json` → `"ramas_protegidas": ["demo", "pre"]`.
5. **Directus queda FUERA** del plugin (se reintroducirá si se necesita).
6. **Clave documental: UNA POR REPO** (4-10 caracteres, estilo Jira). Todo `doc_id` es
   `CLAVE-TIPO-NNN` y el número se calcula leyendo los ficheros **locales**, así que dos repos que
   compartan clave emitirían el **mismo** id (`ACME-GUI-101` en ambos) sin poder detectarlo — la
   colisión no aparece hasta juntar la documentación. Por eso `harness.js clave <CLAVE>` comprueba la
   unicidad en la organización (topic `clave-*`) y no estampa una que ya sea de otro repo. Repartir
   rangos por repo se descartó: es frágil (se olvida al crear el siguiente, nada impide desbordarlos)
   y con &lt;100 documentos por tipo no aporta nada; con clave propia la colisión es imposible por diseño.
   Si dos repos son de verdad el mismo proyecto, la salida correcta es documentar en uno solo.

## Roadmap

- [ ] Prueba de instalación real end-to-end (marketplace → instancia) y en Windows (`${CLAUDE_PLUGIN_ROOT}`).
- [ ] Refactor modular del harness (los smoke tests `npm test` son la red de seguridad; sin big-bang).
- [ ] Config agnóstica `~/.faro.json` anunciada en sesión.
- [x] ~~CLI 0.30 (wizard nuevo + adoptar-migrador + settings mínimo + **cableado de git con el token
      del login**)~~ → hecho en **CLI 0.31.x**: el credential helper HTTPS se cablea *siempre*, también
      con SSH disponible (son canales paralelos: el SSH mueve tu código, pero Claude Code clona los
      marketplaces por HTTPS desde su propio directorio). Además valida los scopes del token antes de
      trabajar, para que la falta de `repo` se detecte en el CLI y no dentro de Claude Code.
- [x] ~~`/faro:nuevo` y `/faro:evolucionar`~~ → sustituidos por **evolución natural**: `/faro:code`
      (hecho, 0.4.0) para el momento "vamos a codificar", y el harness que ya despierta los gates al
      detectar código. Pendiente el guardián de coherencia (código detectado + `nat-documental` ⇒ aviso).
- [ ] Siembra de instancia (CLAUDE.md inicial) desde el plugin · revisión de plantillas (solo `html/` + render).

## Desarrollo

El plugin vive en `plugins/faro/` y el wizard en `cli/`. Todo cambio de
comportamiento sube la versión en `plugins/faro/.claude-plugin/plugin.json` + entrada en
`CHANGELOG.md` + tag `v<version>`. Tests: mientras trabajas, `npm run test:afectados` (solo los dominios que
tocas, deducidos de `git diff`) o `npm run test:dominio -- <nombre>`; `npm test` es la suite completa, para CI y
`/faro:publicar` (una vez al final, no en cada iteración). Node ≥ 18.

Para no dejarse la mitad (el CHANGELOG llegó a quedarse 24 versiones atrás mientras el manifiesto
avanzaba), usa **`/faro:changelog`**: decide el salto major/minor/patch por impacto, escribe la
entrada y valida que versión, CHANGELOG y mensaje de commit digan lo mismo. Con `--check` solo
diagnostica —útil antes de publicar—. Y antes de un release, `claude plugin validate ./plugins/faro`:
un `description` con `": "` sin comillas rompe el frontmatter entero y la skill carga sin metadata
(el modelo deja de saber cuándo usarla).

Prueba local sin publicar: `/plugin marketplace add <ruta-local-del-clon>` en un repo de prueba.

## Licencia

[MIT](LICENSE) © 2026 Fernando Acevedo.
