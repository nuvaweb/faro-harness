# Nomenclatura y control documental

> **Este documento vive en el PLUGIN — no se copia a los repos.** Es la fuente unica de la convencion
> para toda la organizacion: se actualiza con el plugin (autoUpdate) y no envejece por repo. Antes se
> sembraba en `documentos/nomenclatura-documental.md` de cada proyecto y acabo habiendo 7 copias con
> 3 contenidos distintos, que es tanto como no tener convencion.
>
> El **contrato ejecutable** (los 37 tipos con su ambito, estandar y familia) NO esta aqui sino en
> `faro-schema.json`, y se consulta con `harness.js tipo` (catalogo) o `harness.js tipo <CODIGO>`
> (secciones, criterio y errores tipicos). Este documento explica el PORQUE y las reglas; el comando
> da el dato vigente. Si alguna vez discrepan, **manda el comando**.

Convencion para nombrar, identificar y controlar los documentos de la iniciativa (alineada con el control documental ISO 9001: identificable, versionado y con responsables claros).

## ID de documento

Formato CORTO estilo Jira (decision 2026-07-29 — un prefijo de organizacion alargaba sin aportar,
el repo ya define la org): **`<CLAVE>-<TIPO>-<NNN>`**  ·  ej. `ONB-FUN-001`.

- `<CLAVE>` = clave corta del PROYECTO (4-10 caracteres, empieza por letra, MAYUSCULAS; contrato
  `CLAVE_RE`). Es UNA POR REPO: si dos repos la comparten, ambos emiten los MISMOS `doc_id` y
  colisionan al juntar la documentacion (decision 0.4.30). Se declara UNA vez en `clave:`
  (o `key:`) del frontmatter de `ESTADO.md`; si no se declara, el harness la DERIVA (siglas de las
  palabras significativas del nombre, o sus 6 primeras letras si es una sola palabra) — pero
  declararla explicitamente evita ambiguedad y es lo recomendado desde el arranque del trabajo.
- `<TIPO>` = codigo de tipo (ver tabla).
- `<NNN>` = correlativo de ese tipo (se escanea dentro del propio repo: un repo = un trabajo, nunca se mezcla con otro).
- **Legado**: los doc_id emitidos antes con `ORG-CLAVE-TIPO-NNN` (ej. `FRA-ONBOARDING-FUN-001`) SIGUEN SIENDO VALIDOS — no hay que renombrar nada existente. El prefijo `ORG-` es hoy OPCIONAL vía `DOC_ORG` (env), para quien lo quiera explícito.

## Codigos de tipo

> **Fuente única de verdad de esta tabla: `.claude/faro-schema.json`** (enum `tipos_documento`). Lo leen el harness (valida) y el agente. Añadir un tipo = una entrada allí. Cada tipo con plantilla sigue un **estándar de industria**.

> Las instrucciones de cada tipo las provee el PLUGIN (contrato `faro-schema.json`), agrupadas por FAMILIA: `harness.js tipo` da el catálogo y `harness.js tipo <TIPO>` las secciones, el criterio, los diagramas que aportan y el frontmatter exacto. Ya no hay esqueletos por tipo en el repo — ver `documentos/plantillas/LEEME.md`.

