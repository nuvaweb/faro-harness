// lib/triaje.js — JUICIO sobre lo que llega de fuera (reportes, peticiones, ideas).
//
// Por que existe: clasificar un reporte en bug/idea/sugerencia no decide nada. La pregunta cara no
// es "que es esto", es "MERECE LA PENA hacerlo, y por que si o por que no". Sin esa segunda
// pregunta escrita, el Backlog se llena de cosas que nadie descarta nunca porque descartar sin
// motivo se siente arbitrario — y un backlog que solo crece deja de leerse.
//
// La regla dura: el veredicto se justifica CONTRA ALGO ESCRITO, no contra la opinion del agente.
// Lo escrito son tres cosas, por orden de fuerza:
//   1. el FUERA DE ALCANCE del funcional  -> exclusion explicita: alguien decidio que esto no entra
//   2. los requisitos (gestion/requisitos.md, REQ-NN con estado)
//   3. las decisiones (gestion/decisions/, ADR con status)
// El fuera de alcance manda porque es lo unico que dice que NO de forma deliberada. Un funcional
// describe lo que el producto HACE; sin un apartado que diga lo que NO hace, casi todo reporte cae
// en 'sin-criterio' y el triaje devuelve el trabajo en vez de ahorrarlo.
// Si no hay nada escrito que aplique, el veredicto NO es "no aplica": es 'sin-criterio', y lo que
// falta es una decision por tomar. Esa tercera salida impide que el agente invente criterio para no
// quedarse callado.
//
// Los tres veredictos:
//   aplica       -> encaja con un requisito aceptado / una decision vigente. Se dice con cual.
//   no-aplica    -> lo excluye algo escrito (requisito descartado, ADR que decidio lo contrario,
//                   o es una peticion individual sin respaldo de requisito). Se CITA que lo excluye.
//   sin-criterio -> nadie ha decidido esto todavia. Se nombra la decision que falta.
//
// Esto es logica PURA: recibe lo ya leido y devuelve el juicio. Ni lee ficheros ni llama a la API —
// asi el juicio se puede testear sin red y sin repo, que es donde los criterios se rompen sin ruido.
'use strict';

// Un requisito solo RESPALDA algo si esta vivo. 'propuesto' no respalda (aun no se acepto) pero
// tampoco excluye: es justamente el caso de 'sin-criterio'.
const REQ_VIVOS = ['aceptado', 'en-cambio', 'entregado'];
const REQ_MUERTOS = ['descartado'];
// Un ADR rechazado o sustituido NO decide nada: el primero decidio que no, el segundo ya no rige.
const ADR_VIGENTE = ['aceptada'];

const norm = (s) => String(s == null ? '' : s).toLowerCase().trim();

// Palabras del reporte que se buscan en los requisitos/ADR. Se quitan las vacias: sin esto, "el",
// "que" o "de" casan con cualquier requisito y todo pareceria respaldado.
const VACIAS = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'que', 'en', 'y', 'o', 'a',
  'para', 'por', 'con', 'se', 'no', 'es', 'al', 'lo', 'su', 'sus', 'este', 'esta', 'como', 'cuando',
  'si', 'me', 'mi', 'le', 'ha', 'hay', 'ser', 'the', 'and', 'for', 'with']);

function terminos(texto) {
  return [...new Set(norm(texto).split(/[^\wáéíóúñü]+/).filter((p) => p.length > 3 && !VACIAS.has(p)))];
}

// Solape lexico simple. NO pretende entender: pretende ENCONTRAR CANDIDATOS para que el juicio se
// haga sobre algo concreto. Por eso devuelve los candidatos, no un veredicto.
function relacionados(texto, items, campoTexto) {
  const t = terminos(texto);
  if (!t.length) return [];
  return items
    .map((it) => {
      const cuerpo = norm(campoTexto(it));
      const comunes = t.filter((p) => cuerpo.includes(p));
      return { item: it, comunes, peso: comunes.length };
    })
    .filter((r) => r.peso > 0)
    .sort((a, b) => b.peso - a.peso);
}

// Un reporte es INDIVIDUAL cuando pide algo para quien lo pide, no una regla del producto. Es la
// distincion que pidio el usuario: los estandares se aplican, las peticiones unicas se justifican.
// Se detecta por como esta REDACTADO, y por eso es una SEÑAL, no un veredicto: se le dice al humano
// "esto suena individual", no se descarta solo.
const MARCAS_INDIVIDUALES = [
  /\ben mi (caso|equipo|empresa|instalaci[oó]n|entorno|flujo)\b/i,
  /\b(yo|nosotros) (necesit|quier|prefer|us)\w*/i,
  /\bpara (mi|mi equipo|nuestro caso)\b/i,
  /\b(me|nos) (vendr[ií]a|gustar[ií]a|ser[ií]a util)\b/i,
  /\bsolo (lo uso|lo usamos|nos pasa)\b/i,
];
function pareceIndividual(texto) {
  return MARCAS_INDIVIDUALES.some((re) => re.test(String(texto || '')));
}

