import { NextResponse } from 'next/server';
import { analyzeItem, similarity } from '../../../lib/analysis-engine.mjs';
import { classifyMarketStatus } from '../../../lib/market-classification.mjs';

export const dynamic = 'force-dynamic';

type RawItem = { title:string; url:string; publishedAt:Date; source:string; description:string; authority?:number; sourceClass?:'publisher'|'kol'|'policy'|'protocol' };
type Source = { name:string; url:string; authority:number; kind:'rss'|'cryptopanic'; sourceClass?:'publisher'|'kol'|'policy'|'protocol' };
type Market = { symbol:string; change24h:number|null; marketCap:number; volume:number };

const SOURCES: Source[] = [
  { name:'CoinDesk', url:'https://www.coindesk.com/arc/outboundfeeds/rss/', authority:18, kind:'rss' },
  { name:'The Block', url:'https://www.theblock.co/rss.xml', authority:18, kind:'rss' },
  { name:'Cointelegraph', url:'https://cointelegraph.com/rss', authority:14, kind:'rss' },
  { name:'Decrypt', url:'https://decrypt.co/feed', authority:15, kind:'rss' },
  { name:'CoinNess', url:'https://coinness.com/en', authority:15, kind:'rss' },
  { name:'Blockworks', url:'https://blockworks.co/feed', authority:16, kind:'rss' },
  { name:'DL News', url:'https://www.dlnews.com/arc/outboundfeeds/rss/', authority:16, kind:'rss' },
  { name:'Unchained', url:'https://unchainedcrypto.com/feed/', authority:16, kind:'rss' },
  { name:'Bitcoin Magazine', url:'https://bitcoinmagazine.com/.rss/full/', authority:14, kind:'rss' },
  { name:"Trump's Truth", url:'https://www.trumpstruth.org/feed', authority:25, kind:'rss', sourceClass:'policy' },
  { name:'Google News / launches and institutions', url:'https://news.google.com/rss/search?q=%28crypto%20OR%20blockchain%20OR%20token%20OR%20DeFi%29%20%28launches%20OR%20launched%20OR%20introduces%20OR%20unveils%20OR%20%22goes%20live%22%20OR%20%22powered%20by%22%29%20%28BlackRock%20OR%20JPMorgan%20OR%20DTCC%20OR%20Visa%20OR%20Mastercard%20OR%20Fidelity%20OR%20Nasdaq%20OR%20NYSE%29%20when%3A1h&hl=en-US&gl=US&ceid=US%3Aen', authority:18, kind:'rss' },
  { name:'Google News / crypto wires', url:'https://news.google.com/rss/search?q=%28site%3Aprnewswire.com%20OR%20site%3Abusinesswire.com%20OR%20site%3Aglobenewswire.com%29%20%28crypto%20OR%20blockchain%20OR%20token%20OR%20DeFi%29%20when%3A1h&hl=en-US&gl=US&ceid=US%3Aen', authority:19, kind:'rss' },
];

