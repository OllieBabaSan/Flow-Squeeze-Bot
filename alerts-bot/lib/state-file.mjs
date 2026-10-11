import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJsonWithBackup(path, fallback) {
  for (const candidate of [path, `${path}.bak`]) {
    try { return JSON.parse(await readFile(candidate, 'utf8')); } catch {}
  }
  return structuredClone(fallback);
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  try { await copyFile(path, `${path}.bak`); } catch {}
  try {
    await rename(temporary, path);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    await unlink(path).catch(() => {});
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

