// lib/ears.js — EARS (Easy Approach to Requirements Syntax): gramatica fija para los requisitos
// normativos de los deltas. Cinco formas, ni una mas. DETECTOR PURO (clasifica y sugiere, no decide).
//
// Por que: el motor ya exigia texto NORMATIVO (DEBE/SHALL/MUST) y >=1 escenario, pero no decia nada
// de la CONDICION. Asi, "el sistema DEBE validar correctamente los documentos" pasaba el gate: lleva
// DEBE, tiene escenario, y no dice ni CUANDO aplica ni que es "correctamente". EARS pone la condicion
// DELANTE y con palabra fija, y entonces el escenario de prueba se escribe solo.
//
// EL CHEQUEO QUE DE VERDAD APORTA no es "empieza por CUANDO" (eso lo cumple cualquiera copiando la
// plantilla), sino detectar la CONDICION ENTERRADA a mitad de frase: "el sistema DEBE rechazar el
// commit si contiene un secreto" tiene la condicion escondida detras del DEBE. Sacarla al principio
// obliga a decidir cual es el disparador exacto, que es donde se cae la ambiguedad.
//
// Adopcion GRADUAL a proposito: por defecto AVISA. Un gate duro invalidaria de golpe las specs ya
// escritas en todos los repos, y un equipo no puede reescribir su historia para actualizar el plugin.
// Un repo que quiera exigirlo lo declara en faro-schema.json (enums.ears.modo = "gate").
'use strict';

