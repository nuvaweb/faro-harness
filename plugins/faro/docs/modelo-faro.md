# Modelo FARO — definición canónica

> Modelo mental único de FARO y su relación con el CDM. Lo leen humanos y agentes.
> El contrato técnico (colecciones/campos) vive en `faro-schema.json`; **esto es el porqué**.

## La idea en una frase

**El repo se llama como quiera. Lo que ancla la identidad es el CONCEPTO declarado en el
metadata.** El nombre es cosmético; el concepto dice *a qué pertenece*.

## Los 4 niveles (nunca los confundas)

| Nivel | Qué es | Ejemplo | ¿Cambia? |
|---|---|---|---|
| **CLASE** (CDM) | tipo de dato **predefinido**, estable; tiene MUCHAS instancias | `Servicios`, `Clientes`, `Facturas` | No |
| **CONCEPTO** | la **cosa con nombre** = la IDENTIDAD; **es** proyecto/iniciativa/servicio/proceso | `Gratia`, `Formación 360` | Sí (nombre y gobernanza **evolucionan**) |
| **REPO** | el **artefacto** — **sin tipo/nature**; solo pertenece a un concepto | `gratia-back`, `gratia-pipeline` | Nombre libre; `github_id` no |
| **DOC** | el **documento** | funcional, procedimiento, guía | — |

> **El REPO no lleva `nature` (doc/app/worker).** Un repo **evoluciona** (nace documentando, luego
> tiene código): fijarle un tipo lo rompería. En el **wizard**, elegir doc/app/worker = solo la
> **plantilla de arranque**, NO un tipo que se guarde. Lo que "es" el repo emerge de su contenido.

## Qué es un CONCEPTO (la definición)

Un **concepto** es la **identidad semántica** de una cosa (producto, servicio, término):
*qué es y a qué pertenece*, **independiente de cómo se llame el repo o el fichero**.

- Es el **ancla estable**: renombras el repo o el fichero, el concepto no cambia → nada se rompe.
- Lleva la **identidad**: `name`, `code`, `status`, `aliases`, `description`, `domain` (uno o varios).
- Enlaza a su **CLASE CDM** (opcional): `clase → Servicios` → así se sabe *de qué tipo de dato es*.
- Se **declara en el metadata** (`.md` frontmatter) y se registra en `faro_concepts`.

Una **CLASE** (CDM) es el tipo predefinido y estable; un **CONCEPTO** es una instancia concreta
suya (muchos conceptos → una clase). Renombrar/actualizar toca al concepto, nunca a la clase.

## El mecanismo: el metadata es el ancla

El repo puede llamarse **como sea**; su metadata declara a qué concepto pertenece:

```yaml
# ESTADO.md del repo (o frontmatter de un doc)
concepto: gratia            # ← EL ANCLA: a qué pertenece
domain: [producto, operaciones]   # transversal: uno o varios
# el nombre del repo es libre; esto es lo que el sistema lee
```

El harness lee `concepto:` → (si el equipo conecta un catálogo/grafo externo, agnóstico al
sistema) cuelga el repo/doc del concepto **Gratia** → dominio, clase CDM, docs… todo agrupado
**por concepto, no por nombre**.

## Relaciones

```
CLASE CDM: Servicios   (predefinida, estable, muchas instancias)
   ▲ clase (opcional)
CONCEPTO: gratia   name·code·status·aliases   domain:[producto,operaciones]
   ▲ concept (muchos repos → un concepto)
   ├─ REPO gratia-back      nature: app      ◄─ DOCs (FUN, PRO, GUI)
   ├─ REPO gratia-front     nature: app      ◄─ DOCs
   └─ REPO gratia-pipeline  nature: worker   ◄─ DOCs
```

- **DOC → REPO** (dónde vive) → y por el repo, **rollup al CONCEPTO** ("todos los docs de Gratia").
- **REPO → CONCEPTO** (a qué pertenece; muchos repos, un concepto).
- **CONCEPTO → CLASE CDM** (de qué tipo de dato es; opcional).
- **DOMINIO** = el único eje compartido con el CDM; **transversal** (uno o varios).

