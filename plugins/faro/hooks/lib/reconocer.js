// lib/reconocer.js — QUE ES este repo, mirandolo por fuera.
//
// Por que existe: al abrir un repo que aun no usa FARO, lo util es saber con que se esta trabajando
// (stack, forma, tamano) para poder proponer algo con criterio. Eso el harness ya lo hacia... pero
// BLOQUEANDO el arranque y, peor, ordenando al agente crear ESTADO.md antes de nada.
//
// El analisis no sobraba: sobraba DONDE se hacia. Aqui se calcula, y quien lo invoca es el vigilante
// en background — el arranque devuelve el control al instante y el reconocimiento llega despues,
// como aviso.
//
// Es DESCRIPTIVO, nunca prescriptivo: dice lo que ve, no lo que hay que hacer. La diferencia importa
// porque su salida acaba en el contexto del modelo, y una frase imperativa ahi se ejecuta aunque
// nadie la haya pedido.
//
// Logica PURA: recibe un listador de ficheros y devuelve el retrato. Ni lee disco ni llama a git,
// asi que se puede probar sin montar repos.
'use strict';

// Marcadores de stack, por fichero indicador. El orden importa: lo mas especifico primero, porque un
// Worker tambien tiene package.json y decir "Node" de un Worker seria perder la mitad del dato.
const STACKS = [
  { nombre: 'Cloudflare Workers', ficheros: [/^wrangler\.(toml|jsonc?|json)$/i] },
  { nombre: 'Next.js', ficheros: [/^next\.config\.(js|mjs|ts)$/i] },
  { nombre: 'Astro', ficheros: [/^astro\.config\.(js|mjs|ts)$/i] },
  { nombre: 'Django', ficheros: [/^manage\.py$/i] },
  { nombre: 'Rust', ficheros: [/^Cargo\.toml$/i] },
  { nombre: 'Go', ficheros: [/^go\.mod$/i] },
  { nombre: 'Java/Maven', ficheros: [/^pom\.xml$/i] },
  { nombre: 'PHP/Composer', ficheros: [/^composer\.json$/i] },
  { nombre: 'Python', ficheros: [/^(pyproject\.toml|requirements\.txt|setup\.py)$/i] },
  { nombre: 'Node', ficheros: [/^package\.json$/i] },
];

