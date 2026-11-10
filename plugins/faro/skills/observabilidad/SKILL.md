---
description: "Úsala para ver qué hace en producción lo desplegado (tras publicar, al cerrar fase, si falla en real) — lee logs y métricas del Worker vía MCP de Cloudflare."
argument-hint: "[worker o tema opcional]"
---

Los tests dicen que el código hace lo que dice el código. Las specs dicen si hace lo pactado. **Esto
dice si, además, funciona de verdad donde importa.** Foco pedido: $ARGUMENTS

Ejecútalo **TÚ en el hilo principal (inline)**: puede que tengas que preguntar al usuario, y los
subagentes no pueden.

## Antes que nada: ¿aplica aquí?

Esto solo tiene sentido si el repo **despliega algo**. Compruébalo sin preguntar:

- ¿Hay `wrangler.toml` / `wrangler.jsonc` / `wrangler.json`? → es un Worker, sigue.
- ¿No hay? → dilo en una línea y para. Un repo documental no tiene nada que observar.

## Si no tienes el MCP: no pasa nada

Las tools son `mcp__plugin_cloudflare_cloudflare-observability__*` (`query_worker_observability`,
`observability_keys`, `observability_values`, `workers_list`). Vienen de **otro plugin**, no de FARO.

Si no están, o fallan pidiendo autenticación, **no es un error y no bloquea nada**:

> «No puedo ver la observabilidad: el MCP de Cloudflare no está conectado en esta máquina
> (`/mcp` → cloudflare → Authenticate, una vez). Eso **no quiere decir que todo vaya bien** —
> quiere decir que no lo sé.»

Dilo con esas palabras y sigue con lo que el usuario venga a hacer. La distinción importa: **«no pude
mirar» no es «está bien»**, y darlo por bueno es peor que no mirar.

Nadie necesita cuenta propia de Cloudflare para trabajar con FARO. Quien tenga el MCP lo aprovecha;
quien no, trabaja igual.

## Qué mirar, y en qué orden

1. **Errores primero.** Filtra por `$metadata.error` (existe) en las últimas 24h. Un error en
   producción vale más que cualquier métrica agregada: es un caso real que falló a alguien.
2. **Volumen y forma.** Invocaciones por `$metadata.trigger`: qué endpoints se usan de verdad. Suele
   haber sorpresas — rutas que nadie toca y rutas que aguantan todo el tráfico.
3. **Latencia solo si hay queja.** El p99 sin un problema detrás es un número que no cambia ninguna
   decisión. No lo traigas «por completar».

Usa `observability_keys` antes de filtrar: **no adivines los nombres de campo**, cámbialos por los
que el propio Worker emite.

## Lo que aporta de verdad: cruzarlo con el faseo

El valor no está en enseñar logs — está en **relacionarlos con lo que se dio por terminado**:

- Una fase cerrada hace días cuyo endpoint acumula errores 500 desde entonces → **se cerró en falso**.
- Una ruta con tráfico real que **no está en el funcional** → contrástalo con
  `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" contrato`: superficie viva sin documentar.
- Un requisito marcado como entregado cuyo endpoint nadie invoca → o no se usa, o no se desplegó.

Eso es lo que no puede decir ningún test, y lo que justifica la consulta.

## Qué haces con lo que encuentres

**Propones, no ejecutas.** Enséñale al usuario lo que viste, en llano, y sugiere lo que toque:

- ¿Errores sobre trabajo dado por cerrado? → propón reabrir o registrar una tarea nueva, con el dato
  delante. No reabras nada tú.
- ¿Deriva entre lo que corre y lo documentado? → propón actualizar el funcional o el ARQ.
- ¿Nada reseñable? → **dilo en una línea y ya**. Un informe largo para decir que todo va bien enseña a
  no leer los informes.

## Reglas duras

- **No inventes métricas.** Si una consulta falla o vuelve vacía, dilo. Un número inventado sobre
  producción es la peor mentira posible: se toman decisiones con él.
- **Vacío no es cero.** Que no haya logs puede significar que no hay tráfico, que la observabilidad
  está desactivada en `wrangler`, o que miras el Worker equivocado. Distingue los tres.
- **Esto nunca es un gate.** No bloquea `validate`, ni `publicar`, ni el cierre de una fase. Informa
  para que decida el humano.
