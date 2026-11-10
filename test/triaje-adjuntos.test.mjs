// #108 — El triaje LEE lo que acompaña al issue (capturas, documentos), no solo sabe que existe.
//
// Caso real: partner-portal#67 — las 5 pantallas que cita el texto solo estaban dentro de un PDF
// adjunto. El detector debe coger la captura y el PDF y DEJAR FUERA los enlaces que no son adjuntos
// y viven en el mismo issue (visor de Userback, commit, repo, pagina de la app).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const adj = require(path.join(RAIZ, 'plugins', 'faro', 'hooks', 'lib', 'adjuntos.js'));

const ISSUE_67 = `## Evidencia

![Captura 1](https://static.userback.io/4545/project/149959/feedback/8485149/screenshot/X5S4hhruZKt1EAIr7rMo_5954223.png)

[📎 Adjunto](https://static.userback.io/4545/project/149959/feedback/8485149/attachment/zG40h4Fca0IBv7TNjpzC/Relatorio_de_Revisao-d.html.pdf)

[Ver en Userback](https://app.userback.io/viewer/5454/149959/8485149hQffg7qp4GPjwjMHhXpfG2RmmQvMvFq6mjg2Rq/) — peticiones de red y grabación de la sesión, allí.

| Commit | [\`1797904\`](https://github.com/acme-org/partner-portal/commit/1797904) |
| Repo origen | [\`acme-org/partner-portal\`](https://github.com/acme-org/partner-portal) |
| Página | https://partner-portal-dev.acme.example.com/ |`;

test('caso real #67: captura y PDF SI; visor, commit, repo y pagina NO', () => {
  const a = adj.extraerAdjuntos(ISSUE_67);
  assert.deepStrictEqual(a.map((x) => x.tipo), ['imagen', 'documento'], JSON.stringify(a, null, 2));
  assert.match(a[0].url, /screenshot\/.*\.png$/);
  assert.match(a[1].url, /Relatorio_de_Revisao-d\.html\.pdf$/);
  assert.strictEqual(a[1].nombre, 'Relatorio_de_Revisao-d.html.pdf', 'un "📎 Adjunto" toma el nombre del fichero');
});

test('adjuntos de GitHub: <img>, user-attachments sueltos y enlaces a ficheros', () => {
  const a = adj.extraerAdjuntos(`<img width="800" src="https://github.com/user-attachments/assets/abc-123" />
Log: [error.log](https://github.com/user-attachments/files/999/error.log)
https://github.com/user-attachments/assets/def-456
Ver [la doc](https://example.com/guia) y [informe.xlsx](https://example.com/informe.xlsx)`);
  assert.deepStrictEqual(a.map((x) => x.url), [
    'https://github.com/user-attachments/assets/abc-123',
    'https://github.com/user-attachments/files/999/error.log',
    'https://example.com/informe.xlsx',
    'https://github.com/user-attachments/assets/def-456',
  ]);
  assert.strictEqual(a[0].tipo, 'imagen');
});

test('sin duplicados aunque la misma URL salga dos veces', () => {
  assert.strictEqual(adj.extraerAdjuntos('![a](https://x.io/a.png) otra vez ![b](https://x.io/a.png)').length, 1);
});

test('como leer cada tipo lo dice el harness', () => {
  assert.match(adj.comoLeer({ tipo: 'documento', ruta: 'x.pdf' }), /^Read/);
  assert.match(adj.comoLeer({ tipo: 'imagen', ruta: 'x.png' }), /^Read/);
  assert.match(adj.comoLeer({ tipo: 'documento', ruta: 'x.docx' }), /docx/);
  assert.match(adj.comoLeer({ tipo: 'documento', ruta: 'x.log' }), /texto/);
});

// Descarga con un fetch falso: lo que importa es a QUIEN se le manda el token y que nada se calle.
test('el token SOLO viaja a GitHub; lo que falla se dice con motivo', async () => {
  const llamadas = [];
  const fakeFetch = async (url, { headers }) => {
    llamadas.push({ url, auth: headers.Authorization || null });
    if (url.includes('roto')) return { ok: false, status: 404 };
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new TextEncoder().encode('PNG').buffer };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-adj-'));
  const r = await adj.descargar([
    { url: 'https://github.com/user-attachments/assets/abc', nombre: 'captura', tipo: 'imagen' },
    { url: 'https://static.userback.io/x/shot.png', nombre: 'shot.png', tipo: 'imagen' },
    { url: 'https://static.userback.io/x/roto.pdf', nombre: 'roto.pdf', tipo: 'documento' },
  ], dir, { token: 'SECRETO', fetchImpl: fakeFetch });

  assert.strictEqual(llamadas[0].auth, 'Bearer SECRETO');
  assert.strictEqual(llamadas[1].auth, null, 'nunca el token a un host ajeno');
  assert.ok(fs.existsSync(r[0].ruta) && r[0].ruta.endsWith('.png'), 'sin extension en la URL, la saca del content-type');
  assert.match(r[0].leer, /Read/);
  assert.strictEqual(r[2].motivo, 'HTTP 404');
  assert.ok(!r[2].ruta);
});

// SSRF: el cuerpo lo escribe gente de fuera. Nada fuera de los hosts de adjuntos conocidos, y una
// redireccion desde un host permitido hacia otro que no lo es tambien se corta.
test('solo hosts de adjuntos conocidos; las redirecciones se revalidan', async () => {
  const pedidas = [];
  const fakeFetch = async (url) => {
    pedidas.push(url);
    if (url.includes('redirige')) return { ok: false, status: 302, headers: { get: (k) => (k === 'location' ? 'http://169.254.169.254/latest/meta-data' : null) } };
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new ArrayBuffer(1) };
  };
  const r = await adj.descargar([
    { url: 'http://169.254.169.254/latest/meta-data', nombre: 'm', tipo: 'documento' },
    { url: 'https://intranet.local/secreto.pdf', nombre: 's.pdf', tipo: 'documento' },
    { url: 'https://static.userback.io/redirige.png', nombre: 'r.png', tipo: 'imagen' },
  ], fs.mkdtempSync(path.join(os.tmpdir(), 'faro-adj-')), { fetchImpl: fakeFetch });
  assert.match(r[0].motivo, /host no permitido/);
  assert.match(r[1].motivo, /host no permitido/);
  assert.match(r[2].motivo, /host no permitido/, 'la redireccion a una IP interna se corta');
  assert.deepStrictEqual(pedidas, ['https://static.userback.io/redirige.png'], 'a los hosts no permitidos ni se les llama');
});

test('limite de adjuntos: el resto se lista con motivo, no desaparece', async () => {
  const muchos = Array.from({ length: adj.MAX_ADJUNTOS + 2 }, (_, i) => ({ url: `https://static.userback.io/${i}.txt`, nombre: `${i}.txt`, tipo: 'documento' }));
  const fakeFetch = async () => ({ ok: true, status: 200, headers: { get: () => 'text/plain' }, arrayBuffer: async () => new ArrayBuffer(1) });
  const r = await adj.descargar(muchos, fs.mkdtempSync(path.join(os.tmpdir(), 'faro-adj-')), { fetchImpl: fakeFetch });
  assert.strictEqual(r.length, adj.MAX_ADJUNTOS + 2);
  assert.match(r[r.length - 1].motivo, /limite/);
});
