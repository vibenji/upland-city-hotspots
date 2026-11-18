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