// ---------------------------------------------------------------------------
// CONTEXTO que trae un reporte de fuera (widget de feedback, formulario, soporte).
//
// FARO NO construye ese canal ni le impone formato: el widget es del producto, no del harness. Lo
// que hace es LEER lo que venga, si viene. Por eso se aceptan varias formas de escribir lo mismo y
// nada es obligatorio — un reporte sin contexto se juzga igual, solo que con menos material.
//
// El campo que mas cambia el veredicto es a CUANTOS afecta: "me pasa a mi" y "nos pasa a todos" son
// el mismo bug con dos decisiones distintas detras. Hasta ahora eso solo se infería de COMO estaba
// redactado el texto ("en mi caso…"), que falla con cualquiera que escriba en impersonal. Si el dato
// viene explicito, manda sobre la inferencia: es un hecho, no una lectura del tono.
// ---------------------------------------------------------------------------

const CAMPOS_CONTEXTO = [
  { clave: 'url', re: /^[\s>*_-]*(?:url|enlace|link|p[aá]gina)\s*[:=]\s*(.+)$/im },
  { clave: 'pantalla', re: /^[\s>*_-]*(?:pantalla|secci[oó]n|vista|ruta|screen)\s*[:=]\s*(.+)$/im },
  { clave: 'frecuencia', re: /^[\s>*_-]*(?:frecuencia|cu[aá]ndo pasa|ocurre)\s*[:=]\s*(.+)$/im },
  { clave: 'alcance', re: /^[\s>*_-]*(?:afecta a|alcance|a qui[eé]n|usuarios afectados)\s*[:=]\s*(.+)$/im },
  { clave: 'version', re: /^[\s>*_-]*(?:versi[oó]n|version|build)\s*[:=]\s*(.+)$/im },
  { clave: 'navegador', re: /^[\s>*_-]*(?:navegador|browser|user[- ]agent|dispositivo)\s*[:=]\s*(.+)$/im },
];
// Una captura NO es un campo con valor: es un adjunto. Se detecta su presencia, no se lee.
const RE_CAPTURA = /!\[[^\]]*\]\([^)]+\)|https?:\/\/\S+\.(png|jpe?g|gif|webp)\b/i;

// Un canal de feedback no trae solo BUGS: trae bugs, ideas y sugerencias mezclados, y cada uno se
// juzga contra una pregunta distinta —
//   bug        -> ¿deberia funcionar asi? (se contrasta con lo pactado; si si, es un fallo)
//   idea       -> ¿encaja en el alcance? (funcional, fuera de alcance, requisitos)
//   sugerencia -> ¿es un estandar o el gusto de uno? (aqui pesa mas a cuantos afecta)
// Tratarlos igual seria el error de fondo: descartar una idea "porque no esta en la spec" es
// correcto; descartar un BUG por lo mismo seria absurdo — un fallo no necesita estar planificado
// para ser un fallo.
const RE_TIPO = /^[\s>*_-]*(?:tipo|categor[ií]a|type)\s*[:=]\s*(.+)$/im;
const SENALES_TIPO = [
  ['bug', /\b(bug|error|fallo|defecto|no funciona|se rompe|crash|falla|incidencia)\b/i],
  ['idea', /\b(idea|propuesta|me gustar[ií]a que|ser[ií]a genial|feature|funcionalidad nueva)\b/i],
  ['sugerencia', /\b(sugerencia|sugiero|mejorar[ií]a|ser[ií]a mejor|recomiendo)\b/i],
];

/**
 * Que CLASE de reporte es. Si el canal lo declara ('tipo: bug'), manda lo declarado; si no, se
 * infiere del texto. Devuelve null cuando no hay senal: mejor no clasificar que clasificar mal,
 * porque de la clase depende contra QUE se juzga.
 */
function tipoDeReporte(titulo, cuerpo) {
  const t = `${titulo || ''}\n${cuerpo || ''}`;
  const dec = t.match(RE_TIPO);
  if (dec) {
    const v = norm(dec[1]);
    for (const [clase, re] of SENALES_TIPO) if (re.test(v) || v.includes(clase)) return clase;
  }
  for (const [clase, re] of SENALES_TIPO) if (re.test(t)) return clase;
  return null;
}

