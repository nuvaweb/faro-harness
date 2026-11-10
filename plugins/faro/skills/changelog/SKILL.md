---
description: "Úsala antes de commitear trabajo publicable o si el CHANGELOG se quedó atrás — decide major/minor/patch y deja versión, entrada y commit coherentes."
argument-hint: "[--check solo diagnostica · <major|minor|patch> fuerza el salto]"
---

Gobierna el **versionado** y el **CHANGELOG** de este repo. Ejecútalo **TÚ inline**. Argumento: $ARGUMENTS

La regla que sostiene todo: **la versión, la entrada del CHANGELOG y el mensaje del commit describen
el MISMO cambio**. Si los tres no coinciden, el historial miente y deja de servir para decidir.

## 0. ¿Monorepo? Elige la app (o las afectadas)

Si `faro/config.json` tiene la clave `monorepo` (`harness.js apps` las lista), **cada app se versiona por
separado**: su versión es la de `apps/<x>/package.json`, su registro es `apps/<x>/CHANGELOG.md` y su
tag es `{app}@{version}` (o la plantilla de `faro/config.json > monorepo.tag`). No hay un CHANGELOG común
que valga por todas.

- **Qué apps tocaste**: las que tengan ficheros en el diff (`git diff --name-only`, por carpeta). Si
  el usuario nombró una, esa; si hay varias afectadas, repite los pasos 1-6 **para cada una**.
- `harness.js release` dice, por app, desde qué tag se mide, cuántos cambios lleva y qué versión
  sugiere; una app **sin cambios no se toca** (ni versión ni entrada).
- La raíz solo se versiona si declara versión propia (su `package.json` con `version`); si no, no se
  le exige nada. Un tag `v<version>` heredado de antes del monorepo es ambiguo: no lo reutilices.
- En los pasos de abajo, donde dice `package.json` / `CHANGELOG.md` / `v<version>`, léelo como
  `apps/<x>/package.json` / `apps/<x>/CHANGELOG.md` / `<x>@<version>`. Mensaje del commit con la app
  como ámbito: `feat(<x>): <version> — ...`.

## 1. Sitúate (SIEMPRE, también con `--check`)

- **Dónde vive la versión**: `package.json` (CLI/paquete npm) o `.claude-plugin/plugin.json` (plugin).
  Si hay ambos, son proyectos DISTINTOS: versiona solo el que has tocado. En un monorepo, el de la app
  (paso 0).
- **Versión actual** y **última registrada en `CHANGELOG.md`**. Si no coinciden, hay entradas
  pendientes: recupéralas del historial con
  `git log --format="%ad|%s" --date=short --reverse` acotado al rango que falte.
- **Tags existentes** (`git tag -l "v*"`): compáralos contra las cabeceras del CHANGELOG — cualquier
  versión publicada sin su `vX.Y.Z` es un hueco a cerrar en el paso 6, no solo la que estás a punto
  de crear.
- **Qué has cambiado de verdad**: `git status --short` y `git diff` (o `git diff --cached`). No
  versiones de memoria ni por lo que creas haber hecho.

## 2. Decide el salto — SemVer, sin pegar saltos

Elige por el IMPACTO EN QUIEN CONSUME, no por lo que te costó hacerlo ni por lo grande que parezca.

| Salto | Cuándo | Señales |
|---|---|---|
| **major** (`X`) | Rompe a quien ya lo usa | Se elimina/renombra un comando o flag · cambia el contrato de salida · una ruta o formato deja de ser compatible · hay que migrar algo a mano |
| **minor** (`Y`) | Capacidad NUEVA, compatible | Comando/flag/skill nuevo · un flujo hace algo que antes no hacía · nuevo campo opcional |
| **patch** (`Z`) | Ni rompe ni añade | Corrección de un fallo · mensajes y textos · documentación · refactor sin cambio observable · rendimiento |

Criterios que evitan el desajuste típico:

- **Arreglar un bug es `patch`, aunque el bug fuera grave y el diff enorme.** El tamaño no manda.
- **Si un flujo pasa a hacer algo que antes no hacía, es `minor`, aunque el diff sea de 3 líneas.**
- **Ante la duda entre dos, elige el MENOR** y explica el porqué en la entrada. Inflar versiones hace
  ilegible el historial.
- **Un solo salto por publicación**: agrupa todo el trabajo pendiente en UNA versión. No encadenes
  0.8.4 → 0.8.5 → 0.8.6 en la misma tanda; si ya hay varios cambios sin publicar, van juntos y el
  salto lo decide el de mayor impacto (un `minor` absorbe a los `patch` que lo acompañan).
