---
description: "Úsala antes de empezar a trabajar o de abrir un PR — git local↔remoto: trae lo que falta, avanza lo seguro y avisa si tu rama diverge de develop. No es /faro:sync."
argument-hint: "[vacío = sincroniza y aplica lo seguro | informe = solo mirar, sin tocar nada]"
---

Sincroniza el local con el remoto ejecutando `node "${CLAUDE_PLUGIN_ROOT}/hooks/harness.js" sincronizar` (petición del usuario: $ARGUMENTS).

Si el usuario pide **solo mirar / no toques nada / informe**, añade `--solo-informe`.

Funciona igual en **GitHub y GitLab**: todo lo que hace es git puro contra `origin`, así que no depende de la forja ni de tener credenciales de API.

## Qué hace el comando por debajo (y por qué es seguro)

Aplica **solo lo que no puede perder trabajo**:

- **Trae el estado del remoto** (`fetch --prune`): siempre. Solo descarga información; no toca el trabajo del usuario. Sin esto, todo lo demás hablaría de una foto vieja.
- **Avanza las ramas que van por detrás** (fast-forward), y únicamente si el árbol está limpio y la rama **no** ha divergido. En ese caso git solo mueve el puntero a algo que ya contiene todo lo del usuario: no fusiona nada y no hay conflicto posible.
- **NUNCA** fusiona, rebasa ni resuelve conflictos por su cuenta, y **nunca borra ramas**. Eso se propone y decide el usuario.

Los conflictos se detectan **en seco** (fusión de prueba con `merge-tree`): dice qué ficheros chocarían **sin** dejar el repo en estado de conflicto. Por eso sirve para mirar *antes* de abrir la petición de integración.

## Cómo presentar el resultado

Traduce la salida a lenguaje llano, sin dar por hecho que el usuario sabe de git. Cubre, en este orden:

1. **Qué ha cambiado** mientras no miraba (lo que venía del remoto).
2. **Qué he hecho yo** — siempre explicitando que era seguro y por qué ("solo avanzar, sin fusionar").
3. **Si su rama choca** con la base: si está limpia, díselo con claridad ("puedes integrar sin problemas"); si choca, **nombra los ficheros** y avisa de que conviene resolverlo antes de abrir la petición.
4. **Qué le toca decidir a él**: commits sin subir, ramas divergidas, cambios sin commitear que bloquearon la sincronización.

Si el informe señala **ramas muertas**, menciónalo y remite a `/faro:ramas` — esa es la skill que limpia; aquí solo se informa (un único sitio que borra, no dos).

## Cuándo proponerla tú

Ofrécela sin que la pidan cuando el contexto lo justifique:

- El usuario **vuelve tras días sin tocar el repo**, o acaba de clonar en otra máquina.
- **Antes de abrir un PR** (`/faro:pr`): saber si choca con `develop` evita crear una petición con conflictos.
- El usuario dice que quiere **empezar algo nuevo**: conviene partir de una base al día.

## Qué NO hace

No abre ni fusiona peticiones de integración (eso es `/faro:pr` y `/faro:forja`), no aprueba nada (`/faro:publicar`) y no borra ramas (`/faro:ramas`). Su único trabajo es dejar la copia local sana y decir la verdad sobre en qué estado está.
