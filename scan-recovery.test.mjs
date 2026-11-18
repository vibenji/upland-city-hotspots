import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
let source=await readFile(new URL('./full-city-scan.mjs',import.meta.url),'utf8');
const marker='const {createCityMapScan}=scanModule;const {createCityMapJournal}=journalModule;';
source=source.slice(0,source.indexOf(marker))+'\nexport const neighborhoods=mapModule.cityNeighborhoods;export const createScanner=scanModule.createCityMapScan;';
const core=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const polygon={type:'Polygon',coordinates:[[[0,0],[.001,0],[.001,.001],[0,.001],[0,0]]]};
const valid={city_id:15,name:'Published',boundaries:polygon};
test('New Orleans ignores the empty AIRPORT placeholder and retains every published boundary',()=>{
 const result=core.neighborhoods([valid,{city_id:15,name:'AIRPORT',area:null,center:null,boundaries:null,residents:0}], '15');
 assert.equal(result.length,1);assert.equal(result[0].name,'Published');
});
test('missing or corrupt real boundaries still cannot publish a complete empty city',()=>{
 assert.throws(()=>core.neighborhoods([{city_id:15,boundaries:null}], '15'),/No published/);
 assert.throws(()=>core.neighborhoods([valid,{city_id:15,boundaries:{type:'Polygon',coordinates:[]}}], '15'),/Invalid/);
});
test('Paris retries a terminated neighborhood body before creating any map work',async()=>{
 let at=10000,calls=0;const values={};
 const storage={get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(values[k])])),set:async rows=>Object.assign(values,structuredClone(rows))};
 const scanner=core.createScanner({storage,now:()=>at,fetchImpl:async()=>({ok:true,status:200,headers:new Headers(),json:async()=>{if(++calls===1)throw TypeError('terminated');return [valid];}})});
 const retry=await scanner.start('15');assert.equal(retry.needsStart,true);assert.equal(retry.remaining,0);assert.match(retry.message,/Retrying/);assert.ok(retry.retryAt>at);
 at=retry.retryAt+1;const ready=await scanner.start('15');assert.equal(calls,2);assert.equal(ready.needsStart,false);assert.ok(ready.remaining>0);
});
