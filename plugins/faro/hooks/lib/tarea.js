// lib/tarea.js — ESTADO DE UNA TAREA, en un solo sitio (#71).
//
// Que una tarea este hecha no lo dice una casilla ni una etiqueta: lo dicen HECHOS de la forja. La
// cadena es issue #N -> rama <tipo>/N-slug -> PR que la referencia -> merge en develop (-> tag). Aqui
// vive la UNICA regla que convierte esos hechos en un estado y en una accion; consolidar, publicar,
// vigilar y hito verificar la usan en vez de decidir cada uno a su manera. Antes habia cinco sitios
// con su logica y los issues se quedaban abiertos: 'Closes #N' solo cierra si el PR va a la rama por
// defecto, y consolidar solo cerraba lo que el mismo fusionaba.
//
// Todo es PURO (sin red ni git): quien llama recoge los hechos y ejecuta las acciones.
'use strict';

// Ramas donde un merge significa "el trabajo entro": la integracion y la publicacion.
const BASES_DE_ENTREGA = new Set(['develop', 'main', 'master']);
const NOMBRE_BACKLOG = 'Backlog';
const RE_CIERRE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b(?:\s*:\s*|\s+)#(\d+)\b/gi;
const esBug = (issue) => ((issue && issue.labels) || []).some((l) => /(^|:)(bug|bugfix|hotfix)$/i.test(typeof l === 'string' ? l : l.name));
const corto = (sha) => (sha ? String(sha).slice(0, 7) : null);

const textoDePr = (pr) => `${(pr && pr.title) || ''}\n${(pr && pr.body) || ''}`;
const cierraExplicito = (pr) => new Set([...textoDePr(pr).matchAll(RE_CIERRE)].map((x) => Number(x[1])));

