---
description: "Úsala si sospechas que el trabajo se ha descuadrado (antes de cerrar fase, al retomar) — cruza ESTADO, specs, RAID y git buscando incoherencias. Solo lectura, en background."
argument-hint: "[foco adicional opcional]"
---

Lanza el subagente `auditor-faro` en background para un diagnóstico integral de coherencia (cobertura spec↔tarea, contradicciones, RAID desatendido, requisitos sin cobertura y fuentes sin digerir, deuda documental, ritmo). Foco adicional solicitado por el usuario: $ARGUMENTS

Es **solo lectura**: no cambia nada. Y no puede preguntarte nada: `AskUserQuestion` **no existe dentro de un subagente** (Claude Code la filtra siempre, aunque el agente la declare en `tools`). Eso encaja con el diseño de una auditoría, que es **no interrumpir**: todo lo que requiera decisión del usuario va **explícito en su informe** — nunca lo asume por su cuenta. Cuando termine, presenta al usuario la salud global, los hallazgos por impacto y el camino crítico sugerido.
