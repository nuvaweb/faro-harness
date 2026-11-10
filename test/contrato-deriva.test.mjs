// CAPA 2 — deriva entre el contrato DOCUMENTADO y el que el codigo expone de verdad.
//
// Los gates responden "¿compila? ¿pasan los tests?". La evidencia responde "¿esta probado lo
// pactado?". Falta la tercera: **¿lo que el codigo expone HOY sigue siendo lo que el documento dice
// que expone?** — y es la que rompe integraciones ajenas.
//
// El caso tipico no es un fallo: es un exito a medias. Alguien anade un campo o una ruta, actualiza
// SUS tests, todo pasa en verde... y el funcional que leyo el cliente ya no describe la realidad.
// Nadie se entera hasta que un tercero integra contra el documento y se estrella.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');
const require = createRequire(import.meta.url);
const { endpointsDocumentados, endpointsEnCodigo, derivaDeContrato, avisoDeriva, normalizar } = require(path.join(HOOKS, 'lib', 'contrato.js'));

const src = (texto, rel = 'src/index.js') => [{ rel, texto }];

// ---------- leer el documento ----------

// Se acepta como la gente ESCRIBE endpoints, no un formato inventado: exigir una sintaxis propia
// para poder comparar garantizaria que no hay nada que comparar.
test('reconoce endpoints escritos como se escriben de verdad en un funcional', () => {
  const doc = `## API
- POST /leads — crea
- \`GET /leads/{id}\` — consulta
| DELETE | /leads/{id} | borra |
El endpoint PATCH /leads/{id}/estado cambia el estado.
`;
  const e = endpointsDocumentados(doc);
  assert.strictEqual(e.length, 4, JSON.stringify(e.map((x) => x.clave)));
  assert.ok(e.some((x) => x.metodo === 'DELETE'), 'el de la tabla tambien cuenta');
});

test('no duplica el mismo endpoint citado dos veces', () => {
  assert.strictEqual(endpointsDocumentados('POST /leads\ny otra vez POST /leads').length, 1);
});

// ---------- leer el codigo ----------

test('reconoce los routers habituales', () => {
  const e = endpointsEnCodigo(src("app.post('/leads', h);\nrouter.get(\"/users\", h);\napp.delete(`/x`, h);"));
  assert.strictEqual(e.length, 3, JSON.stringify(e.map((x) => x.clave)));
});

// Hono (el router mas comun en Workers) registra varios metodos de golpe.
test('app.on([...]) registra TODOS los metodos que declara, no uno', () => {
  const e = endpointsEnCodigo(src("app.on(['GET','POST'], '/leads', h)"));
  assert.strictEqual(e.length, 2, JSON.stringify(e.map((x) => x.clave)));
});

test('dice en QUE fichero esta cada endpoint (si no, no se puede ir a mirarlo)', () => {
  assert.strictEqual(endpointsEnCodigo(src("app.get('/x', h)", 'src/rutas/leads.ts'))[0].donde, 'src/rutas/leads.ts');
});

// ---------- lo que evita los falsos positivos ----------

// Sin esto, CADA repo que mezcle convenciones entre documento y codigo (casi todos) daria derivas
// falsas — y un detector que grita en falso se desactiva a la semana.
test('/{id} y /:id son el MISMO endpoint: el nombre del parametro no es el contrato', () => {
  assert.strictEqual(normalizar('/leads/{id}'), normalizar('/leads/:leadId'));
  const d = derivaDeContrato('GET /leads/{id}', src("app.get('/leads/:leadId', h)"));
  assert.strictEqual(d.coinciden, 1, 'deberian casar');
  assert.deepStrictEqual([d.sinDocumentar.length, d.sinImplementar.length], [0, 0]);
});

test('la barra final y las mayusculas tampoco son el contrato', () => {
  const d = derivaDeContrato('post /Leads/', src("app.post('/leads', h)"));
  assert.strictEqual(d.coinciden, 1);
});

// ---------- las dos derivas, que NO son el mismo problema ----------

test('el documento PROMETE algo que el codigo no tiene: quien integre se estrella', () => {
  const d = derivaDeContrato('POST /leads\nDELETE /leads/{id}', src("app.post('/leads', h)"));
  assert.strictEqual(d.sinImplementar.length, 1);
  assert.strictEqual(d.sinImplementar[0].metodo, 'DELETE');
  assert.match(avisoDeriva(d), /PROMETE/);
  assert.match(avisoDeriva(d), /se estrellara|integre/i, 'debe decir la consecuencia, no solo el hecho');
});

test('el codigo EXPONE algo que nadie documento: superficie invisible', () => {
  const d = derivaDeContrato('POST /leads', src("app.post('/leads', h);\napp.patch('/leads/:id/estado', h)"));
  assert.strictEqual(d.sinDocumentar.length, 1);
  assert.match(avisoDeriva(d), /EXPONE/);
  assert.match(avisoDeriva(d), /invisible|nadie sabe/i);
});

test('las dos a la vez se cuentan por separado (son problemas distintos)', () => {
  const d = derivaDeContrato('POST /leads\nDELETE /leads/{id}', src("app.post('/leads', h);\napp.patch('/x', h)"));
  assert.strictEqual(d.sinImplementar.length, 1);
  assert.strictEqual(d.sinDocumentar.length, 1);
});

// ---------- el silencio ----------

test('si todo cuadra NO dice nada', () => {
  assert.strictEqual(avisoDeriva(derivaDeContrato('POST /x', src("app.post('/x', h)"))), null);
});

// "No hay nada que comparar" NO es "cuadra": decirlo en cada repo documental seria ruido puro, y un
// aviso que salta siempre se aprende a ignorar.
test('sin endpoints en ningun lado calla (aqui no aplica)', () => {
  assert.strictEqual(avisoDeriva(derivaDeContrato('# Un funcional sin API', [])), null);
  assert.strictEqual(avisoDeriva(derivaDeContrato('', [])), null);
});

// No bloquea a proposito: como gate se sortearia borrando la linea del documento, que es justo lo
// contrario de lo que se busca.
test('el aviso deja claro que la decision es del humano', () => {
  const a = avisoDeriva(derivaDeContrato('POST /x\nGET /y', src("app.post('/x', h)")));
  assert.match(a, /deliberado|descuido/i, 'una deriva puede ser intencionada');
  assert.match(a, /No bloquea/i, a);
});