| Ámbito | Codigo | Tipo | Estándar | Plantilla |
|---|---|---|---|---|
| producto | BRF | Brief de requerimiento | resumen ejecutivo de arranque | sí |
| producto | PRF | PR-FAQ (incluye el press release) | Amazon working-backwards | sí |
| producto | HU | Historias de usuario | Connextra + INVEST + Gherkin | sí |
| producto | ANA | Analisis (funcional/tecnico/integracion) | IEEE 29148/BABOK · design doc · ICD | sí |
| producto | FUN | Funcional / tecnico-funcional | requisitos + reglas + entidades | sí |
| producto | ARQ | Arquitectura | arc42 + C4 + ISO 42010 | sí |
| producto | DIS | Spec de diseño UX/UI (spec-driven) | spec-kit + design systems | sí |
| producto | QA | Plan de pruebas / QA de software | ISO/IEC/IEEE 29119 | sí |
| producto | INV | Investigacion (tecnica/mercado/competencia) | research memo · integracion = ICD | sí |
| producto | SRV | Ficha / descripcion de servicio | service description | sí |
| producto | CHG | Changelog / release notes | Keep a Changelog + SemVer | sí |
| producto | ESP | Especificacion / spec | — | — |
| operaciones | RUN | Runbook / operacion | SRE runbook | sí |
| operaciones | MAN | Manual / flujo de automatizacion | guia operativa | sí |
| operaciones | LEC | Lecciones aprendidas / retrospectiva | PMI + PIR blameless + ISO 9001 §10.2 + PDCA | sí |
| operaciones | PRO | Procedimiento (SOP) | SOP · ISO 9001 | sí |
| operaciones | GUI | Guia / how-to | Diátaxis (how-to) | sí |
| operaciones | INC | Incidente / post-mortem | ITIL/ISO 20000 · SRE (SEV, MTTD/MTTR) | sí |
| operaciones | SLA | Acuerdo de nivel de servicio | ISO/IEC 20000 · SLO/SLI | sí |
| gobierno | COM | Compliance (rgpd/ai-act/ens/iso) | RGPD · AI Act · ENS · ISO 27001 | sí |
| gobierno | DPIA | Evaluacion de impacto (EIPD) | ISO 29134 · RGPD art. 35 | sí |
| gobierno | POL | Politica | ISO 27001 Anexo A | sí |
| gobierno | ACU | Acuerdo / contrato | contrato (enlaza CDM Contratos) | sí |
| gobierno | COR | Corporativo (manifiesto) | manifiesto corporativo | sí |
| gobierno | RES | Resumen ejecutivo (stakeholders) | executive summary · 1 página | sí |
| negocio | PROP | Propuesta comercial / SOW | Statement of Work | sí |
| negocio | PRE | Presupuesto / cotizacion | cotización comercial | sí |
| negocio | OFE | Descripcion de oferta / one-pager | one-pager · datasheet | sí |
| negocio | CAS | Caso de éxito / case study | case study (reto-solución-resultados) | sí |
| negocio | CBN | Caso de negocio / business case | Five Case Model (HM Treasury) · PMI | sí |
| negocio | PUE | Descripcion de puesto | job description | sí |
| gestion | PLN | Plan de proyecto | PMBOK/PMI (ligero) | sí |
| gestion | RACI | Matriz de responsabilidades | RACI | sí |
| gestion | ADR | Decision de arquitectura | MADR / Nygard | sí* |
| gestion | INF | Informe | — | — |
| — | DOC | Documento generico | — | — |

> *ADR **ES un documento controlado**: vive en `documentos/decisiones/` con doc_id (`ADR-NNN`) y versionado, como cualquier otro documento de esta tabla. Su ciclo de vida (propuesta→aceptada→sustituida) mapea a `draft→approved→obsolete`. (Nota: puede existir una carpeta legada `gestion/decisions/` con ADRs datados sin doc_id; la doctrina nueva es el ADR controlado en `documentos/decisiones/`.)

> **PRL (press release suelto) se fusionó en PRF**: el PR-FAQ ya contiene el press release en su primera sección. Si mañana necesitáis anuncios públicos como documento controlado independiente, se reañade PRL en una línea.
> **Nota spec-driven**: los cambios spec-driven (`gestion/cambios/changes/<cambio>/proposal.md`, `tasks.md`) NO son documentos de esta tabla — siguen la convención spec-driven de FARO (`/faro:cambio`), no llevan doc_id ni plantilla de aquí.
> **Nota reporting**: los informes de fase (INF) y las presentaciones a dirección son **reporting de gestión** — viven en `gestion/reporting/` con nombre datado (`AAAA-MM-DD-…`), no como documento controlado de esta tabla.

Un mismo trabajo (p. ej. un servicio de la plataforma Core) puede tener VARIOS documentos
viviendo juntos en su repo: brief (BRF), spec de diseño (DIS), press release (PRL),
tecnico-funcional (FUN)... Todos en `documentos/`, generables con el agente redactor-documento
(`/faro:documento`) ; se aprueban con el merge a main.

