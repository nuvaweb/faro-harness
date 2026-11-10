// permisos.mjs — la caja que cierra crear y traer: quién aprueba, quién da acceso y qué nivel de la
// forja sirve para qué en FARO. Puro: devuelve líneas, la UI las pinta.

const NIVELES = {
  github: [
    { nombre: 'Read', uso: 've el código y los issues; no sube cambios.' },
    { nombre: 'Triage', uso: 'ordena issues y PRs (etiquetas, asignaciones); no sube cambios.' },
    { nombre: 'Write', uso: 'trabaja en ramas y abre PRs a develop; no integra ni publica.' },
    { nombre: 'Maintain', uso: 'maintainer FARO: aprueba, integra a develop y publica a main.' },
    { nombre: 'Admin', uso: 'owner FARO: lo anterior, más configurar el repo y dar acceso.' },
  ],
  gitlab: [
    { nombre: 'Guest', uso: 've los issues; en un proyecto privado no ve el código.' },
    { nombre: 'Reporter', uso: 've el código y ordena issues; no sube cambios.' },
    { nombre: 'Developer', uso: 'trabaja en ramas y abre MRs a develop; no integra ni publica.' },
    { nombre: 'Maintainer', uso: 'maintainer FARO: aprueba, integra a develop y publica a main.' },
    { nombre: 'Owner', uso: 'owner FARO: lo anterior, más gestionar el grupo y dar acceso.' },
  ],
};

function enlaceMiembros(forja, host, ruta) {
  return forja === 'gitlab' ? `https://${host}/${ruta}/-/project_members` : `https://${host}/${ruta}/settings/access`;
}

function lineasPermisos({ forja, host, ruta }) {
  const niveles = NIVELES[forja === 'gitlab' ? 'gitlab' : 'github'];
  const ancho = Math.max(...niveles.map((n) => n.nombre.length));
  return [
    'Solo el owner y los maintainers aprueban, integran a develop y publican a main.',
    'Añadir personas es responsabilidad del owner, en la forja:',
    `  ${enlaceMiembros(forja, host, ruta)}`,
    '',
    'Qué permite cada nivel en FARO:',
    ...niveles.map((n) => `  ${n.nombre.padEnd(ancho)}  ${n.uso}`),
  ];
}

export { NIVELES, enlaceMiembros, lineasPermisos };