// Lo que dice que alguien ya cuidaba este repo: no es lo mismo adoptar un repo con CI y tests que
// uno sin nada, y proponer lo mismo a los dos seria no haber mirado.
const SENALES = [
  { clave: 'ci', etiqueta: 'CI configurado', re: /^\.(github\/workflows|gitlab-ci\.yml)/i },
  { clave: 'tests', etiqueta: 'tests', re: /(^|\/)(test|tests|spec|__tests__)\//i },
  { clave: 'docker', etiqueta: 'Docker', re: /^(Dockerfile|docker-compose\.ya?ml)$/i },
  { clave: 'readme', etiqueta: 'README', re: /^README(\.md)?$/i },
  { clave: 'licencia', etiqueta: 'licencia', re: /^LICEN[CS]E(\.md|\.txt)?$/i },
  { clave: 'arquitectura', etiqueta: 'ARCHITECTURE.md', re: /^ARCHITECTURE\.md$/i },
  { clave: 'contribucion', etiqueta: 'guia de contribucion', re: /^CONTRIBUTING(\.md)?$/i },
];

const EXCLUIR = /(^|\/)(node_modules|\.git|dist|build|vendor|\.venv|__pycache__|target|\.next)\//;

// En un MONOREPO el stack vive en cada app, no en la raiz (#129). Por app se mira tambien el front
// con Vite (TanStack Start, React Router...), que en un repo suelto no aporta y aqui distingue el
// front del worker API.
const STACKS_APP = [...STACKS.slice(0, 1), { nombre: 'Vite', ficheros: [/^vite\.config\.(js|mjs|cjs|ts|mts)$/i] }, ...STACKS.slice(1)];
// Sin globs del workspace (la funcion es pura y no lee el yaml), un pnpm-workspace.yaml en la raiz
// basta para mirar las carpetas habituales.
const GLOBS_DEFECTO = ['apps/*', 'packages/*'];

function monorepoDe(fich, raiz, workspaces) {
  const globs = Array.isArray(workspaces) && workspaces.length ? workspaces
    : (raiz.some((f) => /^pnpm-workspace\.ya?ml$/i.test(f)) ? GLOBS_DEFECTO : null);
  if (!globs) return null;
  const bases = globs.map((g) => String(g).replace(/\\/g, '/').match(/^([^*]+)\/\*\*?$/)).filter(Boolean).map((m) => m[1]);
  const porApp = new Map();
  for (const f of fich) {
    for (const b of bases) {
      if (!f.startsWith(`${b}/`)) continue;
      const resto = f.slice(b.length + 1).split('/');
      if (resto.length < 2) continue;
      const ruta = `${b}/${resto[0]}`;
      if (!porApp.has(ruta)) porApp.set(ruta, []);
      if (resto.length === 2) porApp.get(ruta).push(resto[1]);
    }
  }
  const apps = [...porApp.entries()]
    .filter(([, propios]) => propios.some((p) => /^package\.json$/i.test(p)))
    .map(([ruta, propios]) => ({ ruta, stacks: STACKS_APP.filter((s) => s.ficheros.some((re) => propios.some((p) => re.test(p)))).map((s) => s.nombre) }))
    .sort((a, b) => a.ruta.localeCompare(b.ruta));
  return apps.length ? { apps } : null;
}

/**
 * Retrato del repo a partir de sus rutas.
 * @param {string[]} rutas  rutas relativas, con '/' como separador
 * @param {object}   extra  {commits, autores, desde} — lo que solo sabe git; {workspaces} — globs del workspace
 */
function reconocer(rutas, extra = {}) {
  const fich = (rutas || []).filter((r) => r && !EXCLUIR.test(r));
  const raiz = fich.filter((r) => !r.includes('/'));

  const stacks = STACKS.filter((s) => s.ficheros.some((re) => raiz.some((f) => re.test(f)))).map((s) => s.nombre);
  const senales = SENALES.filter((s) => fich.some((f) => s.re.test(f))).map((s) => s.etiqueta);

  // Las carpetas de primer nivel dan la FORMA del repo mejor que cualquier heuristica: un monorepo,
  // un worker suelto y una libreria se distinguen de un vistazo.
  const carpetas = [...new Set(fich.filter((r) => r.includes('/')).map((r) => r.split('/')[0]))].sort();

  return {
    ficheros: fich.length,
    stacks,
    senales,
    carpetas: carpetas.slice(0, 12),
    monorepo: monorepoDe(fich, raiz, extra.workspaces),
    commits: extra.commits || null,
    autores: extra.autores || null,
    desde: extra.desde || null,
  };
}

/**
 * El aviso que se le muestra al agente. DESCRIPTIVO: cuenta lo que hay y ofrece el camino UNA vez.
 * Devuelve null si no hay nada que contar (un repo vacio no merece un parrafo).
 */
function retrato(r, { adoptado = false } = {}) {
  if (!r || !r.ficheros) return null;
  const l = [];
  const stack = r.stacks.length ? r.stacks.join(' + ') : 'sin stack reconocible';
  const edad = r.desde ? `, con historia desde ${r.desde}` : '';
  const quien = r.autores ? ` · ${r.autores} autor(es)` : '';
  const cuantos = r.commits ? ` · ${r.commits} commit(s)${quien}` : '';

  l.push(`He mirado este repo por encima (en segundo plano, sin tocar nada): ${stack}, ${r.ficheros} fichero(s)${cuantos}${edad}.`);
  if (r.carpetas.length) l.push(`Estructura de primer nivel: ${r.carpetas.join(', ')}.`);
  if (r.monorepo) l.push(`Es un monorepo (workspace) con ${r.monorepo.apps.length} app(s): ${r.monorepo.apps.map((a) => `${a.ruta} (${a.stacks.join(' + ') || 'sin stack reconocible'})`).join(', ')}.`);
  if (r.senales.length) l.push(`Ya trae: ${r.senales.join(', ')}.`);

  if (!adoptado) {
    l.push('Todavia no usa FARO (no hay ESTADO.md ni .faro.json). NO hay que arreglarlo y NO crees nada por tu cuenta.');
    l.push('Si el usuario quiere gobernarlo con FARO, /faro:adoptar REENFOCA lo que ya existe sin tocar el stack.');
    l.push('Cuentaselo al usuario en UNA linea, en llano, y sigue con lo que venia a hacer.');
  }
  return l.join('\n');
}

module.exports = { reconocer, retrato, STACKS, SENALES };
