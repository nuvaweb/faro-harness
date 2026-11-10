# hooks.json — por qué está como está

Claude Code no admite comentarios en `hooks.json` (avisa `unknown key "_comment" ignored`), así que la
justificación vive aquí. **Si tocas un timeout, actualiza este fichero.**

## Timeouts

SIN 'timeout' A PROPOSITO.

El defecto de Claude Code para un hook de tipo 'command' son 600 SEGUNDOS, y la propia plataforma lo rebaja a 30 solo en UserPromptSubmit.

Declararlo aqui no anadia margen: lo QUITABA (los 60/30 que habia eran 10-20x MAS ESTRECHOS que el defecto).

El riesgo que se queria cubrir es real —cuando un hook expira, su salida se DESCARTA en silencio y el agente pierde el gobierno FARO sin que nadie lo note— pero la forma de cubrirlo es no tocar el campo.

Medido en Windows/Node (media de 3, repo tibio, plugin 0.9.7): session ~7.7s, prompt-context ~0.95s, pre-doc ~1.0s, pre-bash ~0.95s, doc-check ~1.4s, stop-check ~1.0s.

Con el defecto de 600s, el arranque en frio de node + antivirus + 'git status' sobre repos grandes o unidades de red cabe de sobra.


Si algun dia hace falta un plazo MENOR que el defecto, se declara aqui CON su justificacion.

EXCEPCION documentada: UserPromptSubmit lleva timeout EXPLICITO de 120 s porque ahi el defecto de la plataforma NO son 600 sino 30 (lo rebaja ella), y 30 s se agotan bajo carga real (medido: la suite de tests corriendo en paralelo hizo que un prompt-context de ~1,6 s tardara mas de 30 y la plataforma descartara el bloque de gobierno del turno).

Un hook que tarda no cuesta nada; uno que expira deja el turno sin reglas.

## Eventos

| Evento | Comando | Qué hace |
|---|---|---|
| SessionStart | `session` + `self-hint.js` | Bloque de gobierno completo al arrancar; **reancla** corto tras compactar (lee `start_reason`) |
| UserPromptSubmit | `prompt-context` | Solo lo que cambia turno a turno (~334 tokens); timeout explícito de 120 s |
| PreToolUse Write/Edit | `pre-doc` | Nombrado, frontmatter, rama protegida, ficheros de credenciales |
| PreToolUse Bash/PowerShell | `pre-bash` | Commit en rama protegida, comandos destructivos, transporte de API ajeno a la forja, secretos y ficheros enormes antes de commitear |
| PreToolUse Bash/PowerShell (servidores) | `pre-bash` | #177: `ask` con «dame el comando y el puerto; lo levantas tú en una terminal aparte» si la orden levanta un servidor de desarrollo (vite, `npm run dev`, `wrangler dev`, `next dev`, `serve`…, también tras `nohup`, `start`, `Start-Process`, `bash -c`). Lógica en `lib/servidores.js`; red de seguridad sobre el texto, no frontera (no ve scripts propios, `node -e` ni `run_in_background`) |
| PostToolUse Write/Edit | `doc-check` | Valida lo escrito |
| PreToolUse Write/Edit/MultiEdit | `tdd-pre` | TDD (#133): código sin test en rojo del módulo en la sesión → aviso una vez por módulo, o exit 2 en modo bloqueo; test en rojo editado antes de su verde → «no debilites el test» |
| PostToolUse + PostToolUseFailure Bash/PowerShell | `tdd-post` | TDD: si el comando ejecutó tests, registra los rojos (con hash) por repo y sesión en `CLAUDE_PLUGIN_DATA`; avisa si un test pasa a verde con su contenido cambiado. Un Bash con exit ≠ 0 llega como PostToolUseFailure, por eso van los dos |
| Stop | `stop-check` | Recuerda commitear documentación pendiente; además (#177) avisa en una frase si hay procesos propios huérfanos o una batería completa en curso (`harness.js procesos`, `procesos --limpiar --confirmo`), en silencio si todo está bien. SessionStart añade el mismo aviso a su alerta al humano |
| Stop | `tdd-stop` | TDD: **no ejecuta nada**. Si el código editado de un dominio no tiene una ejecución en verde posterior (evidencia de `tdd-post`), exit 2 con la orden del dominio; sin dominio que lo acote NUNCA ordena la suite completa: solo exige arreglar un rojo ya visto (`tests-dominios --afectados`) (#237); el mismo pendiente 3 veces → aviso al humano |

Los hooks `tdd-*` son entradas propias (no se cuelgan de `pre-doc` ni de `stop-check`) y callan sin nada que decir; con `.faro.json > tdd.modo: "off"` no hacen nada. Lógica en `lib/tdd.js`.

Corren en CADA Write/Edit y en CADA Bash, así que `harness.js` los despacha en sus primeras líneas, antes de cargar el motor, y `lib/tdd.js` carga perezosamente `apps.js`, `crypto` y `child_process`. Medido en Windows (mediana de 15): `node -e 1` ~100-110 ms, `tdd-pre`/`tdd-post` sin nada que hacer ~140-150 ms. Ningún hook ejecuta el script `test` del repo: un hook corre fuera del sistema de permisos.
