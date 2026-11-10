# Changelog — faro-harness

Una entrada por versión publicada, la más reciente arriba. Criterio SemVer: **major** rompe un flujo o el
contrato de un comando · **minor** añade comportamiento · **patch** corrige sin cambiar el comportamiento.

## 2.3.0 — 2026-11-10

- **¿Dónde se validan los PR/MR?** (#289): `crear` y `adoptar` preguntan si se validan con el CI de la forja, en local o con los dos.
  - Recomienda según el destino: CI si el repo es público o el plan es de pago; local si es privado en un plan gratuito, porque ahí el CI sería solo informativo.
  - Explica qué cuestan los minutos y qué pasa si se agotan.
  - La elección queda en `.faro.json > validacion`. Para no preguntar: `--validacion=ci|local|ambos`; con `--yes` se toma la recomendada.
- **CI generado por el motor**: con `ci` o `ambos`, el wizard pide al plugin instalado (`harness.js ci`) el CI con los gates del repo.
  - No sobrescribe uno existente.
  - En un repo sin código todavía no genera nada y dice cómo hacerlo después.
- **«El pipeline debe pasar»**: en GitLab se activa solo, y únicamente cuando el CI ya está subido. En GitHub el wizard dice cómo exigirlo, porque requiere protección de rama, que en un repo privado exige plan de pago.

## 2.2.3 — 2026-11-10

- **Cambiar de origen ya no deja faro desinstalado** (#286): al pasar `faro-marketplace` a otra fuente (p. ej. de `CAS-IA/faro-plugin` a `nuvaweb/faro-harness`), `instalar` relee el estado tras retirar el marketplace viejo y **reinstala** faro en vez de intentar actualizarlo. El cambio de fuente se comprueba siempre, sin esperar a la ventana de refresco.
- **`~/.claude/settings.json` alineado**: si declara `faro-marketplace` con la fuente vieja, se cambia a la nueva (solo esa entrada).
- **La caché no se vacía**: si un plugin no figura instalado en ningún scope, sus versiones en caché no se borran.
- **Resumen real al terminar**: `instalar` dice qué versión de faro y superpowers queda en la máquina (scope user, para todos los repos) y solo dice «✅ Plugin listo» si están los dos; si falta uno, lo nombra y da el comando.

## 2.2.2 — 2026-11-10

- **Ficha de npm completa** (#284): `homepage`, `bugs`, `keywords` y `author` en `package.json`, el `CHANGELOG` dentro del paquete y el README con los enlaces al repo público, la instalación global (`npm install -g faro-harness`, comando `faro`) y cómo añadir el plugin a mano.

## 2.2.1 — 2026-11-10

- **Origen público en `nuvaweb/faro-harness`** (#282): el wizard instala el plugin desde el repo de la organización y `repository` apunta a él. El paquete npm sigue siendo `faro-harness`.

## 2.2.0 — 2026-11-10

- **GitLab sin app OAuth embebida** (#277): el wizard ya no trae un `client_id` de GitLab. En gitlab.com, como en GitHub, se pega un token personal (scope `api`) y el wizard explica dónde se crea; el token es siempre de quien lo pega. Quien tenga su propia app OAuth la declara en `~/.faro.json > perfiles` (`client_id`) y recupera el login por navegador.

## 2.1.0 — 2026-11-10

- **Instalar sin cuenta** (#274): `npx faro-harness instalar` (y la primera opción del menú) instala o actualiza el plugin `faro` y `superpowers` en Claude Code sin pedir sesión, porque el plugin es público. La cuenta de la forja se pide solo al crear o traer un repo. `update` sigue funcionando como alias.

## 2.0.0 — 2026-11-09

Major porque cambia el menú, retira modos y deja de leer nombres de ficheros antiguos.

- **Cuatro modos:** crear, traer, conectar y actualizar. Traer cubre lo que antes eran abrir, adoptar y
  revisar: una carpeta (`--traer`) o una URL (`--traer=<repo|url>`), y `--check` para solo revisar.
- **Migrar a otra forja o cuenta** (`--traer --migrar=<url>`). Crea el destino, sube todas las ramas y tags,
  cambia `origin` y ofrece archivar el viejo, que nunca se borra. El token viaja por el entorno de git, no
  en la URL ni en los argumentos, y se oculta en cualquier error.
- **Caja de permisos** al terminar de crear o traer: quién aprueba y qué permite cada nivel de la forja.
- **Servidor propio declarado:** la forja de un host propio se fija con `git config faro.forja` o
  `faro.<host>.forja`; nunca se deduce del nombre.
- **Tokens acotados:** los del entorno y los de `gh` solo se envían a github.com, a gitlab.com o a un host
  declarado.
- **Allowlist del esqueleto** más estricta: no abre WebFetch ni permite reescribir la historia git sin
  confirmar.
- **Retirado:** los modos miembros, invitar y renombrar (añadir personas se hace en la forja), los ids de
  perfil antiguos y la lectura de los nombres de config, metadato y sidecar anteriores. Los sidecar de
  colisión pasan a `*.faro`.
- El plugin se instala desde el repo público `FernandoTWE/faro-harness`;
  `git config faro.marketplaceUrl` lo sustituye por un espejo propio.

## 1.0.0 — 2026-11-02

- Sin organización obligatoria: el destino es tu cuenta o una organización o grupo tuyo, en GitHub o GitLab.
- La sesión se detecta (remoto, `~/.faro.json`, entorno, `git credential`) y solo se pide login si falta.
- El esqueleto viaja en el paquete; las plantillas de stack son públicas y opcionales.
- `faro update` refresca el plugin y avisa de versiones nuevas.
- Los errores de `git clone`/`git push` ya no muestran el token.

Las versiones 0.x fueron internas; su historial está en git.
