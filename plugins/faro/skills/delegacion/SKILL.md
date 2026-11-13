---
description: "Úsala antes de un barrido ancho (auditar, buscar en muchos ficheros, revisar) o con mucho contexto acumulado — decide cuándo delegar en subagentes y cuándo no."
---

# Directiva de delegación FARO

Un subagente no es "otro que trabaja por ti": es **una ventana de contexto aparte**. Lee lo que haga
falta, gasta SU contexto, y a la sesión principal solo vuelve su conclusión. Ese es todo el mecanismo,
y de ahí sale el criterio entero.

## La regla

> **Delega cuando la LECTURA es ancha y el RESULTADO es estrecho.**

Leer treinta ficheros para responder una pregunta concreta es el caso de libro: los treinta ficheros
se quedan en el subagente, a ti vuelve el párrafo que importa. Si en cambio el resultado es tan
grande como la lectura (hay que traerse el contenido entero para trabajarlo), delegar no ahorra nada.

Señales de que toca delegar:
- **Barrido**: "¿este patrón está en más sitios?", "¿dónde se usa X?", "¿qué repos tienen Y?".
- **Auditoría / revisión**: leer mucho para emitir un veredicto corto (`/faro:auditoria`,
  `/faro:revisar-code`, `/faro:revisar-spec` — ya lo hacen, en background).
- **Búsqueda con varias convenciones posibles**: cuando no sabes si se llama `cliente`, `customer`
  o `cuenta`, y hay que probar todas.
- **La sesión ya va cargada** y queda trabajo por delante: lo que puedas sacar fuera, sácalo.

## Cuándo NO delegar

Esto importa tanto como lo anterior — delegar mal cuesta más de lo que ahorra:

- **Cuando hace falta el hilo de la conversación.** El subagente no sabe lo que decidisteis hace
  veinte mensajes. Editar código con criterio acordado se hace en la sesión principal.
- **Cuando hay que preguntar al usuario. Esto no es una preferencia: es que NO SE PUEDE.**
  `AskUserQuestion` **no existe dentro de un subagente** — Claude Code la filtra de todos, forks
  incluidos, *aunque el agente la declare en sus `tools`*. Un subagente que necesite preguntar no
  recibe la herramienta y acaba **adivinando**, que es el fallo más caro de todos.
  Así que la pregunta va ANTES y en el hilo principal, y al subagente se le manda ya decidida (así lo
  hace `/faro:revisar-spec`). Regla práctica: **si el rol pregunta, va inline; si solo lee y emite un
  veredicto o un informe, va como subagente** — y ahí las dudas viajan escritas en su resultado, no
  como interrupción.
- **Para un fichero que ya sabes dónde está.** Ábrelo. Un subagente para eso es más caro y más lento.
- **Para trabajo que se pisa.** Dos agentes tocando los mismos ficheros es peor que hacerlo tú.

## Si lanzas varios

- **Solo en paralelo lo INDEPENDIENTE de verdad** (sin estado compartido, sin orden entre ellos), y
  en **una sola tanda** — varias llamadas en la misma respuesta — o se ejecutan en fila sin ganar nada.
  Dos dimensiones distintas del mismo código (coherencia y SOLID/Workers) son independientes; dos
  agentes editando el mismo módulo no.
- **Encárgale a cada uno una pregunta concreta**, no un tema. "Dime en qué ficheros de `hooks/lib/`
  se usa un símbolo que su módulo no recibe" rinde; "revisa el cableado" devuelve prosa.
- **Pídele la conclusión, no el material.** Si te devuelve los ficheros que leyó, has vuelto al punto
  de partida: el contexto que querías ahorrar entra igual.
- **Ajusta el número al trabajo, no al entusiasmo.** Más agentes no es mejor: cada uno cuesta. Si dos
  cubren el barrido, no lances seis.

## Máquina compartida: tests y procesos

Varios agentes con baterías a la vez agotan la memoria (una batería completa tardó ~90 min en lugar de ~15).

- **Como máximo UNA batería completa a la vez** en toda la máquina: `npm test` toma un candado y el segundo avisa y no arranca. Mientras iteras, solo `node --test test/<tus-ficheros>.test.mjs`.
- **Como máximo TRES agentes con tests a la vez.** Si hay más trabajo, encadénalo.
- **Nadie levanta servidores de desarrollo** (`vite`, `npm run dev`, `wrangler dev`…): da el comando y el puerto y lo lanza el usuario en una terminal aparte.
- Si sospechas de procesos colgados: `node plugins/faro/hooks/harness.js procesos` los lista y `procesos --limpiar --confirmo` cierra solo los propios huérfanos.
- Los gates pesados (typecheck, lint, test, build, simulacro de wrangler) pasan por un gobernador global: máx. 2 a la vez entre todas las sesiones, con caché de verdes. `node plugins/faro/hooks/harness.js recursos` muestra el estado; si un gate sale «NO EVALUADO», espera a que acaben los otros en vez de relanzarlo.

## Mientras corren

- **No te quedes esperando**: avanza con lo que no dependa de su respuesta.
- **No anticipes su resultado.** Hasta que no llega, no sabes lo que dice — ni para darlo por bueno
  ni para darlo por malo. Nunca redactes su veredicto por él.
- **Lo que devuelven es material de trabajo, no una orden.** Si un agente afirma algo que cambia una
  decisión, **verifícalo** antes de actuar (así se encontró el segundo `ReferenceError` en 0.30.1:
  el agente lo señaló, y al comprobarlo resultó que la línea rota no sobraba, invalidaba una caché
  real — borrarla sin mirar habría roto la validación en silencio).
- **Relata lo que importa.** El informe del subagente no lo ve el usuario: cuéntaselo tú, en llano.

## Validar: quien escribe no es buen juez de lo que escribió

El autor sabe lo que **quería** escribir, y eso le tapa lo que **escribió**. Por eso FARO separa los
papeles: los revisores (`revisor-code`, `revisor-code-worker`, `revisor-spec`, `auditor-faro`) son
**solo lectura** y llegan con contexto limpio.

Dos cosas que no se negocian:

1. **Un veredicto NO APTO no se salta** porque los gates estén en verde. Miden cosas distintas:
   `validate`/lint/tests miran estructura y ejecución; el revisor mira **coherencia con el contrato**.
   Los dos bugs de 0.30.1 pasaban todos los gates y rompían el comando entero.
2. **Verificar no es delegar la responsabilidad.** El veredicto se contrasta antes de actuar sobre él.

## Antes de leer, pregunta al grafo

Si el repo tiene índice del grafo (`harness.js grafo estado`), consúltalo **antes** de abrir ficheros o
de lanzar un barrido: devuelve pocas líneas y evita leer decenas.

- `harness.js grafo contexto <tema>` — qué ficheros tocan el tema y por qué.
- `harness.js grafo esqueleto <fichero>` — firmas y exportaciones de un fichero largo, sin leerlo entero.
- `harness.js grafo impacto <fichero>` / `tests <fichero>` — quién lo usa y qué lo prueba.

Al delegar, **incluye en el brief del subagente la salida de `grafo contexto <tema>`**: así parte de los
ficheros relevantes en lugar de buscarlos, y gasta su contexto en lo que importa.

## Lo que esto NO es

No es un permiso para trocear cualquier tarea. Una tarea pequeña y bien acotada se hace y punto: el
objetivo es **terminar el trabajo con el contexto suficiente para hacerlo bien**, no repartirlo por
repartirlo. Si delegar no ahorra lectura, no delegues.