## Ubicacion y nombre de archivo (ESTANDAR)

- **Nombre de archivo** = `<doc_id>-<slug>.md` (ej. `QRA-BRF-001-brief.md`): el ID viaja en el nombre y en la cabecera.
- **Ubicacion del MD vivo** — dentro de `documentos/`, por TEMA (el control lo da la cabecera, la carpeta organiza):
  - `documentos/funcional/` → DEFINICION del trabajo: brief (BRF), PR-FAQ (PRF), funcional(es) (FUN), historias de usuario (HU)
  - `documentos/analisis/` → analisis (ANA tecnico) e investigacion (INV)
  - `documentos/arquitectura/` · `documentos/diseno/` → arquitectura (ARQ) · spec de diseño (DIS)
  - `documentos/decisiones/` → ADR (decision auditable = documento controlado, doc_id `ADR-NNN`, versionado)
  - `documentos/integraciones/<sistema>/` → analisis de integracion (ANA subtipo integracion) + sus anexos
  - `documentos/operaciones/` → runbooks (RUN), guias (GUI), procedimientos (PRO), SLA y flujos de automatizacion (MAN); el export tecnico (JSON n8n...) va en `flujos/` raiz, 1:1 con su documento
  - `documentos/<tema>/` → libre para lo demas
  - PROHIBIDO: documento controlado (con doc_id) en la RAIZ de `documentos/` — siempre en subcarpeta tematica; ni dentro de `documentos/plantillas/` (solo estructuras) o sin cabecera
- **Entregables HTML generados** → `documentos/entregables/<doc_id>-<slug-titulo>-v<version>.html` (destino automatico de `docgen` si no se indica salida). El **código** diferencia (dos guías = `GUI-001`, `GUI-002`), el **título** lo hace legible, la **versión** es histórico. Se COMMITEAN al entregar: el historial git es la trazabilidad de entregas. El MD es siempre la fuente; el HTML se regenera, nunca se edita.

## Dónde va cada cosa (regla de rol)

`documentos/` es **SOLO prosa controlada** (documentación con `doc_id`). El método técnico — notebooks Jupyter, scripts de validación, datos de trabajo — **NUNCA** vive dentro de `documentos/`: va en la **capa técnica** del repo, y el documento lo **REFERENCIA por ruta**. Este reparto está alineado con la industria (**Cookiecutter Data Science**): la prosa y el código/notebooks son capas separadas.

Antes de colocar un artefacto, decide su **ROL**:

| Rol | Qué es | Dónde va |
|---|---|---|
| **Teoría / hipótesis** (pensar) | exploración, brainstorm, idea a validar | fase 0 del cambio → `gestion/cambios/changes/<cambio>/` (decanta en `proposal.md`) |
| **Validación / práctica con valor** (demostrar) | el MÉTODO (notebook/script) + la CONCLUSIÓN | el método en `notebooks/` (o `scripts/` si reutilizable); la CONCLUSIÓN en un **ANA** de `documentos/analisis/` que lo referencia; la evidencia en `fuentes/` o junto al notebook |
| **Tanteo desechable** | probar algo de usar y tirar | `borrador/` (gitignored, no se commitea) |
| **Material recibido** | brutos, diccionarios, evidencia de partida | `fuentes/` |

**Regla resumen:** `documentos/` = **solo prosa**; el método técnico (jupyter, tests, datos de trabajo) va en la **capa técnica** (`notebooks/` · `scripts/`; en worker/app también `src/` + `test/`) y el documento lo referencia; **nunca un notebook dentro de `documentos/`**.

**El notebook y su documento ANA:** una validación técnica se ejecuta en un notebook (`notebooks/<slug>.ipynb`) — reproducible, en la capa técnica; el hallazgo/conclusión se redacta en un **ANA** (`documentos/analisis/<doc_id>-<slug>.md`) que **cita el notebook por ruta** en su sección de Anexos y responde por él. El notebook es el método; el ANA es el conocimiento controlado (con `doc_id`, versionado, publicable). Nunca al revés (el ANA no contiene el notebook: lo referencia).

