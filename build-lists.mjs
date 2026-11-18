// Wibenji — public hotspot preselection lists. Full parcel data is never truncated.
import {readFile,writeFile,mkdir,appendFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const MODES=['maximum-coverage','balanced','lowest-fees'];
import {readFee,collectFees,feeCoverage,DAY} from './fee-state.mjs';
import {createFeeCacheStore} from './fee-cache.mjs';
export {readFee,collectFees};
export function compareRows(a,b,mode){
 const as=a.hotspotScore??0,bs=b.hotspotScore??0,productive=Number(bs>0)-Number(as>0);if(productive)return productive;
 const af=readFee(a.sendFee),bf=readFee(b.sendFee),known=Number(af===undefined)-Number(bf===undefined);let order=0;
 if(mode==='balanced'||mode==='lowest-fees'){
  if(known)return known;
  if(af!==undefined&&bf!==undefined){if(mode==='lowest-fees')order=af-bf;else if(af===0||bf===0)order=Number(bf===0)-Number(af===0);else order=bs/Math.sqrt(bf)-as/Math.sqrt(af);}
 }
 return order||bs-as||known||(af!==undefined&&bf!==undefined?af-bf:0)||(a.hotspotDistance??0)-(b.hotspotDistance??0)||a.propertyId.localeCompare(b.propertyId);
}
export function buildRankings(rows,{limit=500,fees={},at=Date.now()}={}){
 const candidates=rows.filter(p=>p.sendable!==false&&p.hotspotScore>0).map(p=>{
  const cached=fees[p.propertyId],fee=cached?(cached.at+DAY>at?readFee(cached.fee):undefined):readFee(p.sendFee);
  return {...p,sendFee:fee};
 });
 const known=candidates.filter(p=>readFee(p.sendFee)!==undefined).length;
 const count=Math.min(limit,candidates.length);
 return {schemaVersion:1,provider:'WibenjiTroveHotspots',generatedAt:new Date(at).toISOString(),preselectionOnly:true,personalCooldowns:false,nativeArrivalVerified:false,settings:{plantsPerStructure:50,radiusMetres:60},primaryCount:Math.min(250,count),reserveCount:Math.max(0,count-250),candidateCount:candidates.length,feeCoverage:feeCoverage(candidates.map(p=>p.propertyId),Object.fromEntries(candidates.map(p=>[p.propertyId,readFee(p.sendFee)!==undefined?{fee:readFee(p.sendFee),at:fees[p.propertyId]?.at??at}:fees[p.propertyId]])),at),lists:Object.fromEntries(MODES.map(mode=>[mode,[...candidates].sort((a,b)=>compareRows(a,b,mode)).slice(0,limit).map(p=>({propertyId:p.propertyId,score:p.hotspotScore,...(readFee(p.sendFee)!==undefined?{sendFee:readFee(p.sendFee)}:{feeUnknown:true})}))]))};
}
export async function scoringCore(){
 let source=await readFile(process.env.SCAN_SOURCE??'full-city-scan.mjs','utf8');
 const marker='const {createCityMapScan}=scanModule;const {createCityMapJournal}=journalModule;';
 if(!source.includes(marker))throw Error('Unsupported scanner bundle; refusing inconsistent ranking');
 source=source.slice(0,source.indexOf(marker))+'\nexport const scoreCity=mapModule.cityMapHotspots;';
 return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
function gh(...args){return execFileSync('gh',[...args,'--repo','vibenji/upland-city-hotspots'],{encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']}).trim();}
async function previousFees(cityId,dir){
 try{
  const release=JSON.parse(gh('release','view','current-data','--json','assets'));
  let selected=null,tag='current-data';
  if(release.assets.some(a=>a.name==='index.json')){
   gh('release','download','current-data','--pattern','index.json','--dir',dir,'--clobber');
   const text=await readFile(join(dir,'index.json'),'utf8'),catalog=JSON.parse(text),record=catalog.cities.find(c=>c.id===cityId),ranking=record?.rankings?.url?record.rankings:record?.previous?.rankings;
   if(ranking?.url){const url=new URL(ranking.url),parts=url.pathname.split('/');if(url.hostname!=='github.com'||parts.slice(1,5).join('/')!=='vibenji/upland-city-hotspots/releases/download')throw Error('Unexpected fee cache URL');tag=parts[5];selected={name:parts[6],expectedHash:ranking.compressedSha256};}
  }
  const asset=selected??release.assets.filter(a=>new RegExp('^rankings-'+cityId+'-[0-9]+-[0-9]+\\.json\\.gz$').test(a.name)).sort((a,b)=>b.name.localeCompare(a.name,undefined,{numeric:true}))[0];
  if(!asset)return {};
  gh('release','download',tag,'--pattern',asset.name,'--dir',dir,'--clobber');
  const compressed=await readFile(join(dir,asset.name));if(asset.expectedHash&&createHash('sha256').update(compressed).digest('hex')!==asset.expectedHash)throw Error('Fee cache checksum mismatch');
  return JSON.parse(gunzipSync(compressed).toString('utf8')).fees??{};
 }catch(error){console.error(JSON.stringify({event:'fee-cache-unavailable',error:error.message}));return {};}
}
export async function logFeeCheckpoint({cityId,records,progress,checkpoint,summaryFile=process.env.GITHUB_STEP_SUMMARY}){
 const saved=await checkpoint.save(records,Date.now(),{coverage:progress.coverage,requests:progress.requests,retryAt:progress.retryAt});
 console.log(JSON.stringify({event:'fee-checkpoint',cityId,...saved}));
 if(summaryFile)await appendFile(summaryFile,'\n- '+cityId+': fees '+progress.coverage.known+'/'+progress.coverage.total+' fresh, '+progress.coverage.recorded+' recorded; '+progress.requests+' requests (checkpoint saved).\n');
}
async function main(){
 const cityId=process.env.CITY_ID;if(!/^[1-9]\d{0,8}$/.test(cityId??''))throw Error('Invalid city');
 const dir=resolve(process.env.OUTPUT_DIR??'output');await mkdir(dir,{recursive:true});
 const city=JSON.parse(await readFile(process.env.CITY_DATA_FILE,'utf8'));
 if(!city.complete||city.cityId!==cityId||!Array.isArray(city.properties))throw Error('Only complete matching city datasets can be processed');
 const {scoreCity}=await scoringCore();
 const rows=scoreCity(city.properties).filter(p=>p.sendable!==false&&p.hotspotScore>0);
 const candidates=[...rows].sort((a,b)=>compareRows(a,b,'maximum-coverage'));
 const feeBudget=Number(process.env.FEE_MAX_REQUESTS??1000000),budgetMs=Number(process.env.FEE_TIME_BUDGET_MS??16200000);
 if(!Number.isInteger(feeBudget)||feeBudget<0||feeBudget>1000000||!Number.isFinite(budgetMs)||budgetMs<1||budgetMs>17400000)throw Error('Invalid fee request/time budget');
 const release=JSON.parse(gh('release','view','current-data','--json','assets'));const names=new Set(release.assets.map(a=>a.name));
 const checkpoint=createFeeCacheStore(cityId,{
  load:async name=>{if(!names.has(name))return null;gh('release','download','current-data','--pattern',name,'--dir',dir,'--clobber');return readFile(join(dir,name));},
  save:async(name,bytes)=>{const file=join(dir,name);await writeFile(file,bytes);gh('release','upload','current-data',file,'--clobber');names.add(name);}
 });
 const legacy=await previousFees(cityId,dir),cached=await checkpoint.load();
 const records={...legacy};for(const [id,r]of Object.entries(cached))if(!records[id]||r.at>records[id].at)records[id]=r;
 const sourceAt=Date.parse(city.fetchedAt);for(const row of candidates)if(readFee(row.sendFee)!==undefined&&Number.isFinite(sourceAt)&&(!records[row.propertyId]||sourceAt>records[row.propertyId].at))records[row.propertyId]={fee:readFee(row.sendFee),at:sourceAt};
 const feeResult=await collectFees(candidates.map(p=>p.propertyId),{records,maxRequests:feeBudget,budgetMs,concurrency:4,intervalMs:100,retryRateLimits:true,retryErrors:true,
  onCheckpoint:(records,progress)=>logFeeCheckpoint({cityId,records,progress,checkpoint})
 });
 const result={...buildRankings(rows,{fees:feeResult.records}),cityId,sourceFetchedAt:city.fetchedAt,fees:feeResult.records,feeRequestBudget:feeBudget,feeTimeBudgetMs:budgetMs,feeBudgetReached:feeResult.budgetReached,feeRequests:feeResult.requests,feeRateLimits:feeResult.rateLimits,feeRetryAt:feeResult.retryAt,feeErrors:feeResult.errors,feeScope:'all-candidates',fullDatasetRequiredForStarredSearch:true};
 const stamp=(process.env.GITHUB_RUN_ID??Date.now())+'-'+(process.env.GITHUB_RUN_ATTEMPT??'1'),assetName='rankings-'+cityId+'-'+stamp+'.json.gz';
 const raw=Buffer.from(JSON.stringify(result)),compressed=gzipSync(raw,{level:6});await writeFile(join(dir,assetName),compressed);
 const manifest={status:result.feeCoverage.complete?'ready':'partial-fees',assetName,encoding:'gzip',bytes:compressed.length,sha256:createHash('sha256').update(raw).digest('hex'),compressedSha256:createHash('sha256').update(compressed).digest('hex'),generatedAt:result.generatedAt,feeFreshUntil:candidates.length?Object.values(feeResult.records).reduce((min,r)=>Math.min(min,r.at+DAY),Date.now()+DAY):Date.now()+DAY,feeCoverage:result.feeCoverage,feeScope:result.feeScope,feeBudgetReached:result.feeBudgetReached,feeRetryAt:result.feeRetryAt,feeErrors:Object.keys(result.feeErrors).length,modes:MODES,primaryCount:result.primaryCount,reserveCount:result.reserveCount,preselectionOnly:true};
 await writeFile(join(dir,'rankings-manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({event:'rankings-ready',cityId,...manifest}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});