module.exports = function (ctx) {
  const { faroSchema } = ctx;

  // Las CINCO formas. Cada una: nombre, palabra(s) de apertura y plantilla para el mensaje.
  // Bilingue (es/en) como el resto del motor de specs.
  const FORMAS = [
    {
      id: 'evento',
      nombre: 'dirigida por EVENTO',
      re: /^\s*(?:CUANDO|WHEN)\b/i,
      plantilla: 'CUANDO <disparador>, el <sistema> DEBE <respuesta>',
      cuando: 'el requisito reacciona a algo que OCURRE',
    },
    {
      id: 'estado',
      nombre: 'dirigida por ESTADO',
      re: /^\s*(?:MIENTRAS|WHILE)\b/i,
      plantilla: 'MIENTRAS <estado>, el <sistema> DEBE <respuesta>',
      cuando: 'el requisito vale DURANTE una situacion',
    },
    {
      id: 'opcional',
      nombre: 'de caracteristica OPCIONAL',
      re: /^\s*(?:DONDE|WHERE)\b/i,
      plantilla: 'DONDE <caracteristica> este incluida, el <sistema> DEBE <respuesta>',
      cuando: 'solo aplica si esa parte del sistema existe',
    },
    {
      id: 'no_deseada',
      nombre: 'de comportamiento NO DESEADO',
      re: /^\s*(?:SI|IF)\b/i,
      plantilla: 'SI <condicion no deseada>, ENTONCES el <sistema> DEBE <respuesta>',
      cuando: 'errores, fallos y casos que no deberian pasar',
    },
  ];
  // La quinta (UBICUA) no tiene palabra de apertura: es la que aplica SIEMPRE, sin condicion.
  const UBICUA = { id: 'ubicua', nombre: 'UBICUA (sin condicion)', plantilla: 'El <sistema> DEBE <respuesta>', cuando: 'siempre activo' };

  // Palabras que introducen una condicion. Si aparecen DESPUES del verbo normativo, la condicion
  // esta enterrada: es el caso que EARS existe para evitar.
  const RE_CONDICION_INTERNA = /\b(?:cuando|mientras|si\s+(?!no\b)|en\s+caso\s+de|siempre\s+que|salvo\s+que|a\s+menos\s+que|when|while|if|unless|in\s+case\s+of)\b/i;
  // FALSO POSITIVO del espanol: "si" es tambien PREGUNTA INDIRECTA ("resolver SI el proyecto vive
  // en GitHub" = "whether", no "if"). Ahi no hay condicion ninguna, y avisar seria ruido — y un aviso
  // que es ruido acaba desactivando el gate entero. Se detecta por el verbo que lo precede.
  // El verbo y el "si" pueden ir separados por un inciso ("resolver, a partir de la URL, si..."),
  // asi que se admite texto intermedio sin punto ni conjuncion que abra otra oracion.
  const RE_SI_INTERROGATIVO = /\b(?:sabe[rn]?|resolver|resuelve\w*|comproba\w*|compruebe?\w*|determina\w*|decidi\w*|decide\w*|indica\w*|verifica\w*|valida\w*|detecta\w*|distingu\w*|averigua\w*|consulta\w*|preguntar?\w*|evalua\w*|dice\w*|declara\w*|report\w*)\b[^.;]{0,80}?\bsi\b/i;
  const RE_NORMATIVO = /\b(SHALL|MUST|DEBE(?:RA|RÁ)?N?|OBLIGATORIO)\b/i;

  function modo() {
    const s = faroSchema();
    const e = (s && s.enums && s.enums.ears) || {};
    return e.modo === 'gate' ? 'gate' : 'aviso';
  }

  // clasificar(texto) -> { forma, ok, motivo, sugerencia }
  //   ok=true  : encaja en una de las cinco formas sin condicion enterrada
  //   ok=false : hay una condicion escondida detras del verbo normativo
  function clasificar(texto) {
    const t = String(texto || '').trim();
    if (!t) return { forma: null, ok: false, motivo: 'requisito sin texto' };

    const abre = FORMAS.find((f) => f.re.test(t));
    if (abre) {
      // Forma tipada correcta. Solo queda un detalle: la de comportamiento no deseado necesita ENTONCES.
      if (abre.id === 'no_deseada' && !/\b(?:ENTONCES|THEN)\b/i.test(t)) {
        return {
          forma: abre.id, ok: false,
          motivo: `empieza por SI pero le falta el ENTONCES que separa la condicion de la respuesta`,
          sugerencia: abre.plantilla,
        };
      }
      return { forma: abre.id, ok: true };
    }

    // Sin palabra de apertura: es UBICUA... salvo que esconda una condicion detras del DEBE.
    const mNorm = t.match(RE_NORMATIVO);
    if (mNorm) {
      const cola = t.slice(mNorm.index + mNorm[0].length);
      let cond = cola.match(RE_CONDICION_INTERNA);
      // Si lo unico que se encontro es un "si" de pregunta indirecta, no hay condicion que sacar.
      if (cond && /^si\b/i.test(cond[0].trim()) && RE_SI_INTERROGATIVO.test(cola)) cond = null;
      if (cond) {
        const palabra = cond[0].trim().toLowerCase();
        const sug = /^(si|if|salvo|a menos|unless)/.test(palabra) ? FORMAS[3]
          : /^(mientras|while)/.test(palabra) ? FORMAS[1]
          : FORMAS[0];
        return {
          forma: null, ok: false,
          motivo: `la condicion ("${cond[0].trim()}") va DETRAS del verbo normativo, escondida en la frase`,
          sugerencia: sug.plantilla,
        };
      }
    }
    return { forma: UBICUA.id, ok: true };
  }

  // Mensaje de ayuda con las cinco plantillas, para cuando algo no encaja.
  function ayuda() {
    return [
      'EARS — un requisito normativo toma UNA de estas cinco formas, y la condicion va DELANTE:',
      ...FORMAS.map((f) => `  · ${f.plantilla}   (${f.cuando})`),
      `  · ${UBICUA.plantilla}   (${UBICUA.cuando})`,
      'Poner la condicion delante obliga a decidir el disparador exacto — y entonces el escenario de prueba se escribe solo.',
    ].join('\n');
  }

  return { clasificar, ayuda, modo, FORMAS, UBICUA };
};
