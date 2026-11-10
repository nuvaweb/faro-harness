// lib/validador-json.js — validador MINIMO del subconjunto de JSON Schema que usa el motor.
//
// El motor no tiene node_modules, asi que no hay ajv: este modulo implementa solo lo que los esquemas
// propios necesitan (tarea.schema.json) y nada mas: type (uno o varios), enum, const, required,
// properties, additionalProperties (false o esquema), propertyNames.pattern, items, pattern,
// minLength, minimum, format (date, date-time UTC) y oneOf. Una palabra clave que no conoce se
// IGNORA (el esquema es nuestro: no hay que defenderse de uno ajeno).
//
// validar(schema, valor) -> string[] con un mensaje por incumplimiento, SIEMPRE con la ruta del
// campo ('fechas.objetivo', 'cambios[0].estado'). Vacio = valido. Puro: sin disco ni red.
'use strict';

const tipoDe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const cumpleTipo = (t, v) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : tipoDe(v) === t);

function fechaValida(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
function fechaHoraValida(s) {
  const m = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?Z$/.exec(s);
  return !!m && fechaValida(m[1]);
}
const FORMATOS = { date: fechaValida, 'date-time': fechaHoraValida };

const dondeDe = (ruta) => ruta || '(raiz)';
const hijo = (ruta, clave) => (ruta ? `${ruta}.${clave}` : clave);

function validarEn(schema, valor, ruta, out) {
  if (!schema || typeof schema !== 'object') return;
  const donde = dondeDe(ruta);

  if (schema.oneOf) {
    const aciertos = schema.oneOf.filter((s) => { const o = []; validarEn(s, valor, ruta, o); return o.length === 0; });
    if (aciertos.length !== 1) out.push(`${donde}: no cumple ninguna de las formas permitidas`);
    return;
  }
  if ('const' in schema && valor !== schema.const) { out.push(`${donde}: debe valer ${JSON.stringify(schema.const)}`); return; }
  if (schema.type) {
    const tipos = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!tipos.some((t) => cumpleTipo(t, valor))) { out.push(`${donde}: debe ser ${tipos.join(' o ')} (es ${tipoDe(valor)})`); return; }
  }
  if (schema.enum && !schema.enum.includes(valor)) out.push(`${donde}: '${valor}' no es uno de ${schema.enum.join(', ')}`);

  if (typeof valor === 'string') {
    if (schema.minLength != null && valor.length < schema.minLength) out.push(`${donde}: no puede estar vacio`);
    if (schema.pattern && !new RegExp(schema.pattern).test(valor)) out.push(`${donde}: '${valor}' no cumple el formato ${schema.pattern}`);
    if (schema.format && FORMATOS[schema.format] && !FORMATOS[schema.format](valor)) out.push(`${donde}: '${valor}' no es una ${schema.format === 'date' ? 'fecha AAAA-MM-DD valida' : 'fecha-hora ISO 8601 UTC valida (AAAA-MM-DDThh:mm:ssZ)'}`);
  }
  if (typeof valor === 'number' && schema.minimum != null && valor < schema.minimum) out.push(`${donde}: debe ser >= ${schema.minimum}`);

  if (Array.isArray(valor) && schema.items) valor.forEach((el, i) => validarEn(schema.items, el, `${ruta}[${i}]`, out));

  if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
    const props = schema.properties || {};
    for (const r of schema.required || []) if (!Object.prototype.hasOwnProperty.call(valor, r)) out.push(`${hijo(ruta, r)}: falta (obligatorio)`);
    for (const k of Object.keys(valor)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) validarEn(props[k], valor[k], hijo(ruta, k), out);
      else if (schema.additionalProperties === false) out.push(`${hijo(ruta, k)}: campo desconocido (el nucleo es cerrado; lo propio va en 'extensiones')`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validarEn(schema.additionalProperties, valor[k], hijo(ruta, k), out);
      if (schema.propertyNames && schema.propertyNames.pattern && !new RegExp(schema.propertyNames.pattern).test(k)) out.push(`${hijo(ruta, k)}: la clave debe llevar prefijo 'espacio.clave'`);
    }
  }
}

function validar(schema, valor) { const out = []; validarEn(schema, valor, '', out); return out; }

module.exports = { validar, fechaValida, fechaHoraValida };
