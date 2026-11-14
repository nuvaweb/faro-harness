# Banco del grafo FARO — resultados (#308)

## Ronda 1 (2026-11-13) · 10 tareas sobre el propio motor × 3 brazos × 1 · sonnet · 5,33 USD

| brazo | ejecuciones | acierto | coste medio (USD) | tokens sin caché | llamadas | exploración | grafo | tiempo (s) |
|---|---|---|---|---|---|---|---|---|
| frio | 10 | 10/10 | 0.178 | 36842 | 4.6 | 3.6 | 0.0 | 37.0 |
| empuje | 10 | 10/10 | 0.181 (+2%) | 37338 (+1%) | 4.9 (+7%) | 3.9 | 0.0 | 35.5 (-4%) |
| demanda | 10 | 10/10 | 0.174 (-2%) | 36256 (-2%) | 4.4 (-4%) | 3.4 | 0.0 | 33.5 (-9%) |

Tareas: localizar constantes, definiciones, usos e importadores en `plugins/faro/hooks` (respuesta en
`RESPUESTA.md`, comprobada por `comprobar.js`). Por tarea, la diferencia entre brazos va y viene
(±0,04 USD) sin dirección: es ruido de una sola repetición.

## Lo que dice

1. **No hay ahorro medible** en tareas de localización: los tres brazos aciertan todo con ~4-5
   llamadas; las diferencias (±2 % en coste) están dentro del ruido.
2. **El agente no usa el grafo**: 0 consultas `harness.js grafo` en 30 sesiones. En el brazo empuje
   el arranque sí le dice «Para orientarte, antes de leer: `harness.js grafo contexto <tema>`», y lo
   ignora: Grep resuelve estas preguntas en 2-3 llamadas, más barato que aprender un comando.
3. **El empuje no llega a actuar**: se dispara al editar, y estas tareas solo leen. Esta ronda no
   mide el empuje; mide la orientación.
4. **El coste lo domina el contexto fijo** (~210 k tokens de caché leída y ~33 k sin caché por
   sesión, la mayor parte el arranque del harness), no la exploración: aunque el grafo ahorrara la
   mitad de las búsquedas, el coste total apenas se movería.

## Decisión

- El grafo actual **no se justifica por ahorro** en preguntas de localización. Sigue valiendo por lo
  que no mide este banco (aprendizajes, cuidados, historia), sin prometer ahorro de tokens.
- **#312 (símbolos + BM25) no se construye ahora**: su condición era ahorro medido del grafo actual,
  y no lo hay.
- Para volver a medir con sentido: tareas de **edición multi-fichero** (donde actúa el empuje), en
  repos de trabajo más grandes, con ≥3 repeticiones. El banco ya lo permite (`--repeticiones`).
