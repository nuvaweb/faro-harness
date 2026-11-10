// El triaje JUZGA, no clasifica. La pregunta que responde no es "que es esto" sino "merece la pena
// hacerlo, y POR QUE si o por que no" — con el motivo escrito contra algo que ya estaba escrito.
//
// Lo que estos tests protegen es la honestidad del juicio:
//   - un 'no aplica' SIEMPRE cita que lo excluye (si no, es la opinion del agente disfrazada)
//   - sin nada escrito el veredicto es 'sin-criterio', NUNCA 'no aplica'
//   - un placeholder (TBD) no cuenta como criterio
// El tercer veredicto es el que mas importa: sin el, un agente que no quiere quedarse callado
// inventa un motivo, y entonces el triaje pasa a fabricar criterio en vez de aplicarlo.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { juzgar, comentario, pareceIndividual, fueraDeAlcance, faltaFueraDeAlcance,
  seccionesQueFaltan, adrIncompleto, preguntasADR, criterioDelRepo } = require(path.join(HOOKS, 'lib', 'triaje.js'));

const req = (id, nombre, estado) => ({ id, nombre, campos: { estado } });

// ---------- el fuera de alcance manda ----------

test('lo declarado fuera de alcance se descarta CITANDO la linea del funcional', () => {
  const j = juzgar({
    titulo: 'Soporte multi-idioma en la interfaz',
    fueraAlcance: ['Soporte multi-idioma en v1', 'Integraciones con CRM propios del cliente'],
  });
  assert.strictEqual(j.veredicto, 'no-aplica');
  assert.ok(j.excluye.some((e) => /multi-idioma/i.test(e)), JSON.stringify(j.excluye));
  assert.match(j.motivo, /fuera de alcance/i);
  // Un "no" sin salida hace que la gente deje de reportar: tiene que decir que haria falta.
  assert.match(j.motivo, /ADR|cambiar el alcance/i, `debe decir como se revierte: ${j.motivo}`);
});

test('el fuera de alcance pesa mas que un requisito vivo que solo se parezca', () => {
  const j = juzgar({
    titulo: 'Multi-idioma en los informes',
    requisitos: [req('REQ-03', 'Informes en varios formatos', 'aceptado')],
    fueraAlcance: ['Soporte multi-idioma en v1'],
  });
  assert.strictEqual(j.veredicto, 'no-aplica', 'lo excluido explicitamente gana al parecido lexico');
});

// ---------- requisitos ----------

test('lo respaldado por un requisito aceptado aplica, y dice por cual', () => {
  const j = juzgar({
    titulo: 'Exportar informes a PDF',
    requisitos: [req('REQ-03', 'Exportacion de informes', 'aceptado')],
  });
  assert.strictEqual(j.veredicto, 'aplica');
  assert.ok(j.respaldo.some((r) => /REQ-03/.test(r)), JSON.stringify(j.respaldo));
});

test('un requisito DESCARTADO excluye: no se cuela repitiendo la peticion', () => {
  const j = juzgar({
    titulo: 'Exportar informes a PDF otra vez',
    requisitos: [req('REQ-03', 'Exportacion de informes', 'descartado')],
  });
  assert.strictEqual(j.veredicto, 'no-aplica');
  assert.ok(j.excluye.some((e) => /REQ-03/.test(e)), JSON.stringify(j.excluye));
  assert.match(j.motivo, /reabrir|que ha cambiado/i, `debe exigir reabrir, no solo negar: ${j.motivo}`);
});

// 'propuesto' no es vivo NI muerto: nadie lo ha decidido, que es justo 'sin-criterio'.
test('un requisito solo PROPUESTO no respalda ni excluye: falta decidirlo', () => {
  const j = juzgar({
    titulo: 'Exportar informes a PDF',
    requisitos: [req('REQ-03', 'Exportacion de informes', 'propuesto')],
  });
  assert.strictEqual(j.veredicto, 'sin-criterio', j.motivo);
});

// ---------- peticiones individuales vs estandares ----------

test('una peticion en primera persona sin requisito es individual, y se explica que le falta', () => {
  const j = juzgar({ titulo: 'Filtro por color', cuerpo: 'En mi equipo necesitamos filtrar por color.' });
  assert.strictEqual(j.veredicto, 'no-aplica');
  assert.strictEqual(j.individual, true);
  assert.match(j.motivo, /estandares|individual/i);
  // La salida: que tiene que aportar para subir a requisito.
  assert.match(j.motivo, /a quien mas|evidencia/i, `debe decir como subir a requisito: ${j.motivo}`);
});

