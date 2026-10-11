import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAlertLedger } from '../lib/alert-ledger.mjs';

test('records direction-adjusted outcomes for bearish alerts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radar-ledger-'));const now=Date.parse('2026-09-20T12:00:00Z');
  try{
    const ledger=createAlertLedger({ledgerPath:join(dir,'ledger.jsonl'),outcomeStatePath:join(dir,'outcomes.json')});
    await ledger.reserve({id:'flow-1',kind:'flow',symbol:'TEST',direction:'BEARISH',entryPrice:100,entryAt:new Date(now).toISOString(),quoteKey:'Bybit:TEST'});
    const outcomes=await ledger.observe('flow',new Map([['Bybit:TEST',90]]),now+15*60000);
    const item=outcomes.find(x=>x.horizonMinutes===15);
    assert.equal(item.rawReturnPct,-10);assert.equal(item.directedReturnPct,10);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('records benchmark-adjusted and volatility-normalized X candidate outcomes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radar-ledger-x-'));const now=Date.parse('2026-09-20T12:00:00Z');
  try{
    const ledger=createAlertLedger({ledgerPath:join(dir,'ledger.jsonl'),outcomeStatePath:join(dir,'outcomes.json')});
    await ledger.reserve({id:'x-eval-1',kind:'x_candidate',symbol:'TEST',direction:'BULLISH',entryPrice:100,entryAt:new Date(now).toISOString(),quoteKey:'cg:test',benchmarkQuoteKey:'cg:bitcoin',benchmarkEntryPrice:100,preEventDailyVolatilityPct:6});
    const outcomes=await ledger.observe('x_candidate',new Map([['cg:test',104],['cg:bitcoin',101]]),now+360*60000);
    const item=outcomes.find(x=>x.horizonMinutes===360);
    assert.equal(item.abnormalReturnPct,3);
    assert.equal(item.directedAbnormalReturnPct,3);
    assert.equal(item.expectedMovePct,3);
    assert.equal(item.absoluteMovementToCatalystRatio,1);
    assert.equal(item.directionalMovementToCatalystRatio,1);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('reserves and updates simultaneous alerts as one batch',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radar-ledger-batch-'));
  try{
    const ledgerPath=join(dir,'ledger.jsonl'),outcomeStatePath=join(dir,'outcomes.json');
    const ledger=createAlertLedger({ledgerPath,outcomeStatePath});
    const alerts=[1,2,3].map(index=>({id:`pressure-${index}`,kind:'pressure',symbol:`T${index}`,direction:'BULLISH',entryPrice:index,entryAt:'2026-09-24T12:00:00Z',quoteKey:`Hyperliquid:T${index}`}));
    await ledger.reserveMany(alerts);
    await ledger.deliveryMany(alerts.map(alert=>({id:alert.id,status:'shadow'})));
    const state=JSON.parse(await readFile(outcomeStatePath,'utf8'));
    assert.equal(Object.keys(state.records).length,3);
    assert.ok(Object.values(state.records).every(record=>record.status==='shadow'));
    const events=(await readFile(ledgerPath,'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(events.filter(event=>event.type==='alert_reserved').length,3);
    assert.equal(events.filter(event=>event.type==='delivery').length,3);
  }finally{await rm(dir,{recursive:true,force:true})}
});

test('archives completed outcomes and keeps only active records in fast state',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'radar-ledger-archive-'));const now=Date.parse('2026-09-20T12:00:00Z');
  try{
    const ledgerPath=join(dir,'ledger.jsonl'),outcomeStatePath=join(dir,'outcomes.json'),outcomeArchivePath=join(dir,'archive.jsonl');
    const ledger=createAlertLedger({ledgerPath,outcomeStatePath,outcomeArchivePath});
    await ledger.reserveMany([
      {id:'complete',kind:'pressure',symbol:'DONE',direction:'BULLISH',entryPrice:100,entryAt:new Date(now-1441*60000).toISOString(),quoteKey:'Hyperliquid:DONE'},
      {id:'active',kind:'pressure',symbol:'LIVE',direction:'BULLISH',entryPrice:100,entryAt:new Date(now-10*60000).toISOString(),quoteKey:'Hyperliquid:LIVE'},
    ]);
    await ledger.annotateMany([{id:'complete',details:{evidence:'batched'}},{id:'active',details:{evidence:'batched'}}]);
    await ledger.observe('pressure',new Map([['Hyperliquid:DONE',110],['Hyperliquid:LIVE',101]]),now);
    const state=JSON.parse(await readFile(outcomeStatePath,'utf8'));
    assert.deepEqual(Object.keys(state.records),['active']);
    assert.equal(state.records.active.evidence,'batched');
    const archived=(await readFile(outcomeArchivePath,'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(archived.length,1);
    assert.equal(archived[0].id,'complete');
    assert.equal(archived[0].evidence,'batched');
    assert.ok(archived[0].horizons['1440']);
  }finally{await rm(dir,{recursive:true,force:true})}
});
