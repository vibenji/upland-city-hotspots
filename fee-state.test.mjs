import test from 'node:test';
import assert from 'node:assert/strict';
import {collectFees,feeCoverage,feeQueue,validateFeeCache,makeFeeCache} from './fee-state.mjs';
const DAY=86400000,at=2*DAY;
const reply=url=>Response.json({prop_id:url.split('/').at(-1),teleport_price:0});
test('fee coverage counts missing and stale separately; zero is verified, invalid or future records are not',()=>{
 const records={'1':{fee:0,at},'2':{fee:3,at:1},'3':{fee:null,at},'4':{fee:2,at:at+5000}};
 assert.deepEqual(feeCoverage(['1','2','3','4','5'],records,at),{known:1,recorded:2,total:5,stale:1,missing:3,complete:false});
});
test('missing candidates are fetched before stale records, with fresh records skipped',()=>{
 assert.deepEqual(feeQueue(['1','2','3','4'],{'1':{fee:2,at:1},'2':{fee:2,at},'4':{fee:3,at:2}},at),['3','1','4']);
});
test('all candidates beyond the previous 1000 ceiling are fetched and checkpointed',async()=>{
 let clock=at,calls=0;const checkpoints=[];const ids=Array.from({length:1007},(_,i)=>String(i+1));
 const result=await collectFees(ids,{now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:async u=>{calls++;return reply(u);},maxRequests:2000,checkpointEvery:500,onCheckpoint:async(r,p)=>checkpoints.push({records:Object.keys(r).length,requests:p.requests})});
 assert.equal(calls,1007);assert.equal(Object.keys(result.records).length,1007);assert.equal(result.coverage.complete,true);assert.deepEqual(checkpoints.map(c=>c.requests),[500,1000,1007]);
});
test('collector bounds concurrency, starts requests with pacing and checkpoints only settled records',async()=>{
 let active=0,peak=0;const waits=[],saved=[];
 const result=await collectFees(['1','2','3','4','5'],{concurrency:2,intervalMs:1,sleep:async ms=>{waits.push(ms);},fetchImpl:async u=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,5));active--;return reply(u);},checkpointEvery:2,onCheckpoint:async r=>saved.push(Object.keys(r).length)});
 assert.equal(peak,2);assert.equal(active,0);assert.ok(waits.every(ms=>ms>=1));assert.deepEqual(saved,[2,4,5]);assert.equal(result.coverage.complete,true);
});
test('rate-limited candidates are retried after Retry-After and saved records survive bounded exit',async()=>{
 let clock=at,calls=0;const waits=[];
 const result=await collectFees(['1'],{now:()=>clock,sleep:async ms=>{clock+=ms;waits.push(ms);},retryRateLimits:true,fetchImpl:async u=>++calls===1?new Response('{}',{status:429,headers:{'Retry-After':'2'}}):reply(u)});
 assert.equal(calls,2);assert.equal(result.rateLimits,1);assert.ok(waits.includes(2000));assert.equal(result.records['1'].fee,0);
});
test('budget exit checkpoints valid records and the next run resumes missing candidates',async()=>{
 let clock=at;const options={now:()=>clock,sleep:async ms=>{clock+=ms;},fetchImpl:reply,budgetMs:700};let saved;
 const first=await collectFees(['1','2','3'],{...options,onCheckpoint:async r=>{saved=r;}});assert.equal(first.budgetReached,true);assert.equal(Object.keys(saved).length,2);
 const second=await collectFees(['1','2','3'],{...options,records:saved});assert.equal(second.requests,1);assert.equal(second.coverage.complete,true);
});
test('checkpoint upload failure propagates rather than being mistaken for an API error',async()=>{
 await assert.rejects(()=>collectFees(['1'],{fetchImpl:reply,sleep:async()=>{},onCheckpoint:async()=>{throw Error('Publication failed');}}),/Publication failed/);
});
test('fee checkpoint verifies city, checksum and valid record timestamps before reuse',()=>{
 const cache=makeFeeCache('9',{'1':{fee:0,at}},at);assert.equal(validateFeeCache(cache,'9',at)['1'].fee,0);
 assert.throws(()=>validateFeeCache(cache,'32',at),/city/i);
 const corrupt={...cache,records:{'1':{fee:-1,at}}};assert.throws(()=>validateFeeCache(corrupt,'9',at),/record/i);
});

import {createFeeCacheStore} from './fee-cache.mjs';
test('two-slot fee cache keeps the prior committed checkpoint when pointer publication fails',async()=>{
 const files=new Map();let fail=false;const storage={load:async n=>files.get(n)??null,save:async(n,b)=>{if(fail&&n.endsWith('checkpoint.json')){files.delete(n);throw Error('Upload failed');}files.set(n,Buffer.from(b));}};
 const first=createFeeCacheStore('9',storage);await first.load();await first.save({'1':{fee:0,at}},at);
 fail=true;await assert.rejects(()=>first.save({'1':{fee:0,at},'2':{fee:3,at}},at),/Upload failed/);
 fail=false;const restored=await createFeeCacheStore('9',storage).load(at);assert.deepEqual(Object.keys(restored),['1']);
});

import {logFeeCheckpoint} from './build-lists.mjs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('Actions checkpoint saves records and writes the real job summary without aborting collection',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fee-summary-'));try{
  const summaryFile=join(dir,'summary.md');let saved=0;
  await logFeeCheckpoint({cityId:'9',records:{'1':{fee:0,at}},progress:{coverage:{known:1,total:2,recorded:1},requests:1,retryAt:0},checkpoint:{save:async()=>{saved++;return {records:1};}},summaryFile});
  assert.equal(saved,1);assert.match(await readFile(summaryFile,'utf8'),/fees 1\/2 fresh/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a first checkpoint whose pointer upload fails can resume its validated self-contained slot',async()=>{
 const files=new Map();const storage={load:async n=>files.get(n)??null,save:async(n,b)=>{if(n.endsWith('checkpoint.json'))throw Error('Lost pointer');files.set(n,Buffer.from(b));}};
 const store=createFeeCacheStore('9',storage);await store.load();await assert.rejects(()=>store.save({'1':{fee:0,at}},at),/Lost pointer/);
 assert.equal((await createFeeCacheStore('9',storage).load(at))['1'].fee,0);
});