test('la marca de individual es la REDACCION, no el tema', () => {
  assert.ok(pareceIndividual('En mi caso el boton no responde'));
  assert.ok(pareceIndividual('Nos vendria bien un export'));
  assert.ok(!pareceIndividual('El boton de guardar no responde al pulsarlo'));
});

// Importante: individual NO tumba un requisito aceptado. Si esta respaldado, aplica aunque lo pida
// alguien en primera persona — si no, bastaria redactar mal para perder trabajo previsto.
test('individual NO anula un requisito aceptado: solo se anota la señal', () => {
  const j = juzgar({
    titulo: 'Exportacion', cuerpo: 'En mi equipo necesitamos exportar informes.',
    requisitos: [req('REQ-03', 'Exportacion de informes', 'aceptado')],
  });
  assert.strictEqual(j.veredicto, 'aplica');
  assert.strictEqual(j.individual, true, 'la señal se conserva para que el humano la vea');
});

// ---------- la salida honesta ----------

test('sin nada escrito el veredicto es sin-criterio, NUNCA no-aplica', () => {
  const j = juzgar({ titulo: 'Integrar con el sistema de facturacion' });
  assert.strictEqual(j.veredicto, 'sin-criterio');
  assert.deepStrictEqual(j.excluye, []);
  assert.match(j.motivo, /nadie lo ha decidido|no es que no aplique/i, j.motivo);
  assert.match(j.motivo, /requisito|ADR/i, `debe nombrar la decision que falta: ${j.motivo}`);
});

test('tocar terreno de un ADR vigente sin requisito tampoco se descarta solo', () => {
  const j = juzgar({
    titulo: 'Cambiar el almacenamiento de credenciales',
    decisiones: [{ archivo: '2026-03-11-credenciales.md', titulo: 'Almacenamiento de credenciales', status: 'aceptada' }],
  });
  assert.strictEqual(j.veredicto, 'sin-criterio');
  assert.ok(j.excluye.some((e) => /credenciales/i.test(e)), JSON.stringify(j.excluye));
});

test('un ADR rechazado o sustituido no decide nada', () => {
  const base = { titulo: 'Cambiar el almacenamiento de credenciales' };
  for (const status of ['rechazada', 'sustituida', 'propuesta']) {
    const j = juzgar({ ...base, decisiones: [{ archivo: 'x.md', titulo: 'Almacenamiento de credenciales', status }] });
    assert.deepStrictEqual(j.excluye, [], `un ADR '${status}' no puede excluir nada`);
  }
});

// ---------- el comentario que se publica ----------

test('el comentario lleva veredicto y motivo: quien reporto lee ESTO, no el repo', () => {
  const j = juzgar({ titulo: 'X', fueraAlcance: ['Soporte multi-idioma en v1'], cuerpo: 'multi-idioma' });
  const c = comentario(j, { titulo: 'Soporte multi-idioma' });
  assert.match(c, /No aplica/);
  assert.match(c, /multi-idioma/);
  assert.match(c, /revisa|no es definitivo/i, 'un veredicto automatico sin derecho a replica quema al que reporta');
});

// ---------- leer el criterio del funcional ----------

const FUNCIONAL = `# Funcional

## Alcance y fuera de alcance

Lo que hace: gestionar el faseo.

### Fuera de alcance
- Integraciones con CRM propios del cliente
- Soporte multi-idioma en v1

## Requisitos funcionales
- RF-01 algo
`;

test('extrae las lineas del fuera de alcance y para en el siguiente apartado', () => {
  const f = fueraDeAlcance(FUNCIONAL);
  assert.deepStrictEqual(f, ['Integraciones con CRM propios del cliente', 'Soporte multi-idioma en v1']);
});

// El fallo que casi se cuela: bajo 'Alcance y fuera de alcance' lo PRIMERO es el alcance (lo que SI
// se hace). Leerlo como exclusion haria que el triaje citara "lo que el producto hace" como motivo
// para descartar algo — exactamente lo contrario de la verdad.
test('con subapartado propio, el alcance NO se lee como exclusion', () => {
  const f = fueraDeAlcance(FUNCIONAL);
  assert.ok(!f.some((l) => /gestionar el faseo/i.test(l)), `el alcance se colo como exclusion: ${JSON.stringify(f)}`);
});

