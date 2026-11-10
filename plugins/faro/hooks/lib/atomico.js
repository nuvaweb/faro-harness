// lib/atomico.js — INFORME de atomicidad del codigo (harness.js atomico). AVISA, NO BLOQUEA.
//
// Por que existe: el motor no tenia NINGUN criterio de atomicidad. Lo unico parecido era una frase
// en prosa dentro de revisor-code-worker ("1 archivo = 1 funcionalidad") que juzga el modelo a ojo y
// solo se activa en repos Cloudflare. Sin senal objetiva, el troceado de un fichero grande no tiene
// forma de saber cuando esta terminado.
//
// Por que AVISA y no bloquea (decision): un umbral duro se sortea partiendo un fichero por la mitad
// —el numero baja y el diseno empeora—, asi que como GATE seria contraproducente. Como SENAL sirve:
// ordena la deuda y hace visible lo que mezcla responsabilidades. El umbral vive en
// faro-schema.json (enums.atomicidad), no aqui: un repo puede declarar el suyo sin tocar el motor.
//
// Salida SIEMPRE con codigo 0 (es un informe, no una validacion).
'use strict';

module.exports = function (ctx) {
  const { fs, path, ROOT, faroSchema } = ctx;
  // Lista UNICA de generados, compartida con grafo.js (#126): se aplica aunque el repo traiga su 'excluir'.
  const generados = require('./generados.js');

  const DEFECTO = {
    max_lineas: 400,
    extensiones: ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.php'],
    excluir: ['node_modules/', 'dist/', 'build/', '.git/', 'vendor/', 'borrador/', 'plantillas/', 'fuentes/', '.min.', '-lock.'],
  };

  // El contrato manda; si el repo (o el plugin) no declara enums.atomicidad, cae al defecto.
  function config() {
    const s = faroSchema();
    const a = s && s.enums && s.enums.atomicidad;
    if (!a || typeof a !== 'object') return DEFECTO;
    return {
      max_lineas: Number(a.max_lineas) > 0 ? Number(a.max_lineas) : DEFECTO.max_lineas,
      extensiones: Array.isArray(a.extensiones) && a.extensiones.length ? a.extensiones : DEFECTO.extensiones,
      excluir: Array.isArray(a.excluir) ? a.excluir : DEFECTO.excluir,
    };
  }

  function recorrer(dir, cfg, out, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (generados.excluidoPorRuta(rel)) continue;
      if (cfg.excluir.some((x) => (`${rel}/`).includes(x) || rel.includes(x))) continue;
      if (e.isDirectory()) { recorrer(rel, cfg, out, depth + 1); continue; }
      if (!cfg.extensiones.some((x) => e.name.toLowerCase().endsWith(x))) continue;
      let txt;
      try { txt = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
      out.push({ rel, lineas: txt.split(/\r?\n/).length });
    }
  }

  // escanear -> { cfg, total, exceden: [{rel, lineas, exceso}] } ordenado de mayor a menor.
  function escanear() {
    const cfg = config();
    const leidos = [];
    recorrer('', cfg, leidos, 0);
    const validos = new Set(generados.depurar(ROOT, leidos.map((f) => f.rel), fs, path));
    const todos = leidos.filter((f) => validos.has(f.rel));
    const exceden = todos
      .filter((f) => f.lineas > cfg.max_lineas)
      .map((f) => ({ ...f, exceso: f.lineas - cfg.max_lineas }))
      .sort((a, b) => b.lineas - a.lineas);
    return { cfg, total: todos.length, exceden };
  }

  // Lineas para el contexto de sesion: SOLO si hay deuda, y como maximo las 3 peores (sin ruido).
  function atomicoLines() {
    const r = escanear();
    if (!r.exceden.length) return [];
    const top = r.exceden.slice(0, 3).map((f) => `${f.rel} (${f.lineas})`).join(' · ');
    return [
      `ATOMICIDAD: ${r.exceden.length} fichero(s) de codigo por encima de ${r.cfg.max_lineas} lineas — ${top}` +
      `${r.exceden.length > 3 ? ` (+${r.exceden.length - 3} mas)` : ''}. ` +
      'Es una SENAL de responsabilidades mezcladas, no un error: no partas por la mitad para bajar el numero — separa por CONCEPTO. Detalle: node .claude/hooks/harness.js atomico.',
    ];
  }

  function cmdAtomico() {
    const r = escanear();
    const out = [`Atomicidad — umbral ${r.cfg.max_lineas} lineas · ${r.total} fichero(s) de codigo analizados.`];
    if (!r.exceden.length) {
      out.push('', `✅ Ningun fichero supera el umbral.`);
      process.stdout.write(out.join('\n') + '\n');
      return;
    }
    out.push('', `${r.exceden.length} por encima del umbral (de mayor a menor):`);
    for (const f of r.exceden) out.push(`   ${String(f.lineas).padStart(6)}  (+${f.exceso})  ${f.rel}`);
    out.push(
      '',
      'Como leerlo: el numero es una SENAL de responsabilidades mezcladas, no una ley. Partir un fichero',
      'por la mitad baja la cifra y empeora el diseno; separa por CONCEPTO (un modulo = una razon para cambiar).',
      'Es un informe: no bloquea nada y no cambia el resultado de validate.',
    );
    process.stdout.write(out.join('\n') + '\n');
  }

  // INFORME COMPUESTO de salud del codigo (harness.js codigo): atomicidad + ciclos + huerfanos.
  // Las tres senales juntas, cada una con su veredicto. Sigue siendo un INFORME: salida 0 siempre.
  // Se compone aqui (y no en grafo.js) porque atomico es la senal base; grafo aporta las suyas.
  function cmdCodigo() {
    const r = escanear();
    const out = [`Salud del codigo — ${r.total} fichero(s) analizados.`, ''];

    out.push(`── ATOMICIDAD (umbral ${r.cfg.max_lineas} lineas) ──`);
    if (!r.exceden.length) out.push('   ✅ Ningun fichero supera el umbral.');
    else {
      out.push(`   ⚠ ${r.exceden.length} por encima del umbral:`);
      for (const f of r.exceden) out.push(`      ${String(f.lineas).padStart(6)}  (+${f.exceso})  ${f.rel}`);
      out.push('   Es una SENAL de responsabilidades mezcladas, no una ley: separa por CONCEPTO, no por la mitad.');
    }

    let g = null;
    try { g = require('./grafo.js')(ctx).analizar(); } catch (e) { out.push('', `(grafo no disponible: ${(e && e.message) || e})`); }
    if (g) {
      out.push('', '── CICLOS DE DEPENDENCIA ──');
      if (!g.ciclos.length) out.push('   ✅ Sin ciclos.');
      else {
        out.push(`   ⛔ ${g.ciclos.length} ciclo(s) — ningun modulo de un ciclo se entiende ni se prueba por separado:`);
        for (const c of g.ciclos) out.push(`      ${c.join(' → ')} → ${c[0]}`);
      }
      out.push('', '── MODULOS QUE NADIE IMPORTA ──');
      if (!g.huerfanos.length) out.push('   ✅ Ninguno (tests y puntos de entrada aparte).');
      else {
        out.push(`   ⚠ ${g.huerfanos.length} posible(s) huerfano(s) — suelen ser codigo muerto, PERO revisa antes de borrar:`);
        for (const h of g.huerfanos) out.push(`      ${h}`);
        out.push('   Si alguno es un ejecutable legitimo, declaralo en faro-schema.json (enums.atomicidad.entradas).');
      }
    }

    out.push('', 'Es un informe: no bloquea nada y no cambia el resultado de validate.');
    process.stdout.write(out.join('\n') + '\n');
  }

  return { cmdAtomico, cmdCodigo, escanear, atomicoLines, config };
};
