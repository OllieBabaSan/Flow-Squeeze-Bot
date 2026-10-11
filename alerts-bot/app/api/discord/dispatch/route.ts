import { env } from 'cloudflare:workers';
import { NextResponse } from 'next/server';
import { collectNews } from '../../news/route';
import { DEFAULT_MAX_DISPATCH_AGE_MINUTES, alertFrequencyDecision, alertScopeKey, dispatchDecision, eventKey } from '../../../../lib/dispatch-policy.mjs';
import { reviewEditorialCandidate } from '../../../../lib/editorial-gate.mjs';
import { contractAddressLabel, hasVerifiedContract, isMemeToken, registryLabel, resolveTrackedToken } from '../../../../lib/token-registry.mjs';

export const dynamic = 'force-dynamic';

type D1Like = { prepare:(sql:string)=>{bind:(...values:unknown[])=>{first:<T>()=>Promise<T|null>;all:<T>()=>Promise<{results?:T[]}>;run:()=>Promise<unknown>};run:()=>Promise<unknown>} };

async function ensureSchema(db:D1Like){
  await db.prepare(`CREATE TABLE IF NOT EXISTS discord_alerts (
    signal_id TEXT PRIMARY KEY,
    headline TEXT NOT NULL,
    score INTEGER NOT NULL,
    sent_at TEXT NOT NULL,
    event_key TEXT,
    scope_key TEXT,
    published_at TEXT
    ,delivery_status TEXT
  )`).run();
  try{await db.prepare('ALTER TABLE discord_alerts ADD COLUMN event_key TEXT').run()}catch{}
  try{await db.prepare('ALTER TABLE discord_alerts ADD COLUMN published_at TEXT').run()}catch{}
  try{await db.prepare('ALTER TABLE discord_alerts ADD COLUMN scope_key TEXT').run()}catch{}
  try{await db.prepare('ALTER TABLE discord_alerts ADD COLUMN delivery_status TEXT').run()}catch{}
  await db.prepare('CREATE INDEX IF NOT EXISTS discord_alerts_event_key_idx ON discord_alerts(event_key)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS discord_alerts_scope_key_idx ON discord_alerts(scope_key, sent_at)').run();
}

function color(level:string){return level==='HIGH'?0x5ee1a6:0xefbd5a}

export async function GET(){return NextResponse.json({ok:true,service:'crypto-alerts-dispatch',dispatchEnabled:process.env.HOSTED_DISPATCH_ENABLED==='true'},{headers:{'Cache-Control':'no-store'}})}

