// Wibenji — public hotspot preselection lists. Full parcel data is never truncated.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const MODES=['maximum-coverage','balanced','lowest-fees'];
export function readFee(value){if(typeof value!=='number'&&(typeof value!=='string'||!value.trim()))return undefined;const fee=Number(value);return Number.isFinite(fee)&&fee>=0?fee:undefined;}
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
  const cached=fees[p.propertyId],fee=readFee(p.sendFee)??(cached?.at+86400000>at?readFee(cached.fee):undefined);
  return {...p,...(fee!==undefined?{sendFee:fee}:{})};
 });
 const known=candidates.filter(p=>readFee(p.sendFee)!==undefined).length;
 return {schemaVersion:1,provider:'WibenjiTroveHotspots',generatedAt:new Date(at).toISOString(),preselectionOnly:true,personalCooldowns:false,nativeArrivalVerified:false,settings:{plantsPerStructure:50,radiusMetres:60},primaryCount:Math.min(250,limit),reserveCount:Math.max(0,limit-250),candidateCount:candidates.length,feeCoverage:{known,total:candidates.length,complete:known===candidates.length},lists:Object.fromEntries(MODES.map(mode=>[mode,[...candidates].sort((a,b)=>compareRows(a,b,mode)).slice(0,limit).map(p=>({propertyId:p.propertyId,score:p.hotspotScore,...(readFee(p.sendFee)!==undefined?{sendFee:readFee(p.sendFee)}:{feeUnknown:true})}))]))};
}
export async function collectFees(ids,{records={},fetchImpl=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),maxRequests=1000}={}){
 records=structuredClone(records);let requests=0,failures=0,rateLimits=0,retryAt=0;
 for(const id of ids){
  if(records[id]?.at+86400000>now()&&readFee(records[id].fee)!==undefined)continue;
  if(requests>=maxRequests||failures>=6)break;
  await sleep(250);requests++;
  try{
   const response=await fetchImpl('https://api.prod.upland.me/api/properties/'+id,{headers:{accept:'application/json'},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
   if(response.status===429||response.status===503){const after=response.headers.get('retry-after'),seconds=Number(after);retryAt=now()+Math.max(1000,after?(Number.isFinite(seconds)?seconds*1000:Date.parse(after)-now()||60000):60000);rateLimits+=Number(response.status===429);break;}
   if(!response.ok)throw Error('Property HTTP '+response.status);
   const body=await response.json(),fee=readFee(body.teleport_price);
   if(String(body.prop_id)!==id||fee===undefined)throw Error('Missing verified fee');
   records[id]={fee,at:now()};failures=0;
  }catch{failures++;await sleep(Math.min(60000,3000*2**(failures-1)));}
  if(requests%100===0)console.log(JSON.stringify({event:'fees',requests,cached:Object.keys(records).length}));
 }
 return {records,requests,rateLimits,retryAt,consecutiveFailures:failures};
}
async function scoringCore(){
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
  const asset=release.assets.filter(a=>new RegExp('^rankings-'+cityId+'-[0-9]+-[0-9]+\\.json\\.gz$').test(a.name)).sort((a,b)=>b.name.localeCompare(a.name,undefined,{numeric:true}))[0];
  if(!asset)return {};
  gh('release','download','current-data','--pattern',asset.name,'--dir',dir,'--clobber');
  return JSON.parse(gunzipSync(await readFile(join(dir,asset.name))).toString('utf8')).fees??{};
 }catch(error){console.error(JSON.stringify({event:'fee-cache-unavailable',error:error.message}));return {};}
}
async function main(){
 const cityId=process.env.CITY_ID;if(!/^[1-9]\d{0,8}$/.test(cityId??''))throw Error('Invalid city');
 const dir=resolve(process.env.OUTPUT_DIR??'output');await mkdir(dir,{recursive:true});
 const city=JSON.parse(await readFile(process.env.CITY_DATA_FILE,'utf8'));
 if(!city.complete||city.cityId!==cityId||!Array.isArray(city.properties))throw Error('Only complete matching city datasets can be processed');
 const {scoreCity}=await scoringCore();
 const rows=scoreCity(city.properties).filter(p=>p.sendable!==false&&p.hotspotScore>0);
 // Match the extension's bounded fee candidate pool. Publish partial coverage
 // explicitly: these are shortcuts, never a claim of the globally cheapest parcel.
 const candidates=[...rows].sort((a,b)=>compareRows(a,b,'maximum-coverage')).slice(0,1000);
 const feeBudget=Number(process.env.FEE_MAX_REQUESTS??1000);if(!Number.isInteger(feeBudget)||feeBudget<0||feeBudget>1000)throw Error('Invalid fee request budget');
 const feeResult=await collectFees(candidates.map(p=>p.propertyId),{records:await previousFees(cityId,dir),maxRequests:feeBudget});
 if(feeResult.retryAt>Date.now())await new Promise(r=>setTimeout(r,feeResult.retryAt-Date.now()));
 const result={...buildRankings(rows,{fees:feeResult.records}),cityId,sourceFetchedAt:city.fetchedAt,fees:feeResult.records,feeRequestBudget:feeBudget,feeRequests:feeResult.requests,feeRateLimits:feeResult.rateLimits,feeRetryAt:feeResult.retryAt,feeScope:'highest-coverage-1000-candidates',fullDatasetRequiredForStarredSearch:true};
 const stamp=(process.env.GITHUB_RUN_ID??Date.now())+'-'+(process.env.GITHUB_RUN_ATTEMPT??'1'),assetName='rankings-'+cityId+'-'+stamp+'.json.gz';
 const raw=Buffer.from(JSON.stringify(result)),compressed=gzipSync(raw,{level:6});await writeFile(join(dir,assetName),compressed);
 const manifest={status:result.feeCoverage.complete?'ready':'partial-fees',assetName,encoding:'gzip',bytes:compressed.length,sha256:createHash('sha256').update(raw).digest('hex'),compressedSha256:createHash('sha256').update(compressed).digest('hex'),feeCoverage:result.feeCoverage,feeScope:result.feeScope,modes:MODES,primaryCount:result.primaryCount,reserveCount:result.reserveCount,preselectionOnly:true};
 await writeFile(join(dir,'rankings-manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({event:'rankings-ready',cityId,...manifest}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