- **`0.x`**: se sigue el mismo criterio (no se sube a `1.0.0` por acumulación). Romper algo en `0.x`
  sube `minor`, porque el major está reservado a la estabilización.

Si el usuario pasó `major|minor|patch` como argumento, **respétalo**; si contradice lo que ves en el
diff, dilo en una frase y aplícalo igual (es su decisión).

## 3. Escribe la entrada del CHANGELOG

Formato: `## <version> — <AAAA-MM-DD>` (fecha REAL de hoy), la más reciente arriba, bajo el título.
Si el fichero no existe, créalo con una cabecera que fije el criterio SemVer del repo.

Cada punto explica **el PORQUÉ**: qué se rompía, qué faltaba o qué costaba. Un changelog que solo
enumera el qué no sirve para decidir si actualizar.

- **Mal**: "Corregido el label de los issues."
- **Bien**: "Los issues se crean siempre con label: el contexto de sesión enseñaba la forma SIN
  `--tipo`, el agente la copiaba y el comando abortaba."

Reglas: en negrita la afirmación que resume el punto · nombra fichero/función cuando ayude a
localizarlo · nada de "varias mejoras" ni "correcciones menores" · si algo queda fuera o a medias,
dilo explícitamente.

## 4. Valida antes de commitear (no te saltes esto)

- La versión de `package.json` / `plugin.json` **coincide** con la cabecera nueva del CHANGELOG.
- La versión **sube** respecto a la anterior y **no salta números** (0.8.3 → 0.8.4, nunca 0.8.6).
- La fecha es la de HOY y el formato es `AAAA-MM-DD`.
- Si es un plugin dentro de un marketplace: la entrada de `marketplace.json` **no contradice** a
  `plugin.json` (valídalo con `claude plugin validate <ruta>` si está disponible).
- Todo lo que hay en el diff está reflejado, y no hay entradas de cosas que no hiciste.

## 5. Commit y rama

Mensaje: `<tipo>(<ámbito>): <version> — <resumen en una línea>`
(`feat` si es minor · `fix` si es patch · `docs` si solo es documentación).
Ejemplo: `feat(cli): 0.32.0 — el CLI instala los plugins, no solo los declara`

**Rama**: se commitea en `develop` (o `feature/<tema>`), NUNCA directo en `main`. `main` es el
archivo de lo publicado y recibe el trabajo con `/faro:publicar`, que lo lanza quien tenga
permiso. Si estás en `main`, cámbiate tú (`git switch develop`) y commitea ahí — es la mecánica
normal, no un bloqueo que trasladar al usuario.

## 6. Tag de versión (SIEMPRE, salvo `--check`)

El tag es lo que deja trazable en git "qué commit exacto es cada versión publicada" — sin él, el
CHANGELOG dice una fecha pero nadie puede ir directo al punto del historial. **Todo salto de
versión termina en un tag anotado**, sea plugin o CLI:

```
git tag -a v<version> -m "<version> — <resumen de una línea, el mismo del CHANGELOG>"
git push origin v<version>
```

Reglas:

- **Formato del nombre: `v<version>`** (`v0.9.3`, nunca `0.9.3` a secas ni `version-0.9.3`) —
  consistente con el historial existente del repo (revísalo con `git tag -l` antes del primero).
  **En un monorepo, `<app>@<version>`** (la plantilla de `faro/config.json > monorepo.tag`): `publicar` crea
  uno por cada app cambiada, con su propio Release.
- **Se etiqueta el commit de MERGE a la rama principal** (main/master), no el commit de la rama de
  trabajo — el tag marca lo que quedó publicado, no lo que se propuso. Si el flujo es
  PR→merge, etiqueta después del merge, sobre `main`.
- **Antes de crear el tag, comprueba que no exista ya** (`git tag -l v<version>`): si existe y
  apunta a otro commit, PARA y pregunta al usuario — nunca lo fuerces (`-f`) sin confirmación
  explícita, reescribir un tag ya publicado rompe a quien ya lo referenciaba.
- **Si hay versiones publicadas sin tag en el historial** (detectable comparando `git tag -l` contra
  las cabeceras del CHANGELOG), complétalas sobre su commit de merge real
  (`git log --oneline --all | grep "<version>"` para localizarlo) antes o junto con la nueva — no
  dejes huecos que luego cuesta reconstruir.

## `--check` (solo diagnostica, no escribe)

Informa y para: versión actual · última del CHANGELOG · **entradas que faltan** (con la lista de
commits sin registrar) · si hay cambios sin commitear que exigirían versión · salto que
recomendarías y por qué · **tags que faltan** (versiones en el CHANGELOG sin `git tag` equivalente).
Útil antes de publicar y para detectar a tiempo que el CHANGELOG se está quedando atrás.
