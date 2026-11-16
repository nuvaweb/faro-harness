#!/usr/bin/env node
// scripts/release-ci.js — PUBLICACION AUTOMATICA desde el CI (FARO 3.0). Sustituye a /faro:publicar.
//
//   node scripts/release-ci.js comprobar --base <ref>   (en el PR) avisa si la version de plugin.json no
//                                                        sube lo que piden los commits Conventional
//   node scripts/release-ci.js publicar                  (en main) si la version de plugin.json no tiene
//                                                        tag, crea vX.Y.Z y la release con su CHANGELOG
//
// La version la fija el PR (bump en plugin.json + entrada en CHANGELOG.md, como siempre: sin bump las
// caches de los usuarios no se actualizan). El CI no escribe en main: solo etiqueta y publica lo que
// entro. Que parte de la version toca lo decide lib/flujo.js (bumpDe), la misma regla que el harness.
// Avisa, no rompe: un PR de docs/chore no publica y no necesita bump.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const flujo = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'flujo.js'));
const RUTA_PLUGIN = path.join('plugins', 'faro', '.claude-plugin', 'plugin.json');

// ---- logica pura (tests: test/release-ci.test.mjs) ----

// Seccion '## X.Y.Z — fecha' del CHANGELOG (sin el titulo). null si no esta.
function seccionChangelog(texto, version) {
  const lineas = String(texto || '').split(/\r?\n/);
  const esCab = (l) => /^## /.test(l);
  const ini = lineas.findIndex((l) => esCab(l) && l.replace(/^##\s*\[?/, '').startsWith(version));
  if (ini < 0) return null;
  let fin = lineas.findIndex((l, i) => i > ini && esCab(l));
  if (fin < 0) fin = lineas.length;
  return lineas.slice(ini + 1, fin).join('\n').trim() || null;
}

const cmpVersion = (a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

// En el PR: { bump, esperada, avisos[] }. versionBase = la de main; versionPr = la de la rama.
function comprobar({ mensajes, versionBase, versionPr, changelog }) {
  const bump = flujo.bumpDe(mensajes);
  const avisos = [];
  const esperada = bump ? flujo.siguienteVersion(versionBase, bump) : versionBase;
  if (bump && cmpVersion(versionPr, esperada) < 0) avisos.push(`Los commits piden version ${bump} (${versionBase} -> ${esperada}) y plugin.json dice ${versionPr}. Sube la version: sin bump las caches de los usuarios no se actualizan.`);
  if (cmpVersion(versionPr, versionBase) > 0 && !seccionChangelog(changelog, versionPr)) avisos.push(`plugin.json sube a ${versionPr} pero CHANGELOG.md no tiene la seccion '## ${versionPr} — <fecha>'.`);
  if (!bump && cmpVersion(versionPr, versionBase) > 0) avisos.push(`Sube la version a ${versionPr} pero ningun commit es feat/fix/perf/refactor (ni '!'): revisa el tipo de los commits o del titulo del PR.`);
  return { bump, esperada, avisos };
}

// En main: { publicar, tag, notas, motivo }.
function planPublicar({ version, tags, changelog }) {
  const tag = `v${version}`;
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ''))) return { publicar: false, motivo: `version invalida en plugin.json: '${version}'` };
  if ((tags || []).includes(tag)) return { publicar: false, tag, motivo: `${tag} ya existe: este merge no cambia la version (docs/chore/test), nada que publicar.` };
  const notas = seccionChangelog(changelog, version);
  return { publicar: true, tag, notas: notas || `Version ${version}.` };
}

// ---- efectos (solo en el CI) ----
const git = (...a) => execFileSync('git', a, { cwd: RAIZ, encoding: 'utf8' }).trim();
const leer = (ruta) => fs.readFileSync(path.join(RAIZ, ruta), 'utf8');
const versionDe = (json) => JSON.parse(json).version;

function main(argv) {
  const [modo] = argv;
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  if (modo === 'comprobar') {
    const base = val('--base') || 'origin/main';
    const mensajes = git('log', '--format=%B%x00', `${base}..HEAD`).split('\0').map((s) => s.trim()).filter(Boolean);
    const titulo = process.env.PR_TITULO || '';
    const r = comprobar({ mensajes: titulo ? [titulo, ...mensajes] : mensajes, versionBase: versionDe(git('show', `${base}:${RUTA_PLUGIN.replace(/\\/g, '/')}`)), versionPr: versionDe(leer(RUTA_PLUGIN)), changelog: leer('CHANGELOG.md') });
    console.log(`Version que pide el cambio: ${r.bump || 'ninguna (no publica)'}${r.bump ? ` -> ${r.esperada}` : ''}`);
    for (const a of r.avisos) console.log(`::warning title=version::${a}`);
    return 0;
  }
  if (modo === 'publicar') {
    const plan = planPublicar({ version: versionDe(leer(RUTA_PLUGIN)), tags: git('tag', '--list').split('\n'), changelog: leer('CHANGELOG.md') });
    if (!plan.publicar) { console.log(plan.motivo); return 0; }
    const notas = path.join(process.env.RUNNER_TEMP || require('os').tmpdir(), 'notas-release.md');
    fs.writeFileSync(notas, plan.notas);
    if (argv.includes('--seco')) { console.log(`Publicaria ${plan.tag}:\n${plan.notas}`); return 0; }
    // gh crea el tag sobre el commit de main y la release en un solo paso (GITHUB_TOKEN del job).
    execFileSync('gh', ['release', 'create', plan.tag, '--target', process.env.GITHUB_SHA || git('rev-parse', 'HEAD'), '--title', plan.tag, '--notes-file', notas], { cwd: RAIZ, stdio: 'inherit' });
    console.log(`Publicada ${plan.tag}.`);
    return 0;
  }
  console.error('Uso: node scripts/release-ci.js comprobar [--base <ref>] | publicar [--seco]');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { seccionChangelog, comprobar, planPublicar };
