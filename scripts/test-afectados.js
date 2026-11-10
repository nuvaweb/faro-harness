#!/usr/bin/env node
// scripts/test-afectados.js — tests del MOTOR por dominio (#178).
//
//   npm run test:afectados            los tests de los dominios que toca tu cambio (git diff contra la base)
//   npm run test:dominio -- <nombre>  todos los tests de un dominio (sin los marcados `lento`; `--lentos` los incluye)
//   --lista                           solo imprime los ficheros de test, no ejecuta
//   --base <ref>                      base del diff (por defecto, el merge-base con origin/develop|develop|main)
//   --app <ruta>                      acota a una app (monorepo); si el cambio toca varias, el comando PREGUNTA cual
//
// La suite completa queda para CI y /faro:publicar (`npm test`): el agente no la lanza salvo peticion expresa del usuario.
// Un verde anota lo validado (.git/faro-tests-verdes.json): la siguiente vez solo entra lo que ha cambiado desde
// entonces, y un fichero que solo cambia en textos no arrastra dependientes (#198, lib/validado.js).
// Toda la logica (dominios, grafo require/import, regla interior/contrato/transversal, etiqueta `lento`) vive en
// plugins/faro/hooks/lib/dominios.js, el mismo servicio que usa el hook TDD de los repos de trabajo; los dominios
// del motor se declaran en .faro.json > tests.dominios. Aqui solo se ejecuta: argv fijo, sin shell.
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const dom = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'dominios.js'));
const val = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'validado.js'));

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const valor = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const RE_RUTA = /^test\/[\w.-]+\.test\.mjs$/;

function main() {
  const cfg = dom.config(RAIZ);
  if (!cfg.declarado) { console.error('Sin .faro.json > tests.dominios: nada que deducir. Usa `npm test` (suite completa).'); return 2; }
  const ctx = dom.contexto(RAIZ, { cfg });
  const total = ctx.lista.filter((f) => /^test\/.*\.test\.mjs$/.test(f)).length;
  let tests; let porque; let foto = null;
  const nombre = valor('--dominio');
  if (flag('--dominio') && !nombre) { console.error(`Uso: npm run test:dominio -- <nombre>. Dominios: ${Object.keys(cfg.dominios).join(', ')}`); return 2; }
  if (nombre) {
    if (!cfg.dominios[nombre]) { console.error(`El dominio '${dom.unaLinea(nombre, 40)}' no existe. Dominios: ${Object.keys(cfg.dominios).join(', ')}`); return 2; }
    const d = ctx.dominios[nombre];
    tests = d.testsF.filter((t) => flag('--lentos') || !d.lentoF.includes(t));
    porque = `dominio ${nombre}`;
  } else {
    const malApp = dom.appInvalida(ctx, flag('--app'), valor('--app'));
    if (malApp) { console.error(malApp); return 2; }
    const pv = dom.porValidar(RAIZ, valor('--base'));
    const r = dom.resolver(RAIZ, pv.cambiados, { ctx, app: valor('--app'), soloTexto: pv.soloTexto });
    if (pv.validados.length) console.error(`ⓘ ${pv.validados.length} fichero(s) ya validados en verde y sin cambios desde entonces: fuera.`);
    if (pv.soloTexto.size) console.error(`ⓘ solo cambian en textos (interior, sin dependientes): ${[...pv.soloTexto].join(', ')}`);
    foto = { ficheros: pv.cambiados };
    tests = r.tests;
    porque = r.afectados.length ? `dominios afectados: ${r.afectados.map((a) => `${a.dominio} (${a.motivo})`).join(', ')}` : 'ningún dominio afectado';
    const pq = dom.textoPreguntas(r.preguntas, { repetir: 'npm run test:afectados --' });
    if (pq) console.error(pq);
    // varias apps sin elegir: no se decide por el usuario; nada se ejecuta hasta que responda (--app <x>|todas)
    if (r.preguntas.some((p) => p.tipo === 'app')) { console.log('Nada ejecutado: falta elegir la app (--app).'); return 0; }
    if (r.lentosOmitidos.length) console.error(`ⓘ ${r.lentosOmitidos.length} test(s) lentos fuera (entran si tocas su módulo): ${r.lentosOmitidos.join(', ')}`);
  }
  tests = tests.filter((t) => RE_RUTA.test(t)).sort();
  if (!tests.length) { console.log(`Nada que ejecutar (${porque}).`); return 0; }
  console.log(`${tests.length} de ${total} tests (${Math.round((tests.length / total) * 100)} %) · ${porque}`);
  if (flag('--lista')) { console.log(tests.join('\n')); return 0; }
  // lo que se valida es el contenido de AHORA (si se edita durante la ejecucion, eso ya no queda validado)
  if (foto && !valor('--app')) foto.instantanea = val.instantanea(RAIZ, foto.ficheros);
  const t0 = Date.now();
  // test/run.js fija el entorno aislado de la suite (credenciales, datos del plugin); serie, como `npm test`.
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'test', 'run.js'), '--test-concurrency=1', ...tests], { cwd: RAIZ, stdio: 'inherit', windowsHide: true });
  console.log(`\n${tests.length} tests en ${Math.round((Date.now() - t0) / 1000)} s (la suite completa queda para CI y /faro:publicar).`);
  if (r.status === 0 && foto && foto.instantanea) val.registrarVerde(RAIZ, foto.instantanea);
  return r.status == null ? 1 : r.status;
}

process.exitCode = main();
