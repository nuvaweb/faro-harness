// modos.mjs — los cuatro modos del wizard (instalar va primero y no pide cuenta) y los flags que llevan a cada uno. Puro: lee una lista de
// argumentos; core.mjs sigue siendo quien lee process.argv.

const MENU = {
  instalar: { etiqueta: 'Instalar o actualizar el plugin', explica: 'Deja faro y superpowers en Claude Code. Sin cuenta ni token.' },
  crear: { etiqueta: 'Crear un repositorio nuevo', explica: 'Desde el esqueleto FARO, en GitHub o GitLab, con su clon local.' },
  traer: { etiqueta: 'Traer un repositorio que ya existe', explica: 'Esta carpeta o una URL: le pone la capa FARO o lo revisa, y si quieres lo mueve de forja.' },
  conectar: { etiqueta: 'Conectar con una forja', explica: 'Iniciar sesión (navegador o token). Vale para el wizard y para el plugin de Claude Code.' },
};

// Devuelve { modo } con modo null cuando decide el menú. Para traer: origen 'carpeta' | 'repo', el repo
// (ruta o URL), revisar (solo check) y migrar (URL de destino, true si el destino sale de --perfil, o null).
function leerModo(lista = []) {
  const val = (n) => { const a = lista.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
  const flag = (n) => lista.includes(`--${n}`);
  if (lista[0] === 'instalar' || lista[0] === 'update') return { modo: 'instalar' };
  if (lista[0] === 'crear') return { modo: 'crear' };
  if (flag('login')) return { modo: 'conectar' };
  const migrar = val('migrar') || (flag('migrar') ? true : null);
  const repo = val('abrir') || val('traer');
  if (repo) return { modo: 'traer', origen: 'repo', repo, revisar: false, migrar };
  if (flag('traer') || flag('adoptar') || flag('check') || migrar) {
    return { modo: 'traer', origen: 'carpeta', repo: null, revisar: flag('check'), migrar };
  }
  return { modo: null };
}

const AYUDA = `
faro-harness — repositorios con el harness FARO (Forge-Agnostic Repo Operations), en GitHub o GitLab

Uso:  npx faro-harness [modo] [opciones]

Modos (sin opciones, el wizard pregunta):
  instalar                Instala o actualiza el plugin en Claude Code. Sin cuenta ni token. Alias: update.
  crear                   Repositorio nuevo desde el esqueleto FARO.
  --traer                 Trae la carpeta actual (o --dir): le pone la capa FARO, o la revisa si ya la tiene.
  --traer=<repo|url>      Trae un repositorio de la forja: lo clona y lo deja listo.
      Alias: --adoptar (la carpeta), --check (solo revisar la carpeta), --abrir=<repo|url>.
  --migrar=<url-destino>  Con --traer: lo mueve a otra forja o cuenta. Crea el destino, sube todas las
                          ramas y tags, cambia origin y ofrece archivar el viejo (nunca lo borra).
  --migrar --perfil=<id>  Igual, eligiendo el destino desde el perfil (github, gitlab o los tuyos).
  --login                 Conectar con una forja (navegador o token) y salir.

Crear sin preguntas (CI):
  npx faro-harness --nombre="Analisis de red" --domain=producto --naturaleza=worker --dir=./proyectos --yes

Opciones:
  --org=<nombre>          Cuenta, organización o grupo destino.
  --domain=<id>           Área: producto | comercial | operaciones | financiero | legal | marketing |
                          rrhh | sistemas | master-data | servicios-generales | innovacion
  --naturaleza=<id>       documental | worker | app
  --plantilla=<id>        Plantilla de stack (worker: tanstack-ui).
  --monorepo              Monorepo pnpm: cada app en apps/<id>.
  --nombre=<texto>        Nombre en lenguaje normal (se convierte en un slug sin prefijo).
  --validacion=<modo>     Dónde se validan los PR/MR: ci | local | ambos (sin flag, se recomienda según el plan).
  --dir=<ruta>            Carpeta donde clonar, o la carpeta a traer.
  --perfil=<id>           Perfil: github | gitlab | los de ~/.faro.json.
  --forja=github|gitlab   Acota el perfil cuando no hay remoto que leer.
  --token=<token>         Token personal (GitHub: repo, read:org; GitLab: api).
  --reautorizar           Vuelve a pedir permisos. Alias: --reauth.
  --yes / --si            Sin confirmaciones.
  --force                 Sigue aunque tu SSH empuje como otra cuenta distinta a tu sesión.
  --no-open               No abre el editor al terminar.
  --dry-run               Simula sin crear nada.
  --help                  Esta ayuda.

Servidor propio: la forja de un host que no es github.com ni gitlab.com se declara en git config
(faro.forja en el repo, o faro.<host>.forja con --global). Si falta, el wizard la pregunta.
`;

export { MENU, leerModo, AYUDA };
