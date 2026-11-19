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
export function buildRankings(rows,{limit=500,fees={},at=Date.now(),retainFees=false}={}){
 const candidates=rows.filter(p=>p.sendable!==false&&p.hotspotScore>0).map(p=>{
  const cached=fees[p.propertyId],fee=cached?(retainFees||cached.at+DAY>at?readFee(cached.fee):undefined):readFee(p.sendFee);
  return {...p,sendFee:fee};
 });
 const known=candidates.filter(p=>readFee(p.sendFee)!==undefined).length;
 const count=Math.min(limit,candidates.length);
 return {schemaVersion:1,provider:'WibenjiTroveHotspots',generatedAt:new Date(at).toISOString(),preselectionOnly:true,personalCooldowns:false,nativeArrivalVerified:false,settings:{plantsPerStructure:50,radiusMetres:60},primaryCount:Math.min(250,count),reserveCount:Math.max(0,count-250),candidateCount:candidates.length,feeCoverage:feeCoverage(candidates.map(p=>p.propertyId),Object.fromEntries(candidates.map(p=>[p.propertyId,readFee(p.sendFee)!==undefined?{fee:readFee(p.sendFee),at:fees[p.propertyId]?.at??at}:fees[p.propertyId]])),at),lists:Object.fromEntries(MODES.map(mode=>[mode,[...candidates].sort((a,b)=>compareRows(a,b,mode)).slice(0,limit).map(p=>({propertyId:p.propertyId,score:p.hotspotScore,...(readFee(p.sendFee)!==undefined?{sendFee:readFee(p.sendFee)}:{feeUnknown:true})}))]))};
}