## Metadata por NIVEL (no se mezclan)

Hay dos sitios de metadata, cada uno con su función:

**A · CONCEPTO — la instancia con nombre** (`faro_concepts`):
- `name` · `code` · `status` · `aliases` (muchos nombres de la misma cosa) · `description`
- **`domain`**: **UN** dominio de los 10 del CDM (`financiero` · `operaciones` · `producto` ·
  `comercial` · `legal` · `marketing` · `rrhh` · `master-data` · `sistemas` · `servicios-generales`)
- **`entidad`**: la CLASE — `servicio` / `proyecto` / `iniciativa` / `proceso` / `procedimiento`…
  Qué ES. **Ya NO se pregunta ni se valida en el alta del repo** (CLI/harness): se gestiona en el
  grafo de conocimiento vía MCP (colección `faro_entities`, alineada con el CDM) y se asigna/usa
  cuando hay señal — **MUTABLE** (una iniciativa puede convertirse en servicio; cambia el campo, no
  los repos). Al dar de alta un repo solo importan el **DEPARTAMENTO (dominio)** y los teams.
  Una **entidad** tiene **muchos** conceptos (Servicio → Gratia, Formación 360…).
- **`replaced_by`** → el concepto que lo **sustituye** (relevo/linaje). El viejo pasa a
  `status: obsolete`; las referencias siguen resolviendo al vigente. Nada se pierde.

> Ej.: **Gratia** = `domain: operaciones` (dónde está, obligatorio desde el alta), `entidad: servicio`
> (qué ES, asignada vía MCP cuando hay señal suficiente — no es un dato de alta). El REPO
> (`gratia-back`) es el artefacto y apunta al concepto. **Entidad = clase · Concepto = instancia.**

**B · DOCUMENTO — cómo se publica y quién lo ve** (`faro_docs`):
- `type` (FUN/PRO/GUI/POL…) · `status` (draft/in_review/approved/obsolete)
- **`classification`**: `public` / `internal` / `confidential` / `restricted` (privacidad / access tier)
- `domain` · `language` · `author` · `entity` (→ repo) · `content_md`

> **Regla:** el CONCEPTO dice *qué es* (y su ciclo de vida); el DOCUMENTO dice *cómo se publica y
> quién lo ve*. Un mismo concepto (Gratia) tiene docs `public` (una guía) y `confidential` (una
> arquitectura). La privacidad es del **doc**, nunca del concepto.

## Reglas de oro

1. **Nombre libre, identidad por metadata.** El repo/fichero se llama como quiera; el `concepto:`
   del metadata es el ancla. Renombrar no rompe.
2. **`github_id` = ancla inmutable del repo.** Recuperar/upsert por él, nunca por el nombre.
3. **Dominio obligatorio y transversal.** Único puente con el CDM; puede ser varios.
4. **Relación a CLASE CDM = opcional.** Solo cuando el concepto ES un dato canónico.
5. **Atributos de datos → viven en el CDM** (`atlas-modelo.json`). FARO referencia, nunca copia.
6. **Acuerdos/procedimientos = DOCS** (`type: POL`/`PRO`) bajo un repo, no entidades nuevas.
7. **Flexible, no rígido.** Documentar primero; relacionar (clase/concepto/CDM) donde aporta.
   Lo que no encaja va en `tags`.

## Flujo de mañana (aplicado)

1. Creas repo, eliges **app** → `gratia-back` (REPO, `nature: app`). Nombre libre.
2. En su metadata: `concepto: gratia`, `domain: producto`.
3. El sistema sabe que **pertenece a Gratia** (aunque el repo se llame distinto).
4. Documentas dentro → DOCs cuelgan del repo → suben al concepto Gratia.
5. Listas "todo Gratia" = concepto → repos → docs. Renombras el repo → sigue en Gratia.
