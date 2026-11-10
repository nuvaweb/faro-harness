# scripts/

Automatizacion REUTILIZABLE y versionada: utilidades del repo (tooling, generadores,
migraciones, ayudas de dev/ops) que se comparten y se mantienen en git.

Distinto de `faro/borrador/` (scratch desechable, gitignored) y de `faro/flujos/` (exports de
workflow que se importan/ejecutan). Regla: ¿de usar y tirar? -> `faro/borrador/`; ¿se
reutiliza o forma parte del repo? -> `scripts/`.
