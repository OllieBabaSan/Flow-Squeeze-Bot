import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return structuredClone(fallback); }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  const { rename } = await import('node:fs/promises');
  await rename(temp, path);
}

export async function appendJsonl(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, { flag: 'a' });
}

export async function readNewLines(path, offset) {
  try {
    const size = (await stat(path)).size;
    if (size < offset) offset = 0;
    if (size === offset) return { lines: [], offset };
    const handle = await open(path, 'r');
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    await handle.close();
    return { lines: buffer.toString('utf8').split(/\r?\n/).filter(Boolean), offset: size };
  } catch { return { lines: [], offset }; }
}
