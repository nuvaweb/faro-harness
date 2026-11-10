---
description: "Úsala para que el agente no lance la suite completa en cada cambio — define con el usuario los DOMINIOS de tests (funcionalidades), migra un repo existente y ajusta la regla de TDD del CLAUDE.md."
argument-hint: "[proponer | aplicar | revisar, opcional]"
---

Guía al usuario para organizar los tests de este repo **por funcionalidad** (dominio), de modo que mientras se trabaja solo corra lo afectado y la batería completa quede para CI y `/faro:publicar`. Ejecútalo **TÚ en esta conversación (hilo principal)** para poder preguntar con `AskUserQuestion`. Habla en llano: «una funcionalidad es algo que el negocio reconoce — cobros, altas de cliente, informes —, no una carpeta».

Petición del usuario: $ARGUMENTS

## Idea (para explicarla en dos frases)

Un **dominio** es una funcionalidad con sus tests propios. Si cambias su interior, corre solo ese dominio; si cambias lo que expone a otros (su contrato), corren también los dominios que dependen de él; si cambias algo transversal (esquema, configuración compartida), los que lo alcanzan. Lo que no pertenece a ningún dominio se avisa: es un hueco de cobertura, no algo que esconder ejecutándolo todo.

## 1 · Mira cómo está (solo lectura)

1. `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" tests-dominios` — si ya hay dominios, los lista con sus avisos (código sin dominio, tests que cruzan dominios, decisiones pendientes).
2. Si no hay, `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" tests-dominios --proponer` — deduce un borrador de las `Evidencia:` de las specs, del grafo de imports y de las carpetas de test, y lista los huecos. **No escribe nada.**

## 2 · Decide con el usuario, sin inventar

Presenta el borrador **dominio a dominio** en lenguaje de negocio (qué hace, qué tests lo prueban, qué código toca) y pregunta lo que el harness marca como `pendiente`:

- ¿Este dominio es una funcionalidad completa, o es un trozo de otra? ¿Se llama así?
- Código sin dominio: ¿a cuál pertenece o es una funcionalidad nueva?
- Tests que cruzan dominios: ¿hay que partir el test, o un dominio depende realmente del otro (se declara en `dependientes`)?
- Ficheros que usan varias funcionalidades: ¿transversales (`transversal`) o contrato de un dominio?
- Comando de tests: solo valen las formas de la lista cerrada (`node --test`, `npx|pnpm|yarn vitest|jest`, `npm|pnpm|yarn test`). Cualquier otra se **muestra** para que la ejecute el usuario; el harness nunca la lanza.

Si el usuario no sabe, deja el dominio como `pendiente` (queda a la vista en `validate`): no rellenes por él.

## 3 · Escribe, siempre con confirmación

Nunca en silencio. Con el OK explícito del usuario:

`node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" tests-dominios --aplicar --confirmo --claude-md`

Escribe `faro/config.json > tests.dominios` (sin pisar lo ya declarado ni inventar: lo dudoso queda en `pendiente`) y un bloque delimitado `<!-- faro:tests -->` en el `CLAUDE.md` del repo con la regla nueva. Si el `CLAUDE.md` contiene una instrucción antigua de correr la suite completa en cada cambio, **muéstrasela al usuario** y propón quitarla; el bloque dice que la sustituye, pero la decisión de editar su texto es suya.

## 4 · Comprueba

- `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" validate` — sin avisos `[tests]` nuevos que no se hayan decidido.
- `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" tests-dominios --afectados` — con un cambio de prueba, debe salir solo el dominio esperado.

## Durante el trabajo (la regla que queda)

- Razona por **funcionalidad tocada**, no por «qué tests corro»: `tests-dominios --afectados` te da los dominios y la orden exacta.
- **Monorepo**: la app se deduce de los ficheros cambiados. Si el cambio toca **varias apps** o hay **código sin dominio**, el comando lo marca con «PREGUNTA AL USUARIO» y las opciones: pregúntalo con AskUserQuestion y repite con la respuesta (`--app apps/<x>` o `--app todas`, o declara el dominio). No elijas tú.
- La suite completa **no la lances tú**: la corren CI y `/faro:publicar`. Solo si el usuario la pide expresamente; ni siquiera «una vez al final» antes del commit o del PR. El harness registra nº de tests y tiempo de cada ejecución y avisa si encadenas baterías completas.
- No rebajes tests para que pasen: el harness contrasta el diff de los tests (aserciones eliminadas, `.skip`/`.only`, umbrales o `expect` relajados) con lo que afirmas. Si algo se quita a propósito, dilo y justifícalo: `tests-dominios --integridad --afirmacion "<lo que dirás>"`.

Cuenta al final: cuántos dominios quedan declarados, cuáles siguen `pendiente` y qué hueco queda abierto.
