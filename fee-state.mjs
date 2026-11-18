// Wibenji — resumable verified public send fees; missing and stale are never free.
export const DAY=86400000;
export function readFee(value){if(typeof value!=='number'&&(typeof value!=='string'||!value.trim()))return undefined;const fee=Number(value);return Number.isFinite(fee)&&fee>=0?fee:undefined;}
const valid=(r,at)=>r&&typeof r.fee==='number'&&readFee(r.fee)!==undefined&&Number.isFinite(r.at)&&r.at>=0&&r.at<=at+2000;
export function feeCoverage(ids,records,at=Date.now()){
 let known=0,recorded=0;ids=[...new Set(ids)];for(const id of ids)if(valid(records[id],at)){recorded++;if(records[id].at+DAY>at)known++;}
 return {known,recorded,total:ids.length,stale:recorded-known,missing:ids.length-recorded,complete:known===ids.length};
}
export function feeQueue(ids,records,at=Date.now()){
 return [...new Set(ids)].filter(id=>!valid(records[id],at)||records[id].at+DAY<=at).sort((a,b)=>Number(valid(records[a],at))-Number(valid(records[b],at))||((records[a]?.at??0)-(records[b]?.at??0)));
}
export const makeFeeCache=(cityId,records,at=Date.now())=>({schemaVersion:1,cityId,updatedAt:new Date(at).toISOString(),records:structuredClone(records)});
export function validateFeeCache(value,cityId,at=Date.now()){
 if(value?.schemaVersion!==1||value.cityId!==cityId||!Number.isFinite(Date.parse(value.updatedAt??new Date(at).toISOString()))||Date.parse(value.updatedAt??new Date(at).toISOString())>at+2000||!value.records||Array.isArray(value.records)||typeof value.records!=='object')throw Error('Invalid fee cache city or schema');
 for(const [id,r]of Object.entries(value.records))if(!/^[1-9]\d{0,15}$/.test(id)||!valid(r,at))throw Error('Invalid fee cache record '+id);
 return value.records;
}
export async function collectFees(ids,{records={},fetchImpl=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),maxRequests=1000000,budgetMs=600000,concurrency=1,intervalMs=250,checkpointEvery=500,onCheckpoint=async()=>{},retryRateLimits=false,retryErrors=false}={}){
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4||!Number.isFinite(intervalMs)||intervalMs<1)throw Error('Invalid fee concurrency/pacing');
 ids=[...new Set(ids)];records=Object.fromEntries(ids.filter(id=>valid(records[id],now())).map(id=>[id,{...records[id]}]));
 const queue=feeQueue(ids,records,now()),attempts={},errors={};const started=now();let cursor=0,requests=0,failures=0,rateLimits=0,retryAt=0,budgetReached=false,lastCheckpoint=0,checkpointed=false,delay=intervalMs;
 const progress=()=>({requests,rateLimits,retryAt,consecutiveFailures:failures,budgetReached,coverage:feeCoverage(ids,records,now()),errors:{...errors}});
 const checkpoint=async()=>{await onCheckpoint(structuredClone(records),progress());lastCheckpoint=requests;checkpointed=true;};
 while(cursor<queue.length&&requests<maxRequests&&failures<6){
  if(retryAt>now()){
   if(!retryRateLimits)break;
   const wait=retryAt-now();if(now()+wait+delay-started>=budgetMs){budgetReached=true;break;}
   await sleep(wait);retryAt=0;
  }
  const batch=[];
  for(let i=0;i<concurrency&&cursor<queue.length&&requests<maxRequests;i++){
   if(now()+delay-started>=budgetMs){budgetReached=true;break;}
   const id=queue[cursor++];await sleep(delay);requests++;attempts[id]=(attempts[id]??0)+1;
   batch.push((async()=>{
    try{
     const response=await fetchImpl('https://api.prod.upland.me/api/properties/'+id,{headers:{accept:'application/json'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
     if(response.status===429||response.status===503){const after=response.headers.get('retry-after'),seconds=Number(after);const wait=after?(Number.isFinite(seconds)?seconds*1000:Date.parse(after)-now()):60000;return {id,limited:true,status:response.status,retryAt:now()+Math.max(1000,Number.isFinite(wait)?wait:60000)};}
     if(!response.ok)throw Error('Property HTTP '+response.status);
     const body=await response.json(),fee=readFee(body.teleport_price);
     if(String(body.prop_id)!==id||fee===undefined)throw Error('Missing verified fee');
     return {id,record:{fee,at:now()}};
    }catch(error){return {id,error:String(error.message).slice(0,240)};}
   })());
  }
  const results=await Promise.all(batch);
  for(const result of results){
   if(result.record){records[result.id]=result.record;delete errors[result.id];failures=0;}
   else if(result.limited){rateLimits+=Number(result.status===429);retryAt=Math.max(retryAt,result.retryAt);errors[result.id]='HTTP '+result.status;failures++;if(retryRateLimits&&attempts[result.id]<6)queue.splice(cursor,0,result.id);delay=Math.min(2000,Math.max(250,delay*2));}
   else{errors[result.id]=result.error;failures++;if(retryErrors&&attempts[result.id]<3)queue.push(result.id);}
  }
  if(requests-lastCheckpoint>=checkpointEvery)await checkpoint();
  if(results.some(r=>r.error)&&failures>0){const wait=Math.min(60000,3000*2**(failures-1));if(now()+wait-started>=budgetMs){budgetReached=true;break;}await sleep(wait);}
  if(budgetReached||!batch.length)break;
 }
 if(cursor<queue.length&&requests>=maxRequests)budgetReached=true;
 if(!checkpointed||lastCheckpoint!==requests)await checkpoint();
 return {records,...progress()};
}