test('el encabezado especifico gana al combinado aunque vaya despues', () => {
  const doc = `## Alcance y fuera de alcance
- Hace A
- Hace B

### Fuera de alcance
- No hace C
`;
  assert.deepStrictEqual(fueraDeAlcance(doc), ['No hace C']);
});

test('un subtitulo dentro del apartado no corta ni cuenta como exclusion', () => {
  const doc = `## Fuera de alcance

### Por ahora
- Multi-idioma

### Nunca
- Integraciones a medida

## Requisitos
- RF-01
`;
  assert.deepStrictEqual(fueraDeAlcance(doc), ['Multi-idioma', 'Integraciones a medida']);
});

test('acepta las variantes de redaccion del encabezado', () => {
  for (const h of ['## Fuera de alcance', '## Fuera del alcance', '## Alcance y fuera de alcance', '### 3. Fuera de alcance']) {
    assert.ok(fueraDeAlcance(`${h}\n- Algo concreto\n`).length === 1, `no reconoce '${h}'`);
  }
});

// Este es el fallo silencioso que motivo la validacion: la seccion existe (el contrato la exige) pero
// nadie comprobaba que tuviera algo debajo.
test('la seccion vacia se avisa: un encabezado sin contenido no es criterio', () => {
  const aviso = faltaFueraDeAlcance('# F\n\n## Fuera de alcance\n\n## Requisitos\n- RF-01\n', 'FUN-001.md');
  assert.ok(aviso, 'una seccion vacia tiene que avisar');
  assert.match(aviso, /vac[ií]o|VACIO/i, aviso);
});

test('un placeholder no cuenta como criterio', () => {
  for (const p of ['TBD', 'pendiente', 'N/A', '<por completar>', '...']) {
    assert.deepStrictEqual(fueraDeAlcance(`## Fuera de alcance\n- ${p}\n`), [], `'${p}' no es criterio`);
    assert.ok(faltaFueraDeAlcance(`# F\n## Fuera de alcance\n- ${p}\n`), `'${p}' deberia avisar`);
  }
});

test('sin el apartado avisa diciendo QUE se pierde, no solo que falta', () => {
  const aviso = faltaFueraDeAlcance('# F\n## Requisitos funcionales\n- RF-01\n', 'FUN-001.md');
  assert.ok(aviso);
  assert.match(aviso, /FUN/, 'debe citar el contrato que lo exige');
  assert.match(aviso, /sin criterio|no se hace|justificar/i, `debe decir la consecuencia: ${aviso}`);
});

test('un funcional correcto NO avisa: el silencio es lo normal', () => {
  assert.strictEqual(faltaFueraDeAlcance(FUNCIONAL, 'FUN-001.md'), null);
});

test('sin funcional no avisa por aqui (ya avisa el harness por otro lado)', () => {
  assert.strictEqual(faltaFueraDeAlcance('', 'x'), null);
  assert.strictEqual(faltaFueraDeAlcance(null, 'x'), null);
});

// ---------- completitud de los ADR (MADR) ----------
//
// FARO exige 4 secciones: las 3 obligatorias de MADR mas CONSECUENCIAS. Las otras 5 de MADR quedan
// opcionales a proposito: un ADR de 9 secciones cuesta media hora y a la tercera decision nadie lo
// escribe — y un ADR que no se escribio deja al triaje sin criterio igual que uno pobre.

const ADR_LEGACY = {
  archivo: '2026-01-14-cola.md', titulo: 'Cola de mensajes', status: 'aceptada',
  texto: '# Cola\n\n## Contexto\nHacia falta una cola.\n\n## Decision\nSQS.\n',
};
const ADR_COMPLETO = {
  archivo: '2026-05-02-cache.md', titulo: 'Cache de sesion', status: 'aceptada',
  texto: `# Cache

## Contexto y problema
Las sesiones se perdian entre despliegues.

## Alternativas consideradas
- Redis: descartada por coste operativo
- KV: elegida

## Decision
KV de Cloudflare.

## Consecuencias
Consistencia eventual: un login puede tardar en propagarse.
`,
};

