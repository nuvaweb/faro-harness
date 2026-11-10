import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cdSugerido, comandoDependencias } from '../bin/lib/repo.mjs';

test('cdSugerido: subcarpeta → cd relativo', () => {
  const base = path.join(os.tmpdir(), 'faro-x');
  assert.equal(cdSugerido(base, path.join(base, 'faro-y')), 'cd "faro-y"');
});

test('cdSugerido: mismo directorio → null', () => {
  const base = path.join(os.tmpdir(), 'faro-x');
  assert.equal(cdSugerido(base, base), null);
});

test('cdSugerido: fuera del cwd → ruta absoluta', () => {
  const cwd = path.join(os.tmpdir(), 'faro-a', 'b');
  const destino = path.join(os.tmpdir(), 'faro-c');
  const out = cdSugerido(cwd, destino);
  assert.ok(out.startsWith('cd "') && out.includes('faro-c'));
});

test('comandoDependencias: precedencia lockfile > package.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-dep-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  assert.equal(comandoDependencias(dir), 'npm install');
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
  assert.equal(comandoDependencias(dir), 'pnpm install');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('comandoDependencias: python/go y vacío', () => {
  const py = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-py-'));
  fs.writeFileSync(path.join(py, 'requirements.txt'), '');
  assert.equal(comandoDependencias(py), 'pip install -r requirements.txt');
  const go = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-go-'));
  fs.writeFileSync(path.join(go, 'go.mod'), '');
  assert.equal(comandoDependencias(go), 'go mod download');
  const vac = fs.mkdtempSync(path.join(os.tmpdir(), 'faro-vac-'));
  assert.equal(comandoDependencias(vac), null);
  for (const d of [py, go, vac]) fs.rmSync(d, { recursive: true, force: true });
});