**Mapping a la industria** (Cookiecutter Data Science):

| FARO | Industria | Qué |
|---|---|---|
| `documentos/` | `docs/` | prosa controlada (`doc_id`) |
| `notebooks/` | `notebooks/` | Jupyter, validaciones, análisis técnico reproducible |
| `scripts/` | `src/` | código reutilizable/compartido |
| `fuentes/` | `references/` + `data/raw/` | material de partida, diccionarios, evidencia |
| `gestion/reporting/` | `reports/` | informes/presentaciones generados, datados |
| `borrador/` | scratch (gitignored) | tanteo desechable |

## Anexos tecnicos (ESTANDAR — schemas, workflows JSON, OpenAPI, exports…)

Todo artefacto NO-markdown (DBML/SQL de esquema, JSON de n8n, YAML OpenAPI, CSV/XLSX de ejemplo, payloads) es un **ANEXO de un documento controlado — nunca huerfano**: siempre existe UN documento .md con doc_id que lo explica, lo referencia por ruta y responde por el (su "documento propietario").

- **Ubicacion segun su naturaleza**:
  - Se IMPORTA o EJECUTA en un sistema (workflow n8n, migracion SQL aplicable) → carpeta tecnica raiz: `flujos/` (1:1 con su documento MAN en `documentos/operaciones/`).
  - Es CONTRATO, MODELO o REFERENCIA (schema DBML, OpenAPI, payload de ejemplo) → junto a su documento propietario, en la misma carpeta tematica de `documentos/` (ej. `documentos/integraciones/postgress/modelo-schema.dbml`).
  - Es MATERIAL DE PARTIDA o evidencia (exports, actas, datos brutos) → `fuentes/`.
- **Versionado**: git versiona el anexo; cuando el anexo cambia de forma relevante, el documento propietario SUBE su version y lo refleja en su Control de versiones. Un cambio ESTRUCTURAL (p. ej. el schema de datos) es un cambio spec-driven (proposal) y, si es decision de arquitectura, ADR.
- **Seccion "Anexos"**: el documento propietario lista sus anexos con ruta y proposito.

Y la receta de FLEXIBILIDAD para "mañana mas cosas": tipo de documento nuevo → una entrada en `faro-schema.json` del plugin diciendo su FAMILIA (hereda de ella la guia; no hay que escribir un esqueleto); tema nuevo → subcarpeta `documentos/<tema>/`; artefacto tecnico nuevo → regla de anexos de arriba; tipo de trabajo o plataforma nueva → una linea en el harness (`PLATAFORMAS`/`TIPOS`) + catalogo del CLI. Nada mas requiere tocar codigo: el control es siempre por cabecera.

## Sistema de versionado (ESTANDAR)

1. El MD lleva `version` SemVer en cabecera + tabla **Control de versiones** en el cuerpo: TODO cambio de contenido sube la version y anade fila (que cambio, quien, fecha).
2. Git versiona cada guardado (commit por cambio documental); la APROBACION formal del documento es el **merge a main** (docgen avisa si el status no es coherente con la rama).
3. El entregable HTML hereda la version en el nombre (`-v1.2.html`): entregas distintas conviven, nada se sobreescribe en silencio.
4. `status` refleja el ciclo (`draft → in_review → approved → obsolete`); un documento con `[CLARIFICAR: …]` no puede estar `approved` (gate del harness).

## Reporting (versionado por FECHA)

El versionado SemVer de arriba es del **documento VIVO** (`documentos/`). El **reporting de gestión** (informes de fase, presentaciones a dirección, one-pagers — todo lo de `gestion/reporting/`) NO usa ese esquema: va **SIEMPRE versionado por FECHA, nunca sin fecha**, como snapshot datado.