test('detecta las secciones que faltan, no solo si el fichero existe', () => {
  assert.deepStrictEqual(seccionesQueFaltan(ADR_LEGACY), ['Alternativas consideradas', 'Consecuencias']);
  assert.deepStrictEqual(seccionesQueFaltan(ADR_COMPLETO), []);
});

// Mismo fallo silencioso que el fuera de alcance: el encabezado esta, debajo no hay nada.
test('una seccion con encabezado y sin contenido cuenta como que falta', () => {
  const vacio = { archivo: 'x.md', texto: '## Contexto\nAlgo.\n\n## Alternativas consideradas\n\n## Decision\nX.\n\n## Consecuencias\nY.\n' };
  assert.ok(seccionesQueFaltan(vacio).includes('Alternativas consideradas'));
});

test('acepta las redacciones equivalentes (es/en) sin marcar como incompleto lo correcto', () => {
  const en = { archivo: 'x.md', texto: '## Context\nA\n## Considered options\nB\n## Decision outcome\nC\n## Consequences\nD\n' };
  assert.deepStrictEqual(seccionesQueFaltan(en), []);
});

// La regla no puede romper lo que ya funcionaba: si validate se pone en rojo al actualizar el motor,
// el reflejo es desactivar la regla — y entonces se pierde tambien para los ADR nuevos.
test('un ADR LEGACY avisa pero NO bloquea', () => {
  const r = adrIncompleto(ADR_LEGACY, { legacy: true });
  assert.strictEqual(r.bloquea, false);
  assert.match(r.aviso, /anterior a la regla|no bloquea/i, r.aviso);
  assert.match(r.aviso, /se te preguntara|preguntar/i, `debe decir cuando se completara: ${r.aviso}`);
});

test('un ADR NUEVO incompleto si bloquea', () => {
  assert.strictEqual(adrIncompleto(ADR_LEGACY).bloquea, true);
});

test('un ADR completo no avisa ni en legacy ni en nuevo', () => {
  assert.strictEqual(adrIncompleto(ADR_COMPLETO, { legacy: true }), null);
  assert.strictEqual(adrIncompleto(ADR_COMPLETO), null);
});

// ---------- el triaje PIDE en vez de fingir ----------

// El caso que motivo todo: sin 'Alternativas consideradas' no se puede distinguir "se valoro y se
// descarto" de "nadie lo penso". Son opuestos, y emitir un veredicto sin saberlo seria inventarlo.
test('con un ADR incompleto el triaje no juzga: pide lo que falta', () => {
  const j = juzgar({ titulo: 'Usar Redis para la cola de mensajes', decisiones: [ADR_LEGACY] });
  assert.strictEqual(j.veredicto, 'falta-criterio-adr');
  assert.ok(Array.isArray(j.pedir) && j.pedir.length, 'debe decir QUE pedir');
  assert.strictEqual(j.pedir[0].archivo, '2026-01-14-cola.md');
  assert.ok(j.pedir[0].faltan.includes('Alternativas consideradas'));
  assert.match(j.motivo, /se valoro|se descarto|nunca se penso/i, j.motivo);
});

test('con el ADR completo ya no pide nada y vuelve a juzgar', () => {
  const j = juzgar({ titulo: 'Cambiar la cache de sesion', decisiones: [ADR_COMPLETO] });
  assert.notStrictEqual(j.veredicto, 'falta-criterio-adr');
  assert.ok(!j.pedir, 'no hay nada que pedir');
});

// Un ADR se completa PREGUNTANDO: dice lo que se decidio y por que, y eso solo lo sabe quien estuvo.
// Rellenarlo el agente seria fabricar historia y el triaje citaria algo que nadie decidio.
test('las preguntas son una por seccion que falta, y nombran el ADR', () => {
  const qs = preguntasADR(ADR_LEGACY);
  assert.strictEqual(qs.length, 2, JSON.stringify(qs));
  assert.ok(qs.every((q) => /Cola de mensajes/.test(q.pregunta)), JSON.stringify(qs));
  assert.ok(qs.some((q) => /descartaron|valoraron/i.test(q.pregunta)), 'falta la de alternativas');
});

test('un ADR completo no genera preguntas', () => {
  assert.deepStrictEqual(preguntasADR(ADR_COMPLETO), []);
});

