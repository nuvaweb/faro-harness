// Hexagonal estandar en ingles (domain/application/ports/adapters/entrypoints) y SDKs de nube
// prohibidos en el nucleo. Las declaraciones en espanol se cubren en hexagonal.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(RAIZ, 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const HX = require(path.join(HOOKS, 'lib', 'hexagonal.js'));
const LENG = require(path.join(HOOKS, 'lib', 'hexagonal-lenguajes.js'));

const fich = (obj) => Object.entries(obj).map(([rel, texto]) => ({ rel, ...LENG.extraer(rel, texto) }));
const EN = (permitidos = 'zod') => `## Hexagonal
- domain: src/domain/
- application: src/application/
- ports: src/ports/
- adapters: src/adapters/
- entrypoints: src/entrypoints/
- allowed: ${permitidos}
`;
const ES = `## Hexagonal
- dominio: src/dominio/
- aplicacion: src/aplicacion/
- puertos: src/puertos/
- adaptadores: src/adaptadores/
- composicion: src/index.ts
- permitidos: zod
`;

test('claves en inglés equivalen a las españolas', () => {
  const d = HX.leerDeclaracion(EN());
  assert.deepStrictEqual(d.capas.dominio, ['src/domain/']);
  assert.deepStrictEqual(d.capas.aplicacion, ['src/application/']);
  assert.deepStrictEqual(d.capas.puertos, ['src/ports/']);
  assert.deepStrictEqual(d.capas.adaptadores, ['src/adapters/']);
  assert.deepStrictEqual(d.composicion, ['src/entrypoints/']);
  assert.deepStrictEqual(d.permitidos, ['zod']);
  assert.deepStrictEqual(d.errores, []);
});

test('composition también vale como clave de composición', () => {
  const d = HX.leerDeclaracion('## Hexagonal\n- domain: src/domain/\n- composition: src/main.ts\n');
  assert.deepStrictEqual(d.composicion, ['src/main.ts']);
});

test('(FR) declaración en español sigue igual', () => {
  const d = HX.leerDeclaracion(ES);
  assert.deepStrictEqual(d.capas.dominio, ['src/dominio/']);
  assert.deepStrictEqual(d.capas.adaptadores, ['src/adaptadores/']);
  assert.deepStrictEqual(d.composicion, ['src/index.ts']);
  assert.deepStrictEqual(d.permitidos, ['zod']);
  assert.deepStrictEqual(d.errores, []);
  const r = HX.comprobar(d, fich({ 'src/dominio/a.ts': "import fs from 'fs';" }));
  assert.strictEqual(r.violaciones[0].regla, 'dominio hace E/S');
});

test('SDK de nube en application es violación aunque esté en allowed', () => {
  const d = HX.leerDeclaracion(EN('@aws-sdk/client-s3'));
  const r = HX.comprobar(d, fich({ 'src/application/x.ts': "import { S3Client } from '@aws-sdk/client-s3';" }));
  assert.strictEqual(r.conforme, false);
  assert.strictEqual(r.violaciones.length, 1);
  assert.strictEqual(r.violaciones[0].regla, 'application usa SDK de nube');
});

test('cloudflare:workers en domain es violación', () => {
  const r = HX.comprobar(HX.leerDeclaracion(ES), fich({ 'src/dominio/a.ts': "import { env } from 'cloudflare:workers';" }));
  assert.deepStrictEqual(r.violaciones.map((v) => v.regla), ['dominio usa SDK de nube']);
});

test('SDK de nube en ports también es violación', () => {
  const r = HX.comprobar(HX.leerDeclaracion(EN()), fich({ 'src/ports/p.ts': "import { Agent } from 'agents';" }));
  assert.deepStrictEqual(r.violaciones.map((v) => v.regla), ['ports usa SDK de nube']);
});

