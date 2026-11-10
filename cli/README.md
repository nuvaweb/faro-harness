# faro-harness

[![npm](https://img.shields.io/npm/v/faro-harness)](https://www.npmjs.com/package/faro-harness) [![licencia MIT](https://img.shields.io/npm/l/faro-harness)](./LICENSE)

Wizard de **FARO (Forge-Agnostic Repo Operations)**: deja un repositorio de GitHub o GitLab listo para trabajar con Claude Code, con gobierno git (`main` + `develop`), documentación, clasificación y el plugin `faro`. Funciona en Windows, macOS y Linux, en tu cuenta personal o en una organización o grupo tuyo.

```
npx faro-harness instalar   # solo el plugin en Claude Code: sin cuenta ni token
npx faro-harness            # crear o traer un repo (aquí sí pide conectar con tu forja)
```

Requisitos: Node 20.12 o superior, git y, si quieres que lo abra al terminar, VS Code o Cursor.

Si lo vas a usar a menudo, instálalo una vez y usa el comando `faro`:

```
npm install -g faro-harness
faro instalar
faro
```

Código, issues y el plugin: [github.com/nuvaweb/faro-harness](https://github.com/nuvaweb/faro-harness).

## Los cuatro modos

Sin opciones, el wizard pregunta qué quieres hacer.

| Modo | Qué hace | Atajo |
| --- | --- | --- |
| **Instalar** | Instala o actualiza el plugin `faro` y `superpowers` en Claude Code. No pide cuenta ni token: el plugin es público. Avisa si hay un wizard más nuevo. | `npx faro-harness instalar` (alias `update`) |
| **Crear** | Repo privado nuevo desde el esqueleto FARO (va dentro del paquete), con `main`, `develop`, topics y clon local. | `npx faro-harness crear` |
| **Traer** | Una carpeta o una URL que ya existe. Le pone la capa FARO **sin tocar tu código ni tu stack** o, si ya la tiene, la revisa y arregla lo sano. Si un fichero ya existe, la versión FARO queda al lado como `*.faro`. | `--traer` (esta carpeta o `--dir`) · `--traer=<dueño/repo o URL>` · `--check` (solo revisar) |
| **Conectar** | Inicia sesión en una forja y sale. La sesión vale también para el plugin dentro de Claude Code. | `--login` |

`--help` lista todas las opciones, y `--dry-run` simula sin crear nada.

## Conectar

El wizard busca una sesión antes de preguntar, en este orden: el remoto de la carpeta, `~/.faro.json`, las variables `FARO_GITHUB_TOKEN`/`GITHUB_TOKEN` o `FARO_GITLAB_TOKEN`/`GITLAB_TOKEN` y `git credential`. Te dice cuál ha encontrado, o te deja elegir si hay varias. Si no hay ninguna, te pide un token personal (GitHub: `repo` y `read:org`; GitLab: `api`) y te explica dónde se crea; también vale `--token=<token>`. El token es siempre tuyo. Solo si declaras una app OAuth propia (ver abajo) se abre en su lugar el login del navegador.

El token se usa para la API y para clonar y empujar por HTTPS. Para eso, el wizard configura un helper de git acotado a ese host y a ese dueño: nunca es global y el token no se guarda en `.git/config`. Además, el token solo se envía a github.com, a gitlab.com o a un servidor que tú hayas declarado.

## Migrar a otra forja o cuenta

```
npx faro-harness --traer --migrar=https://gitlab.com/mi-grupo/mi-repo.git
```

Crea el repo destino si no existe y sube **todas** las ramas y tags. Después cambia `origin`, aplica la capa FARO y ofrece archivar el repo viejo, que nunca se borra. Con `--migrar --perfil=gitlab`, el destino se elige en el wizard. Durante la migración el token viaja por el entorno de git, no en la URL ni en los argumentos.

## Servidor propio

Un GitLab o GitHub Enterprise que no está en `github.com` ni en `gitlab.com` se declara en git config. El wizard nunca lo deduce del nombre del host:

```
git config faro.forja gitlab                       # este repo
git config --global faro.git.miempresa.es.forja gitlab   # todo ese servidor
```

Si falta la declaración, el wizard pregunta. Para perfiles con app OAuth propia: `perfiles: [{ id, forja, host, client_id }]` en `~/.faro.json`. Si tienes un espejo propio del plugin: `git config --global faro.marketplaceUrl <url>`.

## Permisos

Al terminar de crear o traer, el wizard muestra quién aprueba y qué permite cada nivel de la forja en FARO:

- Solo el **owner** y los **maintainers** aprueban, integran a `develop` y publican a `main`.
- **Write** (GitHub) o **Developer** (GitLab) trabajan en ramas y abren PRs/MRs a `develop`.
- Añadir personas lo hace el owner en la propia forja; el wizard enseña el enlace.

## Instalar y actualizar

```
npx faro-harness instalar
```

La primera vez instala el plugin; después lo pone al día (`update` hace lo mismo). Sin red, avisa y no falla. Si hay un wizard más nuevo, te da el comando: `npx faro-harness@latest instalar`.

## El motor vive en el plugin

FARO se gobierna con el plugin `faro` de Claude Code: skills `/faro:*`, agentes y hooks. El repo no lleva copia del motor. Crear y traer declaran el plugin en `.claude/settings.json`, que viaja con el clon, así que quien clone el repo recibe la oferta de instalarlo.

Sin el wizard, el plugin se añade a mano dentro de Claude Code:

```
/plugin marketplace add nuvaweb/faro-harness
/plugin install faro@faro-marketplace
```

## Modo no interactivo

```
npx faro-harness crear --nombre="Analisis de red" --domain=producto --naturaleza=worker --dir=. --yes
```

## Enlaces

- Repositorio y documentación del plugin: [nuvaweb/faro-harness](https://github.com/nuvaweb/faro-harness)
- Errores y propuestas: [issues](https://github.com/nuvaweb/faro-harness/issues)
- Cambios por versión: [CHANGELOG](./CHANGELOG.md)

## Licencia

[MIT](./LICENSE)