export async function POST(request:Request){
  if(process.env.HOSTED_DISPATCH_ENABLED!=='true')return NextResponse.json({ok:false,error:'Hosted dispatch is disabled'},{status:503});
  const secret=process.env.DISPATCH_SECRET||'';
  const supplied=request.headers.get('x-dispatch-secret')||request.headers.get('authorization')?.replace(/^Bearer\s+/i,'')||'';
  if(!secret||supplied!==secret)return NextResponse.json({ok:false,error:'Unauthorized'},{status:401});
  const webhook=process.env.DISCORD_WEBHOOK_URL;
  const alertRoleId=/^\d{17,20}$/.test(process.env.DISCORD_ALERT_ROLE_ID||'')?process.env.DISCORD_ALERT_ROLE_ID:'';
  const db=(env as unknown as {DB?:D1Like}).DB;
  if(!webhook||!db)return NextResponse.json({ok:false,error:'Discord or alert history is not configured'},{status:503});
  await ensureSchema(db);
  const data=await collectNews();
  const configured=Number(process.env.DISCORD_MAX_AGE_MINUTES||DEFAULT_MAX_DISPATCH_AGE_MINUTES);
  const maxAgeMinutes=Number.isFinite(configured)?Math.max(5,Math.min(60,configured)):DEFAULT_MAX_DISPATCH_AGE_MINUTES;
  const decisions=data.signals.map(signal=>({signal,decision:dispatchDecision(signal,Date.now(),maxAgeMinutes),rescueEligible:Boolean(signal.editorialRescue&&signal.tokens.length===1&&signal.ageMinutes>=0&&signal.ageMinutes<=maxAgeMinutes)}));
  const candidates=decisions.filter(x=>x.decision.eligible||x.rescueEligible).map(x=>x.signal).slice(0,12);
  const rejected=decisions.reduce<Record<string,number>>((out,x)=>{if(!x.decision.eligible&&!x.rescueEligible)out[x.decision.reason]=(out[x.decision.reason]||0)+1;return out},{});
  const sent:string[]=[];
  const editorialRejected:Record<string,number>={};
  for(const signal of candidates){
    const key=eventKey(signal);
    const scope=alertScopeKey(signal);
    const prior=await db.prepare("SELECT signal_id FROM discord_alerts WHERE signal_id = ? OR (event_key = ? AND sent_at >= datetime('now', '-48 hours')) LIMIT 1").bind(signal.id,key).first<{signal_id:string}>();
    if(prior)continue;
    const tokenPrefix=`${signal.tokens[0]}:%`;
    const history=await db.prepare("SELECT sent_at FROM discord_alerts WHERE sent_at >= datetime('now', '-24 hours') AND (scope_key = ? OR (scope_key IS NULL AND event_key LIKE ?))").bind(scope,tokenPrefix).all<{sent_at:string}>();
    const frequency=alertFrequencyDecision(history.results?.map(row=>row.sent_at)||[],Date.now());
    if(!frequency.eligible)continue;
    const tokenIdentity=await resolveTrackedToken(signal.tokens[0],{contextText:`${signal.title} ${signal.description||''}`});
    if(!tokenIdentity){editorialRejected.unverified_token=(editorialRejected.unverified_token||0)+1;continue}
    if(isMemeToken(tokenIdentity,{title:signal.title,description:signal.description||''})&&!hasVerifiedContract(tokenIdentity)){editorialRejected.memecoin_missing_verified_address=(editorialRejected.memecoin_missing_verified_address||0)+1;continue}
    signal.tokenIdentity=tokenIdentity;
    if(signal.marketClassification.untracked)signal.marketClassification={...signal.marketClassification,untracked:false,labels:[],label:`${tokenIdentity.provider.toUpperCase()} TRACKED`};
    const recent=await db.prepare("SELECT headline, event_key, sent_at FROM discord_alerts WHERE sent_at >= datetime('now', '-72 hours') ORDER BY sent_at ASC LIMIT 100").all<{headline:string;event_key:string;sent_at:string}>();
    const editorial=await reviewEditorialCandidate({signal,article:{title:signal.title,description:signal.description||'',source:signal.source},recentAlerts:(recent.results||[]).map(row=>({headline:row.headline,event_type:row.event_key,sent_at:row.sent_at}))});
    if(!editorial.approved){editorialRejected[editorial.reason]=(editorialRejected[editorial.reason]||0)+1;continue}
    if(signal.editorialRescue&&!dispatchDecision(signal,Date.now(),maxAgeMinutes).eligible){signal.score=Math.max(70,signal.score);signal.level='WATCH';signal.actionability='ACTIONABLE';signal.opportunityStatus=signal.ageMinutes<=15?'FLASH_EARLY':'MOMENTUM_UNDERWAY';if(signal.eventType==='Market context')signal.eventType='Editorially confirmed catalyst'}
    if(editorial.verdict?.direction)signal.direction=editorial.verdict.direction;
    if(editorial.verdict?.what_changed||editorial.verdict?.rationale)signal.reason=[editorial.verdict.what_changed||editorial.verdict.rationale];
    const body={
      username:'Crypto News Radar',
      ...(alertRoleId?{content:`<@&${alertRoleId}>`,allowed_mentions:{roles:[alertRoleId]}}:{allowed_mentions:{parse:[]}}),
      embeds:[{
        title:`${signal.marketClassification.label} · ${signal.opportunityStatus==='FLASH_EARLY'?'FLASH · EARLY':signal.opportunityStatus==='LATE_CHASE_RISK'?'LATE · CHASE RISK':'ACTIVE'} · ${signal.level} ${signal.score} · ${signal.eventType}`,
        description:`**${signal.title}**\n\n${signal.reason.join(' · ')}`,
        url:signal.url,
        color:color(signal.level),
        fields:[
          {name:'Tokens',value:signal.tokens.length?signal.tokens.map(t=>`$${t}`).join(', '):'Market-wide',inline:true},
          {name:'Project / entity',value:registryLabel(signal.tokenIdentity),inline:false},
          {name:'Token address',value:contractAddressLabel(signal.tokenIdentity,signal.marketClassification.chain),inline:false},
          {name:'Expected impact',value:signal.direction||'Unclear',inline:true},
          {name:'Opportunity',value:String(signal.opportunityStatus||'Unknown').replaceAll('_',' '),inline:true},
          {name:'Sources',value:String(signal.confirmations),inline:true},
          {name:'Published',value:`${signal.ageMinutes} minutes ago`,inline:true},
          {name:'Market status',value:signal.marketClassification.label,inline:true},
          {name:'Chain',value:signal.marketClassification.chain,inline:true},
          {name:'Further research',value:`[Open source article](${signal.url})`,inline:true},
          {name:'Risk flags',value:signal.risks.length?signal.risks.join(' · '):'None identified'},
        ],
        footer:{text:'Research alert only · verify before acting'},
        timestamp:new Date().toISOString(),
      }],
    };
    const reservedAt=new Date().toISOString();
    try{await db.prepare('INSERT INTO discord_alerts (signal_id, headline, score, sent_at, event_key, scope_key, published_at, delivery_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(signal.id,signal.title,signal.score,reservedAt,key,scope,signal.publishedAt,'reserved').run()}catch{continue}
    let response:Response;
    try{response=await fetch(webhook,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)})}catch{await db.prepare('UPDATE discord_alerts SET delivery_status = ? WHERE signal_id = ?').bind('uncertain',signal.id).run();continue}
    await db.prepare('UPDATE discord_alerts SET delivery_status = ? WHERE signal_id = ?').bind(response.ok?'sent':'failed',signal.id).run();
    if(!response.ok)continue;
    sent.push(signal.id);
    if(sent.length>=3)break;
  }
  return NextResponse.json({ok:true,reviewed:candidates.length,sent:sent.length,maxAgeMinutes,rejected,editorialRejected,generatedAt:new Date().toISOString()},{headers:{'Cache-Control':'no-store'}});
}