test('SDK de nube en adapters es válido', () => {
  const r = HX.comprobar(HX.leerDeclaracion(EN()), fich({ 'src/adapters/aws/s3.ts': "import { S3Client } from '@aws-sdk/client-s3';\nimport w from 'wrangler';" }));
  assert.deepStrictEqual(r.violaciones, []);
  assert.strictEqual(r.conforme, true);
});

test('esSdkNube reconoce la lista y no confunde paquetes parecidos', () => {
  for (const s of ['cloudflare:workers', 'agents', 'wrangler', 'aws-lambda', '@cloudflare/workers-types', '@aws-sdk/client-s3', '@azure/storage-blob']) {
    assert.strictEqual(HX.esSdkNube(s), true, s);
  }
  for (const s of ['zod', 'agentsmith', 'node:fs', '@awsome/x', './agents']) assert.strictEqual(HX.esSdkNube(s), false, s);
  assert.ok(HX.SDK_NUBE.includes('@aws-sdk/'));
});

test('cada violación trae un arreglo que dirige hacia la hexagonal', () => {
  const d = HX.leerDeclaracion(EN('@aws-sdk/client-s3'));
  const r = HX.comprobar(d, fich({
    'src/application/x.ts': "import { S3Client } from '@aws-sdk/client-s3';",
    'src/domain/a.ts': "import fs from 'fs';\nimport axios from 'axios';\nimport { b } from '../adapters/b';",
  }));
  assert.ok(r.violaciones.length >= 4);
  for (const v of r.violaciones) assert.ok(typeof v.arreglo === 'string' && v.arreglo.length > 0 && !v.arreglo.includes('\n'), v.regla);
  const nube = r.violaciones.find((v) => /SDK de nube/.test(v.regla));
  assert.match(nube.arreglo, /ports\//);
  assert.match(nube.arreglo, /adapters\//);
  assert.match(r.violaciones.find((v) => /paquete externo/.test(v.regla)).arreglo, /allowed/);
  assert.match(r.violaciones.find((v) => /→/.test(v.regla)).arreglo, /domain/);
});

test('pintar muestra el arreglo bajo cada violación', () => {
  const d = HX.leerDeclaracion(EN());
  const r = HX.comprobar(d, fich({ 'src/domain/a.ts': "import w from 'wrangler';" }));
  const txt = HX.pintar('x', d, r).join('\n');
  assert.match(txt, /domain usa SDK de nube/);
  assert.match(txt, /arreglo: .*ports\/.*adapters\//);
});

test('planMigracion propone rutas en inglés y renombrar las españolas', () => {
  const p = HX.planMigracion(fich({ 'src/dominio/a.ts': 'export const a=1', 'src/index.ts': '' }));
  assert.match(p.seccion, /- domain: src\/domain\//);
  assert.match(p.seccion, /- application: src\/application\//);
  assert.match(p.seccion, /- ports: src\/ports\//);
  assert.match(p.seccion, /- adapters: src\/adapters\//);
  assert.match(p.seccion, /- entrypoints: /);
  assert.ok(p.pasos.some((x) => /dominio\/ → domain\//.test(x)));
});

test('planMigracion no pide renombrar si no hay carpetas en español', () => {
  const p = HX.planMigracion(fich({ 'src/a.ts': 'export const a=1', 'src/index.ts': '' }));
  assert.ok(!p.pasos.some((x) => /→ domain\//.test(x)));
});

test('el arreglo nombra las carpetas en inglés aunque la declaración sea en español', () => {
  const d = HX.leerDeclaracion(ES);
  const r = HX.comprobar(d, fich({
    'src/dominio/a.ts': "import fs from 'fs';\nimport w from 'wrangler';\nimport { b } from '../adaptadores/b';",
  }));
  assert.ok(r.violaciones.length >= 3);
  for (const v of r.violaciones) {
    assert.match(v.arreglo, /domain\//, v.regla);
    assert.doesNotMatch(v.arreglo, /dominio\/|adaptadores\/|puertos\//, v.regla);
  }
  assert.ok(r.violaciones.every((v) => /^dominio /.test(v.regla)));
});