// El PR AVANZA la tarea #n sin terminarla (#91): la cita con 'Refs', 'Ref', 'Parte de', 'Part of' o
// 'Relates to' y ninguna palabra de cierre la nombra. Es lo que permite trabajar en 'docs/96-x' sin
// que integrar cierre la #96. Una palabra de cierre explicita gana siempre. 'Refs #96, #97' cubre las dos.
function soloReferencia(pr, n) {
  const num = Number(n);
  if (!num || cierraExplicito(pr).has(num)) return false;
  for (const m of textoDePr(pr).matchAll(/\b(?:refs?|parte\s+de|part\s+of|relates?\s+to)\b(?:\s*:\s*|\s+)((?:#\d+(?:\s*(?:,|&|\by\b|\band\b)\s*)?)+)/gi)) {
    if ([...m[1].matchAll(/#(\d+)/g)].some((x) => Number(x[1]) === num)) return true;
  }
  return false;
}

// Issues que un PR declara que resuelve: el numero de su rama ('fix/12-x') y las palabras de cierre
// ('Closes #7'). Una mencion suelta ('ver #5') NO cuenta: citar no es resolver. Y si el PR dice
// 'Refs #12', el numero de la rama tampoco: avanza la tarea, no la termina (soloReferencia).
function issuesDePr(pr) {
  const nums = cierraExplicito(pr);
  const m = String((pr && pr.head && pr.head.ref) || '').match(/^[^/]+\/(\d+)(?:-|$)/);
  if (m && !soloReferencia(pr, m[1])) nums.add(Number(m[1]));
  return nums;
}
const fusionadoEnEntrega = (pr) => Boolean(pr && pr.merged_at && BASES_DE_ENTREGA.has(pr.base && pr.base.ref));
const enBacklog = (issue) => Boolean(issue && issue.milestone && issue.milestone.title === NOMBRE_BACKLOG);

// Estado de UNA tarea a partir de sus PRs (ya filtrados o no: se filtran aqui) y de las ramas remotas.
//   hecha                 un PR que la referencia esta fusionado en develop/main
//   descartada            cerrada como 'not_planned'
//   cerrada-sin-evidencia cerrada como completada sin ningun PR fusionado que la respalde
//   mencionada            un PR integrado la CITA sin palabra de cierre: puede estar hecha, pero una
//                         mencion no lo demuestra — se avisa, nunca se cierra sola
//   en-revision           tiene un PR abierto
//   en-curso              existe una rama con su numero
//   abierta               nada de lo anterior
//   desconocido           no se pudo consultar el issue: NUNCA se actua sobre el
// accion: 'cerrar' (hecha y abierta) · 'mover-a-fase' (hecha pero en el Backlog: una tarea no se
// completa desde la sala de espera) · null.
function evaluarTarea(issue, prs, { ramas = [] } = {}) {
  if (!issue || !issue.number) return { numero: issue && issue.number, estado: 'desconocido', accion: null, evidencia: null };
  const n = Number(issue.number);
  const suyos = (prs || []).filter((p) => issuesDePr(p).has(n));
  const entregado = suyos.filter(fusionadoEnEntrega).sort((a, b) => String(b.merged_at).localeCompare(String(a.merged_at)))[0];
  const abierto = suyos.find((p) => p.state === 'open');
  const base = { numero: n, titulo: issue.title || '', bug: esBug(issue), issue };
  const evidencia = entregado ? {
    pr: entregado.number, url: entregado.html_url || null, rama: entregado.head && entregado.head.ref,
    base: entregado.base && entregado.base.ref, commit: corto(entregado.merge_commit_sha), fecha: String(entregado.merged_at).slice(0, 10),
    titulo: entregado.title || '', cuerpo: entregado.body || '',
  } : null;
  if (issue.state === 'closed') {
    if (issue.state_reason === 'not_planned') return { ...base, estado: 'descartada', accion: null, evidencia };
    return { ...base, estado: evidencia ? 'hecha' : 'cerrada-sin-evidencia', accion: null, evidencia };
  }
  if (evidencia) return { ...base, estado: 'hecha', accion: enBacklog(issue) ? 'mover-a-fase' : 'cerrar', evidencia };
  const cita = new RegExp(`#${n}(?![0-9])`);
  const mencion = (prs || []).filter((p) => fusionadoEnEntrega(p) && !suyos.includes(p) && cita.test(`${p.title || ''}\n${p.body || ''}`))[0];
  if (abierto) return { ...base, estado: 'en-revision', accion: null, evidencia: { pr: abierto.number, url: abierto.html_url || null } };
  if (mencion) return { ...base, estado: 'mencionada', accion: null, evidencia: { pr: mencion.number, url: mencion.html_url || null } };
  const enRama = (ramas || []).some((r) => new RegExp(`(^|/)[^/]+/${n}(-|$)`).test(String(r)));
  return { ...base, estado: enRama ? 'en-curso' : 'abierta', accion: null, evidencia: null };
}

// Todas las tareas de una vez. 'resumen' es lo que se guarda en cache para la sesion y validate.
function reconciliar({ issues = [], prs = [], ramas = [] } = {}) {
  const evaluaciones = issues.filter((i) => i && !i.pull_request).map((i) => evaluarTarea(i, prs, { ramas }));
  const porCerrar = evaluaciones.filter((e) => e.accion === 'cerrar');
  const enBacklogHechas = evaluaciones.filter((e) => e.accion === 'mover-a-fase');
  const sinEvidencia = evaluaciones.filter((e) => e.estado === 'cerrada-sin-evidencia');
  const mencionadas = evaluaciones.filter((e) => e.estado === 'mencionada');
  return {
    evaluaciones, porCerrar, enBacklog: enBacklogHechas, sinEvidencia, mencionadas,
    resumen: {
      hechasSinCerrar: [...porCerrar, ...enBacklogHechas].map((e) => e.numero).sort((a, b) => a - b),
      sinEvidencia: sinEvidencia.map((e) => e.numero).sort((a, b) => a - b),
      mencionadas: mencionadas.map((e) => e.numero).sort((a, b) => a - b),
    },
  };
}

// Seccion '## <titulo>' del cuerpo de un PR (primer parrafo util), o null.
function seccionDe(cuerpo, ...titulos) {
  for (const t of titulos) {
    const m = String(cuerpo || '').match(new RegExp(`^#{1,4}\\s*${t}\\s*$([\\s\\S]*?)(?=^#{1,4}\\s|$(?![\\s\\S]))`, 'im'));
    const txt = m && m[1].trim().replace(/\s+/g, ' ');
    if (txt) return txt.length > 300 ? `${txt.slice(0, 300)}…` : txt;
  }
  return null;
}

// COMENTARIO DE CIERRE estandar: siempre la trazabilidad (PR, rama, commit, fecha); en un BUG,
// ademas 'Causa · Arreglo · Test', sacados del propio PR — si el PR no los describe, se DICE, no se
// inventan. 'version' se anade al publicar.
function comentarioDeCierre(e, { version = null } = {}) {
  const ev = (e && e.evidencia) || {};
  const lineas = [
    `Cerrada por el harness: el PR #${ev.pr}${ev.rama ? ` (\`${ev.rama}\`)` : ''} se integro en \`${ev.base || 'develop'}\`` +
      `${ev.fecha ? ` el ${ev.fecha}` : ''}${ev.commit ? `, commit \`${ev.commit}\`` : ''}.${version ? ` Publicada en v${version}.` : ''}`,
  ];
  if (e && e.bug) {
    const falta = `(sin describir en el PR #${ev.pr})`;
    lineas.push('', '**Causa · Arreglo · Test**',
      `- Causa: ${seccionDe(ev.cuerpo, 'Causa') || falta}`,
      `- Arreglo: ${seccionDe(ev.cuerpo, 'Arreglo') || ev.titulo || falta}`,
      `- Test: ${seccionDe(ev.cuerpo, 'Tests?', 'Test de regresion') || falta}`);
  }
  return lineas.join('\n');
}

// ESTADO.md: marca [x] las lineas '- [ ] #N ...' cuyo issue esta CERRADO (la forja manda). No toca
// nada mas: ni desmarca (eso lo señala validate como desajuste), ni lineas sin numero.
function marcarEnEstado(texto, cerrados) {
  const marcadas = [];
  const nuevo = String(texto).replace(/^([ \t]*-\s)\[ \](\s+#(\d+)\b)/gm, (m, pre, resto, n) => {
    if (!cerrados.has(Number(n))) return m;
    marcadas.push(Number(n));
    return `${pre}[x]${resto}`;
  });
  return { texto: nuevo, marcadas };
}

// BANDEJA DE ENTRADA (#84): lo que llega de fuera (bugs, features, sugerencias) entra SUELTO, sin hito,
// y se recupera por esa condicion, no por un hito ni por el canal: abiertos SIN HITO, mas cualquiera
// con la etiqueta 'reporte' ("llego de fuera, nadie ha decidido"). La doble condicion es a proposito:
// sale lo que manda Userback (etiquetado) y lo que alguien crea a mano en la web (sin nada). El tipo que
// traiga es una PISTA del canal, no una decision. La mas antigua primero: lo que mas lleva esperando.
const DEL_EQUIPO = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
function bandejaDeEntrada(issues, catalogo, ahora = Date.now()) {
  const { tipoDeEtiquetas } = require('./ciclo.js');
  const nombres = (i) => (i.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
  const esReporte = (i) => nombres(i).some((n) => n === 'reporte' || n === 'faro:reporte');
  return (issues || [])
    .filter((i) => i && !i.pull_request && i.state === 'open' && (!i.milestone || esReporte(i)))
    .map((i) => {
      const origen = nombres(i).map((n) => n.match(/^origen:(.+)$/)).find(Boolean);
      return {
        numero: i.number,
        titulo: i.title || '',
        tipo: tipoDeEtiquetas(nombres(i).filter((n) => !/^(faro:)?reporte$/.test(n)), catalogo),
        origen: origen ? origen[1] : null,
        votos: (i.reactions && i.reactions['+1']) || 0,
        comentarios: i.comments || 0,
        dias: i.created_at ? Math.floor((ahora - Date.parse(i.created_at)) / 86400000) : null,
        deFuera: !DEL_EQUIPO.has(String(i.author_association || '').toUpperCase()),
        url: i.html_url || null,
      };
    })
    .sort((a, b) => (b.dias || 0) - (a.dias || 0));
}

module.exports = { bandejaDeEntrada, issuesDePr, soloReferencia,evaluarTarea, reconciliar, comentarioDeCierre, marcarEnEstado, BASES_DE_ENTREGA, NOMBRE_BACKLOG };
