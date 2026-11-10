// Lint determinista (0.9.3): TODO proceso hijo del motor debe llevar windowsHide: true — en Windows
// un spawn sin esa opcion puede abrir una ventana de consola fugaz ("flash") en cada evento de hook,
// una mala experiencia para el usuario. Mismo trabajo, invisible.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'faro', 'hooks');

const files = [
  ...fs.readdirSync(HOOKS).filter((f) => f.endsWith('.js')).map((f) => path.join(HOOKS, f)),
  ...fs.readdirSync(path.join(HOOKS, 'lib')).filter((f) => f.endsWith('.js')).map((f) => path.join(HOOKS, 'lib', f)),
];

test('todo spawn/exec del motor lleva windowsHide: true (sin flashes de consola en Windows)', () => {
  const faltas = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith('//')) return;
      // Una llamada dentro de un STRING no es codigo que se ejecute: los mensajes de ayuda del motor
      // sugieren comandos al usuario ("mide con: node -e \"...execFileSync...\"") y no deben contar
      // como spawns sin windowsHide. Se vacian los literales antes de buscar (comillas y plantillas).
      const codigo = line
        .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '``')
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""');
      if (!/\b(execFileSync|execSync|spawnSync|spawn)\s*\(/.test(codigo)) return;
      if (/require\(|\bconst\b.*=\s*require/.test(line) && !/\(\s*['"`]/.test(line.split(/\b(?:execFileSync|execSync|spawnSync|spawn)\s*\(/)[1] || '')) {
        // linea de import (destructuring), no una llamada
        if (/^\s*const\s*\{/.test(line)) return;
      }
      // la llamada puede partir sus opciones en varias lineas: mira la sentencia (hasta 6 lineas)
      const stmt = lines.slice(i, i + 6).join(' ');
      if (!/windowsHide\s*:\s*true/.test(stmt)) faltas.push(`${path.basename(path.dirname(file))}/${path.basename(file)}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(faltas, [], `spawns SIN windowsHide (flashean consola en Windows):\n${faltas.join('\n')}`);
});
