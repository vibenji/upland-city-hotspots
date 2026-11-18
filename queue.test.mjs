import test from 'node:test';
import assert from 'node:assert/strict';
import {orderCities,mergeIndex,selectCatalog} from './scan-queue.mjs';
test('priorities precede every other discoverable city without dropping new cities',()=>{
 const rows=[{city_id:35},{city_id:1},{city_id:32},{city_id:9},{city_id:900},{city_id:1}];
 assert.deepEqual(orderCities(rows,[]).map(c=>c.id),['9','32','35','1','900']);
});
test('failed city update retains the last complete public snapshot',()=>{
 const old={schemaVersion:1,cities:[{id:'9',complete:true,dataset:{url:'old'}}]};
 const next=mergeIndex(old,{id:'9',complete:false,error:'rate limit'});
 assert.equal(next.cities[0].dataset.url,'old');
 assert.equal(next.cities[0].lastAttempt.error,'rate limit');
 assert.equal(old.cities[0].lastAttempt,undefined);
});
test('a successful snapshot replaces only its own city and retains the previous snapshot',()=>{
 const next=mergeIndex({cities:[{id:'9',complete:true,dataset:{url:'old'}},{id:'32',complete:true}]},{id:'9',complete:true,dataset:{url:'new'}});
 assert.equal(next.cities[0].dataset.url,'new');assert.equal(next.cities[0].previous.dataset.url,'old');assert.equal(next.cities[1].id,'32');
});
test('adding rankings to the same snapshot does not discard its previous generation',()=>{
 const old={cities:[{id:'9',complete:true,dataset:{url:'current'},previous:{dataset:{url:'older'}}}]};
 const next=mergeIndex(old,{id:'9',complete:true,dataset:{url:'current'},rankings:{status:'ready'}});
 assert.equal(next.cities[0].previous.dataset.url,'older');
});
test('missing public index recovers its backup instead of dropping existing cities',()=>{
 const backup={schemaVersion:1,cities:[{id:'9',complete:true}]};
 assert.deepEqual(selectCatalog(null,backup,{initialized:true}),backup);
 assert.throws(()=>selectCatalog(null,null,{initialized:true}),/catalog.*unavailable/i);
 assert.deepEqual(selectCatalog(null,null,{initialized:false}).cities,[]);
});
test('an unexpectedly shortened index cannot erase a complete city held in backup',()=>{
 const primary={schemaVersion:1,cities:[{id:'32',complete:true}]},backup={schemaVersion:1,cities:[{id:'9',complete:true},{id:'32',complete:true}]};
 assert.deepEqual(selectCatalog(primary,backup,{initialized:true}).cities.map(c=>c.id).sort(),['32','9']);
});

import {repairCatalog} from './scan-queue.mjs';
test('recovery rescans only failed incomplete cities and always backfills pending mode lists',async()=>{
 const calls=[];
 const index={cities:[{id:'9',complete:true,rankings:{status:'pending'}},{id:'15',name:'New Orleans',complete:false,status:'failed'},{id:'91',name:'Paris',complete:false,status:'failed'},{id:'117',complete:true,rankings:{status:'pending'}},{id:'120',complete:false,status:'scanning'}]};
 const failed=await repairCatalog(index,{scan:async c=>{calls.push(c.id);return c.id!=='15';},rebuild:async()=>calls.push('lists')});
 assert.deepEqual(calls,['15','91','lists']);assert.equal(failed,1);
});
test('successful completed maps are never rescanned during list recovery',async()=>{
 let rebuilt=false;const failed=await repairCatalog({cities:[{id:'9',complete:true,status:'ready'}]},{scan:()=>{throw Error('Must not scan');},rebuild:async()=>{rebuilt=true;}});
 assert.equal(failed,0);assert.equal(rebuilt,true);
});
