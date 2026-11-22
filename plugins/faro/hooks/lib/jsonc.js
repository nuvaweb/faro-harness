'use strict';
// JSON con comentarios y comas finales (wrangler.jsonc, tsconfig...). Devuelve null si no se puede leer.
function parse(texto) {
  if (!texto) return null;
  try {
    const limpio = String(texto).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(limpio);
  } catch { return null; }
}
module.exports = { parse };