/** Lo que el reporte trae de fuera. Todo opcional: se usa lo que haya. */
function contextoDelReporte(cuerpo) {
  const t = String(cuerpo || '');
  const ctx = {};
  for (const c of CAMPOS_CONTEXTO) {
    const m = t.match(c.re);
    if (m) ctx[c.clave] = m[1].trim().replace(/^[`'"*_\s]+|[`'"*_\s]+$/g, '');
  }
  if (RE_CAPTURA.test(t)) ctx.captura = true;
  return ctx;
}

// ---------------------------------------------------------------------------
// SEÑALES DEL PROPIO ISSUE (no del texto). Un issue de la forja trae mas que titulo y cuerpo, y
// parte de eso es evidencia OBJETIVA de a cuantos afecta — que es justo la pregunta que el triaje
// mas necesita responder y peor resolvia leyendo el tono.
//
//   reactions.+1  -> cuanta gente lo respalda. Es un hecho, no una lectura del texto.
//   comments      -> varios sumandose no es un caso aislado.
//   assoc         -> quien lo abre: MEMBER/OWNER es de dentro; NONE/CONTRIBUTOR, de fuera.
//   labels        -> lo que alguien ya clasifico a mano; si esta, no se re-adivina.
//
// Umbral deliberadamente BAJO (2): con un solo voto no hay senal —el que lo abre suele votarse— y
// esperar a diez seria no enterarse nunca. Dos personas distintas ya descartan el caso unico.
const RESPALDO_MINIMO = 2;

function senalesDelIssue(issue) {
  const i = issue || {};
  const r = i.reactions || {};
  const votos = Number(r['+1'] || r.plus_one || 0);
  const comentarios = Number(i.comments || 0);
  const etiquetas = (i.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
  const assoc = String(i.author_association || '').toUpperCase();
  return {
    votos,
    comentarios,
    etiquetas,
    deDentro: ['MEMBER', 'OWNER', 'COLLABORATOR'].includes(assoc),
    // Respaldado = mas de una persona lo pide o lo sufre. Rompe la presuncion de "caso individual"
    // aunque el texto este escrito en primera persona: los hechos mandan sobre la redaccion.
    respaldado: votos >= RESPALDO_MINIMO || comentarios >= RESPALDO_MINIMO,
  };
}

// De lo declarado, ¿se deduce que afecta a UNA persona? Devuelve true/false si el dato lo dice, y
// null si no hay dato (entonces manda la inferencia por redaccion, que es lo que habia).
const SOLO_YO = /\b(solo a m[ií]|s[oó]lo a m[ií]|solo yo|a m[ií]|una persona|un usuario|mi equipo|solo nosotros)\b/i;
const A_TODOS = /\b(a todos|todos los usuarios|cualquiera|general|toda la plataforma|varios equipos|muchos)\b/i;
function alcanceDeclarado(ctx) {
  const v = (ctx && ctx.alcance) || '';
  if (!v) return null;
  if (A_TODOS.test(v)) return false;   // afecta a muchos -> NO es individual
  if (SOLO_YO.test(v)) return true;
  return null;
}

/**
 * Juzga UN reporte contra lo escrito.
 *
 * @param {object} p
 * @param {string} p.titulo        titulo del issue/reporte
 * @param {string} p.cuerpo        texto del reporte
 * @param {Array}  p.requisitos    [{id, nombre, campos:{estado, origen}}] — tal cual los da digestion.parseRequisitos()
 * @param {Array}  p.decisiones    [{archivo, titulo, status}] — los ADR de gestion/decisions/
 * @param {Array}  p.fueraAlcance  ['linea del "## Fuera de alcance" del funcional', …]
 * @returns {{veredicto, motivo, respaldo:[], excluye:[], individual:boolean}}
 *          'motivo' es el texto que se publica EN EL ISSUE: quien lo lea tiene que entender el
 *          porque sin abrir el repo, y por eso cita ids y ficheros, no adjetivos.
 */
function juzgar({ titulo = '', cuerpo = '', requisitos = [], decisiones = [], fueraAlcance = [], issue = null } = {}) {
  const texto = `${titulo}\n${cuerpo}`;
  const contexto = contextoDelReporte(cuerpo);
  const tipo = tipoDeReporte(titulo, cuerpo);
  const senales = senalesDelIssue(issue);

  // ¿Es un caso INDIVIDUAL? Tres fuentes, en orden de fiabilidad decreciente — los HECHOS mandan
  // sobre la lectura del tono, que es lo unico que habia antes:
  //   1. los votos/comentarios del issue: si dos personas distintas lo respaldan, NO es individual
  //      por muy en primera persona que este escrito
  //   2. el campo 'afecta a' que declare el canal
  //   3. como esta redactado (el ultimo recurso, no el primero)
  const declarado = alcanceDeclarado(contexto);
  const individual = senales.respaldado ? false
    : declarado !== null ? declarado
      : pareceIndividual(texto);

  const reqs = relacionados(texto, requisitos || [], (r) => `${r.id} ${r.nombre}`);
  const adrs = relacionados(texto, decisiones || [], (d) => `${d.titulo || ''} ${d.archivo || ''}`);
  const fuera = relacionados(texto, (fueraAlcance || []).map((l) => ({ linea: l })), (f) => f.linea);

  const est = (r) => norm(r.item.campos && r.item.campos.estado);
  const respaldo = reqs.filter((r) => REQ_VIVOS.includes(est(r)));
  const muertos = reqs.filter((r) => REQ_MUERTOS.includes(est(r)));
  const adrVigentes = adrs.filter((d) => ADR_VIGENTE.includes(norm(d.item.status)));

  const ref = (r) => `${r.item.id} · ${r.item.nombre}`;
  const refAdr = (d) => `${d.item.archivo}${d.item.titulo ? ` (${d.item.titulo})` : ''}`;

  // El FUERA DE ALCANCE se mira PRIMERO: es la unica exclusion deliberada del funcional, y por eso
  // pesa mas que un requisito vivo que solo se parezca de refilon. Si lo que piden esta ahi escrito,
  // no hay nada que valorar — ya se valoro al definir el alcance.
  // Salvo un BUG: un fallo no necesita estar planificado para serlo, y el cruce es por palabras sueltas
  // («turnos» y «ausencias» casaban con una ingesta de Excel que nada tiene que ver). Queda en
  // sin-criterio en vez de un no-aplica que cita una frase que no lo excluye (#244).
  if (fuera.length && tipo !== 'bug') {
    const citas = fuera.map((f) => f.item.linea);
    return {
      veredicto: 'no-aplica',
      individual, tipo, contexto, senales,
      respaldo: [],
      excluye: citas,
      motivo: 'Esta declarado FUERA DE ALCANCE en el funcional de la iniciativa:\n' +
        citas.map((c) => `> ${c}`).join('\n') +
        '\n\nNo es un olvido: se decidio dejarlo fuera al definir el alcance. Para que entre hay que ' +
        'cambiar el alcance, y eso se hace con un ADR que diga que ha cambiado para justificarlo — ' +
        'no con un reporte.',
    };
  }

  // Lo DESCARTADO manda sobre lo vivo: si ya se decidio que no, volver a proponerlo necesita
  // reabrir el requisito, no colarlo por la puerta de un reporte nuevo.
  if (muertos.length) {
    return {
      veredicto: 'no-aplica',
      individual, tipo, contexto, senales,
      respaldo: respaldo.map(ref),
      excluye: muertos.map(ref),
      motivo: `Ya se descarto: ${muertos.map(ref).join(', ')} esta en estado 'descartado' en ` +
        'gestion/requisitos.md. Para retomarlo hay que reabrir ese requisito y decir que ha ' +
        'cambiado desde que se descarto — no basta con volver a pedirlo.',
    };
  }

  if (respaldo.length) {
    return {
      veredicto: 'aplica',
      individual, tipo, contexto, senales,
      respaldo: respaldo.map(ref),
      excluye: [],
      motivo: `Respaldado por ${respaldo.map(ref).join(', ')} (gestion/requisitos.md). ` +
        'Es trabajo previsto: entra en el faseo con ese requisito citado para que quede trazado.',
    };
  }

  // Sin requisito que lo respalde y redactado en primera persona: es una peticion individual. No se
  // tira — se PIDE lo que le falta para ser un requisito (a quien mas le pasa, y con que evidencia).
  if (individual) {
    return {
      veredicto: 'no-aplica',
      individual: true, tipo, contexto, senales,
      respaldo: [],
      excluye: adrVigentes.map(refAdr),
      motivo: 'Peticion individual: esta redactada como necesidad de quien la reporta y no la ' +
        'respalda ningun requisito aceptado en gestion/requisitos.md. FARO aplica estandares, no ' +
        'casos particulares. Para que entre, tiene que subir a requisito: a quien mas le ocurre, ' +
        'que evidencia hay, y que regla del producto cambiaria. Con eso se registra como REQ y se ' +
        'decide; sin eso, queda anotado pero no planificado.',
    };
  }

  if (adrVigentes.length) {
    // Si el ADR que toca esta INCOMPLETO no se puede juzgar contra el: sin 'Alternativas
    // consideradas' no hay forma de saber si lo que piden se valoro y se descarto, o si nadie lo
    // penso. Son cosas opuestas y el ADR no las distingue. En vez de fingir un veredicto, se PIDE lo
    // que falta — y se pide AQUI porque es el momento en que duele y la respuesta se aprovecha.
    const cojos = adrVigentes.filter((d) => (d.item.secciones || d.item.texto) && !completoParaJuzgar(d.item));
    if (cojos.length) {
      return {
        veredicto: 'falta-criterio-adr',
        individual, tipo, contexto, senales,
        respaldo: [],
        excluye: [],
        pedir: cojos.map((d) => ({
          archivo: d.item.archivo,
          titulo: d.item.titulo || '',
          faltan: seccionesQueFaltan(d.item),
          pregunta: `Cuando se decidio "${d.item.titulo || d.item.archivo}", ¿se valoro esto y se descarto, o no se planteo?`,
        })),
        motivo: `Toca terreno ya decidido (${cojos.map(refAdr).join(', ')}), pero ese ADR no declara ` +
          'que alternativas se consideraron. Sin eso no se puede saber si esto se valoro en su dia y ' +
          'se descarto (entonces NO aplica y hay motivo) o si nunca se penso (entonces esta por ' +
          'decidir). Completa el ADR con las alternativas que se manejaron y el triaje podra citarlo.',
      };
    }
    return {
      veredicto: 'sin-criterio',
      individual, tipo, contexto, senales,
      respaldo: [],
      excluye: adrVigentes.map(refAdr),
      motivo: `Toca terreno ya decidido (${adrVigentes.map(refAdr).join(', ')}) pero ningun ` +
        'requisito lo cubre. Antes de planificarlo hay que contrastarlo con esa decision: o encaja ' +
        'y se registra como requisito, o la contradice y entonces lo que toca es un ADR nuevo que ' +
        'sustituya al anterior.',
    };
  }

  // La salida honesta: no hay nada escrito con que juzgarlo. Decir "no aplica" aqui seria inventarse
  // un criterio; decir "aplica" seria colar trabajo sin respaldo. Lo que falta es DECIDIR.
  return {
    veredicto: 'sin-criterio',
    individual, tipo, contexto, senales,
    respaldo: [],
    excluye: [],
    motivo: 'No hay nada escrito con que juzgarlo: ningun requisito en gestion/requisitos.md ni ' +
      'ninguna decision en gestion/decisions/ habla de esto. No es que no aplique — es que nadie ' +
      'lo ha decidido todavia. Lo que toca es decidir: registrarlo como requisito (y darle estado) ' +
      'o dejar un ADR diciendo que queda fuera del alcance y por que.',
  };
}

// El comentario que se publica en el issue. El formato importa: quien abrio el reporte lee ESTO, no
// el repo. Por eso lleva siempre el porque, y en el 'no-aplica' lleva ademas que haria falta para
// que cambiara la respuesta — un "no" sin salida es lo que hace que la gente deje de reportar.
const ETIQUETA = { aplica: 'Aplica', 'no-aplica': 'No aplica', 'sin-criterio': 'Falta decidir' };

function comentario(juicio, { titulo = '' } = {}) {
  const j = juicio || {};
  const l = [`**Triaje FARO — ${ETIQUETA[j.veredicto] || j.veredicto}**`, ''];
  if (titulo) l.push(`> ${titulo}`, '');
  l.push(j.motivo || '');
  if (j.respaldo && j.respaldo.length) l.push('', `Respaldo: ${j.respaldo.join(', ')}`);
  if (j.excluye && j.excluye.length) l.push('', `Lo excluye: ${j.excluye.join(', ')}`);
  l.push('', '---', '_Triaje automatico de FARO. Si el motivo no encaja con lo que querias decir, ' +
    'respondele aqui: el veredicto se revisa, no es definitivo._');
  return l.join('\n');
}

// ---------------------------------------------------------------------------
// COMPLETITUD DE LOS ADR (estandar MADR).
//
// MADR define 9 secciones, 3 obligatorias (contexto, alternativas, decision). FARO exige ademas
// CONSECUENCIAS: es lo unico que dice con que se cargo a cambio, y sin eso, cuando alguien tropieza
// con una limitacion no puede distinguir un fallo de un precio aceptado a sabiendas — que es
// justamente la distincion que el triaje necesita para responder.
//
// Las otras cinco (drivers, confirmacion, pros/contras, mas informacion) van en la plantilla como
// opcionales. No por descuido: un ADR de 9 secciones cuesta media hora, y a la tercera decision
// nadie lo escribe. Un ADR pobre se mejora; uno que nunca se escribio no deja rastro, y entonces el
// triaje se queda sin criterio igual.
//
// LEGACY: lo escrito antes de esta regla NO se rompe. Exigir las 4 a un repo con ADRs de hace meses
// pondria 'validate' en rojo el dia que actualiza el motor, y el reflejo seria desactivar la regla —
// perdiendo tambien la exigencia para los nuevos. Asi que se avisa, y se PREGUNTA en los dos momentos
// en que completarlo sale barato: al editar ese ADR (el contexto ya esta abierto) y al triar algo
// que choca con el (ahi la respuesta se aprovecha en el acto).
// ---------------------------------------------------------------------------

// Las 4 que FARO exige, con las redacciones que admite cada una. Se aceptan variantes porque exigir
// un literal exacto marcaria como incompleto un ADR correcto por una palabra.
// Utilidades de markdown compartidas por el analisis de ADR y el del funcional. Viven ARRIBA de sus
// dos usos a proposito: son 'const', asi que usarlas antes de su definicion no es un error de
// sintaxis — revienta solo al ejecutar (TDZ), y ese es el tipo de fallo que no ve ningun 'node -c'.
const RE_TITULO = /^#{1,6}\s+/;
const nivel = (l) => (l.match(/^#+/) || [''])[0].length;
// Un placeholder NO es contenido: tomar un 'TBD' por criterio es peor que no tener nada, porque el
// triaje citaria un marcador como si fuera una decision.
const RE_PLACEHOLDER = /^(n\/?a|tbd|pendiente|por definir|<.*>|\.\.\.|—|-)$/i;

const SECCIONES_ADR = [
  { clave: 'contexto', etiqueta: 'Contexto y problema', re: /^#{1,6}\s*(?:\d+[.)]\s*)?(?:contexto|context)\b/im },
  { clave: 'alternativas', etiqueta: 'Alternativas consideradas', re: /^#{1,6}\s*(?:\d+[.)]\s*)?(?:alternativas|opciones|considered options|opciones consideradas)\b/im },
  { clave: 'decision', etiqueta: 'Decision', re: /^#{1,6}\s*(?:\d+[.)]\s*)?(?:decisi[oó]n|decision outcome|resultado)\b/im },
  { clave: 'consecuencias', etiqueta: 'Consecuencias', re: /^#{1,6}\s*(?:\d+[.)]\s*)?(?:consecuencias|consequences|implicaciones)\b/im },
];
// Las 5 opcionales de MADR: no se exigen, pero la plantilla las deja preparadas para que quien
// quiera profundizar tenga el sitio hecho y no se invente un formato propio.
const SECCIONES_ADR_OPCIONALES = ['Decision drivers', 'Confirmacion', 'Pros y contras de las opciones', 'Mas informacion'];

// Un encabezado sin nada debajo no es una seccion: es el mismo fallo silencioso del fuera de alcance.
function tieneContenido(texto, re) {
  const lineas = String(texto || '').split(/\r?\n/);
  const i = lineas.findIndex((l) => re.test(l));
  if (i < 0) return false;
  const propio = nivel(lineas[i]);
  for (let j = i + 1; j < lineas.length; j++) {
    const l = lineas[j];
    if (RE_TITULO.test(l) && nivel(l) <= propio) break;
    const t = l.replace(/^\s*[-*+]\s*/, '').trim();
    if (t && !RE_PLACEHOLDER.test(t)) return true;
  }
  return false;
}

/** Que secciones obligatorias le faltan (o estan vacias) a un ADR. [] = completo. */
function seccionesQueFaltan(adr) {
  const texto = (adr && (adr.texto || adr.contenido)) || '';
  return SECCIONES_ADR.filter((s) => !tieneContenido(texto, s.re)).map((s) => s.etiqueta);
}

// Para JUZGAR basta con que declare alternativas: es la seccion que distingue "se valoro y se
// descarto" de "no se penso". Un ADR sin consecuencias es incompleto, pero aun se puede citar.
function completoParaJuzgar(adr) {
  const texto = (adr && (adr.texto || adr.contenido)) || '';
  return tieneContenido(texto, SECCIONES_ADR[1].re);
}

/**
 * Aviso de ADR incompleto. 'legacy' cambia el TONO y la fuerza, no el diagnostico.
 * @returns {{bloquea:boolean, aviso:string, faltan:string[]}|null} null si esta completo.
 */
function adrIncompleto(adr, { legacy = false } = {}) {
  const faltan = seccionesQueFaltan(adr);
  if (!faltan.length) return null;
  const ref = (adr && adr.archivo) || 'el ADR';
  if (legacy) {
    return {
      bloquea: false,
      faltan,
      aviso: `${ref}: le faltan ${faltan.join(', ')} (estandar MADR). Es anterior a la regla, asi que ` +
        'no bloquea nada. Cuando lo abras para otra cosa, o cuando el triaje necesite citarlo, se te ' +
        'preguntara por lo que falta: completarlo entonces cuesta minutos y evita volver a discutir ' +
        'lo que ya se decidio.',
    };
  }
  return {
    bloquea: true,
    faltan,
    aviso: `${ref}: faltan ${faltan.join(', ')}. Un ADR sin alternativas no permite saber si algo se ` +
      'valoro y se descarto o si nadie lo penso, y sin consecuencias no se distingue un fallo de un ' +
      'precio aceptado a sabiendas. Son las dos preguntas que hay que responder cada vez que alguien ' +
      'reabra el tema.',
  };
}

/**
 * REPO LEGACY que adopta FARO: el problema no es que los ADR esten incompletos — es que no hay
 * ninguno. Las decisiones se tomaron (el codigo las demuestra) pero nunca se escribieron, y un
 * triaje sin nada escrito devuelve 'sin-criterio' a todo, que no le sirve a nadie.
 *
 * Por eso al adoptar se SIEMBRA el criterio: se pregunta por lo estructural y se escribe. No es
 * documentar por documentar — es que sin esto el triaje no puede responder nada.
 *
 * Devuelve el diagnostico, no las respuestas: que falta y que preguntar. Quien contesta es el
 * usuario, siempre.
 */
function criterioDelRepo({ funcional = '', decisiones = [], requisitos = [] } = {}) {
  const exclusiones = fueraDeAlcance(funcional);
  const adrs = decisiones || [];
  const completos = adrs.filter((a) => !seccionesQueFaltan(a).length);
  const vivos = (requisitos || []).filter((r) => {
    const e = norm(r.campos && r.campos.estado);
    return REQ_VIVOS.includes(e) || REQ_MUERTOS.includes(e);
  });

  const huecos = [];
  if (!String(funcional || '').trim()) {
    huecos.push({
      que: 'funcional',
      falta: 'No hay funcional: es de donde sale TODO el criterio. Sin el, el triaje no puede responder nada.',
      pregunta: '¿Que hace este producto, y — sobre todo — que NO hace? Lo segundo es lo que permite descartar peticiones con fundamento.',
    });
  } else if (!exclusiones.length) {
    huecos.push({
      que: 'fuera-de-alcance',
      falta: 'El funcional describe lo que el producto hace, pero no lo que deliberadamente NO hace.',
      pregunta: '¿Que cosas se ha decidido dejar fuera de este producto? (aunque sean tres lineas: es lo que evita rediscutirlo cada vez)',
    });
  }
  if (!adrs.length) {
    huecos.push({
      que: 'decisiones',
      falta: 'No hay ninguna decision registrada. En un repo con historia las decisiones SE TOMARON — el codigo las demuestra — pero no estan escritas, asi que no se pueden citar.',
      pregunta: '¿Que decisiones estructurales se tomaron en este proyecto y hoy darias por cerradas? (stack, arquitectura, integraciones, lo que se descarto y por que)',
    });
  }
  if (!vivos.length) {
    huecos.push({
      que: 'requisitos',
      falta: 'No hay requisitos de negocio registrados con estado: no hay con que respaldar un "esto si estaba previsto".',
      pregunta: '¿Que requisitos de negocio estan aceptados hoy, y cuales se propusieron y se descartaron?',
    });
  }

  return {
    // Cuanto criterio hay REALMENTE para juzgar. Con 0, el triaje solo puede devolver 'sin-criterio'.
    exclusiones: exclusiones.length,
    decisionesCompletas: completos.length,
    decisionesCojas: adrs.length - completos.length,
    requisitos: vivos.length,
    huecos,
    // El aviso honesto: decirle al usuario lo que el triaje VA A PODER hacer, antes de que lo use y
    // se lleve la decepcion de recibir 'sin-criterio' en todo.
    listo: huecos.length === 0,
  };
}

/**
 * Las preguntas que hacer al usuario para completar un ADR. NUNCA se rellena solo: un ADR dice lo
 * que se decidio y por que, y eso solo lo sabe quien estuvo. Inventarlo seria fabricar historia.
 */
function preguntasADR(adr) {
  const faltan = new Set(seccionesQueFaltan(adr));
  const t = (adr && (adr.titulo || adr.archivo)) || 'esta decision';
  const qs = [];
  if (faltan.has('Contexto y problema')) qs.push({ seccion: 'Contexto y problema', pregunta: `¿Que problema habia que resolver cuando se decidio "${t}"?` });
  if (faltan.has('Alternativas consideradas')) qs.push({ seccion: 'Alternativas consideradas', pregunta: `¿Que otras opciones se valoraron para "${t}", y por que se descartaron?` });
  if (faltan.has('Decision')) qs.push({ seccion: 'Decision', pregunta: `¿Que se eligio finalmente en "${t}" y por que esa y no otra?` });
  if (faltan.has('Consecuencias')) qs.push({ seccion: 'Consecuencias', pregunta: `¿Con que se carga a cambio? Lo bueno y lo malo que trajo "${t}".` });
  return qs;
}

// ---------------------------------------------------------------------------
// El CRITERIO se lee del funcional. El contrato del tipo FUN ya exige la seccion
// 'Alcance y fuera de alcance' (y la pone como error tipico no declararla), pero nadie comprobaba
// que estuviera RELLENA: un encabezado con nada debajo pasaba la validacion. Sin contenido ahi, el
// triaje se queda sin la unica exclusion deliberada que existe y casi todo cae en 'sin-criterio'.
// ---------------------------------------------------------------------------

// Se acepta cualquiera de las redacciones que usa el contrato y la gente ('Alcance y fuera de
// alcance', 'Fuera de alcance', 'Fuera del alcance'): exigir una literal exacta romperia funcionales
// correctos por una preposicion.
// Dos patrones, y el orden importa. 'Alcance y fuera de alcance' es la redaccion que exige el
// contrato FUN, pero bajo ese encabezado lo primero que viene es EL ALCANCE (lo que SI se hace) y el
// fuera de alcance suele colgar de un subapartado. Leer el combinado a secas hacia que el extractor
// se tragara el alcance y citara "lo que el producto hace" como motivo para descartar algo: lo
// contrario de la verdad. Por eso el encabezado ESPECIFICO tiene prioridad sobre el combinado.
const RE_FUERA_SOLO = /^#{1,6}\s*(?:\d+[.)]\s*)?(?:lo\s+que\s+queda\s+)?fuera\s+de(?:l)?\s+alcance\s*:?\s*$/i;
const RE_FUERA_COMBI = /^#{1,6}\s*(?:\d+[.)]\s*)?alcance\s+y\s+fuera\s+de(?:l)?\s+alcance\s*:?\s*$/i;
const RE_FUERA = (l) => RE_FUERA_SOLO.test(l) || RE_FUERA_COMBI.test(l);

/**
 * Extrae las lineas del apartado de fuera de alcance del funcional.
 * Devuelve [] si la seccion no existe o esta vacia — quien llama distingue ambos casos con
 * 'faltaFueraDeAlcance', porque "no lo declaro" y "lo declaro vacio" se corrigen igual pero se
 * cuentan distinto.
 */
function fueraDeAlcance(textoFuncional) {
  const lineas = String(textoFuncional || '').split(/\r?\n/);
  // El especifico primero: si el funcional separa 'Fuera de alcance' en su propio (sub)apartado, esa
  // es la exclusion de verdad. Solo si no existe se cae al combinado.
  let i = lineas.findIndex((l) => RE_FUERA_SOLO.test(l.trim()));
  if (i < 0) i = lineas.findIndex((l) => RE_FUERA_COMBI.test(l.trim()));
  if (i < 0) return [];
  const propio = nivel(lineas[i].trim());
  const out = [];
  for (let j = i + 1; j < lineas.length; j++) {
    const l = lineas[j];
    // Corta con un encabezado del MISMO nivel o superior. Un subapartado (mas #) sigue siendo parte
    // de este apartado: cortar ahi perderia las exclusiones agrupadas por tema.
    if (RE_TITULO.test(l) && nivel(l) <= propio) break;
    if (RE_TITULO.test(l)) continue;         // subtitulo interno: no es una exclusion en si
    const t = l.replace(/^\s*[-*+]\s*/, '').trim();
    if (!t || RE_PLACEHOLDER.test(t)) continue;
    out.push(t);
  }
  return out;
}

/** El aviso para validate/sesion. Devuelve null cuando esta bien: el silencio es lo normal. */
function faltaFueraDeAlcance(textoFuncional, ruta = 'el funcional') {
  const txt = String(textoFuncional || '');
  if (!txt.trim()) return null;              // sin funcional ya avisa el harness por otro lado
  const hay = txt.split(/\r?\n/).some((l) => RE_FUERA(l.trim()));
  if (!hay) {
    return `${ruta}: falta el apartado 'Alcance y fuera de alcance' que exige el contrato del tipo FUN. ` +
      'Sin lo que queda FUERA escrito, no hay con que justificar un "esto no se hace": toda peticion ' +
      'que llegue quedara sin criterio y habra que decidirla de cero cada vez.';
  }
  if (!fueraDeAlcance(txt).length) {
    return `${ruta}: el apartado de fuera de alcance esta VACIO (o solo tiene marcadores tipo TBD). ` +
      'Es lo que evita la discusion de despues y el unico criterio para descartar peticiones con ' +
      'fundamento. Escribe que NO hace el producto, aunque sean tres lineas.';
  }
  return null;
}

module.exports = {
  juzgar, comentario, relacionados, pareceIndividual, terminos,
  fueraDeAlcance, faltaFueraDeAlcance,
  seccionesQueFaltan, completoParaJuzgar, adrIncompleto, preguntasADR, criterioDelRepo,
  contextoDelReporte, tipoDeReporte, senalesDelIssue, alcanceDeclarado,
  SECCIONES_ADR, SECCIONES_ADR_OPCIONALES,
};
