import test from 'node:test';
import assert from 'node:assert/strict';
import { clearTokenRegistryCache, contractAddressLabel, hasVerifiedContract, isMemeToken, registryLabel, resolveTrackedToken } from '../lib/token-registry.mjs';

test('resolves an ambiguous ticker from article identity rather than rank alone',async()=>{
  clearTokenRegistryCache();
  const fetchImpl=async url=>url.includes('/search?')?({ok:true,json:async()=>({coins:[
    {id:'bohr',name:'BOHR',symbol:'br',market_cap_rank:5893},
    {id:'bedrock',name:'Bedrock',symbol:'br',market_cap_rank:321},
    {id:'not-br',name:'Other',symbol:'other',market_cap_rank:1},
  ]})}):({ok:true,json:async()=>({bohr:{usd:.004},bedrock:{usd:.26}})});
  const identity=await resolveTrackedToken('BR',{fetchImpl,env:{},contextText:'Bedrock token unlock'});
  assert.equal(identity.name,'Bedrock');
  assert.equal(identity.provider,'CoinGecko');
  assert.match(registryLabel(identity),/Bedrock \(\$BR\)/);
});

test('rejects an ambiguous ticker without name or price corroboration',async()=>{
  clearTokenRegistryCache();
  const fetchImpl=async url=>url.includes('/search?')?({ok:true,json:async()=>({coins:[{id:'one',name:'One',symbol:'xx'},{id:'two',name:'Two',symbol:'xx'}]})}):({ok:true,json:async()=>({})});
  assert.equal(await resolveTrackedToken('XX',{fetchImpl,env:{}}),null);
});

test('returns null when neither trusted registry verifies the symbol',async()=>{
  clearTokenRegistryCache();
  const fetchImpl=async()=>({ok:true,json:async()=>({coins:[]})});
  assert.equal(await resolveTrackedToken('NOTREAL',{fetchImpl,env:{}}),null);
});

test('falls back to the keyless CoinMarketCap map when CoinGecko is unavailable',async()=>{
  clearTokenRegistryCache();
  const urls=[];
  const fetchImpl=async url=>{
    urls.push(url);
    if(url.includes('coingecko.com')) return {ok:false,json:async()=>({})};
    return {ok:true,json:async()=>({data:[
      {id:1,name:'Bitcoin',symbol:'BTC',slug:'bitcoin',rank:1,is_active:1},
      {id:2,name:'Bitcoin Copy',symbol:'BTC',slug:'bitcoin-copy',rank:3000,is_active:1},
    ]})};
  };
  const identity=await resolveTrackedToken('BTC',{fetchImpl,env:{},contextText:'Bitcoin adoption accelerates'});
  assert.equal(identity.name,'Bitcoin');
  assert.equal(identity.provider,'CoinMarketCap Public');
  assert.ok(urls.some(url=>url.includes('/public-api/v1/cryptocurrency/map')));
});

test('sends a configured CoinGecko demo key in the request header',async()=>{
  clearTokenRegistryCache();
  let headers;
  const fetchImpl=async (url,options)=>{
    headers=options.headers;
    return url.includes('/search?')
      ? {ok:true,json:async()=>({coins:[{id:'bitcoin',name:'Bitcoin',symbol:'btc',market_cap_rank:1}]})}
      : {ok:true,json:async()=>({bitcoin:{usd:100000}})};
  };
  await resolveTrackedToken('BTC',{fetchImpl,env:{COINGECKO_API_KEY:'demo-key'},contextText:'Bitcoin'});
  assert.equal(headers['x-cg-demo-api-key'],'demo-key');
});

test('fetches and formats the verified contract address from CoinGecko',async()=>{
  clearTokenRegistryCache();
  const fetchImpl=async url=>{
    if(url.includes('/search?'))return {ok:true,json:async()=>({coins:[{id:'pepe',name:'Pepe',symbol:'pepe',market_cap_rank:50}]})};
    if(url.includes('/simple/price'))return {ok:true,json:async()=>({pepe:{usd:.00001}})};
    return {ok:true,json:async()=>({asset_platform_id:'ethereum',platforms:{ethereum:'0x6982508145454Ce325dDbE47a25d4ec3d2311933'},categories:['Meme']})};
  };
  const identity=await resolveTrackedToken('PEPE',{fetchImpl,env:{},contextText:'Pepe'});
  assert.deepEqual(identity.contracts,[{platform:'Ethereum',address:'0x6982508145454Ce325dDbE47a25d4ec3d2311933'}]);
  assert.match(contractAddressLabel(identity,'Ethereum (ERC-20)'),/0x6982508145454Ce325dDbE47a25d4ec3d2311933/);
  assert.equal(isMemeToken(identity),true);
  assert.equal(hasVerifiedContract(identity),true);
});

test('labels native assets without inventing a contract address',async()=>{
  clearTokenRegistryCache();
  const fetchImpl=async url=>{
    if(url.includes('/search?'))return {ok:true,json:async()=>({coins:[{id:'bitcoin',name:'Bitcoin',symbol:'btc',market_cap_rank:1}]})};
    if(url.includes('/simple/price'))return {ok:true,json:async()=>({bitcoin:{usd:100000}})};
    return {ok:true,json:async()=>({asset_platform_id:null,platforms:{}})};
  };
  const identity=await resolveTrackedToken('BTC',{fetchImpl,env:{},contextText:'Bitcoin'});
  assert.equal(contractAddressLabel(identity),'Native asset — no contract address');
  assert.equal(hasVerifiedContract(identity),false);
});

test('recognizes explicit memecoin reporting when registry categories are absent',()=>{
  assert.equal(isMemeToken({categories:[]},{title:'New meme coin launches on Solana'}),true);
});

test('shows only the requested chain address when a token has several contracts',()=>{
  const identity={provider:'Registry',contractStatus:'verified',primaryPlatform:'Ethereum',contracts:[
    {platform:'Ethereum',address:'0xprimary'},
    {platform:'Solana',address:'SolanaAddress'},
  ]};
  assert.equal(contractAddressLabel(identity,'Solana (SPL)'),'**Solana:** `SolanaAddress`');
  assert.equal(contractAddressLabel(identity,'Not identified — verify source'),'**Ethereum:** `0xprimary`');
});

test('prefers Monad native identity over a wrapped Solana MON contract',()=>{
  const identity={symbol:'MON',name:'Monad',provider:'CoinMarketCap',contractStatus:'verified',primaryPlatform:'',contracts:[
    {platform:'Solana',address:'CrAr4RRJMBVwRsZtT62pEhfA9H5utymC2mVx8e7FreP2'},
    {platform:'Monad',address:'0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'},
  ]};
  assert.equal(contractAddressLabel(identity),'Native asset on **Monad** — no contract address');
  assert.equal(contractAddressLabel(identity,'Solana (SPL)'),'**Solana:** `CrAr4RRJMBVwRsZtT62pEhfA9H5utymC2mVx8e7FreP2`');
});

test('does not treat a native-asset marker as a verified contract',()=>{
  const identity={contractStatus:'verified',contracts:[{platform:'Monad',address:'0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'}]};
  assert.equal(hasVerifiedContract(identity),false);
});