// ---------- repo LEGACY que adopta FARO ----------
//
// Aqui el problema no es que los ADR esten incompletos: es que NO HAY. Las decisiones se tomaron (el
// codigo las demuestra) pero nunca se escribieron. Un triaje sobre un repo asi devuelve
// 'sin-criterio' a todo — util como diagnostico, inutil como ayuda. Por eso al adoptar se SIEMBRA el
// criterio preguntando, antes de que alguien use el triaje y se lleve la decepcion.

test('un repo sin nada escrito: dice que le falta y QUE preguntar', () => {
  const c = criterioDelRepo({});
  assert.strictEqual(c.listo, false);
  const qs = c.huecos.map((h) => h.que);
  assert.ok(qs.includes('funcional'), JSON.stringify(qs));
  assert.ok(qs.includes('decisiones'), JSON.stringify(qs));
  assert.ok(qs.includes('requisitos'), JSON.stringify(qs));
  assert.ok(c.huecos.every((h) => h.pregunta && h.falta), 'cada hueco trae su pregunta y el porque');
});

// El caso legacy tipico: hay decisiones tomadas, pero no escritas. La pregunta tiene que ir por ahi.
test('la pregunta por las decisiones asume que SE TOMARON, no que no existen', () => {
  const h = criterioDelRepo({}).huecos.find((x) => x.que === 'decisiones');
  assert.match(h.falta, /se tomaron|el codigo las demuestra/i, h.falta);
  assert.match(h.pregunta, /estructurales|descart/i, h.pregunta);
});

test('con funcional pero sin fuera de alcance, el unico hueco es ese', () => {
  const c = criterioDelRepo({
    funcional: '# F\n## Alcance\nHace cosas.\n',
    decisiones: [ADR_COMPLETO],
    requisitos: [req('REQ-01', 'Algo', 'aceptado')],
  });
  assert.deepStrictEqual(c.huecos.map((h) => h.que), ['fuera-de-alcance']);
  assert.strictEqual(c.exclusiones, 0);
});

test('un repo con criterio completo esta listo y no pregunta nada', () => {
  const c = criterioDelRepo({
    funcional: FUNCIONAL,
    decisiones: [ADR_COMPLETO],
    requisitos: [req('REQ-01', 'Algo', 'aceptado')],
  });
  assert.strictEqual(c.listo, true, JSON.stringify(c.huecos));
  assert.strictEqual(c.exclusiones, 2);
  assert.strictEqual(c.decisionesCompletas, 1);
});

// Cuenta lo que hay de verdad: un ADR cojo no suma criterio aunque exista el fichero.
test('los ADR cojos se cuentan aparte: existir no es aportar criterio', () => {
  const c = criterioDelRepo({ funcional: FUNCIONAL, decisiones: [ADR_LEGACY, ADR_COMPLETO], requisitos: [req('REQ-01', 'X', 'aceptado')] });
  assert.strictEqual(c.decisionesCompletas, 1);
  assert.strictEqual(c.decisionesCojas, 1);
});

// ---------- lo que llega de un canal de feedback ----------
//
// FARO NO construye el widget ni el transporte: eso es automatizacion del producto. Lo que hace es
// LEER lo que llegue al issue y juzgarlo mejor con ello. Por eso nada de esto es obligatorio: un
// reporte sin contexto se juzga igual, solo que con menos material.

const { contextoDelReporte, tipoDeReporte, senalesDelIssue, alcanceDeclarado } =
  require(path.join(HOOKS, 'lib', 'triaje.js'));

const REPORTE = `El boton de guardar no responde.

tipo: bug
url: https://app.x.com/leads
pantalla: Listado de leads
frecuencia: siempre
afecta a: a todos los usuarios
![captura](https://x.com/a.png)`;

test('lee el contexto que trae el widget, sin exigirle formato propio', () => {
  const c = contextoDelReporte(REPORTE);
  assert.strictEqual(c.url, 'https://app.x.com/leads');
  assert.strictEqual(c.pantalla, 'Listado de leads');
  assert.strictEqual(c.frecuencia, 'siempre');
  assert.strictEqual(c.captura, true, 'la captura se detecta, no se lee');
});

test('acepta las variantes de nombre de cada campo (el widget no es de FARO)', () => {
  assert.strictEqual(contextoDelReporte('enlace: https://x.com/a').url, 'https://x.com/a');
  assert.strictEqual(contextoDelReporte('- **Sección:** Ajustes').pantalla, 'Ajustes');
});

