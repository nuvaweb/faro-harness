// lib/validado.js — que falta por validar de un cambio (#198). Lo usan `harness.js tests-dominios --afectados`
// y scripts/test-afectados.js a traves de lib/dominios.js, para que los tests enfocados no acaben en la suite completa:
//   - VERDE: tras una ejecucion en verde se guarda el contenido de cada fichero validado (blob de git, en
//     .git/faro-tests-verdes.json: fuera del arbol, nunca se commitea). Lo que no ha cambiado desde entonces no
//     vuelve a seleccionar tests (rama apilada sobre otra sin integrar, iteraciones sucesivas).
//   - SOLO TEXTO: si un fichero JS/TS solo cambia en cadenas o comentarios respecto a lo validado (o a la base),
//     el cambio es interior de su dominio: no arrastra a los dependientes de su contrato.
// Nada se ejecuta del repo: solo git con argv fijo.
'use strict';
const fs = require('fs');
const path = require('path');

const git = (args, op) => require('child_process').spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000, ...op, windowsHide: true });
const posix = (p) => String(p || '').replace(/\\/g, '/');
const EXT_CODIGO = /\.(m|c)?(j|t)sx?$/;
const RE_HASH = /^[0-9a-f]{40,64}$/;
const FICHERO = 'faro-tests-verdes.json';
// tras estos caracteres (o palabras) una '/' abre una regex, no es una division
const ANTES_DE_REGEX = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const PALABRAS_REGEX = /(?:^|[^\w$])(return|typeof|case|in|of|void|throw|delete|new|yield|await)$/;

/**
 * El codigo de un fuente JS/TS sin el contenido de cadenas, plantillas ni comentarios (los `${…}` de una plantilla
 * y las regex SI se conservan: son codigo). Dos versiones con el mismo esqueleto difieren solo en textos.
 */
function esqueleto(src) {
  const s = String(src || '');
  let out = '';
  const pila = [];                                       // llaves abiertas dentro de un ${…}: 'cod' | 'tpl'
  let i = 0;
  const previo = () => { let k = out.length - 1; while (k >= 0 && /\s/.test(out[k])) k--; return out.slice(Math.max(0, k - 15), k + 1); };
  const plantilla = () => {                              // i apunta tras la ` de apertura; consume hasta ` o ${
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; out += '`'; return; }
      if (c === '$' && s[i + 1] === '{') { out += '${'; i += 2; pila.push('tpl'); return; }
      i++;
    }
  };
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const fin = s.indexOf('*/', i + 2); i = fin < 0 ? s.length : fin + 2; out += ' '; continue; }
    if (c === "'" || c === '"') {
      i++;
      while (i < s.length && s[i] !== c && s[i] !== '\n') i += s[i] === '\\' ? 2 : 1;
      i++; out += c + c; continue;
    }
    if (c === '`') { out += '`'; i++; plantilla(); continue; }
    if (c === '/') {
      const p = previo();
      if (!p || ANTES_DE_REGEX.has(p[p.length - 1]) || PALABRAS_REGEX.test(p)) {
        let j = i + 1; let clase = false;
        while (j < s.length && s[j] !== '\n') {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === '[') clase = true; else if (s[j] === ']') clase = false; else if (s[j] === '/' && !clase) break;
          j++;
        }
        j++;
        while (j < s.length && /[a-z]/i.test(s[j])) j++;
        out += s.slice(i, j); i = j; continue;
      }
    }
    if (c === '{') pila.push('cod');
    if (c === '}' && pila.length) {
      if (pila.pop() === 'tpl') { out += '}'; i++; plantilla(); continue; }
    }
    out += c; i++;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** true si `antes` y `despues` (de un fichero JS/TS) difieren y solo en cadenas o comentarios. */
function soloTexto(rel, antes, despues) {
  if (!EXT_CODIGO.test(posix(rel)) || antes == null || despues == null || antes === despues) return false;
  return esqueleto(antes) === esqueleto(despues);
}

function rutaRegistro(root) {
  const r = git(['rev-parse', '--git-path', FICHERO], { cwd: root });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  return path.resolve(root, r.stdout.trim());
}
function leerRegistro(root) {
  const p = rutaRegistro(root);
  if (!p) return {};
  try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
}

/**
 * Contenido actual de cada fichero como blob de git (lo guarda en .git para poder compararlo despues):
 * { rel: hash | null (no existe) }. Se toma ANTES de ejecutar los tests: lo que se valida es eso.
 */
function instantanea(root, ficheros, { guardar = true } = {}) {
  const lista = [...new Set((ficheros || []).map(posix))];
  const existen = lista.filter((f) => { try { return fs.statSync(path.join(root, f)).isFile(); } catch { return false; } });
  const res = Object.fromEntries(lista.map((f) => [f, null]));
  if (existen.length) {
    const r = git(['hash-object', ...(guardar ? ['-w'] : []), '--stdin-paths'], { cwd: root, input: `${existen.join('\n')}\n` });
    const hashes = r.status === 0 ? r.stdout.split('\n').map((x) => x.trim()).filter(Boolean) : [];
    if (hashes.length === existen.length) existen.forEach((f, k) => { res[f] = hashes[k]; });
    else for (const f of existen) delete res[f];        // sin hashes fiables no se afirma nada de esos ficheros
  }
  return res;
}

/** Anota como validado en verde el contenido de una instantanea (se mezcla con lo ya anotado). */
function registrarVerde(root, foto) {
  const p = rutaRegistro(root);
  if (!p || !foto) return false;
  const reg = leerRegistro(root);
  for (const [f, h] of Object.entries(foto)) reg[f] = h && RE_HASH.test(h) ? h : null;
  try { fs.writeFileSync(p, `${JSON.stringify(reg, null, 1)}\n`); return true; } catch { return false; }
}

const contenidoBlob = (root, h) => { const r = git(['cat-file', 'blob', h], { cwd: root }); return r.status === 0 ? r.stdout : null; };
const contenidoEn = (root, base, f) => { const r = git(['show', `${base}:${f}`], { cwd: root }); return r.status === 0 ? r.stdout : null; };

/**
 * De los ficheros cambiados contra `base`, que falta por validar:
 * -> { cambiados: [pendientes], validados: [sin cambios desde su verde], soloTexto: Set(rel) }.
 * Un fichero ya validado que ha vuelto a cambiar se compara con su version validada; uno nunca validado, con la base.
 * { verde: false } (una --base explicita): no descuenta lo validado; solo juzga el cambio de texto contra la base.
 */
function pendientes(root, cambiados, base, { verde = true } = {}) {
  const reg = verde ? leerRegistro(root) : {};
  const actual = instantanea(root, cambiados, { guardar: false });
  const res = { cambiados: [], validados: [], soloTexto: new Set() };
  for (const f of (cambiados || []).map(posix)) {
    const h = Object.prototype.hasOwnProperty.call(actual, f) ? actual[f] : undefined;
    const anotado = Object.prototype.hasOwnProperty.call(reg, f);
    if (h !== undefined && anotado && reg[f] === h) { res.validados.push(f); continue; }
    res.cambiados.push(f);
    if (!h || !EXT_CODIGO.test(f)) continue;
    const ahora = (() => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return null; } })();
    const antes = anotado && reg[f] ? contenidoBlob(root, reg[f]) : (base ? contenidoEn(root, base, f) : null);
    if (soloTexto(f, antes, ahora)) res.soloTexto.add(f);
  }
  return res;
}

module.exports = { esqueleto, soloTexto, instantanea, registrarVerde, pendientes, rutaRegistro };
