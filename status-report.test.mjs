import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {auditCity,reportMarkdown,decodeAsset,buildReport} from './status-report.mjs';
const at=1795000000000,iso=new Date(at).toISOString();
const properties=[{propertyId:'1',cityId:'9',sources:[]},{propertyId:'2',cityId:'9',sources:[]}];
const city={schemaVersion:1,cityId:'9',complete:true,fetchedAt:iso,properties};
const candidateRows=[{propertyId:'1',hotspotScore:10},{propertyId:'2',hotspotScore:5}];
const fees={'1':{fee:0,at},'2':{fee:5,at:at-86400001}};
const modes=['maximum-coverage','balanced','lowest-fees'];
const ranking={cityId:'9',sourceFetchedAt:iso,generatedAt:iso,fees,candidateCount:2,lists:Object.fromEntries(modes.map(m=>[m,[{propertyId:'1',score:10,sendFee:0},{propertyId:'2',score:5,feeUnknown:true}]]))};
const record={id:'9',name:'Bakersfield',complete:true,parcels:2,sourceProperties:0,plants:0,structures:0,fetchedAt:iso,dataset:{allParcels:true},rankings:{feeCoverage:{known:2,total:2,complete:true}}};
test('audit recomputes freshness and does not trust a green manifest',()=>{
 const row=auditCity(record,city,ranking,{candidateRows,now:at});assert.equal(row.maps,'verified');assert.equal(row.lists,'verified');assert.equal(row.fees.known,1);assert.equal(row.fees.stale,1);assert.equal(row.complete,false);
});
test('invalid counts, duplicate IDs and invalid list members are visible failures',()=>{
 const bad=auditCity(record,{...city,properties:[properties[0],properties[0]]},ranking,{candidateRows,now:at});assert.equal(bad.maps,'invalid');assert.equal(bad.complete,false);
 const badList=structuredClone(ranking);badList.lists.balanced=[{propertyId:'999',sendFee:0}];assert.equal(auditCity(record,city,badList,{candidateRows,now:at}).lists,'invalid');
});
test('asset audit verifies both hashes and refuses corrupt gzip payloads',()=>{
 const raw=Buffer.from(JSON.stringify(city)),zip=gzipSync(raw),sha=b=>createHash('sha256').update(b).digest('hex');const metadata={sha256:sha(raw),compressedSha256:sha(zip)};
 assert.deepEqual(decodeAsset(zip,metadata),city);assert.throws(()=>decodeAsset(Buffer.from('bad'),metadata),/checksum/i);
});
test('report includes planned missing cities and explains zero-candidate completeness',()=>{
 const rows=[auditCity(record,city,{...ranking,fees:{'1':{fee:0,at},'2':{fee:2,at}}},{candidateRows,now:at})];
 const report=buildReport([{id:'9',name:'Bakersfield'},{id:'91',name:'Paris'}],rows,at);assert.equal(report.complete,false);assert.equal(report.cities.length,2);assert.match(reportMarkdown(report),/Paris/);assert.match(reportMarkdown(report),/missing/);
 const empty=auditCity({...record,parcels:0},{...city,properties:[]},{...ranking,candidateCount:0,fees:{},lists:Object.fromEntries(modes.map(m=>[m,[]]))},{candidateRows:[],now:at});assert.equal(empty.fees.total,0);assert.equal(empty.complete,true);
});

test('audit rejects wrong ordering, fake scores and hidden known fees in otherwise complete lists',()=>{
 const correct=structuredClone(ranking);correct.fees={'1':{fee:0,at},'2':{fee:5,at}};
 for(const list of Object.values(correct.lists)){list[0].score=10;list[1].score=5;delete list[1].feeUnknown;list[1].sendFee=5;}
 const candidateRows=[{propertyId:'1',hotspotScore:10},{propertyId:'2',hotspotScore:5}];
 for(const mutate of [r=>r.lists['lowest-fees'].reverse(),r=>r.lists.balanced[0].score=-999,r=>{delete r.lists.balanced[0].sendFee;r.lists.balanced[0].feeUnknown=true;}]){
  const bad=structuredClone(correct);mutate(bad);const row=auditCity(record,city,bad,{candidateIds:['1','2'],candidateRows,now:at});assert.equal(row.lists,'invalid');assert.equal(row.complete,false);
 }
});