test('sin contexto no falla: se juzga con lo que haya', () => {
  assert.deepStrictEqual(contextoDelReporte('solo texto suelto'), {});
  assert.deepStrictEqual(contextoDelReporte(''), {});
});

// Un canal de feedback trae bugs, ideas y sugerencias MEZCLADOS, y cada uno se juzga contra una
// pregunta distinta: descartar una idea "porque no esta en la spec" es correcto; descartar un BUG
// por lo mismo seria absurdo — un fallo no necesita estar planificado para ser un fallo.
test('distingue bug / idea / sugerencia', () => {
  assert.strictEqual(tipoDeReporte('', 'tipo: bug'), 'bug', 'lo declarado manda');
  assert.strictEqual(tipoDeReporte('El boton no funciona', ''), 'bug', 'y si no, se infiere');
  assert.strictEqual(tipoDeReporte('', 'Me gustaría que hubiera exportación'), 'idea');
  assert.strictEqual(tipoDeReporte('', 'Sugiero mover el menú'), 'sugerencia');
});

test('sin señal NO clasifica: mejor null que una clase inventada', () => {
  assert.strictEqual(tipoDeReporte('Algo', 'texto neutro sin pistas'), null);
});

// ---------- los HECHOS mandan sobre el tono ----------
//
// El dato que mas cambia el veredicto es a CUANTOS afecta, y antes solo se inferia de COMO estaba
// redactado — lo que falla con cualquiera que escriba en primera persona sobre un problema general.

test('el campo "afecta a" declarado gana a la redaccion en primera persona', () => {
  const soloTexto = juzgar({ titulo: 'x', cuerpo: 'En mi caso el boton no responde' });
  assert.strictEqual(soloTexto.individual, true, 'el tono, solo, engaña');

  const conDato = juzgar({ titulo: 'x', cuerpo: 'En mi caso el boton no responde\nafecta a: a todos los usuarios' });
  assert.strictEqual(conDato.individual, false, 'el dato declarado manda sobre el tono');
});

test('el respaldo REAL del issue (votos, comentarios) gana a todo lo demas', () => {
  const j = juzgar({
    titulo: 'x', cuerpo: 'En mi caso el boton no responde',
    issue: { reactions: { '+1': 4 }, comments: 3 },
  });
  assert.strictEqual(j.individual, false, 'cuatro personas votandolo no es un caso individual');
  assert.strictEqual(j.senales.respaldado, true);
});

// Umbral bajo a proposito: con UN voto no hay señal (quien abre suele votarse solo), pero esperar a
// diez seria no enterarse nunca. Dos personas distintas ya descartan el caso unico.
test('un solo voto NO cuenta como respaldo (quien lo abre suele votarse)', () => {
  assert.strictEqual(senalesDelIssue({ reactions: { '+1': 1 }, comments: 0 }).respaldado, false);
  assert.strictEqual(senalesDelIssue({ reactions: { '+1': 2 }, comments: 0 }).respaldado, true);
});

test('distingue quien abre el issue: de dentro o de fuera', () => {
  assert.strictEqual(senalesDelIssue({ author_association: 'MEMBER' }).deDentro, true);
  assert.strictEqual(senalesDelIssue({ author_association: 'NONE' }).deDentro, false);
});

test('sin issue no revienta: el juicio sigue funcionando solo con el texto', () => {
  const j = juzgar({ titulo: 'x', cuerpo: 'algo' });
  assert.ok(j.senales, 'senales siempre existe, aunque venga vacio');
  assert.strictEqual(j.senales.respaldado, false);
});

test('el veredicto lleva el tipo y el contexto para que el humano los vea', () => {
  const j = juzgar({ titulo: 'El boton no responde', cuerpo: REPORTE });
  assert.strictEqual(j.tipo, 'bug');
  assert.strictEqual(j.contexto.pantalla, 'Listado de leads');
});

test('alcanceDeclarado devuelve null si no hay dato (no adivina)', () => {
  assert.strictEqual(alcanceDeclarado({}), null);
  assert.strictEqual(alcanceDeclarado({ alcance: 'no se' }), null);
  assert.strictEqual(alcanceDeclarado({ alcance: 'solo a mi' }), true);
  assert.strictEqual(alcanceDeclarado({ alcance: 'a todos los usuarios' }), false);
});
