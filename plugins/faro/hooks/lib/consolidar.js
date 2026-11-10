// lib/consolidar.js — QUE integra `consolidar` y CON QUE se valida (#226). Puro: sin git ni red.
//
// Antes integraba TODAS las ramas de trabajo locales sin integrar y lanzaba siempre `validate --todas`
// (los gates de todas las apps). Con 17 ramas locales y un solo PR pedido, metia en develop trabajo que
// nadie habia pedido integrar y saturaba la maquina validando apps que ninguna rama tocaba.
'use strict';

const sinAlmohadilla = (p) => String(p).trim().replace(/^#/, '');
const prAbiertoADevelop = (p) => p && p.state === 'open' && (!p.base || p.base.ref === 'develop');

/**
 * Ramas a integrar.
 * - pedidas: lo que el usuario nombro (numero de PR, numero de issue o nombre de rama). Entra SOLO eso.
 * - sin pedidas: solo las ramas con un PR abierto a develop. Si los PRs no se pudieron consultar
 *   (prs === null), no entra nada: integrar a ciegas es lo que habia que evitar.
 * - todasLasRamas: el comportamiento anterior (todas las ramas sin integrar).
 * prs: Map rama -> PR[] (de la forja) o null si no se pudo consultar.
 * -> { ramas, sinPr, noEncontradas, sinConsultar }
 */
function seleccionarRamas({ ramas, pedidas = [], prs = null, issueDeRama, todasLasRamas = false }) {
  const lista = ramas || [];
  const prsDe = (r) => (prs && prs.get(r)) || [];
  if (todasLasRamas) return { ramas: [...lista], sinPr: [], noEncontradas: [], sinConsultar: false };
  if (pedidas.length) {
    const elegidas = [];
    const noEncontradas = [];
    for (const p of pedidas) {
      const v = sinAlmohadilla(p);
      const r = lista.includes(v) ? v
        : /^\d+$/.test(v) ? lista.find((x) => prsDe(x).some((q) => String(q.number) === v)) || lista.find((x) => issueDeRama(x) === v)
          : null;
      if (r && !elegidas.includes(r)) elegidas.push(r);
      else if (!r) noEncontradas.push(String(p));
    }
    return { ramas: elegidas, sinPr: [], noEncontradas, sinConsultar: false };
  }
  if (prs === null) return { ramas: [], sinPr: [], noEncontradas: [], sinConsultar: true };
  const conPr = lista.filter((r) => prsDe(r).some(prAbiertoADevelop));
  return { ramas: conPr, sinPr: lista.filter((r) => !conPr.includes(r)), noEncontradas: [], sinConsultar: false };
}

/**
 * Argumentos de `validate` para lo que se integra: en un monorepo, solo los gates de las apps que tocan
 * las ramas (ninguna app tocada -> ninguna gate, solo el ciclo); en un repo simple, sus gates (--gates).
 * `todas` fuerza la bateria completa (consolidar --todas).
 */
function argsValidate({ monorepo, apps = [], todas = false }) {
  if (todas) return ['validate', '--todas'];
  if (!monorepo) return ['validate', '--gates'];
  return apps.length ? ['validate', '--app', apps.join(',')] : ['validate'];
}

module.exports = { seleccionarRamas, argsValidate };
