# Calidad medible y hexagonal: principios de ub-mode en FARO

- **Estado:** aprobada (2026-11-24); fase 1 implementada en FARO 3.5.0
- **Fecha:** 2026-11-24
- **Fuente:** [unclebob/ub-mode](https://github.com/unclebob/ub-mode) (MIT), con sus herramientas [crapper](https://github.com/unclebob/crapper), [dryer](https://github.com/unclebob/dryer) y [mutator](https://github.com/unclebob/mutator)

## Por qué

Código más limpio, de calidad y robusto, con enfoque hexagonal, en los proyectos que usan FARO y en FARO mismo. Hoy la calidad la revisa `revisor-code` a ojo y `gates` solo corre lo que declara cada proyecto; nada mide complejidad, duplicación ni la fuerza de los tests. ub-mode aporta unos principios reducidos y tres herramientas deterministas que sí lo miden.

## Objetivos

- Los principios de ub-mode guían al agente en todo cambio de código, repartidos en las skills que ya existen.
- Tres medidas deterministas sobre el código que toca cada cambio: CRAP < 10 por función, duplicación estructural < 0,8 y ningún mutante vivo.
- El CI generado (GitHub y GitLab) falla si un cambio empeora la calidad del código que toca.
- FARO cumple lo mismo que exige: declara su hexagonal y entra en el mismo CI de calidad.

## No objetivos y antiobjetivos

- No bloquear en local: coherente con la 3.4.0, `harness.js calidad` informa y no para el trabajo.
- No exigir de golpe la calidad a todo el código existente: dejaría cualquier repo con historia, FARO incluido, en rojo durante meses.
- No duplicar ub-mode como una skill paralela que repita lo que FARO ya hace (TDD, un PR por issue, limpieza de worktrees).
- Antiobjetivo: un CI tan lento que se acabe desactivando.

## Enfoques considerados

- **A. Principios repartidos y medición sobre lo que cambia (elegido).** El CI falla solo por regresiones en el código tocado; en local se informa.
- **B. Umbral absoluto en el CI desde el primer día.** Más puro, pero obliga a refactorizar todo antes de poder fusionar nada.
- **C. Solo principios, sin herramientas.** Rápido, pero se queda en consejo que nadie mide.

## Diseño

### 1. Principios

Cada principio va donde ya se aplica, citando ub-mode:

| Principio | Dónde |
|---|---|
| Hacer lo mínimo, restar antes de sumar, rediseñar en lugar de parchear, causa raíz | skill `code` |
| TDD, probar comportamiento y no implementación | skill `tests` |
| Commits pequeños que dicen por qué, qué cambió y cómo se comprobó | skill `pr` |
| Arquitectura: dominio sin estados ilegales, validar en el borde, lógica pura, idempotencia, un solo escritor | skill `code` (sección hexagonal) y `revisor-code` |
| Umbrales CRAP, duplicación y mutación | `revisor-code` y `revisar-code`, que ejecutan `harness.js calidad` |

### 2. `harness.js calidad`

Hexagonal, como el resto de FARO:

- **Dominio y CLI de medida, `lib/calidad.py`:** en Python, porque el CI del proyecto no tiene el plugin y crapper y dryer son librerías Python. Su parte pura (`rangos_diff`, `tocado`, `evaluar`, `informe`) recibe funciones, duplicados y el diff, y decide qué incumple; los adaptadores (git, crapper, dryer) van separados al final del fichero. Una función cuenta como tocada si su rango de líneas se cruza con `git diff -U0` contra el merge-base de la rama base (más los ficheros sin seguimiento); así no hace falta guardar ninguna línea base.
- **Sin cobertura** (lo normal en el CI, que no repite los tests) se exige CC < 10: como CRAP = CC²·(1−cov)³ + CC ≥ CC, es una cota segura que nunca da un falso positivo. Con `--cobertura`, o con un LCOV ya en disco, se usa el CRAP real.
- **Adaptador local, `lib/calidad-herramientas.js`:** busca Python ≥ 3.11 (`FARO_PYTHON` lo fuerza), crea un venv propio en `~/.faro/herramientas/calidad-venv` e instala con pip crapper y dryer **fijados a un commit** (`lib/calidad-ci.js > HERRAMIENTAS`); reinstala solo si cambian los SHA. Sin Python o sin red, lo dice y sale con 0.
- **Uso:** `harness.js calidad [--base REF] [--todo] [--cobertura] [--ci]`. En local informa y nunca bloquea; solo `--ci` sale con 1 si algo incumple.
- **Lenguajes:** los que cubren las herramientas: JS/TS, Python, Go, Java, Rust y Clojure. Los demás no se miden y no fallan.

### 3. CI generado

`harness.js ci` copia el script al proyecto como `.faro/calidad.py` (cabecera con los SHA, que también es la clave de caché de pip) y añade un job `calidad`, solo en PR/MR no borrador, en GitHub y en GitLab:

- historia completa (`fetch-depth: 0` / `GIT_DEPTH: "0"`) para calcular el merge-base;
- Python 3.12 con caché de pip;
- `pip install` de las herramientas fijadas y `python .faro/calidad.py --ci --base origin/<rama destino>`;
- sin credenciales.

Si el proyecto ya tiene su CI, `harness.js ci` no lo toca y enseña los pasos del job para añadirlo a mano.

### 4. FARO mismo

- Declarar la sección `## Hexagonal` en su `ARCHITECTURE.md`: `lib/` como dominio y adaptadores, y `harness.js` como raíz de composición.
- Su propio CI corre `calidad` (fase 3). Como se mide solo lo tocado, cada cambio a `harness.js` (5.000 líneas) va mejorando el código sin exigir una reescritura previa.

## Fases

1. Principios en skills y agentes, más `calidad` con CRAP y duplicación, en local y en el CI.
2. Mutación de las funciones tocadas.
3. Hexagonal declarada en FARO y migración incremental de `harness.js`.

## Estado de la fase 1 (3.5.0)

- Medido sobre su propia rama, `calidad` marca tres funciones de `harness.js` que ya venían por encima del umbral y que esta rama toca: `githubCiYaml` (CC 28), `cmdCi` (CC 14) y `gitlabCiYaml` (CC 12). Se trocean en la fase 3, junto con la migración incremental de `harness.js`; por eso FARO aún no corre `calidad` en su propio CI.

## Riesgos

- **Las herramientas son jóvenes.** Las fijamos a un commit y las actualizamos con un PR revisado.
- **La mutación es lenta.** Se limita a las funciones tocadas y tiene tope de tiempo.
- **Python como requisito nuevo.** Sin Python, la medición informa de que no puede ejecutarse y no falla.

## Lo que queda al constructor

Los nombres internos, el formato del informe, el tope de tiempo de la mutación y cómo se cruzan el diff y los rangos de función en cada lenguaje.
