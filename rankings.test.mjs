import test from 'node:test';
import assert from 'node:assert/strict';
import {compareRows,buildRankings,readFee,collectFees} from './build-lists.mjs';
const rows=[{propertyId:'1',hotspotScore:10,sendFee:100},{propertyId:'2',hotspotScore:6,sendFee:4},{propertyId:'3',hotspotScore:3,sendFee:1},{propertyId:'4',hotspotScore:20}];
test('the three modes use existing Toolbox semantics; unknown fees never become free',()=>{
 assert.deepEqual([...rows].sort((a,b)=>compareRows(a,b,'maximum-coverage')).map(r=>r.propertyId),['4','1','2','3']);
 assert.deepEqual([...rows].sort((a,b)=>compareRows(a,b,'balanced')).map(r=>r.propertyId),['2','3','1','4']);
 assert.deepEqual([...rows].sort((a,b)=>compareRows(a,b,'lowest-fees')).map(r=>r.propertyId),['3','2','1','4']);
 assert.equal(readFee(null),undefined);assert.equal(readFee(''),undefined);assert.equal(readFee(-1),undefined);assert.equal(readFee(0),0);
});
test('publishes independent bounded lists without mutating full city data',()=>{
 const original=structuredClone(rows),result=buildRankings(rows,{limit:2});
 assert.deepEqual(rows,original);assert.equal(result.lists['lowest-fees'].length,2);assert.equal(result.candidateCount,4);
 assert.equal(result.feeCoverage.known,3);assert.equal(result.feeCoverage.total,4);assert.equal(result.feeCoverage.complete,false);
});
test('productive destinations precede empty or unavailable destinations in every mode',()=>{
 for(const mode of ['maximum-coverage','balanced','lowest-fees'])assert.ok(compareRows({propertyId:'1',hotspotScore:1,sendFee:100},{propertyId:'2',hotspotScore:0,sendFee:0},mode)<0);
 const result=buildRankings([...rows,{propertyId:'9',hotspotScore:99,sendable:false}]);assert.ok(result.lists['maximum-coverage'].every(r=>r.propertyId!=='9'));
});
test('fee collector respects Retry-After and preserves successfully read fees',async()=>{
 let at=0,calls=0;const waits=[];
 const result=await collectFees(['1','2'],{fetchImpl:async()=>{calls++;if(calls===1)return new Response(JSON.stringify({prop_id:'1',teleport_price:5}),{status:200});return new Response('{}',{status:429,headers:{'Retry-After':'7'}});},now:()=>at,sleep:async ms=>{waits.push(ms);at+=ms;},maxRequests:2});
 assert.equal(result.records['1'].fee,5);assert.equal(result.rateLimits,1);assert.ok(result.retryAt>=at+7000);assert.equal(calls,2);assert.ok(waits.every(ms=>ms>=250));
});
test('cached fresh fees are reused without network reads',async()=>{
 const result=await collectFees(['1'],{records:{'1':{fee:2,at:1000}},now:()=>2000,fetchImpl:()=>{throw Error('network must not run');},sleep:async()=>{}});
 assert.equal(result.records['1'].fee,2);assert.equal(result.requests,0);
});
test('repeated fee failures back off and leave fees unknown',async()=>{
 const waits=[];let calls=0;
 const result=await collectFees(['1','2','3','4','5','6','7'],{fetchImpl:async()=>{calls++;return new Response('{}',{status:500});},sleep:async ms=>waits.push(ms)});
 assert.equal(calls,6);assert.equal(Object.keys(result.records).length,0);assert.ok(waits.some(ms=>ms>=3000));
});
