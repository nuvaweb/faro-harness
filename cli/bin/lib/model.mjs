// model.mjs — catálogo por defecto (dominios, naturalezas, grupos), constantes y utilidades PURAS
// (slugify, coincideRepo, tipoDeTopics, rel, validación de nombre).

// NOTA: la ENTIDAD (clase del trabajo) ya NO la clasifica este CLI. Un documento puede corresponder a
// varias entidades; eso lo resuelve el harness dentro de los templates. Aquí el único eje es el DOMINIO.
// DOMINIO (los 10 del CDM): DE QUÉ ÁREA es. OBLIGATORIO. Se guarda como `domain`.
const DOMINIOS = {
  producto: { etiqueta: 'Producto', explica: 'Producto, I+D, diseño.' },
  comercial: { etiqueta: 'Comercial', explica: 'Ventas y desarrollo de negocio.' },
  operaciones: { etiqueta: 'Operaciones', explica: 'Entrega, soporte, logística, calidad.' },
  financiero: { etiqueta: 'Financiero', explica: 'Finanzas, contabilidad, facturación.' },
  legal: { etiqueta: 'Legal', explica: 'Contratos, cumplimiento, jurídico.' },
  marketing: { etiqueta: 'Marketing', explica: 'Marca, contenidos, campañas.' },
  rrhh: { etiqueta: 'RR. HH.', explica: 'Personas, talento, cultura.' },
  sistemas: { etiqueta: 'Sistemas / IT', explica: 'Infraestructura e IT interno.' },
  'master-data': { etiqueta: 'Datos maestros', explica: 'Clientes, catálogos, datos de referencia.' },
  'servicios-generales': { etiqueta: 'Servicios generales', explica: 'Compras, instalaciones, administración.' },
  innovacion: { etiqueta: 'Innovación', explica: 'I+D, IA, exploración estratégica.' },
};
// Naturaleza del trabajo. Grupo: 'documental' o 'codigo'. El nivel 2 (donde corre) se auto-salta si el
// grupo tiene una sola entrada.
//
// Todos los repos nacen del esqueleto del paquete (bin/esqueleto): la capa FARO es la misma en las tres
// naturalezas y por eso no se pregunta. `plantillas` es otra cosa: el STACK DE APLICACION que corre
// encima y que el usuario SI elige (nivel 3 del menu). Encapsula decisiones caras y compartidas
// —sistema de diseño, identidad, RBAC— que ningun scaffold oficial da. Para un stack generico (Python,
// Go, un Worker cualquiera) sigue mandando el scaffold oficial + /faro:code, que no hay que mantener.
//
// EJES SEPARADOS a proposito: la NATURALEZA dice DONDE CORRE (la infraestructura: Cloudflare Workers
// hoy; mañana otra) y la PLANTILLA dice QUE SE MONTA encima (TanStack + UI, una API…). Mezclarlos
// —"Worker TanStack" como una sola opcion— obligaria a duplicar la lista entera el dia que aparezca
// una infraestructura nueva, y dejaria sin sitio al Worker que NO es TanStack. Con los ejes
// separados, una infraestructura nueva es una entrada aqui con SUS plantillas, y una plantilla nueva
// es una linea dentro de la infraestructura a la que pertenece.
const NATURALEZAS = {
  documental: {
    grupo: 'documental',
    etiqueta: 'Proyecto FARO — gestión y documentación',
    explica: 'Fases, specs, informes, KPIs. Si mañana necesita código, EVOLUCIONA sin cambiar de repo.',
  },
  worker: {
    grupo: 'codigo',
    etiqueta: 'Cloudflare Workers',
    explica: 'La infraestructura de la casa: ejecución en el edge, deploy con wrangler y bindings de la plataforma. Encima eliges el stack.',
    // Nivel 3: que se monta SOBRE Cloudflare. SIEMPRE se parte de una plantilla: un Worker no arranca
    // de la nada (wrangler, entry, tipos, bindings, deploy por entorno) y montarlo a mano en cada
    // repo nuevo es justo el trabajo que esto viene a evitar. Lo que falte se cubre añadiendo una
    // plantilla mas aqui.
    plantillas: {
      'tanstack-ui': {
        etiqueta: 'App web — TanStack + UI',
        explica: 'Interfaz completa: TanStack Start, React, Tailwind, sistema de diseño, i18n, identidad del centro y RBAC ya montados.',
        repo: 'TANSTACK-WORKER-UI',
        // Marcadores que el CLI sustituye al instanciar (ver personalizarPlantilla en plantilla.mjs).
        instanciar: ['wrangler-name'],
        // Instanciable como app de un MONOREPO (apps/<id>, lo copia el CLI: ver monorepo.mjs).
        // id = el de apps/<id> por defecto (--monorepo --plantilla=tanstack-ui lo usa sin preguntar).
        monorepo: true,
        id: 'web',
      },
    },
  },
  app: {
    grupo: 'codigo',
    etiqueta: 'Otra infraestructura / stack',
    explica: 'Lo que NO corre en Cloudflare: otro proveedor, un servicio on-premise, un stack propio. El harness gobierna igual; el andamio lo montas tú dentro con /faro:code.',
  },
};
const GRUPOS = {
  documental: { etiqueta: 'Documentar (sin código)', explica: 'Documentos, specs, informes, faseo. Sin programar.' },
  codigo: { etiqueta: 'Crear una aplicación / servicio', explica: 'Software: sobre Cloudflare Workers (con plantilla de stack) u otra infraestructura.' },
};

