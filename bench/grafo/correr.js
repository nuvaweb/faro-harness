#!/usr/bin/env node
// bench/grafo/correr.js — ejecuta el banco de medida del grafo FARO (#308).
//
//   node bench/grafo/correr.js --tareas bench/grafo/tareas.ejemplo.json [--brazos frio,empuje,demanda]
//        [--repeticiones 1] [--solo t1,t2] [--salida <dir>] [--modelo <m>] [--minutos 20]
//   node bench/grafo/correr.js --informe <dir>      (rehace informe.md con lo ya medido)
//
// Cada ejecución trabaja en un CLON desechable del repo de la tarea (el original no se toca), con
// el plugin de este repo cargado por --plugin-dir y el instalado apagado. Cuesta sesiones reales de
// Claude: el número de ejecuciones es tareas × brazos × repeticiones, y se enseña antes de empezar.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const B = require('./banco.js');

function args(argv) {
  const o = { brazos: B.BRAZOS, repeticiones: 1, minutos: 20 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === '--tareas') { o.tareas = v; i++; }
    else if (argv[i] === '--brazos') { o.brazos = v.split(','); i++; }
    else if (argv[i] === '--repeticiones') { o.repeticiones = Math.max(1, parseInt(v, 10) || 1); i++; }
    else if (argv[i] === '--solo') { o.solo = v.split(','); i++; }
    else if (argv[i] === '--salida') { o.salida = v; i++; }
    else if (argv[i] === '--modelo') { o.modelo = v; i++; }
    else if (argv[i] === '--minutos') { o.minutos = Math.max(1, parseInt(v, 10) || 20); i++; }
    else if (argv[i] === '--informe') { o.informe = v; i++; }
  }
  return o;
}

const leerResultados = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
  .filter((r) => r && r.brazo);

function escribirInforme(dir) {
  const md = B.informe(leerResultados(dir));
  fs.writeFileSync(path.join(dir, 'informe.md'), md);
  process.stdout.write(md);
}

function clonar(ruta, ref) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-banco-'));
  const r = spawnSync('git', ['clone', '-q', ruta, d], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`no se pudo clonar ${ruta}: ${(r.stderr || '').trim()}`);
  if (ref) {
    const c = spawnSync('git', ['checkout', '-q', ref], { cwd: d, encoding: 'utf8', windowsHide: true });
    if (c.status !== 0) throw new Error(`no existe ${ref} en ${ruta}`);
  }
  return d;
}

function main() {
  const o = args(process.argv.slice(2));
  if (o.informe) return escribirInforme(o.informe);
  if (!o.tareas) { console.error('Uso: node bench/grafo/correr.js --tareas <fichero.json> [--brazos …] [--repeticiones N] [--solo ids] [--salida dir] [--modelo m] [--minutos N]  |  --informe <dir>'); process.exit(2); }
  const base = path.dirname(path.resolve(o.tareas));
  const t = JSON.parse(fs.readFileSync(o.tareas, 'utf8'));
  const errores = B.validarTareas(t);
  for (const b of o.brazos) if (!B.BRAZOS.includes(b)) errores.push(`brazo desconocido: ${b}`);
  if (errores.length) { console.error(errores.map((e) => `✖ ${e}`).join('\n')); process.exit(2); }
  const tareas = t.tareas.filter((x) => !o.solo || o.solo.includes(x.id));
  const salida = path.resolve(o.salida || path.join(base, 'resultados', new Date().toISOString().replace(/[:.]/g, '-')));
  fs.mkdirSync(salida, { recursive: true });
  const total = tareas.length * o.brazos.length * o.repeticiones;
  console.log(`banco: ${tareas.length} tareas × ${o.brazos.length} brazos × ${o.repeticiones} = ${total} ejecuciones → ${salida}`);
  let n = 0;
  for (let rep = 1; rep <= o.repeticiones; rep++) {
    for (const tarea of tareas) {
      for (const brazo of o.brazos) {
        n++;
        const nombre = `${tarea.id}-${brazo}-${rep}`;
        const repo = t.repos[tarea.repo];
        const origen = path.resolve(base, repo.ruta);
        const clon = clonar(origen, repo.ref);
        try {
          // Si el banco vive dentro del repo medido, fuera del clon: el agente no debe ver las respuestas.
          const dentro = path.relative(origen, base);
          if (dentro && !dentro.startsWith('..') && !path.isAbsolute(dentro)) fs.rmSync(path.join(clon, dentro), { recursive: true, force: true });
          B.prepararBrazo(clon, brazo);
          const ini = Date.now();
          // Sin shell: con shell los argumentos se concatenan sin escapar y el prompt se rompe.
          // FARO_BANCO_CLAUDE apunta a otro ejecutable (p. ej. claude.cmd de una instalación npm).
          const r = spawnSync(process.env.FARO_BANCO_CLAUDE || 'claude', B.argsClaude(tarea.prompt, { modelo: o.modelo }), {
            cwd: clon, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: o.minutos * 60000,
          });
          if (r.error) throw new Error(`no se pudo lanzar claude: ${r.error.message}`);
          fs.writeFileSync(path.join(salida, `${nombre}.stream.jsonl`), r.stdout || '');
          if (r.stderr) fs.writeFileSync(path.join(salida, `${nombre}.stderr.txt`), r.stderr);
          const metricas = B.metricas(r.stdout || '');
          if (metricas.ms == null) metricas.ms = Date.now() - ini;
          const comprobar = tarea.comprobar.split('{base}').join(base.replace(/\\/g, '/'));
          const c = spawnSync(comprobar, { cwd: clon, encoding: 'utf8', windowsHide: true, shell: true, timeout: 600000 });
          const resultado = { tarea: tarea.id, repo: tarea.repo, brazo, repeticion: rep, acierto: c.status === 0,
            comprobacion: ((c.stdout || '') + (c.stderr || '')).slice(-2000), metricas };
          fs.writeFileSync(path.join(salida, `${nombre}.json`), JSON.stringify(resultado, null, 2));
          console.log(`[${n}/${total}] ${nombre}: ${resultado.acierto ? 'OK' : 'FALLO'} · ${metricas.coste == null ? '?' : metricas.coste.toFixed(3)} USD · ${metricas.llamadas} llamadas`);
        } catch (e) {
          console.log(`[${n}/${total}] ${nombre}: ERROR ${e.message}`);
        } finally {
          try { fs.rmSync(clon, { recursive: true, force: true }); } catch { /* lo limpia el sistema */ }
        }
      }
    }
  }
  escribirInforme(salida);
}

main();