- **Nombre**: `<tema>-AAAA-MM-DD.md` (+ su `.html` hermano), en `gestion/reporting/{informes,presentaciones}/<tema>/`. El `<tema>` es el nombre libre de lo que se confecciona (un funcional, un proyecto, una integración, lo que se pida); la fecha data el snapshot.
- **Misma fecha → ACTUALIZA** ese mismo fichero (si se re-pide/re-genera ese día): NO crea otro.
- **Fecha nueva → snapshot nuevo**: los datados conviven, nada se sobreescribe entre días.
- El **informe de CIERRE DE FASE** obligatorio mantiene su plano datado: `gestion/reporting/informes/AAAA-MM-DD-fase-<N>-informe.md`.

**Contraste (importante):**

| | Documento VIVO (`documentos/`) | Reporting (`gestion/reporting/`) |
|---|---|---|
| Qué es | conocimiento controlado que perdura | snapshot puntual de estado/negocio |
| Identidad | `doc_id` (`CLAVE-TIPO-NNN`) | `<tema>` + fecha |
| Versionado | `version` SemVer + estado + Control de versiones | por **FECHA** (`AAAA-MM-DD`) |
| Re-generar el mismo día | sube versión, añade fila | **actualiza** el mismo fichero datado |
| Aprobación | ciclo `draft→…→approved` + merge a main | no aplica: es reporting datado |

## Generar el ID automaticamente

```
node .claude/hooks/harness.js docref <TIPO>
```

`<CLAVE>` sale de `clave:`/`key:` en ESTADO.md (o se deriva del nombre/repo si no está declarada) y
`<NNN>` es el siguiente correlativo (escanea `documentos/` y `gestion/`). Ej.: `docref FUN` -> `ONB-FUN-001`.

## Cabecera estandar de datos (frontmatter del MD)

Todo documento controlado lleva la cabecera estandar — es el contrato de datos con el harness. Tres niveles:

**1. Datos iniciales OBLIGATORIOS** (el harness los valida al escribir y en `validate`):

| Campo | Contenido |
|---|---|
| `doc_id` | ID unico `CLAVE-TIPO-NNN` (generar con `docref <TIPO>`; legado `ORG-CLAVE-TIPO-NNN` sigue valido) |
| `title` | Titulo del documento |
| `version` | SemVer (`1.0`, `1.2.1`) |
| `date` | AAAA-MM-DD de esta version |
| `status` | `draft` → `in_review` → `approved` → `obsolete` |
| `author` | Autor/propietario (usuario git) |
| `classification` | `public` · `internal` · `confidential` · `restricted` |

**2. Agregados OPCIONALES** (recomendados; los consume el gestor documental):

| Campo | Contenido |
|---|---|
| `subtitle` | Subtitulo/descripcion corta |
| `tipo` | Codigo de tipo documental (BRF, FUN, DIS…) |
| `dominio` | **Subárea** de la taxonomía jerárquica (valores en inglés — hoja: `data`, `support`, `marketing`…; áreas: `product`/`commercial`/`operations`/`corporate`). ORTOGONAL al tipo. El harness deriva `domain_area` (área padre) para roll-up. Un repo puede fijar `dominio` en ESTADO.md como default que los docs heredan |
| `componente` | Servicio/componente concreto al que refiere (permite documentar N servicios en un repo y filtrar por servicio) |
| `trabajo` | Nombre del trabajo/iniciativa al que pertenece |
| `fase` | Fase del faseo a la que corresponde (N o `transversal`) |
| `idioma` | `es` (defecto) |
| `tags` | Lista de etiquetas para busqueda |
| `relacionados` | Lista de `doc_id` relacionados |
| `revisor` / `aprobador` | Quien revisa / quien aprueba |
| `proxima_revision` | AAAA-MM-DD de revision programada |

**3. CALCULADOS** (NUNCA se escriben a mano): `git_url` (URL exacta del archivo en el repo), `repo`, `ruta`, `commit`.

En el cuerpo: **Control del documento** (propietario/revisor/aprobador/proxima revision) + **Control de versiones**.

## Estados

`draft` -> `in_review` -> `approved` -> `obsolete`.

## Clasificacion

`public` · `internal` · `confidential` · `restricted`.

El entregable HTML se genera con `harness.js docgen <md>`, que usa la plantilla de marca del plugin (MD fuente -> HTML con marca).
