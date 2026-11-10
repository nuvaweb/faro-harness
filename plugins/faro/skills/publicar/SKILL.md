---
description: "Úsala para publicar a producción (develop → main), bajo demanda — analiza lo acumulado, propone versión, valida el ciclo, tagea y publica. Solo admin/owner/maintainer."
argument-hint: ""
---

**Publicar NO es cerrar un ciclo: es sacar a producción.** Los ciclos se cierran en `develop` (ahí se
integran las ramas, se cierran las tareas y se archivan los cambios). Main es el **release**, y puede
agrupar varios ciclos: se publica **cuando alguien lo decide**, no en cada integración.

> Hasta 0.37.0 esto se llamaba "aprobar" — ese nombre describía el permiso, no el acto. El nombre
> viejo **se retiró por completo**, sin alias ni código muerto: no existe ni como skill ni como
> subcomando. El único nombre válido es `publicar` (`/faro:publicar`, `harness.js publicar`).

## 0. Mira QUÉ hay acumulado (el registro, antes de decidir)

```
harness.js release      # solo lee: desde qué release, cuántos cambios, qué versión tocaría
```

Te dice **desde dónde** se publicó lo anterior, **qué lleva acumulado** y **qué versión sugiere**
(MAJOR si algo rompe, MINOR si hay funcionalidad, PATCH si solo son correcciones). Enséñaselo al
usuario en llano: publicar a ciegas es lo que hay que evitar.

Si dice que no hay nada acumulado, **para**: no se publica un release vacío.

**Monorepo** (`.faro.json > monorepo`): `release` lo desglosa **por app** — cada una se mide desde
SU último tag (`{app}@{version}`), con su versión sugerida y lo acumulado en el `[Unreleased]` de su
`apps/<x>/CHANGELOG.md`. Elige con el usuario qué apps salen (las afectadas): `publicar` crea **un
tag y un Release por cada app cambiada** cuya versión esté en su CHANGELOG, y **cancela** si una app
cambiada tiene versión nueva sin entrada (corre `/faro:changelog` para esa app). Una app sin cambios
no se toca; una con cambios pero con la versión ya tageada se avisa y no se publica. Un tag `v0.x`
heredado de antes del monorepo se informa como ambiguo y se ignora.

## La mecánica

1. **Valida el rol** (guardia dura): `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" role`. Si **NO puedes aprobar** (permiso write/read) → **NO apruebas**: prepara la petición con `/faro:pr` y derívala a un admin/owner/maintainer (`harness.js pendientes`). Para aquí. Nadie escribe en main; el rol solo decide quién APRUEBA.
2. **Sitúa quién aprueba** (mira `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" equipo`): la ELECCIÓN de a qué admin se mandó ya se hizo al abrir el PR (`/faro:pr`); aquí quien ejecuta ES el aprobador.
   - **Si eres el ÚNICO que puede aprobar** (único admin del repo): autoapruebas — no esperas a nadie. Se aprueba **dejando constancia por API** (el merge queda registrado en la forja — GitHub o GitLab — como acto de aprobación), tras validar estados. Díselo en llano: *"eres el único que aprueba, así que apruebo y queda registrado"*.
   - **Si hay varios admin** y apruebas tú: avísale en llano que **lo estás aprobando tú** (por si la revisión correspondía a otro admin), y continúa.
