import test from 'node:test';
import assert from 'node:assert/strict';
import {orderCities,mergeIndex} from './scan-queue.mjs';
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
