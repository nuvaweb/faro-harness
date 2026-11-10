// lib/reporte-negocio.js — EL CONTENIDO del reporte de negocio (Word con estilo neutro FARO) (#121).
//
// Lo lee NEGOCIO: habla de VALOR ENTREGADO, no de trabajo tecnico. Nada de repos, issues, ramas, PR ni
// nombres de tareas. Cada entregable (fase) dice que aporta, con su estado y su fecha; el estado general
// lleva semaforo, avance, KPIs, riesgos y decisiones pendientes.
//
// La FUENTE es el mismo modelo que el one-pager (lib/onepager.js buildOnepagerModel): una sola verdad,
// asi el Word, el one-pager y la epica no pueden contradecirse. Aqui solo se ordena y se redacta.
//
// HUELLA: resumen del CONTENIDO sin la fecha de generacion. Si no cambia, el estado de negocio no ha
// cambiado y no hace falta generar otro Word igual.
'use strict';
const fs = require('fs');
const path = require('path');
const { crc32 } = require('./docx.js');

// Primera frase de la prosa de la fase: es el VALOR que aporta. Corta para no abrumar.
function valorDeFase(f) {
  const txt = String(f.descripcion || '').replace(/\s+/g, ' ').trim();
  if (!txt) return '';
  const frase = (txt.match(/^.*?[.!?](\s|$)/) || [txt])[0].trim();
  return frase.length > 160 ? `${frase.slice(0, 157).trimEnd()}…` : frase;
}

const SEMAFORO = { verde: '🟢', ambar: '🟠', rojo: '🔴' };

function estadoEntregable(f) {
  const total = (f.done || 0) + (f.open || 0);
  if (f.estado === 'done') return 'Entregado';
  if (f.estado === 'in_progress' || f.estado === 'testing') return `En curso${total ? ` (${Math.round(((f.done || 0) / total) * 100)} %)` : ''}`;
  return 'Pendiente';
}

/** Modelo -> secciones del documento. `modelo` = buildOnepagerModel(); `fases` = parseEstado().fases. */
function contenidoReporte({ modelo, fases, fm = {} }) {
  const m = modelo.meta;
  const objetivos = fases.map((f) => f.objetivo).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))).sort();
  const fin = objetivos.length ? objetivos[objetivos.length - 1] : null;
  const actual = fases.find((f) => f.estado !== 'done') || null;
  const entregados = fases.filter((f) => f.estado === 'done').length;

  const secciones = [];
  secciones.push({
    titulo: 'Resumen ejecutivo',
    destacado: `${SEMAFORO[modelo.rag.nivel] || ''} **${modelo.rag.label}** — ${modelo.rag.frase}`,
    parrafos: [`**Avance:** ${modelo.avance.pct} % · **${entregados} de ${fases.length}** entregables completados · **Fin previsto:** ${fin || 'sin fecha'}`],
  });
  const descripcion = String(fm.descripcion || fm.objetivo || m.objetivo || '').trim();
  secciones.push({
    titulo: 'Descripción del proyecto',
    parrafos: [descripcion || 'Descripción pendiente de completar.'],
  });
  secciones.push({
    titulo: 'Entregables y valor aportado',
    tabla: {
      cabecera: ['Entregable', 'Estado', 'Qué aporta al negocio', 'Fecha'],
      anchos: [2300, 1500, 4600, 1300],
      filas: fases.map((f) => [f.nombre, estadoEntregable(f), valorDeFase(f) || '—', f.objetivo || '—']),
    },
  });
  secciones.push({
    titulo: 'Plazo',
    lista: [
      ...(fm.fecha_inicio ? [`**Inicio:** ${fm.fecha_inicio}`] : []),
      `**Fin previsto:** ${fin || 'sin fecha objetivo'}`,
      ...(actual ? [`**Ahora:** ${actual.nombre}${actual.objetivo ? ` (objetivo ${actual.objetivo})` : ''}`] : ['**Ahora:** todos los entregables completados']),
    ],
  });
  const k = modelo.kpis;
  secciones.push(k.definidos
    ? { titulo: 'Indicadores (KPIs)', tabla: { cabecera: ['Indicador', 'Objetivo', 'Actual', 'Última medición'], anchos: [3700, 2000, 2000, 2000], filas: k.items.map((i) => [i.nombre, i.obj, i.actual, i.estado]) } }
    : { titulo: 'Indicadores (KPIs)', parrafos: ['Aún no hay indicadores de valor definidos para medir el impacto del proyecto.'] });
  const r = modelo.riesgos;
  secciones.push({
    titulo: 'Riesgos y bloqueos',
    ...(r.top.length ? { lista: r.top.map((x) => `**${x.tag}** — ${x.txt}`) } : { parrafos: ['Sin riesgos abiertos que afecten al negocio.'] }),
  });
  if ((modelo.decisiones || []).length) secciones.push({ titulo: 'Decisiones pendientes', lista: modelo.decisiones.map((d) => `${d.q}${d.who ? ` — ${d.who}` : ''}`) });
  const siguientes = fases.filter((f) => f.estado !== 'done').slice(0, 2);
  secciones.push({
    titulo: 'Próximos pasos',
    ...(siguientes.length
      ? { lista: siguientes.map((f) => `**${f.nombre}**${f.objetivo ? ` (objetivo ${f.objetivo})` : ''}: ${valorDeFase(f) || 'por concretar'}`) }
      : { parrafos: ['Todos los entregables están completados.'] }),
  });

  const titulo = m.nombre;
  const subtitulo = descripcion.split(/(?<=[.!?])\s/)[0] || '';
  // La huella resume el ESTADO DE NEGOCIO, no el dia: lo relativo al reloj (un KPI «hace 34d») cuenta solo
  // como «desactualizado», o cada push de un dia distinto subiria otro Word igual a la epica.
  const sinReloj = (k, v) => (typeof v === 'string' && /^hace \d+d$/.test(v) ? 'desactualizado' : v);
  const huella = crc32(Buffer.from(JSON.stringify({ titulo, subtitulo, secciones }, sinReloj))).toString(16);
  return { titulo, subtitulo, secciones, huella, fin };
}

/**
 * Logo opcional de la portada (PNG claro, para la banda oscura): el de la plantilla faro-informe.html si alguien
 * le pone uno como <img class="bp-logo" src="data:image/png;base64,...">. La plantilla neutra no trae imagen
 * (marca tipografica «FARO»), asi que por defecto devuelve null y el Word sale sin logo.
 */
function logoMarca() {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'plantillas', 'html', 'faro-informe.html'), 'utf8');
    const m = html.match(/class="bp-logo" src="data:image\/png;base64,([^"]+)"/);
    if (!m) return null;
    const png = Buffer.from(m[1], 'base64');
    return { png, ancho: png.readUInt32BE(16), alto: png.readUInt32BE(20) };
  } catch { return null; }
}

/** Genera el .docx (Buffer) y su huella. `hoy` inyectado: los tests no dependen del reloj. */
function generarReporte({ modelo, fases, fm, hoy }) {
  const c = contenidoReporte({ modelo, fases, fm });
  const { crearDocx } = require('./docx.js');
  const buffer = crearDocx({
    titulo: c.titulo,
    subtitulo: c.subtitulo,
    meta: `Estado a ${hoy}${c.fin ? ` · Fin previsto ${c.fin}` : ''}`,
    secciones: c.secciones,
    pie: `Generado por FARO el ${hoy}`,
    logo: logoMarca(),
  });
  return { buffer, huella: c.huella, contenido: c };
}

module.exports = { contenidoReporte, generarReporte, logoMarca, estadoEntregable };
