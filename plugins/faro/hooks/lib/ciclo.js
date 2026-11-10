// lib/ciclo.js — el issue AMPLIO y el cierre de su ciclo.
//
// El trabajo es agentico: un agente se come un bloque entero de una sentada, asi que la unidad
// natural es un issue amplio con sus subtareas DENTRO (checkboxes), no once issues de un rato que
// ensucian el hito y dejan ramas que nadie cierra. Y como del trabajo real siempre salen cosas que
// no estaban previstas, ese issue se AMPLIA en vez de partirse.
//
// La otra mitad: cuando el bloque termina, el ciclo debe cerrarse. El harness MARCABA [x] y ahi se
// paraba, pidiendo al humano que "revisara ESTADO.md y cerrara la fase". Aqui vive la deteccion de
// ese trabajo terminado que nunca salio de su rama.
'use strict';

const CAB = '## Subtareas';

// Normaliza para comparar: lo que importa es el texto, no si la caja esta marcada.
const textoDe = (linea) => String(linea).replace(/^\s*-\s*\[[ xX]\]\s*/, '').trim();

const lineasDeSubtarea = (cuerpo) =>
  String(cuerpo || '').split('\n').filter((l) => /^\s*-\s*\[[ xX]\]\s/.test(l));

// Cuerpo del issue con sus subtareas como checkboxes. Las subtareas son la ESTRUCTURA del issue
// amplio: se marcan ahi segun avanza, sin que cada una necesite su propio issue ni su propia rama.
// Mete subtareas DENTRO de la seccion '## Subtareas' si ya existe: tras la ultima casilla de esa
// seccion (no del cuerpo entero, que en la plantilla es 'Criterios') y quitando el marcador de
// ejemplo '- [ ] <paso>'. Devuelve null si el cuerpo no tiene la seccion.
function insertarEnSubtareas(txt, items) {
  const lineas = String(txt).split('\n');
  const ini = lineas.findIndex((l) => l.trim() === CAB);
  if (ini === -1) return null;
  let fin = lineas.findIndex((l, i) => i > ini && /^#{1,4}\s/.test(l));
  if (fin === -1) fin = lineas.length;
  for (let i = fin - 1; i > ini; i--) {
    if (/^\s*-\s\[[ xX]\]\s*<[^>]*>\s*$/.test(lineas[i])) { lineas.splice(i, 1); fin--; }
  }
  let ult = -1;
  for (let i = ini + 1; i < fin; i++) if (/^\s*-\s\[[ xX]\]\s/.test(lineas[i])) ult = i;
  const nuevas = items.map((s) => `- [ ] ${s}`);
  if (ult === -1) lineas.splice(lineas[ini + 1] !== undefined && lineas[ini + 1].trim() === '' ? ini + 2 : ini + 1, 0, ...nuevas);
  else lineas.splice(ult + 1, 0, ...nuevas);
  return lineas.join('\n');
}

function subtareasEnCuerpo(cuerpo, subtareas) {
  const lista = (subtareas || []).map((s) => String(s).trim()).filter(Boolean);
  if (!lista.length) return cuerpo;
  const dentro = insertarEnSubtareas(cuerpo || '', lista);
  if (dentro !== null) return dentro;
  const bloque = `${CAB}\n\n${lista.map((s) => `- [ ] ${s}`).join('\n')}`;
  return `${String(cuerpo || '').trimEnd()}${cuerpo ? '\n\n' : ''}${bloque}`;
}

// Amplia un issue existente con subtareas nuevas. Idempotente: no repite las que ya estan (mire como
// mire su caja) y no abre un segundo bloque si ya habia uno.
function ampliarCuerpo(cuerpo, nuevas) {
  const lista = (nuevas || []).map((s) => String(s).trim()).filter(Boolean);
  if (!lista.length) return cuerpo;
  const existentes = new Set(lineasDeSubtarea(cuerpo).map(textoDe));
  const faltan = lista.filter((s) => !existentes.has(s));
  if (!faltan.length) return cuerpo;
  const txt = String(cuerpo || '');
  // Con bloque, las nuevas van al final de SU seccion; sin el, se estrena.
  return insertarEnSubtareas(txt, faltan) ?? subtareasEnCuerpo(txt, faltan);
}

// Trabajo TERMINADO que no ha salido de su rama: la fase no tiene tareas abiertas, estas en una rama
// de trabajo y esa rama no se ha integrado. Es el hueco por el que se cuela el trabajo muerto —
// marcado como hecho en ESTADO.md pero invisible en la forja, con su issue abierto para siempre.
function cicloPendiente({ rama, fase, integrada }) {
  if (!rama || integrada || !fase) return null;
  if (!/^[^/]+\/.+/.test(rama)) return null;   // develop/main: no hay ciclo de rama que cerrar
  if (fase.open !== 0 || fase.done <= 0) return null;
  const m = rama.match(/^[^/]+\/(\d+)(?:-|$)/);
  const tarea = m ? ` (tarea #${m[1]})` : '';
  return `Fase ${fase.num} sin tareas abiertas (${fase.done}/${fase.done}) y la rama '${rama}'${tarea} NO se ha integrado: ` +
    'el trabajo esta hecho pero no ha salido. Cierralo con `harness.js terminar` (commitea lo que quede, valida y abre la peticion' +
    (m ? `, que cerrara la tarea #${m[1]} al integrarse` : '') +
    '), o seguira abierto y la fase sin cerrar indefinidamente.';
}

// El PLAN de 'terminar': que pasos tocan segun donde estes. Se decide aparte de ejecutarlo para
// poder fijarlo con tests y para poder ENSENARLO antes de tocar nada.
//
// Criterio de cuando negarse: solo cuando el ciclo ya esta cerrado (rama integrada, peticion ya
// abierta) o no existe (rama protegida). Que la fase tenga tareas abiertas NO bloquea: una rama
// cierra SU bloque, y la fase puede necesitar varios.
function planTerminar({ rama, sucio, integrada, publicada, fase, prAbierto }) {
  const no = (motivo) => ({ ok: false, motivo, pasos: [], avisos: [] });
  if (!rama || !/^[^/]+\/.+/.test(rama)) {
    return no(`'${rama || '(sin rama)'}' no es una rama de trabajo: no hay ciclo que cerrar. Abre una con \`harness.js rama <tipo> "<tema>"\`.`);
  }
  const ficheros = String(sucio || '').split('\n').map((s) => s.trim()).filter(Boolean);
  // 'integrada' compara commits: una rama recien creada, o una ya mergeada sobre la que se sigue
  // trabajando, da igualmente "integrada". Si hay trabajo sin commitear, el ciclo NO esta cerrado.
  if (integrada && !ficheros.length) return no(`La rama '${rama}' ya esta integrada en develop: el ciclo de esta rama ya se cerro.`);
  if (prAbierto) return no(`La rama '${rama}' ya tiene una peticion abierta: ${prAbierto}. Integrala con /faro:consolidar en vez de abrir otra.`);

  const avisos = [];
  const pasos = [];
  if (ficheros.length) pasos.push({ tipo: 'commit', ficheros });

  pasos.push({ tipo: 'validate' });

  const m = rama.match(/^[^/]+\/(\d+)(?:-|$)/);
  const issue = m ? m[1] : null;
  if (!issue) avisos.push(`La rama '${rama}' no esta anclada a ninguna tarea: la peticion no cerrara nada al integrarse.`);
  if (fase && fase.open > 0) {
    avisos.push(`La fase ${fase.num} se queda con ${fase.open} tarea(s) abierta(s): esta rama cierra su bloque, no la fase entera.`);
  }
  // Titulo legible a partir del slug de la rama: 'feat/4-mockup-ui-informe' -> 'mockup ui informe'.
  const slug = rama.replace(/^[^/]+\//, '').replace(/^\d+-/, '').replace(/-/g, ' ').trim();
  pasos.push({ tipo: 'pr', titulo: slug || rama, issue, publicada: !!publicada });
  return { ok: true, motivo: null, pasos, avisos };
}

// El cambio spec-driven y su ejecucion en la forja eran dos mundos sueltos: el proposal conocia su
// fase y sus tareas de ESTADO.md, pero no QUE issue lo ejecuta. Con 'issue:' en el frontmatter, el
// estado del cambio ya no puede ir por delante del de su issue.
//
// Deliberadamente permisivo en dos sitios: sin 'issue:' declarado no hay nada que contrastar (el
// campo es opcional), y si no se pudo CONSULTAR el issue (sin red, sin token) tampoco se bloquea —
// convertir "no pude mirar" en "esta mal" dejaria el trabajo parado por estar sin conexion.
function coherenciaCambioIssue({ slug, estado, issue, issueEstado, archivando }) {
  if (!issue || issueEstado !== 'open') return null;
  if (estado !== 'implementada') return null;   // borrador/aprobada con issue vivo = trabajo en curso
  const que = archivando ? `NO se puede archivar el cambio '${slug}'` : `el cambio '${slug}' esta 'implementada'`;
  return `${que}: su tarea #${issue} sigue ABIERTA. Archivar es declarar el trabajo terminado, y los checkboxes ` +
    'marcados no son evidencia de que haya salido. Cierra el ciclo con `harness.js terminar` (abre la peticion, ' +
    `que cierra la tarea al integrarse) o, si ya esta hecho fuera, \`harness.js cerrar-tarea ${issue}\`.`;
}

// CIERRE ACTIVO de la tarea cuyo trabajo ya esta en develop. El 'Closes #N' de la peticion es la red
// primaria; esto es la de seguridad, para las ramas que se integraron por otra via.
//
// La clave esta en NO confundir los tres estados. 'no pude consultar' (null: sin red, token caducado,
// rate limit) se trataba igual que 'ya cerrada': un 'continue' silencioso que dejaba la tarea ABIERTA
// para siempre sin que nadie se enterara. Son cosas distintas y se responden distinto:
//   - abierta          -> cerrarla (su trabajo ya salio)
//   - cerrada          -> nada, y EN SILENCIO: es lo normal, anunciarlo seria ruido
//   - no se pudo mirar -> NO cerrarla, pero DECIRLO: quedarse callado es el fallo
//
// Ante un estado inesperado se avisa, nunca se da por cerrada: dar por cerrada una tarea viva es el
// error caro (el trabajo desaparece del radar); avisar de mas solo cuesta una linea.
function planCierreDeTarea({ issue, estado, rama, soloReferencia = false }) {
  const nada = { accion: 'nada', aviso: null, motivo: null };
  if (!issue) return nada;   // rama sin anclar: ya se avisa al abrir la peticion, no se repite aqui
  if (estado === 'closed') return nada;
  // Su PR dice 'Refs #N' (#91): la rama avanza la tarea, no la termina. Se respeta y se dice.
  if (soloReferencia) return { ...nada, nota: `La tarea #${issue} sigue abierta: el PR de \`${rama}\` dice 'Refs #${issue}' (la avanza, no la termina).` };
  if (estado === 'open') {
    return { accion: 'cerrar', aviso: null, motivo: `Integrada en develop con la rama \`${rama}\` (consolidacion).` };
  }
  return {
    accion: 'avisar',
    motivo: null,
    aviso: `no pude consultar el estado de la tarea #${issue} (¿sin red, token caducado o limite de la API?): ` +
      `NO la doy por cerrada. Su trabajo ya esta en develop con la rama \`${rama}\`. ` +
      `Reintenta la consolidacion cuando vuelva la conexion, o cierrala a mano: harness.js cerrar-tarea ${issue}`,
  };
}

// ESTRUCTURA del issue. Un issue tiene que ser AUTOCONTENIDO: quien lo coge (persona o agente) debe
// poder ejecutarlo sin reconstruir el contexto a base de preguntar. Con un agente esto no es un lujo
// — no hay dialogo de ida y vuelta: lee los criterios LITERALMENTE y rellena los huecos suponiendo.
// Por eso 'Fuera de alcance' pesa tanto como 'Alcance': es lo que evita que se expanda solo.
//
// Secciones comunes a los tres tipos; lo que cambia es el acento (un bug se reproduce, un
// requerimiento sirve a alguien, una tarea entrega algo).
const SECCIONES = ['Objetivo', 'Contexto', 'Alcance', 'Fuera de alcance', 'Criterios de aceptacion'];

// PLANTILLA ESTANDAR POR TIPO (#74): sale del CONTRATO (faro-schema.json > enums.plantillas_issue),
// no del codigo. Cada tipo es una lista ordenada de secciones {titulo, marcador, obligatoria}; los
// 'alias' mapean variantes (hotfix -> bug) y los 'exento' (reporte, duplicado, descartado) no llevan
// plantilla ni exigencia. Si el contrato no esta, se usa la generica de aqui: nunca se rompe.
const GENERICA = [
  { titulo: 'Objetivo', marcador: '<que se consigue con esto, en una frase>', obligatoria: true },
  { titulo: 'Contexto', marcador: '<que leer primero: ficheros, spec, decision previa>', obligatoria: true },
  { titulo: 'Alcance', marcador: '- <que entra>', obligatoria: true },
  { titulo: 'Fuera de alcance', marcador: '- <que NO entra, para que nadie lo amplie por su cuenta>', obligatoria: true },
  { titulo: 'Subtareas', marcador: '- [ ] <paso>', obligatoria: false },
  { titulo: 'Criterios de aceptacion', marcador: '- [ ] <observable desde fuera: al hacer X, ocurre Y — nunca detalle de implementacion>', obligatoria: true },
];
let _plantillas;
function plantillasDef() {
  if (_plantillas === undefined) {
    try { _plantillas = (require('../faro-schema.json').enums || {}).plantillas_issue || null; } catch { _plantillas = null; }
  }
  return _plantillas;
}
// Secciones del tipo: lista (propia o generica) o null si el tipo esta EXENTO.
function seccionesDeTipo(tipo) {
  const P = plantillasDef() || {};
  const t = String(tipo || '').toLowerCase();
  const clave = P[t] ? t : Object.keys(P).find((k) => !k.startsWith('_') && (P[k].alias || []).includes(t));
  const def = clave ? P[clave] : null;
  if (def && def.exento) return null;
  return (def && def.secciones) || P._generica || GENERICA;
}

// Regex de la cabecera de una seccion, aceptando sus 'alias' (#134): 'Comportamiento obtenido' (lo que
// manda Userback y llevan los bugs anteriores) cuenta como 'Comportamiento actual'.
function reSeccion(s) {
  const titulos = typeof s === 'string' ? [s] : [s.titulo, ...((s && s.alias) || [])];
  return new RegExp(`^#{1,4}\\s*(?:${titulos.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})\\s*$`, 'im');
}

function plantillaIssue(tipo) {
  const secs = seccionesDeTipo(tipo);
  if (!secs) return '';
  return secs.map((s) => `## ${s.titulo}\n\n${s.marcador}\n`).join('\n');
}

// COMPLETAR SIN REESCRIBIR (#84): si el cuerpo ya trae secciones de la plantilla (lo que manda un canal
// como Userback: Comportamiento obtenido, Evidencia, Entorno...), se conservan TAL CUAL y solo se anaden
// las que faltan, en el orden de la plantilla, antes del pie ('---'). null si no trae ninguna seccion de
// FARO: el llamador pone la plantilla entera. Un tipo exento no se toca.
function completarPlantilla(cuerpo, tipo) {
  const secs = seccionesDeTipo(tipo);
  const txt = String(cuerpo || '');
  if (!secs) return cuerpo;
  const tiene = (s) => reSeccion(s).test(txt);
  if (!secs.some((s) => tiene(s))) return null;
  const faltan = secs.filter((s) => !tiene(s));
  if (!faltan.length) return cuerpo;
  const bloque = faltan.map((s) => `## ${s.titulo}\n\n${s.marcador}\n`).join('\n');
  const pie = txt.search(/^---\s*$/m);
  if (pie === -1) return `${txt.replace(/\s+$/, '')}\n\n${bloque}`;
  return `${txt.slice(0, pie).replace(/\s+$/, '')}\n\n${bloque}\n${txt.slice(pie)}`;
}

// TIPO de un issue a partir de sus etiquetas (#81): la de FARO ('mejora' o 'faro:mejora') o la NATIVA
// de GitHub que el catalogo le asigna en su campo 'github' ('enhancement'). Los transversales
// (urgente, riesgo...) no son tipo. Un solo sitio: la plantilla y los huecos dependen de acertar.
function tipoDeEtiquetas(etiquetas, catalogo) {
  const ns = (etiquetas || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
  const def = (catalogo || []).find((l) => l && !l.transversal && ns.some((n) => n === l.slug || n === `faro:${l.slug}` || (l.github && n === l.github)));
  return def ? def.slug : null;
}

// Que le FALTA a un issue para ser ejecutable. Devuelve la lista de huecos (vacia = completo).
// Con tipo, exige las secciones OBLIGATORIAS de su plantilla; sin tipo, las comunes.
function huecosDeIssue(cuerpo, tipo) {
  const txt = String(cuerpo || '');
  const huecos = [];
  const defs = tipo === undefined || tipo === null ? SECCIONES : (seccionesDeTipo(tipo) || []).filter((s) => s.obligatoria);
  for (const d of defs) {
    const sec = typeof d === 'string' ? d : d.titulo;
    const re = reSeccion(d);
    if (!re.test(txt)) { huecos.push(`falta la seccion '${sec}'`); continue; }
    // La seccion existe: ¿tiene algo dentro? Una cabecera vacia engana mas que no ponerla.
    const desde = txt.search(re);
    const resto = txt.slice(desde).split('\n').slice(1);
    const fin = resto.findIndex((l) => /^#{1,4}\s/.test(l));
    const dentro = (fin === -1 ? resto : resto.slice(0, fin)).join('\n').trim();
    if (!dentro) huecos.push(`la seccion '${sec}' esta vacia`);
  }
  return huecos;
}

// REPARTO: ESTADO.md resume (que se pretende en la fase + una linea por entregable con su id y quien
// lo hace) y el issue guarda TODO el detalle. Lo duplicado se desincroniza — un checkbox marcado con
// su issue abierto fue justo lo que paso —, asi que ESTADO.md referencia en vez de repetir.
function refDeTarea(linea) {
  const txt = String(linea || '').replace(/^\s*-\s*\[[ xX]\]\s*/, '').trim();
  // Dos formas validas de anotar la tarea: '#4' y el marcador '[gh:4]' / '[gl:4]' (el mismo estilo
  // que '[cu:...]' de ClickUp). Reconocer las dos evita pelearse con una convencion razonable.
  const mI = txt.match(/#(\d+)/) || txt.match(/\[g[hl]:(\d+)\]/i);
  const mQ = txt.match(/\[resp:\s*([^\]]+)\]/i) || txt.match(/@([A-Za-z0-9][\w.-]*)/);
  return {
    issue: mI ? mI[1] : null,
    quien: mQ ? mQ[1].trim() : null,
    // El separador tras el id ('#4 · Titulo') se quita tambien: si no, el titulo empieza por '·' y
    // cualquier analisis posterior (p. ej. detectar un verbo inicial) falla sin que se note.
    titulo: txt.replace(/#\d+\s*/, '').replace(/\[g[hl]:\d+\]/i, '').replace(/\[resp:[^\]]*\]/i, '').replace(/[—-]\s*@[\w.-]+/, '').replace(/@[\w.-]+/, '').replace(/^[·\-—:]\s*/, '').trim(),
  };
}

// Verbos de PASO: los que delatan que se ha troceado de mas. No es lo mismo 'Traducir subtitle' (un
// rato, no entrega nada por si solo) que 'Personalizacion e identidad' (un bloque con sentido).
const VERBOS_PASO = /^(traducir|renombrar|configurar|anadir|añadir|poner|quitar|borrar|mover|cambiar|ajustar|actualizar|crear|instalar|copiar|subir|corregir|arreglar)\b/i;

// Un titulo atomico es sintoma, no delito: sirve para AVISAR al crear la tarea, nunca para bloquear.
// Se afina con la longitud — un verbo de paso con un alcance amplio detras si entrega algo.
//
// EXENTOS los tipos que SURGEN: un bug que llega es un bug y ya esta. No se agrupa ni se fuerza a ser
// amplio — se arregla y se cierra. Agrupar solo tiene sentido en lo que se PLANIFICA, donde el
// troceo es una decision; en lo que aparece, el alcance lo fija el propio hallazgo.
const TIPOS_QUE_SURGEN = /^(bug|bugfix|hotfix|fix|infra|pregunta|question)$/i;

function tituloAtomico(titulo, tipo) {
  if (tipo && TIPOS_QUE_SURGEN.test(String(tipo))) return false;
  const t = String(titulo || '').trim();
  if (!t || !VERBOS_PASO.test(t)) return false;
  const palabras = t.split(/\s+/).length;
  return palabras <= 4;   // 'Traducir common.subtitle' si; 'Implementar el mockup completo del informe' no
}

// La fase ES el hito, y su formato en ESTADO.md debe estar GARANTIZADO, no confiado a que alguien
// recuerde la convencion:
//
//   ### Fase N · <nombre> — <estado>
//   <descripcion: que trae la fase>
//   - [ ] #<id> · <titulo GENERAL> — @<quien>
//
// Una fase CERRADA no se audita: es historico, y reescribirlo seria falsear lo que paso.
//
// 'draft': la fase existe en el papel pero su hito TODAVIA no se ha creado en la forja (onboarding,
// antes de 'hito sync'). El onboarding pide escribir el faseo SIN #N, y esos ids solo existen
// DESPUES de integrar esa misma rama y correr 'hito sync' -- exigirlos antes es una dependencia
// circular (no se puede pasar 'validate' del PR de arranque sin #N, y no hay #N sin ese PR ya
// integrado). #N y @quien dependen de la forja: se eximen. Descripcion y tareas NO dependen de la
// forja: se siguen exigiendo igual que en cualquier fase abierta.
function huecosDeFase(fase) {
  if (!fase || /^(done|closed)$/i.test(String(fase.estado || ''))) return [];
  const esDraft = /^draft$/i.test(String(fase.estado || ''));
  const huecos = [];
  if (!String(fase.descripcion || '').trim()) {
    huecos.push(`Fase ${fase.num}: falta la descripcion (que trae esta fase) — sin ella la fase es solo un titulo.`);
  }
  // La FECHA no depende del hito (ESTADO.md manda, 'hito sync' solo la copia a due_on) -- se exige
  // tambien en 'draft'. NO es rigida en su VALOR: se reajusta libremente si cambia el alcance o
  // surgen imprevistos ('hito sync' actualiza el hito cuando 'Objetivo:' difiere). Lo que no se
  // acepta es que FALTE: sin ella nadie sabe cuando se espera la fase, y el vencimiento del hito
  // queda vacio en silencio (nadie avisa de una fecha que nunca se puso).
  if (!String(fase.objetivo || '').trim()) {
    huecos.push(`Fase ${fase.num}: falta 'Objetivo: AAAA-MM-DD' — sin fecha nadie sabe cuando se espera la fase (se reajusta libremente despues si cambia el alcance).`);
  }
  const tareas = fase.tareas || [];
  if (!tareas.length) {
    huecos.push(`Fase ${fase.num}: no declara ninguna tarea — una fase sin entregables no se puede planificar ni contabilizar.`);
    return huecos;
  }
  // AGRUPADO por fase: una linea por problema con el recuento, no dos por tarea. Un ESTADO.md con 11
  // tareas sueltas generaba 22 avisos y el ruido tapaba el mensaje.
  const corto = (s) => (s.length > 40 ? `${s.slice(0, 40)}...` : s);
  const refs = tareas.map((t) => refDeTarea(t.text));
  const sinId = refs.filter((r) => !r.issue);
  const sinQuien = refs.filter((r) => !r.quien);
  const atomicas = refs.filter((r) => tituloAtomico(r.titulo));
  if (!esDraft && sinId.length) {
    huecos.push(`Fase ${fase.num}: ${sinId.length}/${refs.length} tarea(s) SIN id de tarea (#N) — no estan en la forja, nadie las ve ni las puede cerrar: ` +
      `${sinId.slice(0, 3).map((r) => `'${corto(r.titulo)}'`).join(', ')}${sinId.length > 3 ? ` y ${sinId.length - 3} mas` : ''}. Creala con 'asignar-tarea ... --hito ${fase.num}' y anota su #N aqui.`);
  }
  if (!esDraft && sinQuien.length) huecos.push(`Fase ${fase.num}: ${sinQuien.length}/${refs.length} tarea(s) SIN responsable (@usuario) — nadie las hace.`);
  if (atomicas.length) {
    huecos.push(`Fase ${fase.num}: ${atomicas.length} tarea(s) parecen un PASO, no un entregable (${atomicas.slice(0, 3).map((r) => `'${corto(r.titulo)}'`).join(', ')}). ` +
      'El titulo va GENERAL y el detalle DENTRO del issue como subtareas — asi el agente puede ademas anadir lo que encuentre por el camino, sin abrir tareas nuevas.');
  }
  return huecos;
}

// Que trae la fase, en numeros. 'estados' (opcional) es {id: 'open'|'closed'} leido de la forja: con
// el se separan abiertos de cerrados y, sobre todo, se delatan los DESAJUSTES — un checkbox marcado
// cuyo issue sigue abierto es trabajo que se dio por hecho sin salir.
function contabilidadFase(fase, estados) {
  const tareas = (fase && fase.tareas) || [];
  const refs = tareas.map((t) => ({ ...refDeTarea(t.text), done: !!t.done }));
  const c = {
    total: refs.length,
    hechas: refs.filter((r) => r.done).length,
    conIssue: refs.filter((r) => r.issue).length,
    conResponsable: refs.filter((r) => r.quien).length,
    sinIssue: refs.filter((r) => !r.issue).map((r) => r.titulo),
    abiertos: null, cerrados: null, desajustes: [],
  };
  if (!estados) return c;
  c.abiertos = 0; c.cerrados = 0;
  for (const r of refs) {
    const est = r.issue ? estados[r.issue] : null;
    if (est === 'open') c.abiertos++;
    else if (est === 'closed') c.cerrados++;
    if (r.done && est === 'open') c.desajustes.push(`#${r.issue} '${r.titulo}' esta marcada [x] pero su tarea sigue ABIERTA en la forja.`);
    if (!r.done && est === 'closed') c.desajustes.push(`#${r.issue} '${r.titulo}' esta CERRADA en la forja pero sigue sin marcar [x].`);
  }
  return c;
}

// CERRAR UNA FASE es una ceremonia, y era el unico hueco del ciclo sin cablear: cuatro pasos
// manuales (marcar checkbox, escribir el informe, editar ESTADO.md, tagear) que 'publicar' terminaba
// pidiendo al humano. Aqui se decide SI se puede y QUE falta; ejecutarlo es cosa del comando.
//
// Se NIEGA con motivo, nunca con un "no se puede" seco: quien cierra una fase necesita saber que le
// falta, no que lo intente otra vez a ciegas. Y acumula TODO lo que falta de una pasada, para no
// mandar a alguien a arreglar una cosa y que al volver aparezca la siguiente.
//
// 'desajustes' viene de desajustesDelFaseo (la forja): el checkbox marcado NO es evidencia de que el
// trabajo saliera. Si no se pudo consultar la forja llega vacio, y entonces no bloquea — quedarse sin
// conexion no puede impedir gobernar el faseo.
function planCerrarFase({ fase, informe, desajustes, siguiente, dirInformes = 'gestion/reporting/informes' }) {
  const faltan = [];
  if (!fase) return { ok: false, faltan: ['no hay ninguna fase con ese numero en ESTADO.md.'], faseActual: null };
  if (/^(done|closed)$/i.test(String(fase.estado || ''))) {
    return { ok: false, faltan: [`la fase ${fase.num} ya esta cerrada (${fase.estado}): una fase cerrada es historico y no se reescribe.`], faseActual: null };
  }
  if (fase.open > 0) {
    faltan.push(`la fase ${fase.num} tiene ${fase.open} tarea(s) abierta(s) sin marcar: cierralas antes (o muevelas a otra fase con 'mover-tarea <N> --hito <M>').`);
  }
  if (!informe) {
    faltan.push(`falta el informe de cierre: crea '${dirInformes}/AAAA-MM-DD-fase-${fase.num}-informe.md' (lo redacta /faro:reportar). Sin informe, nadie sabra que entrego esta fase.`);
  }
  for (const d of (desajustes || [])) {
    faltan.push(`${d} El checkbox no es evidencia de que el trabajo saliera: cuadralo antes de cerrar.`);
  }
  return { ok: faltan.length === 0, faltan, faseActual: faltan.length === 0 ? (siguiente ?? null) : null };
}

// QUE CAMBIO desde la ultima vez que se miro. 'desajustesDelFaseo' dice que NO CUADRA, pero no puede
// decir POR QUE: solo ve una foto. Y los dos casos posibles son OPUESTOS —trabajo hecho sin registrar
// vs. registro sin trabajo— y con una sola foto se ven iguales.
//
// Solo se apuntan CAMBIOS, no cada lectura: registrar "seguia igual" en cada consulta llenaria el
// fichero de ruido que nadie mira (el antipatron del TODO, mudado de sitio). Asi crece al ritmo del
// trabajo real.
//
// Un issue visto por primera vez NO es un cambio: no habia con que comparar. Y uno que deja de
// consultarse tampoco — puede haber salido del faseo, o no haberse podido consultar; afirmar que
// "cambio" seria inventar.
function cambiosObservados(anterior, actual) {
  if (!anterior || !actual) return [];
  const out = [];
  for (const [issue, estado] of Object.entries(actual)) {
    const antes = anterior[issue];
    if (antes === undefined) continue;   // primera vez que se ve: no hay cambio que contar
    if (antes !== estado) out.push({ issue: String(issue), de: antes, a: estado });
  }
  return out;
}

// EXPLICA un desajuste concreto, usando la historia si la hay. Devuelve null cuando no hay nada que
// contar: si cuadra, o si no se pudo consultar la forja (no saber no es un hallazgo).
//
// La diferencia entre los dos casos no es de matiz, es de fondo:
//   - cerrado en la forja y sin marcar  -> el trabajo SALIO, falta registrarlo
//   - marcado y abierto en la forja     -> el trabajo NO ha salido, el registro miente
// Por eso cada uno se lee distinto y pide una accion distinta.
function explicarDesajuste({ issue, titulo, marcado, estadoForja, cambio }) {
  if (!estadoForja) return null;                        // no se pudo mirar: no se afirma nada
  if (marcado && estadoForja === 'closed') return null;  // cuadra
  if (!marcado && estadoForja === 'open') return null;   // cuadra
  const cuando = cambio && cambio.cuando ? ` el ${String(cambio.cuando).slice(0, 10)}` : '';
  if (!marcado && estadoForja === 'closed') {
    return `#${issue} '${titulo}' se cerro en la forja${cuando}${cambio ? ' (cambio detectado desde la ultima revision)' : ''} ` +
      'pero su checkbox sigue sin marcar: el trabajo salio y el faseo no lo refleja. Marcalo en ESTADO.md.';
  }
  // marcado && open
  return `#${issue} '${titulo}' esta marcada [x] pero su tarea sigue ABIERTA en la forja${cuando}: ` +
    'el trabajo se dio por hecho sin salir. Cierra el ciclo (`harness.js terminar`) o desmarca el checkbox.';
}

// Lo que NO cuadra entre ESTADO.md y la forja, en TODO el faseo. Es lo que 'consolidar' y 'publicar'
// enseñan: los dos momentos donde el desajuste aun se puede corregir a tiempo.
//
// Solo fases ABIERTAS: una fase cerrada es historico (mismo criterio que huecosDeFase) y sus issues
// ya no se tocan, asi que avisar de ella no serviria para nada.
//
// 'estados' se INYECTA ({id: 'open'|'closed'}, lo que la forja haya contestado): sin el —sin token,
// sin red, sin forja— no se inventa ningun desajuste. Convertir "no pude mirar" en "esta mal" dejaria
// el trabajo parado por estar sin conexion. Un issue que no se pudo consultar simplemente no aparece.
function desajustesDelFaseo(fases, estados) {
  if (!estados || !fases || !fases.length) return [];
  // La API devuelve los ids como NUMERO y el checkbox los trae como STRING ('#4'): sin normalizar,
  // el lookup falla siempre y el aviso queda mudo para siempre sin que nadie lo note.
  const porId = {};
  for (const [k, v] of Object.entries(estados)) porId[String(k)] = v;
  const out = [];
  for (const f of fases) {
    if (/^(done|closed)$/i.test(String((f && f.estado) || ''))) continue;
    for (const d of contabilidadFase(f, porId).desajustes) out.push(`Fase ${f.num}: ${d}`);
  }
  return out;
}

// RELEASE BAJO DEMANDA — 'cerrar el ciclo' y 'publicar' son actos distintos.
//
// main no significa "trabajo terminado", significa PRODUCCION: puede agrupar varios ciclos y se
// publica cuando lo decide quien manda. Cada ciclo cierra del todo en develop y deja su nota en
// [Unreleased]; al publicar, ese bloque pasa a ser la version. Es el estandar Keep a Changelog y el
// mismo patron del "release PR" (release-please) o de changesets: releases INTENCIONALES, no una por
// cada cosa que se integra. Publicar NO se automatiza: se invoca, con registro de desde donde.
const RE_UNRELEASED = /^##\s*\[?Unreleased\]?\s*$/im;

// Lo acumulado por los ciclos y aun sin publicar (texto entre [Unreleased] y la siguiente version).
function leerUnreleased(changelog) {
  const txt = String(changelog || '');
  const m = txt.match(RE_UNRELEASED);
  if (!m) return '';
  const desde = txt.indexOf(m[0]) + m[0].length;
  const resto = txt.slice(desde);
  const sig = resto.search(/^##\s+/m);
  return (sig === -1 ? resto : resto.slice(0, sig)).trim();
}

// Publicar: [Unreleased] pasa a ser '## <version> - <fecha>' y la seccion queda vacia para el
// siguiente ciclo. Sin nada acumulado NO se inventa una version vacia — publicar nada no es publicar.
function promoverUnreleased(changelog, version, fecha) {
  const txt = String(changelog || '');
  const m = txt.match(RE_UNRELEASED);
  if (!m || !leerUnreleased(txt)) return txt;
  const cab = m[0];
  const desde = txt.indexOf(cab);
  const finCab = desde + cab.length;
  const resto = txt.slice(finCab);
  const sig = resto.search(/^##\s+/m);
  const acumulado = (sig === -1 ? resto : resto.slice(0, sig)).trim();
  const cola = sig === -1 ? '' : resto.slice(sig);
  return `${txt.slice(0, desde)}${cab}\n\n## ${version} - ${fecha}\n\n${acumulado}\n\n${cola}`;
}

// ANALISIS del release: que se va a publicar, desde donde, y que version toca. Publicar a mano sin
// esto es a ciegas — nadie sabe cuantos ciclos lleva acumulados ni desde cuando. Convierte el
// release de un merge en una decision informada.
function analizarRelease({ ultimoTag, commits, unreleased, versionActual }) {
  const cs = (commits || []).filter(Boolean);
  const acumulado = String(unreleased || '').trim();
  if (!cs.length && !acumulado) {
    return { hayQuePublicar: false, motivo: 'No hay nada acumulado desde el ultimo release: sin cambios que publicar.', desde: ultimoTag || 'el inicio', ciclos: 0, sugerida: versionActual };
  }
  // SemVer por el contenido, no por el numero de commits: lo que manda es si algo ROMPE, si aporta
  // funcionalidad o si solo corrige.
  const rompe = cs.some((c) => /^[a-z]+(\([^)]*\))?!:/i.test(c) || /BREAKING[ -]CHANGE/i.test(c));
  const feat = cs.some((c) => /^feat(\([^)]*\))?!?:/i.test(c));
  const partes = (v) => String(v || '0.0.0').replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [ma, mi, pa] = partes(versionActual);
  // Si la version DECLARADA ya se subio y no tiene tag (va por delante del ultimo, o no hay ninguno),
  // ESA es la del release: el tag sale de ella (#69). Sumar encima sugeria una version que nadie iba
  // a publicar. Solo si ya esta tageada toca el siguiente salto por contenido.
  const [ta, ti, tp] = partes(ultimoTag);
  const declarada = String(versionActual || '0.0.0') !== '0.0.0'
    && (!ultimoTag || ma > ta || (ma === ta && (mi > ti || (mi === ti && pa > tp))));
  const salto = rompe ? `${ma + 1}.0.0` : feat ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
  const sugerida = declarada ? String(versionActual).replace(/^v/, '') : salto;
  return {
    hayQuePublicar: true,
    motivo: null,
    desde: ultimoTag || 'el inicio del repo (primer release)',
    ciclos: cs.length,
    commits: cs,
    sugerida,
    razon: declarada ? 'es la version declarada, ya subida y sin publicar'
      : rompe ? 'hay un cambio que ROMPE compatibilidad (MAJOR)' : feat ? 'hay funcionalidad nueva (MINOR)' : 'solo correcciones y mantenimiento (PATCH)',
    acumulado,
  };
}

// LIGADURA cambio <-> decision (ADR de gestion/decisions/). El proposal dice el QUE; el ADR, el POR
// QUE tecnico — que enfoque se eligio y contra cuales. Sin enlace entre los dos, ese razonamiento se
// pierde y quien retoma el trabajo (persona o agente) lo reinventa, o peor: lo contradice sin saberlo.
//
// RIGIDO donde importa: si el cambio toca codigo, la decision es OBLIGATORIA. Si es documental u
// organizativo no aplica — no toda edicion arrastra una decision de arquitectura.
function coherenciaCambioDecision({ slug, decision, tocaCodigo, decisionesExistentes }) {
  if (!tocaCodigo) return null;
  const hay = decisionesExistentes || [];
  if (!decision) {
    const ejemplos = hay.length ? ` Las que hay: ${hay.slice(0, 3).join(', ')}${hay.length > 3 ? ` (+${hay.length - 3})` : ''}.` : '';
    return `el cambio '${slug}' toca codigo pero NO cita la decision que lo respalda: anade 'decision: <fichero>' a su proposal.md. ` +
      `El QUE va en el proposal y el POR QUE tecnico en gestion/decisions/AAAA-MM-DD-<decision>.md (ADR: status, deciders).${ejemplos} ` +
      'Sin ese enlace, el enfoque elegido se pierde y el siguiente que lo toque lo reinventa.';
  }
  // Cita tolerante: admite el nombre completo, sin extension y sin la fecha ('usar-tanstack').
  const q = String(decision).replace(/\.md$/i, '').toLowerCase();
  const coinciden = hay.filter((f) => {
    const n = f.replace(/\.md$/i, '').toLowerCase();
    return n === q || n.replace(/^\d{4}-\d{2}-\d{2}-/, '') === q;
  });
  if (!coinciden.length) {
    return `el cambio '${slug}' cita la decision '${decision}' pero NO existe en gestion/decisions/. ` +
      `Crea el ADR o corrige la cita.${hay.length ? ` Las que hay: ${hay.slice(0, 3).join(', ')}.` : ''}`;
  }
  if (coinciden.length > 1) {
    return `el cambio '${slug}' cita '${decision}', pero coinciden ${coinciden.length} decisiones (${coinciden.join(', ')}): ` +
      'usa el nombre completo con su fecha. No elijo yo cual.';
  }
  return null;
}

// TRAZABILIDAD requisito -> evidencia. 'validate' comprobaba que los documentos fueran coherentes
// entre si, pero no que el CODIGO cumpla lo que la spec dice: se podian tener specs impecables y una
// implementacion que no las respeta.
//
// Juzgar la semantica ("¿este codigo hace lo que el requisito pide?") no es determinista — eso lo
// hace 'revisor-code' con criterio. Lo determinista, y lo que faltaba, es exigir EVIDENCIA: un
// requisito que ningun test cita no esta demostrado. Mismo principio que 'hito auditar' con las
// tareas, aplicado a los requisitos: se DEMUESTRAN, no se declaran.
// La evidencia se DECLARA en el propio requisito ('Evidencia: <ruta>'), no se adivina. Inferirla
// buscando el nombre del requisito dentro de los tests daba 46/47 sin evidencia en el propio motor:
// nadie titula un test 'Las operaciones de plataforma se eligen por forja'. Un criterio que obliga a
// renombrar tests para contentarlo no mide nada.
const RE_EVIDENCIA = /^\s*[*_]*\s*(?:Evidencia|Evidence)\s*[*_]*\s*:\s*(.+)$/im;

function evidenciaDeclarada(cuerpo) {
  const m = String(cuerpo || '').match(RE_EVIDENCIA);
  if (!m) return [];
  // La negrita de cierre ('**Evidencia:** x') queda en el valor si no se limpia aqui.
  return m[1].split(',').map((s) => s.trim().replace(/^[`'"*_\s]+|[`'"*_\s]+$/g, '')).filter(Boolean);
}

// 'existe' inyectado (no se toca el disco aqui): asi esto es puro y testeable.
function requisitosSinEvidencia(requisitos, existe) {
  const reqs = requisitos || [];
  const sin = [];
  for (const r of reqs) {
    const ev = r.evidencia || [];
    if (!ev.length) {
      sin.push(`requisito '${r.name}' (capacidad '${r.capacidad}') NO declara evidencia: anade una linea ` +
        "'Evidencia: <ruta del test que lo demuestra>' bajo el requisito. Un requisito se DEMUESTRA, no se declara.");
      continue;
    }
    const rotas = ev.filter((f) => !existe(f));
    if (rotas.length) {
      sin.push(`requisito '${r.name}' (capacidad '${r.capacidad}') declara evidencia que NO existe: ${rotas.join(', ')}. ` +
        'Corrige la ruta o escribe el test que falta.');
    }
  }
  return sin;
}

module.exports = { completarPlantilla, tipoDeEtiquetas, subtareasEnCuerpo, ampliarCuerpo, cicloPendiente, planTerminar, coherenciaCambioIssue, planCierreDeTarea, planCerrarFase, plantillaIssue, huecosDeIssue, refDeTarea, tituloAtomico, huecosDeFase, contabilidadFase, desajustesDelFaseo, cambiosObservados, explicarDesajuste, leerUnreleased, promoverUnreleased, analizarRelease, coherenciaCambioDecision, requisitosSinEvidencia, evidenciaDeclarada };
