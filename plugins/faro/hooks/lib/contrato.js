// lib/contrato.js — DERIVA entre el contrato DOCUMENTADO y el que el codigo expone de verdad.
//
// Por que existe: los gates responden "¿compila? ¿pasan los tests?" y la evidencia responde "¿esta
// probado lo pactado?". Falta una tercera pregunta, y es la que rompe integraciones ajenas:
// **¿lo que el codigo expone HOY sigue siendo lo que el documento dice que expone?**
//
// El caso tipico no es un fallo: es un exito a medias. Alguien anade un campo al body, o una ruta
// nueva, o cambia un 200 por un 201. Todo pasa —los tests son suyos y los actualizo— pero el
// funcional que leyo el cliente (o el equipo de enfrente) ya no describe la realidad. Nadie se
// entera hasta que alguien integra contra el documento y falla.
//
// Esto AVISA, no bloquea: una deriva puede ser deliberada (se amplio el contrato a proposito y toca
// actualizar el doc) o un descuido. Quien lo sabe es el humano. Como gate seria contraproducente —
// se sortearia borrando la linea del documento, que es exactamente lo contrario de lo que se busca.
//
// Logica PURA: recibe textos y devuelve la comparacion. Ni lee disco ni ejecuta nada.
'use strict';

// --- lo DOCUMENTADO -------------------------------------------------------
// Se acepta la forma en que la gente escribe endpoints de verdad en un funcional, no un formato
// inventado que nadie seguiria: 'POST /leads', '- `GET /users/:id`', '| PUT | /x |'. Exigir una
// sintaxis propia para poder comparar garantizaria que no hay nada que comparar.
const METODOS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';
// Entre el metodo y la ruta se admite lo que separa una TABLA markdown ('| DELETE | /x |') o una
// lista, no solo un espacio: en un funcional real los endpoints van tabulados mas veces que en
// prosa. Y sin distinguir mayusculas, porque 'post /leads' en minuscula es el mismo endpoint — una
// deteccion sensible a eso solo generaria falsas derivas.
const RE_DOC = new RegExp(`\\b(${METODOS})\\b[\\s|:·\\-]*(\\/[\\w\\-{}:\\/\\[\\].]*)`, 'gi');

// --- lo que el CODIGO expone ----------------------------------------------
// Los routers mas usados en Workers/Node declaran la ruta igual: app.get('/x'), router.post("/y").
// Se cubre tambien Hono (app.on(['GET','POST'], '/x')) por ser el mas comun en Cloudflare.
const RE_CODIGO = new RegExp(`\\.\\s*(${METODOS.toLowerCase()})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, 'gi');
const RE_CODIGO_ON = /\.\s*on\s*\(\s*\[([^\]]+)\]\s*,\s*['"`]([^'"`]+)['"`]/gi;

// Dos rutas son la misma aunque nombren distinto sus parametros: /users/:id y /users/{userId}
// describen el mismo endpoint. Comparar literalmente daria falsas derivas en cada repo que mezcle
// convenciones entre el documento y el codigo, que son casi todos.
function normalizar(ruta) {
  return String(ruta || '')
    .replace(/\{[^}]*\}|:[\w-]+|\[[^\]]*\]/g, ':p')   // parametros -> marcador comun
    .replace(/\/+$/, '')                               // barra final irrelevante
    .toLowerCase() || '/';
}

const clave = (m, r) => `${String(m).toUpperCase()} ${normalizar(r)}`;

/** Endpoints citados en un documento (funcional, spec, ARQ). */
function endpointsDocumentados(texto) {
  const out = new Map();
  for (const m of String(texto || '').matchAll(RE_DOC)) {
    const k = clave(m[1], m[2]);
    if (!out.has(k)) out.set(k, { metodo: m[1].toUpperCase(), ruta: m[2], clave: k });
  }
  return [...out.values()];
}

