// La skill /faro:desplegar debe existir con frontmatter valido y no prometer lo que FARO no hace.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = path.join(RAIZ, 'plugins', 'faro', 'skills', 'desplegar', 'SKILL.md');

test('desplegar: frontmatter con description y argument-hint', () => {
  assert.ok(fs.existsSync(SKILL), 'falta skills/desplegar/SKILL.md');
  const txt = fs.readFileSync(SKILL, 'utf8').replace(/\r\n/g, '\n');
  const fm = txt.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, 'sin frontmatter');
  assert.match(fm[1], /^description:\s*"?\S/m);
  assert.match(fm[1], /^argument-hint:\s*"?\S/m);
});

test('desplegar: deriva a los comandos reales y no promete deploy.yml ni secretos', () => {
  const txt = fs.readFileSync(SKILL, 'utf8');
  for (const c of ['harness.js" despliegue', 'hexagonal --plan', 'harness.js" ci']) assert.ok(txt.includes(c), c);
  assert.ok(!/secretosEsperados/.test(txt));
  assert.ok(!/deploy\.yml/.test(txt.replace(/no (genera|crea)[^\n]*deploy\.yml/gi, '')));
});
