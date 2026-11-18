// Wibenji — ordered daily public city scans. Preserve creator attribution.
import {readFile,writeFile,mkdir,appendFile,rm} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const REPO='vibenji/upland-city-hotspots',TAG='current-data';
const priority=['9','32','35'];
export function orderCities(rows,names=[]){
 const labels=new Map(names.map(c=>[String(c.id),c.name]));
 const ids=[...new Set(rows.map(r=>String(r.city_id??r.city?.id??'')).filter(id=>/^[1-9]\d{0,8}$/.test(id)))];
 return [...priority.filter(id=>ids.includes(id)),...ids.filter(id=>!priority.includes(id)).sort((a,b)=>Number(a)-Number(b))].map(id=>({id,name:labels.get(id)??({'9':'Bakersfield','32':'Los Angeles','35':'Las Vegas'}[id])??'City '+id}));
}
export function mergeIndex(old,record){
 const next=structuredClone(old??{schemaVersion:1,cities:[]});next.cities??=[];
 const i=next.cities.findIndex(c=>c.id===record.id),previous=next.cities[i];
 const sameSnapshot=previous?.dataset?.url&&previous.dataset.url===record.dataset?.url;
 const value=record.complete?{...record,...(previous?.complete?{previous:sameSnapshot?previous.previous:{dataset:previous.dataset,fetchedAt:previous.fetchedAt,rankings:previous.rankings}}:{})}:previous?.complete?{...previous,lastAttempt:record}:record;
 if(i<0)next.cities.push(value);else next.cities[i]=value;
 next.updatedAt=new Date().toISOString();return next;
}
export function selectCatalog(primary,backup,{initialized=false}={}){
 const valid=[];
 for(const candidate of [primary,backup]){
  try{const value=typeof candidate==='string'?JSON.parse(candidate):candidate;if(value?.schemaVersion===1&&Array.isArray(value.cities))valid.push(value);}catch{}
 }
 if(valid.length){const result=structuredClone(valid[0]);for(const city of valid[1]?.cities??[]){const i=result.cities.findIndex(c=>c.id===city.id);if(i<0)result.cities.push(city);else if(city.complete&&!result.cities[i].complete)result.cities[i]={...city,lastAttempt:result.cities[i]};}return result;}
 if(initialized)throw Error('Established city catalog unavailable; refusing to erase previous city pointers');
 return {schemaVersion:1,cities:[]};
}
function gh(...args){return execFileSync('gh',[...args,'--repo',REPO],{encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']}).trim();}
async function ensureRelease(tag=TAG){try{gh('release','view',tag);}catch{gh('release','create',tag,'--title',tag===TAG?'Current public city data':tag,'--notes','Wibenji public city scans. Full datasets are retained separately from preselection rankings.','--prerelease');}}
async function readAsset(name,dir,tag=TAG){
 const release=JSON.parse(gh('release','view',tag,'--json','assets'));
 if(!release.assets.some(a=>a.name===name))return null;
 await mkdir(dir,{recursive:true});gh('release','download',tag,'--pattern',name,'--dir',dir,'--clobber');
 return readFile(join(dir,name),'utf8');
}
async function upload(files,tag=TAG){gh('release','upload',tag,...files,'--clobber');}
const assetUrl=(name,tag=TAG)=>'https://github.com/'+REPO+'/releases/download/'+tag+'/'+name;
async function catalog(dir){
 const primary=await readAsset('index.json',join(dir,'catalog'));
 const backup=await readAsset('index-backup.json',join(dir,'catalog'));
 const assets=JSON.parse(gh('release','view',TAG,'--json','assets')).assets;
 return selectCatalog(primary,backup,{initialized:assets.some(a=>a.name!=='plan.json')});
}
async function updateIndex(record,dir){
 const old=await catalog(dir);
 const index=mergeIndex(old,record);await mkdir(dir,{recursive:true});
 const backup=join(dir,'index-backup.json');await writeFile(backup,JSON.stringify(old,null,2));await upload([backup]);
 const file=join(dir,'index.json');await writeFile(file,JSON.stringify(index,null,2));await upload([file]);return index;
}
async function discover(){
 await ensureRelease();
 const r=await fetch('https://api.prod.upland.me/api/neighborhood',{headers:{accept:'application/json'},signal:AbortSignal.timeout(60000)});
 if(!r.ok)throw Error('City discovery HTTP '+r.status);
 let names=[];try{names=JSON.parse(await readFile('city-names.json','utf8'));}catch{}
 const cities=orderCities(await r.json(),names);
 if(!priority.every(id=>cities.some(c=>c.id===id)))throw Error('Priority city boundaries missing; refusing reordered scan');
 const batches=[];for(let i=3;i<cities.length;i+=6)batches.push({batch:batches.length,ids:cities.slice(i,i+6).map(c=>c.id).join(',')});
 const notScannable=names.filter(c=>!cities.some(city=>city.id===c.id)).map(c=>({...c,status:'no-published-neighborhood-boundaries'}));
 const plan={schemaVersion:1,createdAt:new Date().toISOString(),priority,cities,notScannable,batches,runId:process.env.GITHUB_RUN_ID??'local'};
 await mkdir('reports',{recursive:true});await writeFile('reports/plan.json',JSON.stringify(plan,null,2));await upload(['reports/plan.json']);
 if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,'matrix='+JSON.stringify({include:batches})+'\n');
 console.log(JSON.stringify({event:'plan',cities:cities.length,priority,batches:batches.length}));
}
function runNode(file,env){return new Promise((accept,reject)=>{const child=spawn(process.execPath,[file],{stdio:'inherit',env:{...process.env,...env}});child.on('error',reject);child.on('exit',code=>code===0?accept():reject(Error('Worker exit '+code)));});}
async function scanCity(city){
 const dir=resolve('reports/city-'+city.id);await mkdir(dir,{recursive:true});
 const attempt={id:city.id,name:city.name,complete:false,status:'scanning',startedAt:new Date().toISOString()};
 await updateIndex(attempt,dir);console.log(JSON.stringify({event:'city-start',...attempt}));
 try{
  await runNode(resolve('full-city-scan.mjs'),{CITY_ID:city.id,OUTPUT_DIR:dir});
  const metrics=JSON.parse(await readFile(join(dir,'metrics.json'),'utf8'));
  if(!metrics.complete||metrics.scan.remaining!==0)throw Error('City worker did not complete');
  const raw=await readFile(join(dir,'city-'+city.id+'.json'));
  if(createHash('sha256').update(raw).digest('hex')!==metrics.exportSha256)throw Error('City checksum mismatch');
  const stamp=(process.env.GITHUB_RUN_ID??Date.now())+'-'+(process.env.GITHUB_RUN_ATTEMPT??'1');
  const name='city-'+city.id+'-'+stamp+'.json.gz',compressed=gzipSync(raw,{level:6});await writeFile(join(dir,name),compressed);
  const metricsName='metrics-'+city.id+'-'+stamp+'.json';await writeFile(join(dir,metricsName),JSON.stringify(metrics,null,2));
  const dataTag='city-data-'+metrics.finishedAt.slice(0,10);await ensureRelease(dataTag);await upload([join(dir,name),join(dir,metricsName)],dataTag);
  const record={id:city.id,name:city.name,complete:true,status:'ready',fetchedAt:metrics.finishedAt,parcels:metrics.scan.parcels,sourceProperties:metrics.scan.properties,plants:metrics.scan.plants,structures:metrics.scan.structures,scanMs:metrics.scanMs,requests:metrics.httpRequests,rateLimits:metrics.rateLimits,dataset:{url:assetUrl(name,dataTag),encoding:'gzip',bytes:compressed.length,decodedBytes:raw.length,sha256:metrics.exportSha256,compressedSha256:createHash('sha256').update(compressed).digest('hex'),allParcels:true},metricsUrl:assetUrl(metricsName,dataTag),rankings:{status:'pending'}};
  await updateIndex(record,dir);
  console.log(JSON.stringify({event:'city-published',id:city.id,parcels:record.parcels,dataset:record.dataset.url}));
  // The first all-city run can adopt the processor being completed in parallel.
  // Only this repository owner's public main branch is used; its hash is logged.
  if(process.env.LIVE_PROCESSOR==='true'){
   try{const response=await fetch('https://raw.githubusercontent.com/'+REPO+'/main/build-lists.mjs',{signal:AbortSignal.timeout(30000)});
   if(response.ok){const code=await response.text(),processor=join(dir,'build-lists.mjs');console.log(JSON.stringify({event:'processor-source',sha256:createHash('sha256').update(code).digest('hex')}));await writeFile(processor,code);
    try{await runNode(processor,{CITY_ID:city.id,CITY_DATA_FILE:join(dir,'city-'+city.id+'.json'),OUTPUT_DIR:dir,SCAN_SOURCE:resolve('full-city-scan.mjs'),RECORD_FILE:join(dir,'record.json')});
     const rankings=JSON.parse(await readFile(join(dir,'rankings-manifest.json'),'utf8'));await upload([join(dir,rankings.assetName)],dataTag);record.rankings={...rankings,url:assetUrl(rankings.assetName,dataTag)};await updateIndex(record,dir);
    }catch(error){console.error(JSON.stringify({event:'rankings-pending',id:city.id,error:error.message}));}
   }else if(response.status!==404)console.error('Processor unavailable: HTTP '+response.status);
   }catch(error){console.error(JSON.stringify({event:'rankings-pending',id:city.id,error:error.message}));}
  }
  if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,'\n- '+city.name+': '+record.parcels+' parcels, '+Math.round(metrics.elapsedMs/1000)+' seconds, '+metrics.httpRequests+' requests, '+metrics.rateLimits+' rate limits. [Full data]('+record.dataset.url+')\n');
  await rm(join(dir,'city-'+city.id+'.json'));await rm(join(dir,name));
  return true;
 }catch(error){await updateIndex({...attempt,status:'failed',finishedAt:new Date().toISOString(),error:error.message},dir);console.error(JSON.stringify({event:'city-failed',id:city.id,error:error.message}));return false;}
}
async function rebuild(){
 const dir=resolve('reports/rebuild');await mkdir(dir,{recursive:true});
 const index=await catalog(dir);let failed=0;
 for(const record of index.cities.filter(c=>c.complete&&c.rankings?.status==='pending')){
  try{
   const url=new URL(record.dataset.url),parts=url.pathname.split('/');
   if(url.hostname!=='github.com'||parts.slice(1,5).join('/')!==REPO+'/releases/download')throw Error('Unexpected dataset URL');
   const tag=parts[5],name=parts[6];gh('release','download',tag,'--pattern',name,'--dir',dir,'--clobber');
   const {gunzipSync}=await import('node:zlib'),raw=gunzipSync(await readFile(join(dir,name)));
   if(createHash('sha256').update(raw).digest('hex')!==record.dataset.sha256)throw Error('Rebuild data checksum mismatch');
   const file=join(dir,'city-'+record.id+'.json');await writeFile(file,raw);
   await runNode(resolve('build-lists.mjs'),{CITY_ID:record.id,CITY_DATA_FILE:file,OUTPUT_DIR:dir,SCAN_SOURCE:resolve('full-city-scan.mjs')});
   const rankings=JSON.parse(await readFile(join(dir,'rankings-manifest.json'),'utf8')),dataTag='city-data-'+record.fetchedAt.slice(0,10);await ensureRelease(dataTag);await upload([join(dir,rankings.assetName)],dataTag);
   await updateIndex({...record,rankings:{...rankings,url:assetUrl(rankings.assetName,dataTag)}},dir);
   await rm(file);await rm(join(dir,name));console.log(JSON.stringify({event:'rankings-backfilled',id:record.id}));
  }catch(error){failed++;console.error(JSON.stringify({event:'backfill-failed',id:record.id,error:error.message}));}
 }
 if(failed)throw Error(failed+' pending cities could not be rebuilt');
}
async function scanBatch(){
 const text=await readAsset('plan.json',resolve('reports/discovery'));if(!text)throw Error('No city plan published');
 const plan=JSON.parse(text),ids=(process.env.CITY_IDS??'9,32,35').split(',');let failed=0;
 for(const id of ids){const city=plan.cities.find(c=>c.id===id);if(!city)throw Error('Unknown planned city '+id);if(!await scanCity(city))failed++;}
 if(failed)throw Error(failed+' city scans failed; last valid data retained');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{if(process.argv[2]==='discover')await discover();else if(process.argv[2]==='rebuild')await rebuild();else await scanBatch();}catch(error){console.error(error.message);process.exitCode=1;}
}
