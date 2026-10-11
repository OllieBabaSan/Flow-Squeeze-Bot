import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJsonWithBackup, writeJsonAtomic } from '../lib/state-file.mjs';

test('atomic state writer preserves a readable backup',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radar-state-'));const path=join(dir,'state.json');
  try{
    await writeJsonAtomic(path,{version:1});await writeJsonAtomic(path,{version:2});
    assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{version:2});
    await writeFile(path,'broken');
    assert.deepEqual(await readJsonWithBackup(path,{}),{version:1});
  }finally{await rm(dir,{recursive:true,force:true})}
});

