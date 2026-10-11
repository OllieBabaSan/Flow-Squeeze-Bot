import test from 'node:test';
import assert from 'node:assert/strict';
import { editorialApproval, normalizeAsset, reviewEditorialCandidate } from '../lib/editorial-gate.mjs';

const verdict = { should_alert:true, context_worthy:false, useful:true, primary_subject:'Balancer exploit', affected_asset:'BAL', relationship:'direct', novelty:'new', direction:'BEARISH', confidence:0.94, duplicate_of:'', canonical_event_id:'balancer-exploit', what_changed:'New exploit disclosed', rationale:'Direct protocol exploit' };

test('asset normalization removes ticker decoration',()=>assert.equal(normalizeAsset('$bal'),'BAL'));
test('direct novel high-confidence catalyst is approved',()=>assert.equal(editorialApproval(verdict,'BAL').approved,true));
test('secondary association is rejected',()=>assert.equal(editorialApproval({...verdict,relationship:'secondary'},'BAL').reason,'asset_not_directly_affected'));
test('semantic repeat is rejected',()=>assert.equal(editorialApproval({...verdict,novelty:'repeat'},'BAL').reason,'semantic_repeat'));
test('wrong affected asset is rejected',()=>assert.equal(editorialApproval({...verdict,affected_asset:'HOOD'},'HYPE').reason,'asset_mismatch'));
test('disabled gate does not require a key',async()=>assert.equal((await reviewEditorialCandidate({signal:{tokens:['BAL']},env:{}})).approved,true));
test('enabled gate fails closed without a key',async()=>assert.equal((await reviewEditorialCandidate({signal:{tokens:['BAL']},env:{EDITORIAL_GATE_ENABLED:'true'}})).reason,'missing_openai_api_key'));
test('structured model verdict is enforced',async()=>{
  const fetchImpl=async(_url,options)=>{
    const body=JSON.parse(options.body);
    assert.equal(body.model,'gpt-5.6-terra');
    assert.equal(body.text.format.type,'json_schema');
    return {ok:true,json:async()=>({output:[{content:[{type:'output_text',text:JSON.stringify(verdict)}]}],usage:{input_tokens:200,output_tokens:50}})};
  };
  const result=await reviewEditorialCandidate({signal:{tokens:['BAL'],title:'Balancer exploit',publishedAt:new Date().toISOString()},article:{description:'Balancer disclosed a new exploit.'},env:{EDITORIAL_GATE_ENABLED:'true',OPENAI_API_KEY:'test-key'},fetchImpl});
  assert.equal(result.approved,true);
  assert.equal(result.usage.input_tokens,200);
});
test('attached X images are included in multimodal editorial review',async()=>{
  const fetchImpl=async(_url,options)=>{
    const body=JSON.parse(options.body);
    assert.ok(Array.isArray(body.input));
    assert.equal(body.input[0].content[1].type,'input_image');
    assert.equal(body.input[0].content[1].image_url,'https://pbs.twimg.com/media/update.jpg');
    return {ok:true,json:async()=>({output:[{content:[{type:'output_text',text:JSON.stringify(verdict)}]}]})};
  };
  const result=await reviewEditorialCandidate({
    signal:{tokens:['BAL'],title:'Important update',publishedAt:new Date().toISOString()},
    article:{description:'See attached announcement.',imageUrls:['https://pbs.twimg.com/media/update.jpg']},
    env:{EDITORIAL_GATE_ENABLED:'true',OPENAI_API_KEY:'test-key'},fetchImpl,
  });
  assert.equal(result.approved,true);
});
test('editorial context includes only recent alerts for the candidate asset',async()=>{
  const fetchImpl=async(_url,options)=>{
    const body=JSON.parse(options.body);
    const input=JSON.parse(body.input);
    assert.deepEqual(input.recent_sent_alerts.map(entry=>entry.asset),['BAL']);
    return {ok:true,json:async()=>({output:[{content:[{type:'output_text',text:JSON.stringify(verdict)}]}]})};
  };
  await reviewEditorialCandidate({
    signal:{tokens:['BAL'],title:'Balancer update',publishedAt:new Date().toISOString()},
    article:{description:'New event.'},
    recentAlerts:[
      {asset:'ETH',title:'Unrelated Ethereum event'},
      {asset:'BAL',title:'Earlier Balancer event'},
    ],
    env:{EDITORIAL_GATE_ENABLED:'true',OPENAI_API_KEY:'test-key'},fetchImpl,
  });
});
