# CLAUDE.md

Repo de trabajo gobernado por el harness FARO. El motor vive en el plugin `faro`, que se instala solo desde `.claude/settings.json`.

**Empieza siempre por `ESTADO.md`**: es la fuente de verdad de qué se construye, en cuántas fases y qué tareas tiene cada una. Si no existe, el harness guía el arranque con `/faro:iniciar`.

## Dónde va cada cosa

| Carpeta | Contenido |
|---|---|
| `documentos/` | Documentación controlada: prosa con `doc_id`, versión y estado |
| `gestion/` | Dirección del trabajo: cambios spec-driven, reporting, riesgos y KPIs |
| `fuentes/` | Material de partida recibido |
| `flujos/` | Exports técnicos ejecutables |
| `notebooks/` | Análisis técnico reproducible |
| `scripts/` | Utilidades reutilizables y versionadas |
| `borrador/` | Pruebas desechables, sin versionar |

Antes de colocar un artefacto, usa `/faro:documentacion`. Nunca dejes ficheros sueltos en la raíz. La exploración y el plan de un cambio viven dentro de `gestion/cambios/changes/<cambio>/`, nunca en una carpeta aparte: redirige ahí las salidas de las skills que escriben en `docs/`.

## Forma de trabajar

- **Cambios:** `/faro:cambio` propone, `/faro:aplicar` implementa y `/faro:archivar` cierra.
- **Ramas:** `main` y `develop` no se editan a mano. El trabajo va en `<tipo>/<slug>` (`feat`, `fix`, `docs`, `chore`…).
- **Integrar:** `/faro:pr` lleva la rama a `develop`, `/faro:consolidar` integra y `/faro:publicar` lleva `develop` a `main`.
- **Estado:** `/faro:estado` muestra por dónde va el trabajo.
