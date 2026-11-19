// Wibenji — independent public city payload audit and readable release report.
import {readFile,writeFile,mkdir,appendFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {feeCoverage,readFee,DAY,validateFeeCache} from './fee-state.mjs';
import {scoringCore,buildRankings,selectBasis,BASIS_VERSION,BASIS_RADIUS_METRES} from './build-lists.mjs';
const MODES=['maximum-coverage','balanced','lowest-fees'],REPO='vibenji/upland-city-hotspots';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function decodeAsset(compressed,metadata){
 if(compressed.length>80000000||sha(compressed)!==metadata.compressedSha256)throw Error('Compressed asset checksum mismatch');
 const raw=gunzipSync(compressed,{maxOutputLength:536870912});if(sha(raw)!==metadata.sha256)throw Error('Decoded asset checksum mismatch');
 return JSON.parse(raw.toString('utf8'));
}
export function auditCity(record,city,ranking,{candidateRows=null,candidateIds=candidateRows?.map(p=>p.propertyId)??[],now=Date.now()}={}){
 const row={id:record.id,name:record.name,maps:'invalid',lists:'missing',mapAt:city?.fetchedAt??record.fetchedAt??null,listAt:ranking?.generatedAt??null,fees:feeCoverage(candidateIds,ranking?.fees??{},now),requiredFees:{known:0,total:0,missing:0,complete:false},feeScope:ranking?.feeScope??'all-candidates',complete:false,problems:[]};
 try{
  if(!record.complete||record.dataset?.allParcels!==true||city?.schemaVersion!==1||!city.complete||city.cityId!==record.id||!Array.isArray(city.properties))throw Error('Missing complete matching map payload');
  const ids=new Set();let sources=0,plants=0,structures=0;
  for(const p of city.properties){if(!/^[1-9]\d{0,15}$/.test(p.propertyId)||ids.has(p.propertyId)||p.cityId!==record.id||!Array.isArray(p.sources))throw Error('Invalid or duplicate parcel');ids.add(p.propertyId);if(p.sources.length)sources++;for(const s of p.sources){plants+=Number(s.sourceKind==='plant');structures+=Number(s.sourceKind==='structure');}}
  if(city.properties.length!==record.parcels||sources!==record.sourceProperties||plants!==record.plants||structures!==record.structures)throw Error('Parcel/source count mismatch');
  if(candidateIds.some(id=>!ids.has(id))||new Set(candidateIds).size!==candidateIds.length)throw Error('Invalid candidate set');
  if(!Number.isFinite(Date.parse(city.fetchedAt))||Date.parse(city.fetchedAt)>now+2000)throw Error('Invalid map timestamp');
  row.maps='verified';row.parcels=ids.size;
 }catch(error){row.problems.push(error.message);}
 if(ranking)try{
  row.lists='invalid';
  if(ranking.cityId!==record.id||ranking.sourceFetchedAt!==city?.fetchedAt||ranking.candidateCount!==candidateIds.length)throw Error('Rankings do not match full city snapshot/candidates');
  const generatedAt=Date.parse(ranking.generatedAt);if(!Number.isFinite(generatedAt)||generatedAt>now+2000)throw Error('Invalid ranking timestamp');
  validateFeeCache({schemaVersion:1,cityId:record.id,records:ranking.fees},record.id,now);
  if(record.rankings?.feeScope!==ranking.feeScope)throw Error('Index and ranking fee scope mismatch');
  const candidates=new Set(candidateIds);
  if(!Array.isArray(candidateRows))throw Error('Missing independently scored candidate rows');
  let requiredIds=candidateIds;
  if(ranking.feeScope==='basis-500-nearest-1'){
   if(ranking.basisVersion!==BASIS_VERSION||ranking.basisRadiusMetres!==BASIS_RADIUS_METRES||ranking.feeRetention!=='until-refreshed')throw Error('Unsupported basis version, radius or retention policy');
   requiredIds=selectBasis(candidateRows).map(p=>p.propertyId);
   if(JSON.stringify(ranking.basisIds)!==JSON.stringify(requiredIds))throw Error('Basis IDs do not match independently recomputed pool');
   const manifest=record.rankings;
   for(const key of ['feeScope','basisVersion','basisRadiusMetres','feeRetention'])if(manifest?.[key]!==ranking[key])throw Error('Index and ranking policy mismatch: '+key);
  }else if(ranking.feeScope&&!['all-candidates','highest-coverage-1000-candidates'].includes(ranking.feeScope))throw Error('Unsupported fee scope');
  const required=feeCoverage(requiredIds,ranking.fees,now);
  row.requiredFees={known:required.recorded,total:required.total,missing:required.missing,complete:required.recorded===required.total,retained:true};
  if(ranking.feeScope==='basis-500-nearest-1'){
   for(const coverage of [ranking.basisCoverage,record.rankings?.basisCoverage]){
    if(!coverage||coverage.known!==row.requiredFees.known||coverage.total!==row.requiredFees.total||coverage.missing!==row.requiredFees.missing||coverage.complete!==row.requiredFees.complete)throw Error('Basis coverage metadata does not match verified fee records');
   }
  }
  if(!row.requiredFees.complete)throw Error(row.requiredFees.missing+' missing required fees');
  for(const mode of MODES){const list=ranking.lists?.[mode];if(!Array.isArray(list)||list.length!==Math.min(500,candidates.size))throw Error('Missing or truncated '+mode+' list');const seen=new Set();for(const item of list){if(!candidates.has(item.propertyId)||seen.has(item.propertyId))throw Error('Invalid '+mode+' member');seen.add(item.propertyId);if(item.sendFee!==undefined){const fee=ranking.fees[item.propertyId];if(readFee(item.sendFee)===undefined||!fee||item.sendFee!==fee.fee)throw Error('Unverified fee in '+mode);}else if(item.feeUnknown!==true)throw Error('Unknown fee must be marked explicitly');}}
  const expected=buildRankings(candidateRows,{fees:ranking.fees,at:generatedAt,retainFees:true});
  for(const mode of MODES)if(JSON.stringify(ranking.lists[mode])!==JSON.stringify(expected.lists[mode]))throw Error('Incorrect order, scores or fee state in '+mode);
  row.lists='verified';
 }catch(error){row.problems.push(error.message);}
 const feeTimes=candidateIds.map(id=>ranking?.fees?.[id]?.at).filter(at=>Number.isFinite(at)&&at<=now+2000);
 row.oldestFeeAt=feeTimes.length?new Date(feeTimes.reduce((a,b)=>Math.min(a,b),Infinity)).toISOString():null;
 const mapAge=now-Date.parse(row.mapAt),listAge=now-Date.parse(row.listAt);
 row.mapFresh=Number.isFinite(mapAge)&&mapAge<DAY;row.listFresh=Number.isFinite(listAge)&&listAge<DAY;
 if(!row.mapFresh)row.problems.push('Map older than 24h or missing');
 if(!row.listFresh)row.problems.push('Lists older than 24h or missing');
 // Fees outside the required pool and retained fact age are informational.
 row.complete=row.maps==='verified'&&row.lists==='verified'&&row.mapFresh&&row.listFresh&&row.requiredFees.complete;
 return row;
}
export function buildReport(planned,rows,now=Date.now()){
 const byId=new Map(rows.map(r=>[r.id,r]));
 const cities=planned.map(c=>byId.get(c.id)??{...c,maps:'missing',lists:'missing',fees:{known:0,recorded:0,total:0,stale:0,missing:0,complete:false},complete:false,problems:['Planned city missing from published catalog']});
 for(const row of rows)if(!cities.some(c=>c.id===row.id))cities.push(row);
 return {schemaVersion:1,generatedAt:new Date(now).toISOString(),basis:'verified published gzip payloads, candidate membership and fee timestamps',mapAndListFreshnessHours:24,feeRetention:'until-refreshed',requiredBasis:{version:BASIS_VERSION,radiusMetres:BASIS_RADIUS_METRES,maxTargets:750},complete:cities.length>0&&cities.every(c=>c.complete),cities};
}
const safe=value=>String(value??'—').replaceAll('|','/').replace(/[\r\n]+/g,' ');
export function reportMarkdown(report){
 const rows=report.cities,totals=rows.reduce((a,r)=>{for(const k of ['known','recorded','total','stale','missing'])a[k]+=r.fees[k];return a;},{known:0,recorded:0,total:0,stale:0,missing:0});
 const required=rows.reduce((sum,r)=>({known:sum.known+(r.requiredFees?.known??0),total:sum.total+(r.requiredFees?.total??0)}),{known:0,total:0});
 return '# Wibenji · City data verification\n\nChecked: '+report.generatedAt+' (UTC). Maps and lists must be less than 24 hours old. Verified fee facts are retained until refreshed.\n\n'+
  '- Overall: **'+(report.complete?'complete':'incomplete')+'**; '+rows.filter(r=>r.complete).length+'/'+rows.length+' cities meet the current publication policy.\n'+
  '- Maps verified: '+rows.filter(r=>r.maps==='verified').length+'/'+rows.length+'; three mode lists verified: '+rows.filter(r=>r.lists==='verified').length+'/'+rows.length+'.\n'+
  '- Required retained fees: **'+required.known+'/'+required.total+'**. All-candidate facts: '+totals.recorded+'/'+totals.total+' recorded; '+totals.missing+' missing outside or inside the required pool; '+totals.stale+' records older than 24h (informational).\n\n'+
  'The required pool is independently recomputed: top 500 coverage targets plus at most one nearest landing within 40m for each leading 250 (at most 750 IDs). Legacy publications require all candidate fees. Fees outside the current candidate set remain valid historical evidence. Zero-candidate cities need no fees. Unknown fees never count as zero. Full maps, both asset hashes, exact pool IDs, fee values/timestamps and all three independently rebuilt lists are checked.\n\n'+
  '| City | Maps | 3 lists | Required fees | All-candidate recorded | Older than 24h (info) | Missing candidates (info) | Map timestamp (UTC) | List timestamp (UTC) | Oldest recorded fee (UTC) | Complete | Details |\n|---|---|---|---:|---:|---:|---:|---|---|---|---|---|\n'+
  rows.map(r=>'| '+[r.name,r.maps,r.lists,r.requiredFees?r.requiredFees.known+'/'+r.requiredFees.total:'unverified',r.fees.recorded+'/'+r.fees.total,r.fees.stale,r.fees.missing,r.mapAt,r.listAt,r.oldestFeeAt,r.complete?'yes':'no',r.problems.join('; ')||'OK'].map(safe).join(' | ')+' |').join('\n')+
  '\n\n[Download machine-readable report](https://github.com/'+REPO+'/releases/download/current-data/status-report.json) · [City index](https://github.com/'+REPO+'/releases/download/current-data/index.json)\n';
}
function gh(...args){return execFileSync('gh',[...args,'--repo',REPO],{encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']}).trim();}
async function readAsset(tag,name,dir){gh('release','download',tag,'--pattern',name,'--dir',dir,'--clobber');const file=join(dir,name),bytes=await readFile(file);await rm(file);return bytes;}
async function readPublished(metadata,dir){
 const url=new URL(metadata.url),parts=url.pathname.split('/');
 if(url.hostname!=='github.com'||parts.slice(1,5).join('/')!==REPO+'/releases/download'||!(/^(current-data|city-data-\d{4}-\d{2}-\d{2})$/).test(parts[5])||!(/^(city|rankings)-\d+-\d+-\d+\.json\.gz$/).test(parts[6])||parts.length!==7)throw Error('Unexpected public asset URL');
 return decodeAsset(await readAsset(parts[5],parts[6],dir),metadata);
}
async function main(){
 const dir=resolve('reports/audit');await mkdir(dir,{recursive:true});
 const index=JSON.parse((await readAsset('current-data','index.json',dir)).toString('utf8')),plan=JSON.parse((await readAsset('current-data','plan.json',dir)).toString('utf8'));
 if(index.schemaVersion!==1||!Array.isArray(index.cities)||!Array.isArray(plan.cities)||!plan.cities.length)throw Error('Missing valid city catalog/plan');
 const {scoreCity}=await scoringCore(),rows=[];
 for(const record of index.cities){
  let city=null,ranking=null,candidateRows=[],errors=[];
  try{city=await readPublished(record.dataset,dir);candidateRows=scoreCity(city.properties).filter(p=>p.sendable!==false&&p.hotspotScore>0);}catch(error){errors.push('Map asset: '+error.message);}
  try{ranking=await readPublished(record.rankings,dir);}catch(error){errors.push('Ranking asset: '+error.message);}
  const row=auditCity(record,city,ranking,{candidateRows});row.problems.push(...errors);if(errors.length)row.complete=false;rows.push(row);console.log(JSON.stringify({event:'city-audit',...row}));
 }
 const report=buildReport(plan.cities,rows),markdown=reportMarkdown(report),jsonFile=join(dir,'status-report.json'),mdFile=join(dir,'status-report.md');
 await writeFile(jsonFile,JSON.stringify(report,null,2));await writeFile(mdFile,markdown);
 gh('release','upload','current-data',jsonFile,mdFile,'--clobber');gh('release','edit','current-data','--notes-file',mdFile);
 if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,markdown);
 console.log(JSON.stringify({event:'report-published',complete:report.complete,cities:rows.length}));
 if(!report.complete)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
