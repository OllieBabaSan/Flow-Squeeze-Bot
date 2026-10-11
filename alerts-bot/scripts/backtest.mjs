import fs from 'node:fs/promises';
import { analyzeItem } from '../lib/analysis-engine.mjs';

const DAYS = Number(process.argv[2] || 60);
const END = Date.now();
const START = END - DAYS * 86400_000;
const sources = [
  ['CoinDesk','coindesk.com',18],['The Block','theblock.co',18],['Cointelegraph','cointelegraph.com',14],
  ['Decrypt','decrypt.co',15],['Blockworks','blockworks.co',16],['DL News','dlnews.com',16],
  ['Unchained','unchainedcrypto.com',16],['Bitcoin Magazine','bitcoinmagazine.com',14],
];
const tokenNames = {
  bitcoin:'BTC',ethereum:'ETH',ether:'ETH',solana:'SOL',ripple:'XRP',cardano:'ADA',avalanche:'AVAX',
  chainlink:'LINK',polygon:'POL',dogecoin:'DOGE',litecoin:'LTC',uniswap:'UNI',aave:'AAVE',hyperliquid:'HYPE',
  pons:'PONS',tron:'TRX',sui:'SUI',toncoin:'TON',binance:'BNB',arbitrum:'ARB',optimism:'OP',near:'NEAR',
  aptos:'APT',celestia:'TIA',injective:'INJ',zcash:'ZEC',tether:'USDT'
};
const events = [
  ['Exploit / security',/\b(hack(?:ed)?|exploit|drain(?:ed)?|attack|breach|vulnerability|halt(?:ed)?|stolen)\b/i,28],
  ['Regulation',/\b(sec|cftc|doj|court|lawsuit|approval|approved|reject(?:ed)?|ban(?:ned)?|regulation|legislation|etf)\b/i,22],
  ['Listing',/\b(list(?:s|ed|ing)?|delist(?:s|ed|ing)?|trading pair|spot market|perpetual futures)\b/i,25],
  ['Protocol metrics',/\b(fees?|revenue|volume|tvl|buyback|burn(?:ed)?|users?|transactions?|inflows?|outflows?)\b/i,18],
  ['Funding / partnership',/\b(partner(?:s|ed|ship)?|acquire(?:s|d)?|acquisition|raises?|funding|integrat(?:es|ion)|adoption)\b/i,15],
  ['Product / upgrade',/\b(launch(?:es|ed)?|mainnet|testnet|upgrade|release(?:s|d)?|staking|airdrop)\b/i,14],
];
const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
const field = (b,n) => decode(b.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}>`,'i'))?.[1]||'');
const words=s=>new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(x=>x.length>3));
const similarity=(a,b)=>{const A=words(a),B=words(b);let n=0;A.forEach(x=>B.has(x)&&n++);return n/Math.max(1,Math.min(A.size,B.size))};
const tokens=text=>{const out=new Set();for(const m of text.matchAll(/\$([A-Z][A-Z0-9]{1,9})\b/g))out.add(m[1]);for(const [n,s] of Object.entries(tokenNames))if(new RegExp(`\\b${n}\\b`,'i').test(text))out.add(s);return [...out].slice(0,6)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function get(url,retries=3){
  for(let i=0;i<retries;i++)try{const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 NewsRadarBacktest/1.0'}});if(r.ok)return r;if(r.status===429)await sleep(1500*(i+1));else throw new Error(`${r.status} ${url}`)}catch(e){if(i===retries-1)throw e;await sleep(800*(i+1))}
}
async function news(){
  const all=[];
  for(const [source,domain,authority] of sources){
    const queries=[`site:${domain} crypto when:${DAYS}d`,`site:${domain} (bitcoin OR ethereum OR solana OR XRP OR token) when:${DAYS}d`];
    for(const q of queries){
      const xml=await (await get(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`)).text();
      for(const b of xml.match(/<item\b[\s\S]*?<\/item>/gi)||[]){
        const title=field(b,'title').replace(new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}$`,'i'),'');
        const publishedAt=new Date(field(b,'pubDate')).getTime();
        if(title&&publishedAt>=START&&publishedAt<=END)all.push({title,url:field(b,'link'),publishedAt,source,authority,description:field(b,'description')});
      }
      await sleep(150);
    }
  }
  return all.filter((x,i,a)=>a.findIndex(y=>y.source===x.source&&(y.url===x.url||similarity(y.title,x.title)>.88))===i);
}
function score(item,all){
  const text=`${item.title} ${item.description}`; const event=events.find(e=>e[1].test(text)); const asset=tokens(text);
  const confirmations=new Set(all.filter(x=>x.source!==item.source&&Math.abs(x.publishedAt-item.publishedAt)<=12*3600_000&&similarity(x.title,item.title)>.52).map(x=>x.source)).size+1;
  let value=(event?.[2]||4)+item.authority+18+(asset.length?10:0)+Math.min(12,(confirmations-1)*6);
  if(/\b(opinion|predicts?|could|may|analyst says|price prediction)\b/i.test(text))value-=18;
  if(/\b(rumou?r|unconfirmed|reportedly)\b/i.test(text))value-=10;
  if(confirmations===1)value-=4;
  // Binance-listed assets are used as the reproducible proxy for the live model's liquidity bonus.
  if(asset.some(x=>x!=='USDT'))value+=4;
  return {...item,tokens:asset.filter(x=>x!=='USDT'),eventType:event?.[0]||'Market context',confirmations,score:Math.max(0,Math.min(100,value))};
}
async function candles(symbol){
  const pair=`${symbol}USDT`; let cursor=START-3600_000,out=[];
  while(cursor<END+25*3600_000){
    const u=`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1h&startTime=${cursor}&endTime=${END+25*3600_000}&limit=1000`;
    const rows=await (await get(u)).json(); if(!Array.isArray(rows)||!rows.length)break;
    out.push(...rows.map(r=>({t:Number(r[0]),o:Number(r[1]),c:Number(r[4])}))); cursor=Number(rows.at(-1)[0])+3600_000;if(rows.length<1000)break;await sleep(80);
  }
  return out;
}
const priceAt=(rows,t)=>{const x=rows.find(r=>r.t>=Math.floor(t/3600_000)*3600_000);return x?.o||null};
const pct=(a,b)=>a&&b?(b/a-1)*100:null;
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const median=a=>{if(!a.length)return null;const x=[...a].sort((a,b)=>a-b),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2};
const round=x=>x==null?null:Number(x.toFixed(3));

const raw=await news();
const unique=raw.filter((x,i,a)=>a.findIndex(y=>y.url===x.url||similarity(y.title,x.title)>.88)===i);
const legacyScored=unique.map(x=>score(x,raw)).filter(x=>x.tokens.length===1);
const scored=unique.map(x=>({...x,...analyzeItem(x,raw,null,x.publishedAt+5*60000)})).filter(x=>x.actionability==='ACTIONABLE'&&x.tokens.length===1);
const syms=[...new Set(scored.flatMap(x=>x.tokens))];
const market={};
for(const s of ['BTC','ETH',...syms.filter(x=>!['BTC','ETH'].includes(x))])try{market[s]=await candles(s)}catch{market[s]=[]} 
const rows=[];
for(const e of scored){
  const s=e.tokens[0], c=market[s], benchmark=s==='BTC'?market.ETH:market.BTC;if(!c?.length||!benchmark?.length)continue;
  const base=priceAt(c,e.publishedAt),btcBase=priceAt(benchmark,e.publishedAt);if(!base||!btcBase)continue;
  const result={...e,publishedAt:new Date(e.publishedAt).toISOString()};
  for(const h of [1,4,24]){const r=pct(base,priceAt(c,e.publishedAt+h*3600_000));const br=pct(btcBase,priceAt(benchmark,e.publishedAt+h*3600_000));result[`r${h}h`]=r;result[`abn${h}h`]=r==null||br==null?null:r-br}
  rows.push(result);
}
function summarize(items){
  const r={n:items.length};
  for(const h of [1,4,24]){const vals=items.map(x=>x[`abn${h}h`]).filter(Number.isFinite);const hits=vals.filter(x=>Math.abs(x)>=2).length;r[`${h}h_mean_abnormal`]=round(mean(vals));r[`${h}h_median_abs_abnormal`]=round(median(vals.map(Math.abs)));r[`${h}h_hit_rate_2pct`]=vals.length?round(hits/vals.length):null}
  return r;
}
function rank(a){const idx=a.map((v,i)=>[v,i]).sort((x,y)=>x[0]-y[0]),r=Array(a.length);for(let i=0;i<idx.length;){let j=i;while(j+1<idx.length&&idx[j+1][0]===idx[i][0])j++;const avg=(i+j+2)/2;for(let k=i;k<=j;k++)r[idx[k][1]]=avg;i=j+1}return r}
function corr(a,b){if(a.length<3)return null;const am=mean(a),bm=mean(b);let n=0,da=0,db=0;for(let i=0;i<a.length;i++){const x=a[i]-am,y=b[i]-bm;n+=x*y;da+=x*x;db+=y*y}return da&&db?n/Math.sqrt(da*db):null}
const paired24=rows.filter(x=>Number.isFinite(x.abn24h));
const spearman24=corr(rank(paired24.map(x=>x.score)),rank(paired24.map(x=>Math.abs(x.abn24h))));
const sortedScores=[...paired24].sort((a,b)=>a.score-b.score),q=Math.max(1,Math.floor(sortedScores.length/4));
const quartiles={bottom:summarize(sortedScores.slice(0,q)),top:summarize(sortedScores.slice(-q))};
const materialDirectional=paired24.filter(x=>Math.abs(x.abn24h)>=2&&(x.direction==='BULLISH'||x.direction==='BEARISH'));
const correctDirectional=materialDirectional.filter(x=>(x.direction==='BULLISH'&&x.abn24h>0)||(x.direction==='BEARISH'&&x.abn24h<0));
const bands={HIGH:rows.filter(x=>x.score>=72),WATCH:rows.filter(x=>x.score>=48&&x.score<72),LOW:rows.filter(x=>x.score<48)};
const byEvent=Object.fromEntries([...new Set(rows.map(x=>x.eventType))].map(k=>[k,summarize(rows.filter(x=>x.eventType===k))]));
const thresholds={};for(let t=50;t<=85;t+=5)thresholds[t]=summarize(rows.filter(x=>x.score>=t));
const report={generatedAt:new Date().toISOString(),modelVersion:'asset-catalyst-v2',periodDays:DAYS,method:{news:'Google News RSS source-domain search; publisher timestamps',prices:'Binance 1-hour USDT candles',outcome:'Token return minus market proxy (BTC; ETH for BTC events); hit = |abnormal return| >= 2%',constraints:['Single-token actionable headlines only','Binance-listed tokens only','Hourly bars cannot measure sub-hour lead time','Google News archive is a sample, not a complete publisher archive','Article timestamps can lag the original catalyst','Historical social/KOL coverage is not included in this publisher archive']},coverage:{rawNews:raw.length,uniqueNews:unique.length,legacySingleTokenCandidates:legacyScored.length,actionableSingleTokenCandidates:scored.length,matchedEvents:rows.length,symbolsWithCandles:Object.entries(market).filter(([,v])=>v.length).map(([k])=>k)},bands:Object.fromEntries(Object.entries(bands).map(([k,v])=>[k,summarize(v)])),thresholds,byEvent,diagnostics:{spearman_score_vs_abs_abnormal_24h:round(spearman24),scoreQuartiles24h:quartiles,directionality:{materialMoves:materialDirectional.length,correct:correctDirectional.length,accuracy:materialDirectional.length?round(correctDirectional.length/materialDirectional.length):null,definition:'Evaluated only when absolute 24h abnormal movement is at least 2%; smaller moves are no-effect outcomes, not direction errors'}},events:rows.map(x=>({date:x.publishedAt,source:x.source,title:x.title,token:x.tokens[0],eventType:x.eventType,direction:x.direction,score:x.score,confirmations:x.confirmations,r1h:round(x.r1h),abn1h:round(x.abn1h),r4h:round(x.r4h),abn4h:round(x.abn4h),r24h:round(x.r24h),abn24h:round(x.abn24h),url:x.url}))};
await fs.mkdir('backtest',{recursive:true});
await fs.writeFile('backtest/results.json',JSON.stringify(report,null,2));
const lines=['# Crypto News Radar — 60-Day Backtest','',`Generated: ${report.generatedAt}`,`Matched events: ${rows.length} from ${raw.length} archived headlines`,'','## Score bands','', '| Band | N | 1h hit | 4h hit | 24h hit | 24h median abs abnormal |','|---|---:|---:|---:|---:|---:|'];
for(const [k,v] of Object.entries(report.bands))lines.push(`| ${k} | ${v.n} | ${v['1h_hit_rate_2pct']??'—'} | ${v['4h_hit_rate_2pct']??'—'} | ${v['24h_hit_rate_2pct']??'—'} | ${v['24h_median_abs_abnormal']??'—'}% |`);
lines.push('','## Threshold sensitivity','', '| Minimum score | N | 4h hit | 24h hit | 24h median abs abnormal |','|---:|---:|---:|---:|---:|');
for(const [k,v] of Object.entries(report.thresholds))lines.push(`| ${k} | ${v.n} | ${v['4h_hit_rate_2pct']??'—'} | ${v['24h_hit_rate_2pct']??'—'} | ${v['24h_median_abs_abnormal']??'—'}% |`);
lines.push('','## Rank diagnostic','',`Spearman correlation between score and 24-hour absolute abnormal movement: ${round(spearman24)??'—'}`,`Top score quartile 24-hour hit rate: ${quartiles.top['24h_hit_rate_2pct']??'—'}`,`Bottom score quartile 24-hour hit rate: ${quartiles.bottom['24h_hit_rate_2pct']??'—'}`);
lines.push('','## Important constraints','',...report.method.constraints.map(x=>`- ${x}`),'','Detailed event-level results are in `results.json`.');
lines.push('','## Comparative result','',`The legacy keyword model produced ${legacyScored.length} single-token candidates. The direction-gated asset-catalyst engine retained ${scored.length}, eliminating ${round((1-scored.length/Math.max(1,legacyScored.length))*100)}% of candidates that lacked a direct, directional catalyst relationship.`,'',`Of the ${paired24.length} retained events with complete 24-hour data, ${materialDirectional.length} produced at least a 2% market-adjusted move. ${correctDirectional.length} moved in the classified direction. Smaller moves are effectiveness failures, not direction-classification errors.`,'','The production HIGH threshold is 80. Actionable scores from 65–79 are WATCH items and are not sent to Discord.','','## Decision','','Semantic direction is deterministic: ambiguous or mixed-direction reports are chatter and cannot alert. Historical market-response validation remains inconclusive because the surviving sample of material moves is too small.');
await fs.writeFile('backtest/REPORT.md',lines.join('\n'));
console.log(JSON.stringify({coverage:report.coverage,bands:report.bands,thresholds:report.thresholds,byEvent:report.byEvent},null,2));