3. **Enseña qué se va a publicar** (en llano): el delta `develop` vs `main` agrupado por item legible (documentos, fases, cambios). Si develop no está por delante → no hay nada que publicar.
3. **El ciclo de vida DEBE estar cerrado** — lo fuerza el harness: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" publicar` ejecuta `validate` ANTES del merge y **cancela si falla** (changes en estado incoherente, sin tasks, sin specs, tareas de fase sin cerrar). Si falla, muestra qué cerrar y para.
   - **Si el repo tiene código** (existe `ARCHITECTURE.md`; en un monorepo, alguna app con código — ver abajo): **PREGUNTA al usuario** (AskUserQuestion) si lanzar la revisión de coherencia antes de publicar — **no la des por hecha**. Tarda varios minutos y no siempre aporta: un cambio que solo toca gestión o documentación no la necesita, y forzarla en cada publicación entrena a saltársela. Di qué revisaría y cuánto cuesta, y recomiéndala cuando el cambio **tocó `src/`**.
     Si el usuario dice que sí: lanza `revisor-code` **en background** sobre `develop` — **y además `revisor-code-worker` si detectas `wrangler.toml`/`wrangler.jsonc`/`wrangler.json`**, los dos en la misma tanda (independientes, corren en paralelo; se complementan, no se sustituyen: uno audita coherencia de negocio, el otro SOLID/Workers). `validate` comprueba estructura/gates (lint, tests); estos dos comprueban algo distinto que `validate` NO ve — que el código siga siendo **coherente** con `ARCHITECTURE.md`, el funcional y las specs (invariantes no rotos, estándares declarados respetados, entornos cerrados de verdad). **NO APTO en cualquiera de los dos = no publiques hasta resolverlo**, aunque el gate esté en verde.
     **En un monorepo** (`.faro.json` declara `monorepo`) el código, el contrato y el wrangler viven en cada app, no en la raíz: cruza `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" apps --json` con el diff `main...develop` para saber qué apps se publican. Lanza `revisor-code` sobre esas apps (contrato de cada una en `apps/<x>/ARCHITECTURE.md`) y `revisor-code-worker` **una vez por cada app worker afectada** (las que tienen `worker`), pasándole la app. Todos en la misma tanda; un NO APTO de cualquiera bloquea igual.
4. **¿Hace falta preguntar?** (#99) **Si quien lanzó `/faro:publicar` es admin u owner** (lo dice `role` en el paso 1), **lanzarlo YA es su aprobación**: tiene la legitimidad, y pedirle confirmación de lo que acaba de ordenar es una vuelta de más. No preguntes: enseña en llano qué se publica (paso 3) y pasa al 5. El control no se relaja: rol, develop por delante y `validate` los sigue exigiendo el harness.
   **Sí confirmas** (AskUserQuestion: *"Voy a validar el ciclo, hacer el merge `develop → main`, **subirlo** (dispara el CI) y **cerrar estados**. ¿Publico?"*) cuando:
   - el rol es **maintainer** (puede aprobar, pero no es quien manda en el repo);
   - **hay varios admin** y la revisión podía corresponder a otro: díselo y pregunta;
   - `validate` o `release` sacan algo que **cambia la decisión** (avisos de tareas hechas sin cerrar, una versión sugerida que no cuadra, una revisión de código NO APTO);
   - actúas en un **loop autónomo** sin que el usuario lo haya pedido en esta conversación. Ahí la confirmación sigue siendo suya (producción es irreversible): si el loop se detiene esperándola, usa `PushNotification` para avisarle activamente.
5. Con la aprobación (implícita del admin/owner o confirmada) → `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" publicar --confirmo`. El `--confirmo` es OBLIGATORIO: sin él, el comando solo MUESTRA qué se publicaría y no ejecuta nada — es el gate duro que exige que el USUARIO haya aprobado en esta conversación: invocando él mismo `/faro:publicar` siendo admin/owner, o confirmando en el paso 4. El comando: valida rol + que develop esté por delante + gate `validate`; hace el merge `--no-ff`, **sube** (`main` + `develop` + el tag de versión si aplica), **vuelve a develop** y **cierra estados** (archiva los changes `implementada` → deltas a `gestion/cambios/specs/`). Ante conflicto, aborta y avisa. **La subida la resuelve el harness** (#194): si la credencial de git (SSH, credential manager) falla, reintenta con el token del harness, y si `main` está protegida, integra develop → main **por petición vía API** con ese token. No mandes al usuario a subir a mano ni a la web: si aun así falla, el mensaje dice el motivo (p. ej. checks pendientes, token caducado → `harness.js auth`).
6. **Cierra el faseo**: `publicar` ya cierra por la forja las tareas con su PR integrado, marca sus `[x]` en `ESTADO.md` y anota «Publicada en vX» en cada una (#71). Revisa lo que quede; si con ellas una fase queda completa, ciérrala (informe en `gestion/reporting/` + estado `done` + `git tag fase-N` en main validado). El estado del faseo NO debe quedar desincronizado respecto a lo publicado.
7. **Reporta**: publicado y subido, qué changes se archivaron, qué falta en el faseo.

Instrucciones adicionales del usuario: $ARGUMENTS. **No asumas**: si no es admin/owner quien lo lanza, o se da alguno de los casos del paso 4, confirma antes de subir.


> **Hitos (GitLab):** al publicar, el harness sincroniza los hitos con las fases de ESTADO.md (crea los que faltan,
> cierra los de fases terminadas) y lo imprime. Si una fase queda `done`, su hito se cierra en la forja sin que hagas nada.
