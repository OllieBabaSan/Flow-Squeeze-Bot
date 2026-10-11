import test from 'node:test';
import assert from 'node:assert/strict';
import {alertFrequencyDecision,alertScopeKey,dispatchDecision,eventKey} from '../lib/dispatch-policy.mjs';

const now=Date.parse('2026-09-08T04:00:00Z');
const signal=(publishedAt,extra={})=>({level:'HIGH',score:88,actionability:'ACTIONABLE',tokens:['SOL'],eventType:'Chain disruption',opportunityStatus:'FLASH_EARLY',title:'Solana network halts block production',publishedAt,...extra});

test('fresh qualifying catalyst dispatches',()=>assert.equal(dispatchDecision(signal('2026-09-08T03:42:00Z'),now).eligible,true));
test('fresh actionable watch candidate reaches editorial review',()=>assert.equal(dispatchDecision(signal('2026-09-08T03:42:00Z',{level:'WATCH',score:68}),now).eligible,true));
test('ten hour old article is rejected even when newly discovered',()=>assert.deepEqual(dispatchDecision(signal('2026-09-07T18:00:00Z'),now),{eligible:false,reason:'stale'}));
test('article outside 30 minute window is rejected',()=>assert.equal(dispatchDecision(signal('2026-09-08T03:29:00Z'),now).reason,'stale'));
test('invalid and future timestamps are rejected',()=>{assert.equal(dispatchDecision(signal(''),now).reason,'invalid_timestamp');assert.equal(dispatchDecision(signal('2026-09-08T04:06:00Z'),now).reason,'future_timestamp')});
test('late chase signals never dispatch',()=>assert.equal(dispatchDecision(signal('2026-09-08T03:55:00Z',{opportunityStatus:'LATE_CHASE_RISK'}),now).reason,'late_chase'));
test('event key is stable across punctuation and filler words',()=>assert.equal(eventKey(signal('2026-09-08T03:55:00Z')),eventKey(signal('2026-09-08T03:55:00Z',{title:'The Solana network halts: block production'}))));
test('alert scope combines token and chain rather than headline',()=>{const first=signal('2026-09-08T03:55:00Z',{marketClassification:{chain:'Solana'}});const second={...first,title:'Different publisher wording',eventType:'Exploit / security'};assert.equal(alertScopeKey(first),alertScopeKey(second));assert.equal(alertScopeKey(first),'SOL:SOLANA')});
test('same scope is limited to one alert per rolling hour',()=>{assert.equal(alertFrequencyDecision([now-59*60000],now).reason,'scope_hourly_limit');assert.equal(alertFrequencyDecision([now-61*60000],now).eligible,true)});
test('same scope is limited to three alerts per rolling day',()=>{const history=[now-2*3600_000,now-8*3600_000,now-20*3600_000];assert.equal(alertFrequencyDecision(history,now).reason,'scope_daily_limit');assert.equal(alertFrequencyDecision(history.slice(0,2),now).eligible,true)});
test('expired and duplicate timestamps do not consume scope quota',()=>{assert.equal(alertFrequencyDecision([now-25*3600_000,now-2*3600_000,now-2*3600_000],now).dayCount,1)});