const decode=(s:string)=>s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
const field=(block:string,names:string[])=>{for(const name of names){const m=block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i'));if(m)return decode(m[1])}return''};

export function parseFeed(xml:string, source:string):RawItem[]{
  const blocks=[...(xml.match(/<item\b[\s\S]*?<\/item>/gi)||[]),...(xml.match(/<entry\b[\s\S]*?<\/entry>/gi)||[])];
  return blocks.slice(0,35).map(b=>{
    const href=b.match(/<link[^>]+href=["']([^"']+)/i)?.[1]||field(b,['link']);
    const rawDate=field(b,['pubDate','published','updated','dc:date']);
    return {title:field(b,['title']),url:decode(href),publishedAt:new Date(rawDate),source,description:field(b,['description','summary','content:encoded','content'])};
  }).filter(x=>x.title&&x.url&&!Number.isNaN(x.publishedAt.getTime()));
}

async function fetchText(url:string){const r=await fetch(url,{headers:{'User-Agent':'NewsRadar/1.0 (+research dashboard)','Accept':'application/rss+xml, application/xml, text/xml, text/html'},signal:AbortSignal.timeout(9000),cache:'no-store'});if(!r.ok)throw new Error(String(r.status));return r.text()}

async function fetchCryptoPanic():Promise<RawItem[]>{
  const token=process.env.CRYPTOPANIC_AUTH_TOKEN; if(!token)return[];
  const plan=process.env.CRYPTOPANIC_API_PLAN||'growth';
  const r=await fetch(`https://cryptopanic.com/api/${plan}/v2/posts/?auth_token=${encodeURIComponent(token)}&regions=en`,{signal:AbortSignal.timeout(9000),cache:'no-store'});
  if(!r.ok)throw new Error(String(r.status)); const j=await r.json() as {results?:Array<Record<string,unknown>>};
  return (j.results||[]).map(x=>({title:String(x.title||''),url:String(x.original_url||x.url||''),publishedAt:new Date(String(x.published_at||x.created_at||'')),source:`CryptoPanic / ${String((x.source as {title?:string})?.title||'aggregated')}`,description:String(x.description||'')})).filter(x=>x.title&&x.url&&!Number.isNaN(x.publishedAt.getTime()));
}

async function fetchLunarCrush():Promise<RawItem[]>{
  const key=process.env.LUNARCRUSH_API_KEY;if(!key)return[];
  const handles=(process.env.KOL_X_HANDLES||'CryptoHayes').split(',').map(x=>x.trim()).filter(Boolean).slice(0,20);
  const start=Math.floor((Date.now()-48*3600_000)/1000),end=Math.floor(Date.now()/1000);
  const results=await Promise.allSettled(handles.map(async handle=>{
    const r=await fetch(`https://lunarcrush.com/api4/public/creator/twitter/${encodeURIComponent(handle)}/posts/v1?start=${start}&end=${end}`,{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(9000),cache:'no-store'});
    if(!r.ok)throw new Error(String(r.status));const j=await r.json() as {data?:Array<Record<string,unknown>>};
    return (j.data||[]).map(x=>({title:String(x.post_title||x.title||''),url:String(x.post_link||''),publishedAt:new Date(Number(x.post_created||0)*1000),source:`X / @${handle}`,description:String(x.description||x.extraText||''),authority:23,sourceClass:'kol' as const})).filter(x=>x.title&&x.url&&!Number.isNaN(x.publishedAt.getTime()));
  }));
  return results.flatMap(x=>x.status==='fulfilled'?x.value:[]);
}

async function fetchMarkets():Promise<Map<string,Market>>{
  try{
    const r=await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h',{signal:AbortSignal.timeout(9000),cache:'no-store'});
    if(!r.ok)return new Map(); const rows=await r.json() as Array<Record<string,unknown>>; const out=new Map<string,Market>();
    for(const x of rows){const symbol=String(x.symbol||'').toUpperCase();if(symbol)out.set(symbol,{symbol,change24h:Number.isFinite(Number(x.price_change_percentage_24h))?Number(x.price_change_percentage_24h):null,marketCap:Number(x.market_cap||0),volume:Number(x.total_volume||0)})}return out;
  }catch{return new Map()}
}

export async function collectNews(){
  const health:{name:string;status:string;items:number}[]=[]; const raw:RawItem[]=[];
  const [results,markets]=await Promise.all([Promise.allSettled(SOURCES.map(async s=>{
    if(s.name==='CoinNess'){
      const cp=await fetchCryptoPanic(); if(!cp.length)throw new Error('API token not configured'); return {s,items:cp.filter(x=>x.source.toLowerCase().includes('coinness'))};
    }
    return {s,items:parseFeed(await fetchText(s.url),s.name).map(x=>({...x,authority:s.authority,sourceClass:s.sourceClass||'publisher' as const}))};
  })),fetchMarkets()]);
  for(const [i,r] of results.entries()){if(r.status==='fulfilled'){raw.push(...r.value.items);health.push({name:SOURCES[i].name,status:'online',items:r.value.items.length})}else health.push({name:SOURCES[i].name,status:'offline',items:0})}
  if(process.env.CRYPTOPANIC_AUTH_TOKEN){try{const cp=await fetchCryptoPanic();raw.push(...cp);health.push({name:'CryptoPanic',status:'online',items:cp.length})}catch{health.push({name:'CryptoPanic',status:'offline',items:0})}}
  if(process.env.LUNARCRUSH_API_KEY){try{const social=await fetchLunarCrush();raw.push(...social);health.push({name:'X KOLs / LunarCrush',status:'online',items:social.length})}catch{health.push({name:'X KOLs / LunarCrush',status:'offline',items:0})}}
  const unique=raw.filter((x,i,a)=>a.findIndex(y=>y.url===x.url||similarity(y.title,x.title)>.88)===i).filter(x=>(Date.now()-x.publishedAt.getTime())<48*3600_000);
  const signals=unique.map(x=>{const first=analyzeItem(x,raw);const firstTokens=first.tokens.length?first.tokens:(first.editorialRescue&&first.rescueToken?[first.rescueToken]:[]);const market=firstTokens.map((t:string)=>markets.get(t)).find(Boolean)||null;const analysis=analyzeItem(x,raw,market);const tokens=analysis.tokens.length?analysis.tokens:(analysis.editorialRescue&&analysis.rescueToken?[analysis.rescueToken]:[]);const marketClassification=classifyMarketStatus({eventType:analysis.eventType,token:tokens[0],title:x.title,description:x.description,market});return {...analysis,tokens,id:btoa(unescape(encodeURIComponent(`${x.source}:${x.url}`))).replace(/=+$/,''),title:x.title,description:x.description,source:x.source,url:x.url,publishedAt:x.publishedAt.toISOString(),market,marketClassification}}).filter(x=>x.tokens.length===1).sort((a,b)=>b.score-a.score||a.ageMinutes-b.ageMinutes).slice(0,80);
  return {generatedAt:new Date().toISOString(),signals,sources:health,live:signals.length>0,discordConfigured:Boolean(process.env.DISCORD_WEBHOOK_URL),note:process.env.CRYPTOPANIC_AUTH_TOKEN?'CryptoPanic enabled':'CryptoPanic available when an API token is configured'};
}

export async function GET(){
  return NextResponse.json(await collectNews(),{headers:{'Cache-Control':'no-store'}});
}