/** Endpoints que el codigo registra de verdad. 'ficheros' = [{rel, texto}]. */
function endpointsEnCodigo(ficheros) {
  const out = new Map();
  for (const f of ficheros || []) {
    const t = String((f && f.texto) || '');
    const anota = (metodo, ruta) => {
      const k = clave(metodo, ruta);
      if (!out.has(k)) out.set(k, { metodo: metodo.toUpperCase(), ruta, clave: k, donde: f.rel });
    };
    for (const m of t.matchAll(RE_CODIGO)) anota(m[1], m[2]);
    // app.on(['GET','POST'], '/x', ...) registra VARIOS metodos de una vez.
    for (const m of t.matchAll(RE_CODIGO_ON)) {
      for (const met of m[1].split(',')) {
        const limpio = met.trim().replace(/['"`]/g, '');
        if (new RegExp(`^(${METODOS})$`, 'i').test(limpio)) anota(limpio, m[2]);
      }
    }
  }
  return [...out.values()];
}

/**
 * Compara los dos lados. Devuelve las dos derivas, que NO son el mismo problema:
 *   - 'sinDocumentar': el codigo expone algo que el documento no cuenta. Superficie invisible: nadie
 *     sabe que existe, nadie lo mantiene a proposito, y cuando se rompa nadie lo echara de menos
 *     hasta que un tercero lo estuviera usando.
 *   - 'sinImplementar': el documento promete algo que el codigo no tiene. Es lo que hace que alguien
 *     integre contra el papel y se estrelle — el mas caro de los dos, porque ya hay quien confia.
 */
function derivaDeContrato(textoDoc, ficherosCodigo) {
  const doc = endpointsDocumentados(textoDoc);
  const cod = endpointsEnCodigo(ficherosCodigo);
  const enDoc = new Set(doc.map((e) => e.clave));
  const enCod = new Set(cod.map((e) => e.clave));
  return {
    documentados: doc.length,
    implementados: cod.length,
    coinciden: doc.filter((e) => enCod.has(e.clave)).length,
    sinDocumentar: cod.filter((e) => !enDoc.has(e.clave)),
    sinImplementar: doc.filter((e) => !enCod.has(e.clave)),
  };
}

/**
 * El aviso, en llano. null cuando todo cuadra: el silencio es lo normal, y un aviso que salta
 * siempre se aprende a ignorar.
 * Tambien devuelve null si NO HAY NADA que comparar (ni documento con endpoints, ni codigo con
 * rutas): eso no es "cuadra", es que aqui no aplica — y decirlo cada vez seria ruido puro.
 */
function avisoDeriva(d, { doc = 'el funcional' } = {}) {
  if (!d || (!d.documentados && !d.implementados)) return null;
  if (!d.sinDocumentar.length && !d.sinImplementar.length) return null;
  const l = [];
  if (d.sinImplementar.length) {
    l.push(`${d.sinImplementar.length} endpoint(s) que ${doc} PROMETE y el codigo no expone: ` +
      d.sinImplementar.map((e) => `${e.metodo} ${e.ruta}`).join(', ') + '.');
    l.push('  Quien integre leyendo el documento se estrellara. O se implementa, o el documento deja de prometerlo.');
  }
  if (d.sinDocumentar.length) {
    l.push(`${d.sinDocumentar.length} endpoint(s) que el codigo EXPONE y ${doc} no cuenta: ` +
      d.sinDocumentar.map((e) => `${e.metodo} ${e.ruta} (${e.donde})`).join(', ') + '.');
    l.push('  Superficie invisible: nadie sabe que existe, y si alguien la esta usando, se rompera sin que nadie lo prevea.');
  }
  l.push('  Puede ser deliberado (se amplio el alcance y toca actualizar el documento) o un descuido. No bloquea: decidelo tu.');
  return l.join('\n');
}

module.exports = { endpointsDocumentados, endpointsEnCodigo, derivaDeContrato, avisoDeriva, normalizar };