// Fee requests are limited; the full city and scored candidate set remain intact.
export const BASIS_VERSION=2;
export const BASIS_RADIUS_METRES=40;
export function selectBasis(rows,{radiusMetres=BASIS_RADIUS_METRES}={}){
 if(!Number.isFinite(radiusMetres)||radiusMetres<=0)throw Error("Invalid basis radius");
 const sorted=rows.filter(p=>p.sendable!==false&&p.hotspotScore>0).sort((a,b)=>compareRows(a,b,'maximum-coverage'));
 const chosen=new Map(sorted.slice(0,500).map(p=>[p.propertyId,p]));
 const cos=Math.max(.05,Math.cos((sorted[0]?.lat??0)*Math.PI/180)),cell=radiusMetres,grid=new Map();
 const point=p=>[p.lng*111320*cos,p.lat*111320];
 for(const p of sorted){if(!Number.isFinite(p.lat)||!Number.isFinite(p.lng))continue;const [x,y]=point(p),key=Math.floor(x/cell)+','+Math.floor(y/cell);if(!grid.has(key))grid.set(key,[]);grid.get(key).push(p);}
 for(const p of sorted.slice(0,250)){
  if(!Number.isFinite(p.lat)||!Number.isFinite(p.lng))continue;
  const [x,y]=point(p),gx=Math.floor(x/cell),gy=Math.floor(y/cell);let nearest=null,best=cell*cell;
  for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const n of grid.get((gx+dx)+','+(gy+dy))??[]){if(n.propertyId===p.propertyId)continue;const [nx,ny]=point(n),distance=(nx-x)**2+(ny-y)**2;if(distance<best||distance===best&&n.propertyId<(nearest?.propertyId??'~')){nearest=n;best=distance;}}
  if(nearest)chosen.set(nearest.propertyId,nearest);
 }
 return [...chosen.values()];
}
const validKnown=(r,at)=>r&&typeof r.fee==='number'&&readFee(r.fee)!==undefined&&Number.isFinite(r.at)&&r.at>=0&&r.at<=at+2000;
export async function waitForFeeRetry(index,{externalRetryAt=0,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const deadline=Math.max(0,...[externalRetryAt,...(index?.cities??[]).map(c=>c.rankings?.feeRetryAt??0)].filter(value=>Number.isFinite(value)&&value>=0));
 while(deadline>now())await sleep(Math.min(60000,deadline-now()));
}
export async function collectBasisFees(ids,{records={},fetchImpl=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),concurrency=8,intervalMs=50,budgetMs=300000,maxRequests=1000,onCheckpoint=async()=>{},checkpointEvery=100}={}){
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>32||!Number.isFinite(intervalMs)||intervalMs<10&&intervalMs!==1)throw Error('Invalid measured throughput profile');
 records=Object.fromEntries(Object.entries(records).filter(([id,r])=>/^[1-9]\d{0,15}$/.test(id)&&validKnown(r,now())).map(([id,r])=>[id,{...r}]));
 const queue=[...new Set(ids)].filter(id=>!validKnown(records[id],now())),started=now();let cursor=0,requests=0,rateLimits=0,retryAt=0,stopped=false,pacing=Promise.resolve(),lastCheckpoint=0,checkpointTail=Promise.resolve();const errors={};
 const coverage=()=>{const known=ids.filter(id=>validKnown(records[id],now())).length;return {known,recorded:known,total:ids.length,missing:ids.length-known,stale:0,complete:known===ids.length,retained:true};};
 const progress=()=>({requests,rateLimits,retryAt,coverage:coverage(),errors:{...errors},budgetReached:now()-started>=budgetMs||requests>=maxRequests&&cursor<queue.length});
 const checkpoint=()=>{checkpointTail=checkpointTail.then(()=>onCheckpoint(structuredClone(records),progress()));return checkpointTail;};
 const pace=()=>{const next=pacing.then(async()=>{if(stopped||now()-started>=budgetMs||requests>=maxRequests)return false;await sleep(intervalMs);if(stopped||now()-started>=budgetMs||requests>=maxRequests)return false;requests++;return true;});pacing=next.catch(()=>{});return next;};
 const workers=Array.from({length:Math.min(concurrency,queue.length)},async()=>{
  while(!stopped&&cursor<queue.length){const id=queue[cursor++];if(!await pace())break;
   try{const response=await fetchImpl('https://api.prod.upland.me/api/properties/'+id,{headers:{accept:'application/json'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
    if(response.status===429||response.status===503){const after=response.headers?.get('Retry-After'),seconds=Number(after),wait=after?(Number.isFinite(seconds)?seconds*1000:Date.parse(after)-now()):60000;retryAt=Math.max(retryAt,now()+Math.max(1000,Number.isFinite(wait)?wait:60000));rateLimits+=Number(response.status===429);stopped=true;errors[id]='HTTP '+response.status;continue;}
    if(!response.ok)throw Error('Property HTTP '+response.status);const body=await response.json(),fee=readFee(body.teleport_price);if(String(body.prop_id)!==id||fee===undefined)throw Error('Unverified fee');records[id]={fee,at:now()};
   }catch(error){errors[id]=String(error.message).slice(0,160);if(Object.keys(errors).length>=6)stopped=true;}
   if(requests-lastCheckpoint>=checkpointEvery){lastCheckpoint=requests;try{await checkpoint();}catch(error){stopped=true;throw error;}}
  }
 });
 const settled=await Promise.allSettled(workers);const failure=settled.find(r=>r.status==='rejected');if(failure)throw failure.reason;
 if(requests)await checkpoint();return {records,...progress()};
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
 const candidates=[...rows].sort((a,b)=>compareRows(a,b,'maximum-coverage')),basis=selectBasis(rows);
 const feeBudget=Number(process.env.FEE_MAX_REQUESTS??1000),budgetMs=Number(process.env.FEE_TIME_BUDGET_MS??300000);
 if(!Number.isInteger(feeBudget)||feeBudget<0||feeBudget>1000000||!Number.isFinite(budgetMs)||budgetMs<1||budgetMs>17400000)throw Error('Invalid fee request/time budget');
 const release=JSON.parse(gh('release','view','current-data','--json','assets'));const names=new Set(release.assets.map(a=>a.name));
 const checkpoint=createFeeCacheStore(cityId,{
  load:async name=>{if(!names.has(name))return null;gh('release','download','current-data','--pattern',name,'--dir',dir,'--clobber');return readFile(join(dir,name));},
  save:async(name,bytes)=>{const file=join(dir,name);await writeFile(file,bytes);gh('release','upload','current-data',file,'--clobber');names.add(name);}
 });
 const legacy=await previousFees(cityId,dir),cached=await checkpoint.load();
 const records={...legacy};for(const [id,r]of Object.entries(cached))if(!records[id]||r.at>records[id].at)records[id]=r;
 const sourceAt=Date.parse(city.fetchedAt);for(const row of candidates)if(readFee(row.sendFee)!==undefined&&Number.isFinite(sourceAt)&&(!records[row.propertyId]||sourceAt>records[row.propertyId].at))records[row.propertyId]={fee:readFee(row.sendFee),at:sourceAt};
 const feeResult=await collectBasisFees(basis.map(p=>p.propertyId),{records,maxRequests:feeBudget,budgetMs,concurrency:Number(process.env.FEE_CONCURRENCY??8),intervalMs:Number(process.env.FEE_INTERVAL_MS??50),
  onCheckpoint:(records,progress)=>logFeeCheckpoint({cityId,records,progress,checkpoint})
 });
 const result={...buildRankings(rows,{fees:feeResult.records,retainFees:true}),cityId,sourceFetchedAt:city.fetchedAt,fees:feeResult.records,feeRequestBudget:feeBudget,feeTimeBudgetMs:budgetMs,feeBudgetReached:feeResult.budgetReached,feeRequests:feeResult.requests,feeRateLimits:feeResult.rateLimits,feeRetryAt:feeResult.retryAt,feeErrors:feeResult.errors,feeScope:'basis-500-nearest-1',basisVersion:BASIS_VERSION,basisRadiusMetres:BASIS_RADIUS_METRES,basisIds:basis.map(p=>p.propertyId),basisCoverage:feeResult.coverage,feeRetention:'until-refreshed',fullDatasetRequiredForStarredSearch:true};
 const stamp=(process.env.GITHUB_RUN_ID??Date.now())+'-'+(process.env.GITHUB_RUN_ATTEMPT??'1'),assetName='rankings-'+cityId+'-'+stamp+'.json.gz';
 const raw=Buffer.from(JSON.stringify(result)),compressed=gzipSync(raw,{level:6});await writeFile(join(dir,assetName),compressed);
 const manifest={status:result.feeCoverage.complete?'ready':result.basisCoverage.complete?'basis-ready':'partial-fees',assetName,encoding:'gzip',bytes:compressed.length,sha256:createHash('sha256').update(raw).digest('hex'),compressedSha256:createHash('sha256').update(compressed).digest('hex'),generatedAt:result.generatedAt,feeFreshUntil:candidates.length?Object.values(feeResult.records).reduce((min,r)=>Math.min(min,r.at+DAY),Date.now()+DAY):Date.now()+DAY,feeCoverage:result.feeCoverage,feeScope:result.feeScope,basisVersion:result.basisVersion,basisRadiusMetres:result.basisRadiusMetres,basisCoverage:result.basisCoverage,feeRetention:result.feeRetention,feeBudgetReached:result.feeBudgetReached,feeRetryAt:result.feeRetryAt,feeErrors:Object.keys(result.feeErrors).length,modes:MODES,primaryCount:result.primaryCount,reserveCount:result.reserveCount,preselectionOnly:true};
 await writeFile(join(dir,'rankings-manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({event:'rankings-ready',cityId,...manifest}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});

