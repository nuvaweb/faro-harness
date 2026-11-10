---
description: "Úsala si el proyecto usa IA o validate avisa [ria] — analiza el proyecto, propone su nivel del RIA con evidencia y aplica la declaración, las filas del RAID y los documentos de ISO/IEC 42001."
argument-hint: "[foco opcional]"
---

**Del aviso a lo aplicado, sin trabajo manual.** `validate` detecta solo que el proyecto usa IA (SDK de
IA en las dependencias, binding de Workers AI) y avisa si `faro/ESTADO.md` no lo declara. Esta skill hace
el resto: analiza, clasifica con evidencia y **escribe**. Ejecútala **TÚ en el hilo principal
(inline)**: hace falta `AskUserQuestion` para la única confirmación.

## 1. Analiza el proyecto (solo lectura)

- `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" validate`: los avisos `[ria]` dicen qué se detectó y qué falta.
- Lee el funcional, el brief (BRF), `faro/fuentes/`, `faro/gestion/requisitos.md`, `faro/ESTADO.md` y, si hay código,
  dónde se llama al modelo (qué entra, qué sale, quién decide con ello).
- Responde con citas a: ¿qué hace la IA?, ¿sobre quién recae su resultado?, ¿decide o asiste a una persona?

## 2. Propón el nivel del RIA, con evidencia

Recorre los niveles de arriba abajo y quédate con el primero que encaje; cita el texto del proyecto que lo justifica:

| Nivel | Cuándo (Reglamento (UE) 2024/1689) |
|---|---|
| `prohibido` | Prácticas del art. 5: puntuación social, manipulación subliminal, reconocimiento de emociones en trabajo o escuela, categorización biométrica sensible… |
| `alto` | Anexo III: biometría, infraestructuras críticas, educación, empleo y selección (p. ej. filtrar CVs), acceso a servicios esenciales (crédito, seguros), fuerzas de seguridad, migración, justicia. O componente de seguridad de un producto del anexo I. |
| `transparencia` | Art. 50: interactúa con personas (chatbot), genera o manipula contenido (texto, imagen, audio, deepfakes). |
| `minimo` | Uso interno o asistivo sin decisión sobre personas (resúmenes, búsqueda, clasificación de tickets). |
| `no-aplica` | No hay sistema de IA (la dependencia detectada no se usa o es solo de desarrollo). |

Fija también el **rol**: `proveedor` (lo desarrolla o lo pone en el mercado con su nombre) o
`responsable` (lo despliega bajo su autoridad), y si la organización sigue **ISO/IEC 42001**.

**Una sola confirmación** (`AskUserQuestion`): el nivel propuesto (recomendado, con su cita), el
inmediatamente superior y el inferior; rol e ISO en la misma pregunta. Clasificar es una decisión
humana y jurídica: si hay duda real entre dos niveles, recomienda el más alto y revisarlo con
asesoría jurídica. No preguntes nada más.

## 3. Aplica (en la rama de trabajo)

1. **Declaración** en el frontmatter de `faro/ESTADO.md`: `ia: { riesgo: <nivel>, rol: <rol>, iso42001: <true|false> }`.
2. **RAID** (`faro/gestion/risks.md`, con el formato del agente `gestor-riesgos`): una fila por obligación
   que falte, con la etiqueta `RIA:art.N` en la descripción, mitigación concreta del proyecto y owner.
   - `alto`: arts. 9 (gestión de riesgos), 10 (datos), 11 (documentación técnica), 12 (registros),
     13 (transparencia al responsable del despliegue), 14 (supervisión humana), 15 (precisión,
     solidez y ciberseguridad). Aplican desde 2027-12-02 (anexo III) o 2028-08-02 (anexo I).
   - `transparencia`: art. 50 (informar de la interacción con IA, marcar el contenido generado), desde 2026-08-02.
   - `prohibido`: no hay filas que lo mitiguen (art. 5). Para, explica por qué no puede desplegarse
     en la UE y propone el rediseño.
3. **ISO/IEC 42001** (si aplica), en `faro/gestion/compliance/`:
   - `iso42001-impacto.md`: evaluación de impacto del sistema de IA (6.1.4) sobre personas y
     sociedad, con los datos del análisis del paso 1.
   - `iso42001-aplicabilidad.md`: tabla `| control | aplica | justificación |` con los controles A.2
     a A.10. Todo control excluido lleva justificación.
4. Vuelve a lanzar `validate`: no debe quedar ningún aviso `[ria]`.

## 4. Reporta

Nivel y cita que lo sostiene, filas añadidas, documentos creados y lo que queda para asesoría
jurídica. Cierra con `/faro:pr`.
