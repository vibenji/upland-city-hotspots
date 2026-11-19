import test from 'node:test';
import assert from 'node:assert/strict';
import {selectBasis,collectBasisFees,buildRankings,waitForFeeRetry,BASIS_VERSION,BASIS_RADIUS_METRES} from './build-lists.mjs';
import {needsFeeRefresh} from './scan-queue.mjs';
const row=(id,score,lat=35,lng=-119)=>({propertyId:String(id),hotspotScore:score,lat,lng});
test('basis is bounded to top 500 plus one nearby neighbor per leading target without changing full rows',()=>{
 const rows=Array.from({length:2000},(_,i)=>row(i+1,2000-i,35,-119+i*.00001)),copy=structuredClone(rows),basis=selectBasis(rows);
 assert.ok(basis.length>=500&&basis.length<=750);assert.equal(new Set(basis.map(p=>p.propertyId)).size,basis.length);assert.deepEqual(rows,copy);
 assert.equal(selectBasis([]).length,0);assert.equal(selectBasis([row(1,1),row(2,0)]).length,1);
});
test('basis reuses old facts and keeps records outside its request subset',async()=>{
 const records={'1':{fee:0,at:1},'99':{fee:25,at:1}},calls=[];
 const result=await collectBasisFees(['1','2'],{records,now:()=>10*86400000,intervalMs:1,concurrency:2,fetchImpl:async u=>{calls.push(u);return Response.json({prop_id:'2',teleport_price:5});}});
 assert.equal(calls.length,1);assert.equal(result.records['1'].fee,0);assert.equal(result.records['99'].fee,25);assert.equal(result.records['2'].fee,5);
});
test('rolling collection fills a released slot while an earlier request is still pending',async()=>{
 let release,started=[];const work=collectBasisFees(['1','2','3'],{intervalMs:1,concurrency:2,fetchImpl:async u=>{const id=u.split('/').at(-1);started.push(id);if(id==='1')await new Promise(r=>release=r);return Response.json({prop_id:id,teleport_price:0});}});
 await new Promise(r=>setTimeout(r,35));assert.deepEqual(started,['1','2','3']);release();assert.equal((await work).requests,3);
});
test('server throttling stops new work, preserves results and reports Retry-After',async()=>{
 const result=await collectBasisFees(['1','2','3'],{intervalMs:1,concurrency:1,fetchImpl:async u=>u.endsWith('/1')?Response.json({prop_id:'1',teleport_price:0}):new Response('{}',{status:429,headers:{'Retry-After':'2'}})});
 assert.equal(result.requests,2);assert.equal(result.records['1'].fee,0);assert.equal(result.rateLimits,1);assert.ok(result.retryAt>Date.now());
});
test('rankings can retain old verified fees when explicitly marked as retained',()=>{
 const result=buildRankings([row(1,1)],{fees:{'1':{fee:0,at:1}},retainFees:true,at:10*86400000});assert.equal(result.lists.balanced[0].sendFee,0);
});
test('complete published basis or full coverage does not restart just because fees are old',()=>{
 assert.equal(needsFeeRefresh({complete:true,rankings:{url:'x',feeScope:'all-candidates',feeCoverage:{complete:true},feeFreshUntil:1}}),false);
 assert.equal(needsFeeRefresh({complete:true,rankings:{url:'x',feeScope:'basis-500-nearest-1',basisCoverage:{complete:true},basisVersion:BASIS_VERSION,basisRadiusMetres:BASIS_RADIUS_METRES}}),false);
 assert.equal(needsFeeRefresh({complete:true,rankings:{url:'x',feeScope:'basis-500-nearest-1',basisCoverage:{complete:false}}}),true);
});

test('a rerun waits for both published city and benchmark Retry-After before API work',async()=>{
 let clock=1000;const waits=[];
 await waitForFeeRetry({cities:[{rankings:{feeRetryAt:3000}}]},{externalRetryAt:4000,now:()=>clock,sleep:async ms=>{waits.push(ms);clock+=ms;}});
 assert.deepEqual(waits,[3000]);assert.equal(clock,4000);
 await waitForFeeRetry({cities:[{rankings:{feeRetryAt:2000}}]},{externalRetryAt:1,now:()=>clock,sleep:async()=>{throw Error('expired deadlines must not wait');}});
});

test('40m basis includes the nearest 30m landing which the old 20m radius excluded',()=>{
 const targets=Array.from({length:500},(_,i)=>row(i+1,1000-i,35+i*.001,-119));
 const rows=[...targets,row(501,1,35,-118.99967),row(502,1,35,-118.99923)];
 assert.equal(selectBasis(rows,{radiusMetres:20}).some(p=>p.propertyId==='501'),false);
 assert.equal(selectBasis(rows).some(p=>p.propertyId==='501'),true);
 assert.equal(selectBasis(rows).some(p=>p.propertyId==='502'),false);
 assert.equal(BASIS_RADIUS_METRES,40);
});
test('previous 20m readiness is upgraded while full candidate coverage remains sufficient',()=>{
 assert.equal(needsFeeRefresh({complete:true,rankings:{url:'x',feeScope:'basis-500-nearest-1',basisCoverage:{complete:true},basisVersion:1}}),true);
});
test('32 rolling workers are supported and a known-only pool does not rewrite its checkpoint',async()=>{
 let active=0,peak=0,writes=0;
 const ids=Array.from({length:33},(_,i)=>String(i+1));
 const result=await collectBasisFees(ids,{concurrency:32,intervalMs:1,sleep:async()=>{},fetchImpl:async u=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,5));active--;return Response.json({prop_id:u.split('/').at(-1),teleport_price:0});}});
 assert.equal(peak,32);assert.equal(result.coverage.complete,true);
 await collectBasisFees(ids,{records:result.records,onCheckpoint:async()=>writes++});assert.equal(writes,0);
});
