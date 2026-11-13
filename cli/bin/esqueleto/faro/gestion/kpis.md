# KPIs de negocio

Métricas de **VALOR DE NEGOCIO** del trabajo (impacto en tiempo, coste, ingresos, calidad, adopción…), validadas por el harness (formato) y por el agente `analista-kpis` (evidencia). Los informes de fase y la presentación a dirección DEBEN incorporarlas.

> No confundir con las **métricas de uso/trabajo del repo entre usuarios** (commits, áreas tocadas, aprobaciones, tareas por owner): esas las da `node .claude/hooks/harness.js stats` y miden actividad del equipo, no valor de negocio. Aquí NO van.

Formato de cada KPI (el harness valida los 4 campos y avisa de mediciones desactualizadas >30 días):

```markdown
## KPI-NN · <nombre del indicador>
- definicion: <qué mide y cómo se calcula>
- linea_base: <valor de partida (y fecha)>
- objetivo: <valor meta (y para cuándo: fase/hito)>
- fuente: <de dónde salen los datos: faro/fuentes/<archivo>, sistema X>
- mediciones:
  - AAAA-MM-DD: <valor> — evidencia: <ruta o enlace>
```

Reglas:

- IDs correlativos: `KPI-01`, `KPI-02`… (no reutilizar).
- Cada medición con fecha y **evidencia verificable** (archivo en `faro/fuentes/`, export, enlace).
- Cambiar un `objetivo:` no es un edit silencioso: registra la decisión como ADR en `faro/gestion/decisions/`.

<!-- Define debajo los KPIs reales del trabajo -->
