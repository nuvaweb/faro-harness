---
status: aceptada
date: 2026-11-16
deciders: FernandoTWE
version: 3.0.0
---

# FARO 3.0 · Flujo directo a main con auto-merge y publicación desde el CI

## Contexto

Hasta la 2.4.0 el ciclo era: rama `<tipo>/<N>-<slug>` → PR a `develop` → `/faro:consolidar` → `/faro:publicar` (develop → main, tag y release a mano). Eran tres pasos manuales y dos ramas largas, con nomenclaturas distintas para ramas, commits y versiones. Además, el bump dependía de que alguien se acordara de publicar.

## Decisión

1. **Una sola rama larga: `main`.** Cada rama de trabajo nace de `origin/main` y entra por PR a `main` con **auto-merge** (squash por defecto).
2. **El CI es la puerta y quien publica.**
   - En el PR corre la suite completa y `scripts/release-ci.js comprobar`, que avisa si la versión no sube lo que piden los commits.
   - Al integrarse en `main`, el job `release` crea el tag `vX.Y.Z` y la release con su sección del CHANGELOG, si `plugin.json` trae una versión nueva.
   - Usa `GITHUB_TOKEN`, no tokens personales: el personal no puede escribir en la organización (403).
3. **Una nomenclatura Conventional** para ramas, commits, títulos y versiones:
   - `feat` → menor;
   - `fix`/`perf`/`refactor`/`revert` → parche;
   - `!` o `BREAKING CHANGE` → mayor;
   - `docs`/`chore`/`test`/`ci`/`build`/`style` no publican.
4. **La política vive en un solo módulo:** `plugins/faro/hooks/lib/flujo.js`. Lo leen harness, libs y CI.
   - Configurable por entorno (`FARO_RAMA_PRINCIPAL`, `FARO_AUTO_MERGE`, `FARO_METODO_MERGE`) o en `faro/config.json > "flujo"`.
   - Prioridad: entorno > repo > defecto.
5. **Tests:** `npm run test:afectados` en local; la suite completa solo en el CI.
6. **Bloquear solo lo irreversible** (commit directo a `main`). El resto avisa.
7. **Retirados:** `develop` como integración, `/faro:consolidar`, `/faro:publicar` y `lib/consolidar.js`. `harness.js consolidar|publicar` solo explica el flujo nuevo.

## Consecuencias

- Las ramas se comparan contra la principal: `gitFlow`, `ramas`, `sincronizar`, `worktrees`, `tdd` y `dominios` usan `flujo.basesCandidatas()`. `develop` solo queda como último recurso en repos heredados.
- `validate` ya no exige `develop`. Los `[x]` de tareas cerradas se marcan en la rama de trabajo y entran con su PR.
- El reconciliador de tareas (`reconciliarTareas` con `cerrar` y `marcar`), que antes ejecutaban `consolidar` y `publicar`, ahora lo ejecuta `terminar` justo antes de abrir el PR. Las tareas nuevas las cierra la forja con el `Closes #N` del PR; `vigilar` solo detecta.
- El bump de versión y la entrada del CHANGELOG siguen yendo **en el PR**: sin bump, las cachés de los usuarios no se actualizan.
- **Pendiente:**
  - El wizard (`cli/bin/flows/crear.mjs`, `adoptar.mjs`, `lib/repo.mjs`) y `lib/monorepo.js --inicial` siguen creando `develop`.
  - Proteger `main` en GitHub con el check requerido y el auto-merge activado en el repo.

## Contexto operativo (para retomar)

- Rama del cambio: `chore/faro-3-flujo-directo-a-main`.
- Los hooks del plugin instalado (2.4.0) gobiernan su propio repo fuente con el flujo viejo; en este repo el plugin está desactivado con `.claude/settings.local.json` (`enabledPlugins: { "faro@faro-marketplace": false }`). Hace falta reiniciar la sesión para que deje de aplicar.
- Identidad para commits: FernandoTWE (noreply). El push va por SSH.
