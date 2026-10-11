export const TOKEN_NAMES = {
  bitcoin:'BTC',ethereum:'ETH',ether:'ETH',solana:'SOL',ripple:'XRP',xrp:'XRP',cardano:'ADA',avalanche:'AVAX',
  chainlink:'LINK',polygon:'POL',dogecoin:'DOGE',litecoin:'LTC',uniswap:'UNI',aave:'AAVE',hyperliquid:'HYPE',
  pons:'PONS',tron:'TRX',sui:'SUI',toncoin:'TON',bnb:'BNB',arbitrum:'ARB',optimism:'OP',near:'NEAR',
  aptos:'APT',celestia:'TIA',injective:'INJ',zcash:'ZEC',ethena:'ENA',ena:'ENA',pendle:'PENDLE',
  layerzero:'ZRO',ondo:'ONDO',worldcoin:'WLD',render:'RENDER',pepe:'PEPE',shiba:'SHIB',tether:'USDT',
  sophon:'SOPH',balancer:'BAL',limewire:'LMWR'
};

const TRUSTED_TOKEN_NAMES = new Set(Object.keys(TOKEN_NAMES));
const MAJOR_INSTITUTION = /\b(BlackRock|J\.?P\.?\s*Morgan|JPMorgan|DTCC|Visa|Mastercard|PayPal|Fidelity|Franklin Templeton|State Street|BNY Mellon|Goldman Sachs|Morgan Stanley|Nasdaq|NYSE|SWIFT)\b/i;
const LIVE_LAUNCH = /\b(launches|launched|introduces|introduced|unveils|unveiled|rolls? out|rolled out|goes live|went live|now live|debut(?:s|ed))\b/i;

