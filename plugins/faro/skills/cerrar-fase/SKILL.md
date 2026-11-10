---
description: "Úsala para cerrar una fase del faseo — valida que esté terminada, la marca done, avanza fase_actual, cierra su hito en la forja y crea el tag fase-N."
argument-hint: "<N>"
---

**Cerrar una fase NO es publicar.** Publicar (`/faro:publicar`) saca a producción; cerrar una fase es
el acto de gestión que declara terminado un bloque de trabajo y lo deja como registro histórico. Son
independientes: se puede cerrar una fase sin publicar, y publicar sin cerrar ninguna fase.

## La mecánica

1. **Mira qué se cerraría**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" cerrar-fase <N>`.
   Sin `--confirmo` **no toca nada**: enseña qué haría y para.

2. **Si se niega, NO insistas ni lo fuerces**: dice exactamente qué falta, y todo de una vez. Los tres
   motivos posibles:
   - **Tareas abiertas** en la fase → ciérralas, o muévelas a otra fase (`mover-tarea <N> --hito <M>`)
     si ya no pertenecen a este bloque. No marques checkboxes para salir del paso: el harness
     comprueba contra la **forja**, y un `[x]` con su issue abierto lo delata.
   - **Falta el informe de cierre** → lo redacta `/faro:reportar`. No lo generes tú vacío para cumplir
     el trámite: el informe es lo que dice qué entregó la fase, y sin él la fase cerrada no cuenta nada.
   - **Desajuste con la forja** → el checkbox dice una cosa y el issue otra. Cuádralo antes.

3. **Si el repo despliega algo, mira qué está haciendo en producción antes de darlo por cerrado.**
   Con `wrangler.toml`/`.jsonc`/`.json` presente, invoca `/faro:observabilidad`: una fase cuyo
   endpoint acumula errores desde que se dio por terminada **se cerró en falso**, y eso no lo dice
   ningún test. Si el MCP de Cloudflare no está conectado, lo dirá y seguirá — **no bloquea**, pero
   entonces se cierra sin ese dato y conviene decirlo en llano ("no he podido comprobar producción").

4. **Enséñaselo al usuario en llano** y **pregunta con AskUserQuestion** antes de confirmar: se
   escribe en `ESTADO.md` (la fuente de verdad del faseo) y se crea un tag. Di qué fase se cierra, a
   qué fase pasa `fase_actual` y que se cerrará su hito.

5. **Si confirma** → `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" cerrar-fase <N> --confirmo`.
   Hace, en este orden: escribe `ESTADO.md` (fase a `done`, `fase_actual` a la siguiente fase abierta),
   sincroniza los hitos (el de esta fase se cierra; si le quedan tareas abiertas dentro, la forja
   **avisa y NO lo cierra**) y crea el tag `fase-N`. El tag hay que **subirlo**: `git push origin fase-N`.

6. **Reporta**: qué fase quedó cerrada, cuál es ahora la actual, y si el hito se cerró o no.

## Lo que NO hace, y por qué

- **No reabre fases.** Una fase cerrada es histórico: reescribirla falsearía lo que pasó.
- **No genera el informe.** Exigirlo y redactarlo son cosas distintas; redactarlo es `/faro:reportar`.
- **No crea fases nuevas.** Si el trabajo que llega después pertenece conceptualmente a una fase ya
  cerrada, **no se reabre**: va a la fase actual (con `--origen-fase <N>` para dejar constancia de
  dónde viene) o al `Backlog` si no se sabe cuándo se atenderá.

Instrucciones adicionales del usuario: $ARGUMENTS. **No asumas**: confirma antes de escribir.
