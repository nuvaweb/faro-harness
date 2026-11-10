---
description: "Úsala antes de abrir el PR si se tocó código — revisa la COHERENCIA con ARCHITECTURE.md, funcional y specs en background, veredicto APTO/NO APTO. No es lint."
argument-hint: "[opcional: alcance o ruta a revisar]"
---

Lanza el subagente **`revisor-code`** **en background** para auditar si el código actual (`src/` o el
layout real del repo) sigue siendo fiel a su propio contrato: `ARCHITECTURE.md` (mapa de módulos, invariantes,
estándares declarados), el funcional/`ESTADO.md`, y las specs de cambios recientes que tocaron código.
**Si el repo tiene `wrangler.toml`/`wrangler.jsonc`/`wrangler.json`** (Cloudflare Workers), lanza
**también** `revisor-code-worker` (SOLID/Workers específico) — se complementan, nunca uno sustituye
al otro. Los dos **en background y en la MISMA tanda** (una sola respuesta con ambas llamadas): son
independientes entre si, asi que corren en paralelo y no se esperan el uno al otro. Es el patrón para futuros stacks propios: un `revisor-code-<stack>` por plataforma, todos
sumándose al genérico, nunca reemplazándolo.

**En un monorepo** (`.faro.json` declara `monorepo`), nada de eso se mira en la raíz: el código, el
contrato y el wrangler viven en cada app. Lista las apps con `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" apps --json`
y cruza con el diff (o con el alcance que te pidan) para saber cuáles toca. Lanza `revisor-code`
pasándole esas apps (cada una con su contrato `apps/<x>/ARCHITECTURE.md`),
y `revisor-code-worker` **una vez por cada app worker afectada** (las que tienen `worker` en
`apps --json`), pasándole la app. Todos en la misma tanda.
Ambos son **solo lectura** y no pueden preguntar: devuelven un veredicto (APTO / NO APTO / APTO
CON RESERVAS) con los problemas por severidad.

**Por que en background:** una revision de coherencia LEE mucho (arquitectura, funcional, specs,
codigo) y devuelve POCO (un veredicto y sus hallazgos). En background esa lectura se queda en el
subagente y a la sesion principal solo vuelve la conclusion — el contexto de la sesion no se gasta
en ficheros que ya no hacen falta. Es el mismo criterio de `/faro:auditoria`.
Mientras corren, NO te quedes esperando: sigue con lo que puedas avanzar sin su veredicto, y NO
inventes ni anticipes su resultado — hasta que no lleguen, no sabes lo que dicen.

No sustituye a `harness.js validate` ni a lint/tests (eso lo cubren los gates automáticos) — esto
audita **coherencia con el contrato**, no estilo ni bugs línea a línea.

Si no existe `ARCHITECTURE.md`, dilo al usuario y sugiere `/faro:code` (lo genera al inicializar el
código) antes de poder revisar coherencia con sentido. En un monorepo la pregunta es por app: una
app afectada sin `apps/<x>/ARCHITECTURE.md` es un aviso (sugiere crearlo), no un motivo para no
revisar las demás.

Preséntale el veredicto al usuario en llano. Si hay bloqueantes, ofrécele resolverlos ahí mismo
(rama de trabajo, nunca en protegida) antes de dar el código por bueno.