const CATALYSTS = [
  {type:'Acquisition / strategic investment',re:/\b(acquir(?:e|es|ed|ing|es)|acquisition|buys?|bought|purchas(?:e|es|ed|ing)|takes? (?:a )?stake|strategic investment|invests? in)\b/i,points:38,direction:'BULLISH',strength:'EXTREME'},
  {type:'Institutional product launch',re:new RegExp(`${LIVE_LAUNCH.source}.{0,140}${MAJOR_INSTITUTION.source}|${MAJOR_INSTITUTION.source}.{0,140}${LIVE_LAUNCH.source}`,'i'),points:35,direction:'BULLISH',strength:'EXTREME'},
  {type:'Protocol wind-down',re:/\b(wind(?:ing)?[ -]?down|shut(?:s|ting)? down|shutdown|ceas(?:e|es|ing) operations?|orderly closure|sunset(?:s|ting)? (?:the )?(?:protocol|project|dao))\b/i,points:32,direction:'BEARISH',strength:'VERY_HIGH'},
  {type:'Exploit / security',re:/\b(hack(?:ed)?|exploit(?:ed)?|drain(?:ed)?|attack(?:ed)?|breach|vulnerability|compromised?|stolen|insolven(?:t|cy)|rug pull)\b/i,points:31,direction:'BEARISH'},
  {type:'Chain disruption',re:/\b(chain|network|mainnet|block production).{0,35}\b(halt(?:ed)?|stoppage|outage|offline|down|failure|stalled)\b|\b(halt(?:ed)?|stoppage|outage).{0,35}\b(chain|network|mainnet)\b/i,points:30,direction:'BEARISH'},
  {type:'Delisting',re:/\b(delist(?:s|ed|ing)?|remove(?:s|d)? trading|trading suspension)\b/i,points:29,direction:'BEARISH'},
  {type:'Listing',re:/\b(list(?:s|ed|ing)?|adds? support|spot market|new trading pair)\b/i,points:27,direction:'BULLISH'},
  {type:'Institutional partnership',re:/\b(partner(?:s|ed|ship)?|integrat(?:es|ed|ion)|adopt(?:s|ed|ion)|collaborat(?:es|ion)).{0,90}\b(bank|payments?|visa|mastercard|paypal|fintech|institution|enterprise|government|telecom|exchange)\b|\b(bank|payments?|visa|mastercard|paypal|institution|enterprise|government).{0,90}\b(partner(?:s|ed|ship)?|integrat(?:es|ed|ion)|adopt(?:s|ed|ion))\b/i,points:27,direction:'BULLISH'},
  {type:'Token economics',re:/\b(buyback|token burn|burns? tokens?|fee switch|revenue shar(?:e|ing)|staking rewards?|supply reduction|emissions? cut)\b/i,points:27,direction:'BULLISH'},
  {type:'Asset-specific regulation',re:/\b(approved?|approval|reject(?:s|ed|ion)?|lawsuit|charges?|settlement|injunction|license|etf)\b/i,points:23,direction:'CONTEXTUAL'},
  {type:'Protocol metrics',re:/\b(record|surges?|spikes?|jumps?|accelerat(?:es|ion)|top).{0,55}\b(fees?|revenue|volume|tvl|users?|transactions?|inflows?)\b|\b(fees?|revenue|volume|tvl|users?|transactions?|inflows?).{0,55}\b(record|surges?|spikes?|jumps?|accelerat(?:es|ion)|top)\b/i,points:22,direction:'BULLISH'},
  {type:'Product / upgrade',re:/\b(mainnet|major upgrade|hard fork|airdrop|staking launch|product launch|launchpad|launches|launched|introduces|introduced|unveils|unveiled|rolls? out|rolled out|goes live|went live|now live|debuts|debuted)\b/i,points:25,direction:'BULLISH'},
  {type:'KOL call',re:/\b(\d+x|bagger|going (?:much )?higher|bullish|bearish|long(?:ing)?|short(?:ing)?|buy(?:ing)?|sell(?:ing)?|accumulat(?:e|ing)|dump(?:ing)?|price target|undervalued|overvalued)\b/i,points:22,direction:'CONTEXTUAL'},
];
const CHAFF=/\b(price (?:news|analysis|prediction)|what (?:is|happened)|explained|(?:beginner(?:'s)? )?guide|weekly recap|daily recap|morning minute|could reach|may reach|analysts? (?:say|predict|see)|opinion|technical analysis|how to|ways? to (?:buy|sell|trade|store|protect)|tips? (?:for|to)|best (?:way|ways|place|places) to|where to (?:buy|sell|trade)|should (?:you|i|investors?) (?:buy|sell|trade)|things? to know|everything you need to know|pros? and cons?|comparison)\b/i;
const RETROSPECTIVE=/\b(after|as).{0,35}\b(surges?|jumps?|rall(?:y|ies|ied)|soars?|plunges?|tumbles?|slides?|drops?)\b|\b(up|down|gains?|loses?)\s+\d+(?:\.\d+)?%\b/i;
const BULLISH=/\b(bullish|\d+x|bagger|long(?:ing)?|buy(?:ing)?|accumulat(?:e|ing)|adopt(?:s|ed|ion)|partner(?:s|ed|ship)?|integrat(?:es|ed|ion)|approved?|approval|buyback|burn|record (?:fees|revenue|volume)|surges? in (?:fees|revenue|volume|tvl))\b/i;
const BEARISH=/\b(bearish|short(?:ing)?|sell(?:ing)?|dump(?:ing)?|hack(?:ed)?|exploit(?:ed)?|drain(?:ed)?|breach|compromised?|stolen|halt(?:ed)?|outage|delist(?:s|ed|ing)?|reject(?:s|ed|ion)?|charges?|lawsuit|insolven(?:t|cy))\b/i;
const MARKET_WIDE=/\b(interest rates?|federal reserve|fed|tariffs?|sanctions?|executive order|crypto reserve|strategic reserve|sec chair|cftc chair|crypto legislation|stablecoin legislation|market structure bill|banking access)\b/i;

const words=s=>new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(x=>x.length>3));
const escapeRegex=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function similarity(a,b){const A=words(a),B=words(b);let n=0;A.forEach(x=>B.has(x)&&n++);return n/Math.max(1,Math.min(A.size,B.size))}
export function extractTokens(text){
  const out=new Set(); for(const m of text.matchAll(/\$([A-Z][A-Z0-9]{1,9})\b/g))out.add(m[1]);
  for(const [name,symbol] of Object.entries(TOKEN_NAMES)){
    const label=escapeRegex(name);
    const bareMention=new RegExp(`\\b${label}\\b`,'i').test(text);
    // Dynamic CoinGecko names are untrusted. Name-before-qualifier avoids
    // interpreting ordinary prose such as "meme coin just bought" as $JST.
    const contextualMention=new RegExp(`\\b(?:${label})\\s+(?:token|coin|protocol|network|project)\\b`,'i').test(text);
    if(bareMention&&(TRUSTED_TOKEN_NAMES.has(name)||contextualMention))out.add(symbol);
  }
  return [...out].slice(0,8);
}
function directionFor(text,catalyst){
  const bull=BULLISH.test(text),bear=BEARISH.test(text);if(bull&&!bear)return'BULLISH';if(bear&&!bull)return'BEARISH';
  return catalyst?.direction||'UNCLEAR';
}
function relationship(text,token,sourceClass,catalyst){
  const explicit=new RegExp(`\\$${escapeRegex(token)}\\b`,'i').test(text);
  const names=Object.entries(TOKEN_NAMES).filter(([,s])=>s===token).map(([n])=>n);
  const labels=[token,...names].map(escapeRegex).join('|');
  const ecosystem=new RegExp(`\\b(?:built|based|runs?|deployed|application|project|token).{0,18}\\b(?:on|using)\\s+(?:the\\s+)?(?:${labels})\\b|\\b(?:${labels})[- ]based\\b`,'i').test(text);
  if(ecosystem)return{kind:'ECOSYSTEM',points:2,confidence:.35};
  if(sourceClass==='kol'&&explicit&&catalyst?.type==='KOL call')return{kind:'DIRECT',points:24,confidence:.95};
  if(catalyst?.type==='KOL call'&&sourceClass!=='kol')return{kind:'MENTION',points:0,confidence:.15};
  if(explicit&&catalyst)return{kind:'DIRECT',points:22,confidence:.9};
  const label=`(?:${labels})`;
  const type=catalyst?.type;
  let direct=false;
  if(type==='Acquisition / strategic investment')direct=new RegExp(`\\b(?:acquir(?:e|es|ed|ing)|buys?|bought|purchas(?:e|es|ed|ing)|takes? (?:a )?stake (?:in )?|invests? in)\\s+(?:the\\s+)?(?:${label})(?:\\s+(?:protocol|project|token|launchpad))?\\b|\\b(?:${label})(?:\\s+(?:protocol|project|token|launchpad))?\\s+(?:is |was )?(?:acquired|bought|purchased)\\b`,'i').test(text);
  else if(type==='Exploit / security'||type==='Chain disruption')direct=new RegExp(`\\b${label}(?:\\s+(?:protocol|network|chain|bridge|pool|mainnet))?.{0,28}\\b(?:hack|exploit|drain|breach|compromis|halt|outage|stoppage)|\\b(?:hack|exploit|drain|breach|compromis|halt|outage|stoppage).{0,28}\\b${label}(?:\\s+(?:protocol|network|chain|bridge|pool|mainnet))?`,'i').test(text)&&!new RegExp(`\\b(?:wallet|card|customer|user|holder|scam|fake).{0,30}\\b${label}|\\b${label}.{0,30}\\b(?:wallet|card|customer|user|holder|scam|fake)`,'i').test(text);
  else if(type==='Listing'||type==='Delisting')direct=new RegExp(`\\b(?:coinbase|binance|kraken|upbit|bithumb|robinhood|okx|bybit).{0,35}\\b(?:list|delist|adds? support).{0,30}\\b${label}|\\b${label}.{0,30}\\b(?:listed|delisted|listing|delisting)\\s+(?:on|by)\\b`,'i').test(text);
  else if(type==='Institutional partnership')direct=new RegExp(`\\b${label}.{0,55}\\b(?:partner|integrat|adopt|collaborat)|\\b(?:partner|integrat|adopt|collaborat).{0,55}\\b${label}`,'i').test(text);
  else if(type==='Asset-specific regulation')direct=new RegExp(`\\b${label}.{0,45}\\b(?:etf|approval|approved|reject|lawsuit|charges?|settlement|license)|\\b(?:etf|approval|approved|reject|lawsuit|charges?|settlement|license).{0,45}\\b${label}`,'i').test(text);
  else if(type==='Protocol metrics')direct=names.some(n=>new RegExp(`\\b${n}(?:\\s+(?:protocol|network|chain|launchpad))?.{0,55}\\b(?:fees?|revenue|volume|tvl|users?|transactions?|inflows?)\\b|\\b(?:fees?|revenue|volume|tvl|users?|transactions?|inflows?).{0,55}\\b${n}(?:\\s+(?:protocol|network|chain|launchpad))?\\b`,'i').test(text))&&!/\b(?:miner|mining company|hardware wallet|wallet maker|exchange-traded company)\b/i.test(text);
  else if(type==='Token economics'||type==='Product / upgrade'||type==='Institutional product launch')direct=names.some(n=>new RegExp(`\\b${n}\\b`,'i').test(text));
  else if(type==='Protocol wind-down')direct=new RegExp(`\\b${label}.{0,70}\\b(?:wind(?:ing)?[ -]?down|shut(?:s|ting)? down|shutdown|ceas(?:e|es|ing) operations?|closure|sunset)|\\b(?:wind(?:ing)?[ -]?down|shut(?:s|ting)? down|shutdown|ceas(?:e|es|ing) operations?|closure|sunset).{0,70}\\b${label}`,'i').test(text);
  return direct?{kind:'DIRECT',points:18,confidence:.78}:{kind:'MENTION',points:0,confidence:.15};
}
export function analyzeItem(item,all=[],market=null,now=Date.now()){
  const text=`${item.title} ${item.description||''}`.replace(/\s+/g,' ');const sourceClass=item.sourceClass||'publisher';
  const catalyst=CATALYSTS.find(x=>x.re.test(text));const trackedSymbol=String(item.trackedSymbol||'').toUpperCase();
  const tokenCandidates=[...new Set([...extractTokens(text),...(sourceClass==='primary'&&trackedSymbol?[trackedSymbol]:[])])].filter(x=>x!=='USDT');
  const rels=tokenCandidates.map(t=>({token:t,...(sourceClass==='primary'&&t===trackedSymbol&&catalyst?{kind:'DIRECT',points:24,confidence:.92}:relationship(text,t,sourceClass,catalyst))}));
  const direct=rels.filter(x=>x.kind==='DIRECT');const affected=direct.length===1?direct[0]:null;
  const confirmations=new Set(all.filter(x=>x.source!==item.source&&Math.abs(new Date(x.publishedAt)-new Date(item.publishedAt))<=12*3600_000&&similarity(x.title,item.title)>.52).map(x=>x.source)).size+1;
  const age=Math.max(0,Math.round((now-new Date(item.publishedAt).getTime())/60000));const chaff=CHAFF.test(text);const retrospective=RETROSPECTIVE.test(text);
  const marketWide=MARKET_WIDE.test(text);const dir=directionFor(text,catalyst);const majorInstitution=MAJOR_INSTITUTION.test(text);
  const editorialRescue=tokenCandidates.length===1&&majorInstitution&&(LIVE_LAUNCH.test(text)||/\b(partner|collaborat|developed by|powered by|strategy|strategies|investment|approved|selected)\b/i.test(text));
  const kolEligible=sourceClass!=='kol'||(affected&&catalyst?.type==='KOL call'&&dir!=='UNCLEAR');
  const directional=dir==='BULLISH'||dir==='BEARISH';
  const actionable=Boolean(catalyst&&affected&&!chaff&&kolEligible&&directional&&(!retrospective||sourceClass==='policy'));
  let value=(catalyst?.points||0)+(item.authority||12)+(affected?.points||0)+(age<=15?17:age<=60?11:age<=240?5:0)+Math.min(8,(confirmations-1)*4)+(dir!=='UNCLEAR'?5:0)+(majorInstitution?10:0);
  const reasons=[];const risks=[];
  if(catalyst)reasons.push(`${catalyst.type} catalyst`);if(affected)reasons.push(`Direct $${affected.token} relationship`);if(dir!=='UNCLEAR')reasons.push(`${dir.toLowerCase()} impact expected`);
  if(sourceClass==='policy')reasons.push('Policy-capable source');if(sourceClass==='kol')reasons.push('Tracked KOL source');if(confirmations>1)reasons.push(`${confirmations} independent sources`);
  if(sourceClass==='primary')reasons.push('Official primary-source disclosure');
  if(majorInstitution)reasons.push('Major institutional counterparty');
  if(chaff){value-=35;risks.push('Commentary or prediction framing')}if(retrospective){value-=24;risks.push('Move may predate report')}
  if(direct.length>1){value-=25;risks.push('Multiple directly mentioned assets')}if(!affected&&tokenCandidates.length)risks.push('No single directly affected token');
  if(!tokenCandidates.length)risks.push(marketWide?'Market-wide context':'No affected asset identified');
  if(confirmations===1)risks.push('Single-source report');
  const alignedMove=market?.change24h==null?null:(dir==='BEARISH'?-market.change24h:market.change24h);
  let opportunityStatus='NOT_ACTIONABLE';
  if(actionable){
    if((alignedMove!=null&&alignedMove>=20)||age>240)opportunityStatus='LATE_CHASE_RISK';
    else if(age<=15&&(alignedMove==null||alignedMove<8))opportunityStatus='FLASH_EARLY';
    else opportunityStatus='MOMENTUM_UNDERWAY';
  }
  if(market?.change24h!=null){if(alignedMove>=20){value-=15;risks.push(`Move already extended ${market.change24h>0?'+':''}${market.change24h.toFixed(1)}% in 24h; chase risk`)}else if(Math.abs(market.change24h)>=8)risks.push(`Price moved ${market.change24h>0?'+':''}${market.change24h.toFixed(1)}% in 24h`)}
  if(!actionable)value=Math.min(value,marketWide&&sourceClass==='policy'?64:47);
  value=Math.max(0,Math.min(100,Math.round(value)));
  return {score:value,level:value>=80&&actionable?'HIGH':value>=65&&actionable?'WATCH':'LOW',actionability:actionable?'ACTIONABLE':chaff?'NON_ACTIONABLE':marketWide?'MARKET_CONTEXT':catalyst&&affected?'CHATTER':'NON_ACTIONABLE',direction:actionable?dir:'UNCLEAR',opportunityStatus,catalystStrength:catalyst?.strength||((catalyst?.points||0)>=29?'VERY_HIGH':(catalyst?.points||0)>=25?'HIGH':'STANDARD'),tokens:actionable&&affected?[affected.token]:[],mentionedTokens:tokenCandidates,directness:affected?.kind||rels[0]?.kind||'NONE',attributionConfidence:affected?.confidence||0,eventType:catalyst?.type||'Market context',confirmations,ageMinutes:age,reason:reasons.length?reasons:['No discrete asset-specific catalyst'],risks,editorialRescue,rescueToken:editorialRescue?tokenCandidates[0]:''};
}
