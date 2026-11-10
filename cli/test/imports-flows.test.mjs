// Lint estatico de imports en bin/flows/*.mjs (0.34.1): un identificador usado sin importar NO
// falla al analizar el modulo (ESM no chequea estatico) — solo revienta en RUNTIME, cuando el
// codigo llega a esa linea, y con try/catch alrededor (patron habitual aqui) el ReferenceError
// queda TRAGADO en silencio. Caso real: check.mjs usaba carpetasFaroQueFaltan() sin importarlo
// (bug descubierto en auditoria); el fallo solo se veia como 'No pude crear alguna carpeta' sin
// traza. Este test carga cada flow con Node y falla si algun identificador global esperado
// (los que exportan los modulos compartidos de bin/lib) se usa sin figurar en el import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOWS_DIR = path.join(ROOT, 'bin', 'flows');
const REPO_MJS = path.join(ROOT, 'bin', 'lib', 'repo.mjs');
const GITHUB_MJS = path.join(ROOT, 'bin', 'lib', 'forjas', 'github.mjs');
// forjas/gitlab.mjs queda FUERA a proposito: los flujos lo consumen solo via ctx.forja.<op> (nunca por
// import directo), asi que sus nombres (repo, ramas, topics...) no son globales esperados en los flujos.
const OTROS = ['plugin.mjs', 'meta.mjs', 'gitcred.mjs', 'perfil.mjs', 'forja.mjs', 'credenciales.mjs'].map((f) => path.join(ROOT, 'bin', 'lib', f));

// Simbolos exportados por los modulos compartidos: candidatos a "se usa pero no se importo".
function exportedNames(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = new Set();
  const mDecl = text.matchAll(/^export\s+(?:async\s+function|function|const|class)\s+([A-Za-z_$][\w$]*)/gm);
  for (const m of mDecl) out.add(m[1]);
  const mList = text.match(/^export\s*\{([^}]+)\}/m);
  if (mList) for (const raw of mList[1].split(',')) {
    const name = raw.trim().split(/\s+as\s+/)[0].trim();
    if (name) out.add(name);
  }
  return out;
}

// Solo CODIGO: sin imports, sin comentarios y sin cadenas ('faro --login' o 'ramas en servidor' no son
// identificadores). De las plantillas (`...`) se conservan las expresiones ${...}, que si son codigo.
function soloCodigo(text) {
  return text
    .replace(/^import[\s\S]*?from\s*['"][^'"]+['"];?$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => (m.match(/\$\{[^}]*\}/g) || []).join(' '))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

test('bin/flows/*.mjs: todo simbolo de los modulos compartidos usado esta en el import (evita ReferenceError en runtime)', () => {
  const compartidos = new Set([...exportedNames(REPO_MJS), ...exportedNames(GITHUB_MJS), ...OTROS.flatMap((f) => [...exportedNames(f)])]);
  const problemas = [];
  for (const f of fs.readdirSync(FLOWS_DIR).filter((x) => x.endsWith('.mjs'))) {
    const full = path.join(FLOWS_DIR, f);
    const text = fs.readFileSync(full, 'utf8');
    // Bloque(s) de import multilinea desde los modulos compartidos: extrae los nombres realmente importados.
    const importados = new Set();
    const mImports = text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]*(?:repo|github|gitlab|index|plugin|meta|gitcred|perfil|forja|credenciales|login|abrir)\.mjs['"]/g);
    for (const m of mImports) for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) importados.add(name);
    }
    const cuerpo = soloCodigo(text);
    for (const nombre of compartidos) {
      if (importados.has(nombre)) continue;
      // Declarado en el propio fichero (const/let/function o destructurado): no es un global esperado.
      if (new RegExp(`\\b(?:const|let|var|function|class)\\s+(?:\\{[^}]*\\b)?${nombre}\\b`).test(cuerpo)) continue;
      // Uso REAL: llamada o referencia sin punto delante (ctx.forja.repo(...) es una propiedad, no un global).
      const usado = new RegExp(`(?<![.\\w$])${nombre}\\s*\\(`).test(cuerpo) || new RegExp(`[^.\\w$]${nombre}\\b(?!\\s*[:(])`, '').test(cuerpo);
      if (usado && new RegExp(`\\b${nombre}\\b`).test(cuerpo)) {
        problemas.push(`${f}: usa '${nombre}' sin importarlo de los modulos compartidos`);
      }
    }
  }
  assert.deepEqual(problemas, [], `Identificadores usados sin importar (ReferenceError en runtime):\n${problemas.join('\n')}`);
});

test('soloCodigo: quita comentarios y cadenas pero conserva las expresiones de las plantillas', () => {
  const s = soloCodigo("const a = 'faro --login'; // login\nsay(`ramas ${ramas(1)} y ${x}`); /* proteger */ f(\"repo\");");
  assert.ok(!/--login/.test(s)); assert.ok(!/proteger/.test(s)); assert.ok(!/"repo"/.test(s));
  assert.ok(/ramas\(1\)/.test(s), 'la expresion de la plantilla se conserva');
});
