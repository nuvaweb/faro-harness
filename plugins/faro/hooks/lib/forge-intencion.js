// lib/forge-intencion.js — Comandos por INTENCION para skills y agentes: leer, comentar y editar una
// tarea o pedir revision sin escribir rutas de una API concreta. Cada uno llama al adaptador de la forja.
'use strict';
const fs = require('fs');

const num = (v) => { const s = String(v || '').replace(/^#/, ''); return /^\d+$/.test(s) ? s : null; };
const SIN_TOKEN = 'SIN_TOKEN: conectate con  node .claude/hooks/harness.js auth.';
function valor(argv, flag) { const i = argv.indexOf(flag); return i >= 0 ? (argv[i + 1] === undefined ? '' : argv[i + 1]) : null; }

// harness.js issue <N> [--comentarios] [--cuerpo "<texto>" | --cuerpo-fichero <ruta>]
async function cmdIssue(m, argv) {
  const n = num(argv[0]);
  if (!n) { console.log('Uso: harness.js issue <N> [--comentarios] [--cuerpo "<texto>" | --cuerpo-fichero <ruta>]'); process.exit(1); }
  const fichero = valor(argv, '--cuerpo-fichero');
  const cuerpo = fichero !== null ? fs.readFileSync(fichero, 'utf8') : valor(argv, '--cuerpo');
  if (cuerpo !== null) {
    const r = await m.editarCuerpoIssue(n, cuerpo);
    if (r.sinToken) { console.log(SIN_TOKEN); process.exit(2); }
    console.log(r.ok ? `✅ Cuerpo de #${n} actualizado.` : `No pude actualizar #${n} (HTTP ${r.status}).`);
    if (!r.ok) process.exit(1);
    return;
  }
  const r = await m.leerIssue(n);
  if (r.sinToken) { console.log(SIN_TOKEN); process.exit(2); }
  if (!r.ok || !r.body) { console.log(`No pude leer el issue #${n} (HTTP ${r.status}).`); process.exit(1); }
  const salida = { ...r.body };
  if (argv.includes('--comentarios')) salida.comentarios = (await m.leerComentarios(n)) || [];
  process.stdout.write(JSON.stringify(salida, null, 2) + '\n');
}

// harness.js comentar <N> "<texto>"
async function cmdComentar(m, argv) {
  const n = num(argv[0]), texto = argv[1];
  if (!n || !texto) { console.log('Uso: harness.js comentar <N> "<texto>"'); process.exit(1); }
  const ok = await m.comentarIssue(n, texto);
  console.log(ok ? `✅ Comentado en #${n}.` : `No pude comentar en #${n} (¿sin token? harness.js auth).`);
  if (!ok) process.exit(1);
}

// harness.js pr revisor <N> <login> [<login>...]
async function cmdPrRevisor(m, argv) {
  const n = num(argv[0]), logins = argv.slice(1).map((l) => l.replace(/^@/, ''));
  if (!n || !logins.length) { console.log('Uso: harness.js pr revisor <N> <login> [<login>...]'); process.exit(1); }
  const ok = await m.pedirRevision(n, logins);
  console.log(ok ? `✅ Revision de #${n} pedida a ${logins.join(', ')}.` : `No pude pedir la revision de #${n}.`);
  if (!ok) process.exit(1);
}

module.exports = { cmdIssue, cmdComentar, cmdPrRevisor };
