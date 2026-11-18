// Wibenji — independent public city payload audit and readable release report.
import {readFile,writeFile,mkdir,appendFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {feeCoverage,readFee,DAY,validateFeeCache} from './fee-state.mjs';
import {scoringCore,buildRankings} from './build-lists.mjs';
const MODES=['maximum-coverage','balanced','lowest-fees'],REPO='vibenji/upland-city-hotspots';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function decodeAsset(compressed,metadata){
 if(compressed.length>80000000||sha(compressed)!==metadata.compressedSha256)throw Error('Compressed asset checksum mismatch');
 const raw=gunzipSync(compressed,{maxOutputLength:536870912});if(sha(raw)!==metadata.sha256)throw Error('Decoded asset checksum mismatch');
 return JSON.parse(raw.toString('utf8'));
}
export function auditCity(record,city,ranking,{candidateRows=null,candidateIds=candidateRows?.map(p=>p.propertyId)??[],now=Date.now()}={}){
 const row={id:record.id,name:record.name,maps:'invalid',lists:'missing',mapAt:city?.fetchedAt??record.fetchedAt??null,listAt:ranking?.generatedAt??null,fees:feeCoverage(candidateIds,ranking?.fees??{},now),complete:false,problems:[]};
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
  const candidates=new Set(candidateIds);
  if(Object.keys(ranking.fees).some(id=>!candidates.has(id)))throw Error('Fee record outside eligible candidate set');
  for(const mode of MODES){const list=ranking.lists?.[mode];if(!Array.isArray(list)||list.length!==Math.min(500,candidates.size))throw Error('Missing or truncated '+mode+' list');const seen=new Set();for(const item of list){if(!candidates.has(item.propertyId)||seen.has(item.propertyId))throw Error('Invalid '+mode+' member');seen.add(item.propertyId);if(item.sendFee!==undefined){const fee=ranking.fees[item.propertyId];if(readFee(item.sendFee)===undefined||!fee||item.sendFee!==fee.fee||fee.at+DAY<=generatedAt)throw Error('Unverified fee in '+mode);}else if(item.feeUnknown!==true)throw Error('Unknown fee must be marked explicitly');}}
  if(!Array.isArray(candidateRows))throw Error('Missing independently scored candidate rows');
  const expected=buildRankings(candidateRows,{fees:ranking.fees,at:generatedAt});
  for(const mode of MODES)if(JSON.stringify(ranking.lists[mode])!==JSON.stringify(expected.lists[mode]))throw Error('Incorrect order, scores or fee state in '+mode);
  row.lists='verified';
 }catch(error){row.problems.push(error.message);}
 const feeTimes=candidateIds.map(id=>ranking?.fees?.[id]?.at).filter(at=>Number.isFinite(at)&&at<=now+2000);
 row.oldestFeeAt=feeTimes.length?new Date(feeTimes.reduce((a,b)=>Math.min(a,b),Infinity)).toISOString():null;
 const mapAge=now-Date.parse(row.mapAt),listAge=now-Date.parse(row.listAt);
 row.mapFresh=Number.isFinite(mapAge)&&mapAge<DAY;row.listFresh=Number.isFinite(listAge)&&listAge<DAY;
 if(!row.mapFresh)row.problems.push('Map older than 24h or missing');
 if(!row.listFresh)row.problems.push('Lists older than 24h or missing');
 if(row.fees.missing)row.problems.push(row.fees.missing+' missing fees');if(row.fees.stale)row.problems.push(row.fees.stale+' stale fees');
 row.complete=row.maps==='verified'&&row.lists==='verified'&&row.mapFresh&&row.listFresh&&row.fees.complete;
 return row;
}
export function buildReport(planned,rows,now=Date.now()){
 const byId=new Map(rows.map(r=>[r.id,r]));
 const cities=planned.map(c=>byId.get(c.id)??{...c,maps:'missing',lists:'missing',fees:{known:0,recorded:0,total:0,stale:0,missing:0,complete:false},complete:false,problems:['Planned city missing from published catalog']});
 for(const row of rows)if(!cities.some(c=>c.id===row.id))cities.push(row);
 return {schemaVersion:1,generatedAt:new Date(now).toISOString(),basis:'verified published gzip payloads, candidate membership and fee timestamps',freshnessHours:24,complete:cities.length>0&&cities.every(c=>c.complete),cities};
}
const safe=value=>String(value??'—').replaceAll('|','/').replace(/[\r\n]+/g,' ');
export function reportMarkdown(report){
 const rows=report.cities,totals=rows.reduce((a,r)=>{for(const k of ['known','recorded','total','stale','missing'])a[k]+=r.fees[k];return a;},{known:0,recorded:0,total:0,stale:0,missing:0});
 return '# Wibenji · City data verification\n\nChecked: '+report.generatedAt+' (UTC). Fresh means verified within 24 hours.\n\n'+
  '- Overall: **'+(report.complete?'complete':'incomplete')+'**; '+rows.filter(r=>r.complete).length+'/'+rows.length+' cities fully verified and fresh.\n'+
  '- Maps verified: '+rows.filter(r=>r.maps==='verified').length+'/'+rows.length+'; three mode lists verified: '+rows.filter(r=>r.lists==='verified').length+'/'+rows.length+'.\n'+
  '- Fees: **'+totals.known+'/'+totals.total+' fresh**, '+totals.recorded+' ever recorded, '+totals.stale+' stale, '+totals.missing+' missing.\n\n'+
  'Full means all eligible candidates, not only the 500 entries in each shortcut list. Zero-candidate cities have no candidate fees to collect. Public map completeness is scoped to published neighborhood boundaries. Unknown fees never count as zero.\n\n'+
  '| City | Maps | 3 lists | Fresh fees / candidates | Recorded | Stale | Missing | Map timestamp (UTC) | List timestamp (UTC) | Oldest recorded fee (UTC) | Complete | Details |\n|---|---|---|---:|---:|---:|---:|---|---|---|---|---|\n'+
  rows.map(r=>'| '+[r.name,r.maps,r.lists,r.fees.known+'/'+r.fees.total,r.fees.recorded,r.fees.stale,r.fees.missing,r.mapAt,r.listAt,r.oldestFeeAt,r.complete?'yes':'no',r.problems.join('; ')||'OK'].map(safe).join(' | ')+' |').join('\n')+
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
