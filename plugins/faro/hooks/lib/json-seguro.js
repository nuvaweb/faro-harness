// lib/json-seguro.js — ESCRITURA SEGURA de ficheros JSON compartidos entre procesos.
//
// El problema que resuelve, reproducido en el almacen de credenciales (~/.faro.json): varios sitios
// del harness leen un JSON, lo modifican y lo vuelven a escribir ENTERO. Entre la lectura y la
// escritura pueden pasar SEGUNDOS —el refresco en background invoca 'ramas.js --json', 6,6s medidos—
// y en esa ventana otro proceso puede haber guardado algo. Al escribir el objeto leido antes, ese
// algo DESAPARECE.
//
// Con credenciales el sintoma era "me desconecta cada dos por tres, tengo que volver a
// autenticarme", y nadie lo relacionaria jamas con el resumen de ramas del arranque de sesion.
//
// Son DOS fallos distintos y se arreglan por separado:
//
//   1) FICHERO A MEDIAS. Un writeFileSync interrumpido (proceso matado, disco lleno) deja el JSON
//      truncado y se pierde TODO el contenido, no solo lo que se estaba escribiendo.
//      -> Se escribe a un temporal y se RENOMBRA. El rename es atomico en el mismo volumen: o esta
//         el fichero viejo entero, o el nuevo entero. Nunca a medias.
//
//   2) PERDIDA POR COPIA OBSOLETA. Escribir lo que se leyo hace rato pisa lo de los demas.
//      -> Se RELEE justo antes de escribir y se fusiona. Lo que el escritor no conocia se conserva.
//
// Este modulo NO tiene estado ni dependencias del harness: es una utilidad pura sobre ficheros.
'use strict';
const fs = require('fs');

// Lee un JSON. Si no existe o esta corrupto, devuelve el valor por defecto en vez de reventar:
// quien llama esta arrancando una sesion, no puede permitirse una excepcion por un fichero ausente.
function leerJson(ruta, porDefecto = {}) {
  try { return JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch { return porDefecto; }
}

// Escribe un JSON de forma ATOMICA: temporal + rename. Nunca deja el fichero a medias.
// 'modo' son los permisos (0o600 para cualquier cosa con credenciales dentro).
// Devuelve true/false en vez de lanzar: los llamantes son hooks que no deben tumbar la sesion.
function escribirJsonAtomico(ruta, datos, modo = 0o600) {
  const tmp = `${ruta}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(datos, null, 2) + '\n', { mode: modo });
    try { fs.chmodSync(tmp, modo); } catch {}   // en Windows chmod puede no aplicar; no es fatal
    fs.renameSync(tmp, ruta);
    try { fs.chmodSync(ruta, modo); } catch {}
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}   // no dejar basura si fallo a mitad
    return false;
  }
}

// Fusiona lo que se va a escribir con lo que HAY en disco ahora mismo, para no pisar lo que otro
// proceso guardo mientras tanto.
//
// El criterio es deliberadamente CONSERVADOR y solo actua al primer nivel de claves: si una clave
// existe en disco y NO viene en lo que se escribe, se conserva. Nada de fusion profunda: mezclar en
// hondo objetos que no conoces produce estados que nadie diseño, y aqui el objetivo es no perder
// datos, no inventar merges listos.
//
// 'conocidas' es la foto de las claves que el escritor VIO al leer. Sirve para distinguir dos casos
// que de otro modo son indistinguibles:
//   - la clave no estaba cuando lei  -> es de otro, NO la piso (se conserva)
//   - la clave estaba y ya no la mando -> la borre a proposito (se respeta el borrado)
// Sin esto, la fusion haria IMPOSIBLE borrar nada.
function fusionarConDisco(ruta, datos, conocidas = null) {
  const enDisco = leerJson(ruta, null);
  if (!enDisco || typeof enDisco !== 'object') return datos;
  const salida = { ...datos };
  for (const clave of Object.keys(enDisco)) {
    if (clave in salida) continue;                         // lo que mando gana
    if (conocidas && clave in conocidas) continue;          // lo conocia y lo quito: borrado querido
    salida[clave] = enDisco[clave];                         // no lo conocia: es de otro, se conserva
  }
  return salida;
}

// Fusion de UN sub-objeto concreto (p. ej. 'tokens'), con el mismo criterio. Hace falta porque el
// dato que de verdad no se puede perder suele vivir dentro de una clave, no al primer nivel: un
// resumen se recalcula solo, pero una credencial hay que volver a pedirsela al usuario.
function fusionarSubobjeto(ruta, datos, clave, conocidas = null) {
  const enDisco = leerJson(ruta, null);
  if (!enDisco || typeof enDisco !== 'object' || !enDisco[clave] || typeof enDisco[clave] !== 'object') return datos;
  const mios = (datos && datos[clave]) || {};
  const fusion = { ...mios };
  for (const k of Object.keys(enDisco[clave])) {
    if (k in mios) continue;
    if (conocidas && k in conocidas) continue;
    fusion[k] = enDisco[clave][k];
  }
  return { ...datos, [clave]: fusion };
}

module.exports = { leerJson, escribirJsonAtomico, fusionarConDisco, fusionarSubobjeto };