// LOGIN por NAVEGADOR (device flow). El client_id es PÚBLICO (no secreto).

// SCOPES: fuente UNICA (antes la lista estaba escrita a mano en 5 sitios —device flow, validacion,
// mensajes de ayuda— y se desincronizaban: el login pedia 4 y la validacion comprobaba 2, asi que
// faltaba uno y nadie lo detectaba hasta que fallaba el push).
//   repo       CRITICO  clonar/empujar repos privados
//   workflow   CRITICO SI el repo tiene .github/workflows/: sin el, GitHub rechaza el push COMPLETO
//              (no solo el fichero) con "refusing to allow an OAuth App to create or update workflow"
//   read:org   OPCIONAL listar tus organizaciones como destino; sin el se trabaja en tu cuenta personal
//   user:email OPCIONAL identidad real del commit; sin el se usa el noreply de GitHub (funciona)
const SCOPES_CRITICOS = ['repo'];
const SCOPES_CI = ['workflow'];          // critico solo cuando hay CI en el repo
const SCOPES_OPCIONALES = ['read:org', 'user:email'];
const SCOPES_PEDIDOS = [...SCOPES_CRITICOS, ...SCOPES_CI, ...SCOPES_OPCIONALES];
const SCOPE_AYUDA = {
  repo: 'clonar y empujar repositorios privados',
  'read:org': 'ofrecerte tus organizaciones como destino',
  workflow: 'crear o tocar ficheros de CI (.github/workflows/); sin él GitHub rechaza el push ENTERO en repos que los tengan',
  'user:email': 'usar tu correo real en los commits (sin él se usa tu noreply de GitHub)',
};

const slugify = (s) => s
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ¿El repo casa con la búsqueda? Por nombre actual O por nombres ANTIGUOS (topic antes-<slug>,
// estampado al renombrar) — así "analisis red" encuentra faro-solucion-360 aunque haya cambiado.
function coincideRepo(repo, q) {
  const nq = (q || '').toLowerCase().trim();
  if (!nq) return false;
  if (repo.name.toLowerCase().includes(nq)) return true;
  // Por TOKENS: cada palabra del query debe aparecer ("analisis red" casa con antes-analisis-de-red).
  const partes = slugify(nq).split('-').filter(Boolean);
  if (!partes.length) return false;
  const casa = (s) => partes.every((p) => s.includes(p));
  if (casa(repo.name.toLowerCase())) return true;
  return (repo.topics || []).some((t) => t.startsWith('antes-') && casa(t.slice('antes-'.length)));
}

// Deriva una etiqueta legible de los topics de un repo (para el listado "abrir"): el DOMINIO.
function tipoDeTopics(topics = []) {
  const dom = (topics.find((t) => t.startsWith('dom-')) || '').replace('dom-', '');
  return (dom && (DOMINIOS[dom]?.etiqueta || dom)) || 'repo FARO';
}
function rel(iso) {
  try {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
    if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
    return `hace ${Math.floor(s / 86400)} d`;
  } catch { return ''; }
}

// Dominios que el usuario puede ELEGIR según su rol: los marcados soloOwner solo los ve el owner.
const dominiosVisibles = (dominios, esOwner) =>
  Object.fromEntries(Object.entries(dominios).filter(([, d]) => esOwner || !d.soloOwner));

// Nombres poco específicos: se AVISA (no se bloquea) para que el repo sea reconocible.
// Criterio: vacío · < 5 caracteres (pilla app/test/web/api/repo…) · o palabra común de 5+ letras
// que no describe nada por sí sola (aquí SOLO listamos las de 5+; las cortas ya caen por longitud).
const GENERICOS = new Set(['prueba', 'pruebas', 'proyecto', 'nuevo', 'nueva', 'varios', 'temporal', 'datos', 'panel', 'portal', 'sistema', 'gestion', 'informe', 'documento', 'aplicacion', 'servicio', 'general']);
const esNombreGenerico = (slug) => !slug || slug.length < 5 || GENERICOS.has(slug);

// Sugiere hasta n nombres LIBRES con sufijo incremental que no estén en `existentes` (array de slugs).
const sugerirLibres = (slug, existentes = [], n = 3) => {
  const usados = new Set(existentes);
  const out = [];
  for (let i = 2; out.length < n && i < 100; i++) {
    const cand = `${slug}-${i}`;
    if (!usados.has(cand)) out.push(cand);
  }
  return out;
};

// Nombres de repos PARECIDOS al slug (por tokens / nombres antiguos), excluyendo el match exacto.
const parecidosA = (slug, repos = []) =>
  repos.filter((r) => r.name !== slug && coincideRepo(r, slug)).map((r) => r.name);

export {
  DOMINIOS, NATURALEZAS, GRUPOS,
  SCOPES_CRITICOS, SCOPES_CI, SCOPES_OPCIONALES, SCOPES_PEDIDOS, SCOPE_AYUDA,
  slugify, coincideRepo, tipoDeTopics, rel, dominiosVisibles,
  esNombreGenerico, sugerirLibres, parecidosA,
};
