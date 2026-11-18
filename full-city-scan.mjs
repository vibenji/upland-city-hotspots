// Wibenji — temporary full-city scan benchmark, bundled from Toolbox 3.1.7.
const deadlineModule=(()=>{
// A late reply cannot settle the caller again. Timers/listeners release on every exit.
function withDeadline(work,{timeoutMs=8000,label='Request',setTimeout:defer=globalThis.setTimeout,clearTimeout:clear=globalThis.clearTimeout,signal}={}){
 return new Promise((resolve,reject)=>{
  let done=false,timer;
  const finish=(fn,value)=>{if(done)return;done=true;if(timer!==undefined)clear(timer);signal?.removeEventListener('abort',abort);fn(value);};
  const abort=()=>finish(reject,Object.assign(Error(`${label} cancelled.`),{code:'cancelled'}));
  if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
  timer=defer(()=>finish(reject,Object.assign(Error(`${label} timed out.`),{code:'timeout'})),timeoutMs);
  Promise.resolve().then(work).then(value=>finish(resolve,value),error=>finish(reject,error));
 });
}

// Only for idempotent reads; never wrap a craft or another mutation with this.
async function readWithDeadline(read,options={}){
 try{return await withDeadline(read,options);}catch(error){if(error?.code!=='timeout')throw error;}
 return withDeadline(read,options);
}

return {withDeadline};})();
const journalModule=(()=>{const {withDeadline}=deadlineModule;

// A deadline ends the caller's wait; it cannot cancel a Chrome storage write.
// Keep the raw promise as the barrier for all later reads/writes/cleanup.
function createCityMapStorage(storage,deadlineOptions={}){
 let tail=Promise.resolve(),pending=0;
 const enqueue=work=>{pending++;const raw=tail.then(work);tail=raw.then(()=>{pending--;},()=>{pending--;});return raw;};
 return {
  get:keys=>withDeadline(async()=>{await tail;return storage.get(keys);},{timeoutMs:typeof keys==='string'&&/^troveCityMapV1:\d+$/.test(keys)?60000:15000,label:pending?'Waiting for previous city map write to finish':'City map storage read',...deadlineOptions}),
  set:values=>{const raw=enqueue(()=>storage.set(values));return withDeadline(()=>raw,{timeoutMs:20000,label:'City map chunk or progress save',...deadlineOptions});},
  ...(storage.remove?{remove:keys=>enqueue(()=>storage.remove(keys))}:{})
 };
}

// Append-only city data. A small manifest is committed only after every new
// chunk is durable, so a failed write cannot advance the pending tile.
const PREFIX='troveCityMapV1:';
const PART_CHARS=16384,WRITE_PARTS=4,READ_PARTS=64;
const validCity=id=>typeof id==='string'&&/^[1-9]\d{0,8}$/.test(id);
function createCityMapJournal(storage,{onProgress=()=>{}}={}){
 const committedRefs=new Map();
 const references=s=>[...(s?.completedBatches??[]),...(s?.work?.propertyBatches??[]),...(s?.work?.regionBatch?[s.work.regionBatch]:[])];
 const keyFor=(city,batch,index)=>PREFIX+city+':chunk:'+batch.id+':'+index;
 const writeBatch=async(city,value,label)=>{
  const json=JSON.stringify(value),batch={id:crypto.randomUUID(),parts:Math.ceil(json.length/PART_CHARS)};
  for(let i=0;i<batch.parts;i+=WRITE_PARTS){
   onProgress(city,label+' · '+Math.min(i+WRITE_PARTS,batch.parts)+'/'+batch.parts+' chunks');
   const values={};for(let j=i;j<Math.min(i+WRITE_PARTS,batch.parts);j++)values[keyFor(city,batch,j)]={version:1,part:json.slice(j*PART_CHARS,(j+1)*PART_CHARS)};
   await storage.set(values);
  }
  return batch;
 };
 const readBatch=async(city,batch)=>{
  if(!batch||!/^[-a-f0-9]{36}$/.test(batch.id)||!Number.isInteger(batch.parts)||batch.parts<1||batch.parts>100000)throw Error('Invalid city map chunk manifest. Saved data was not changed.');
  const parts=[];
  for(let i=0;i<batch.parts;i+=READ_PARTS){
   onProgress(city,'Reading saved city data · '+Math.min(i+READ_PARTS,batch.parts)+'/'+batch.parts+' chunks');
   const keys=Array.from({length:Math.min(READ_PARTS,batch.parts-i)},(_,j)=>keyFor(city,batch,i+j)),values=await storage.get(keys);
   for(const key of keys){const record=values[key];if(record?.version!==1||typeof record.part!=='string')throw Error('Missing or invalid city map chunk: '+key+'. Saved data was not changed.');parts.push(record.part);}
  }
  try{return JSON.parse(parts.join(''));}catch{throw Error('Invalid city map chunk JSON. Saved data was not changed.');}
 };
 const readRows=async(city,batches)=>{
  if(!Array.isArray(batches))throw Error('Invalid city map property manifest.');
  const byId=new Map();for(const batch of batches){const rows=await readBatch(city,batch);if(!Array.isArray(rows))throw Error('Invalid city map property chunk.');for(const row of rows){if(typeof row?.propertyId!=='string'||!Array.isArray(row.sources))throw Error('Invalid saved city map property.');byId.set(row.propertyId,row);}}
  return [...byId.values()];
 };
 return {
  async read(city){
   if(!validCity(city))throw Error('Invalid current city.');const saved=(await storage.get(PREFIX+city))[PREFIX+city];
   committedRefs.set(city,references(saved));
   if(!saved||saved.chunkedVersion==null)return saved;
   if(saved.chunkedVersion!==1)throw Error('Unsupported city map storage version.');
   saved.completed=await readRows(city,saved.completedBatches);
   if(saved.work){saved.work.properties=await readRows(city,saved.work.propertyBatches);saved.work.regions=await readBatch(city,saved.work.regionBatch);if(!Array.isArray(saved.work.regions))throw Error('Invalid saved city boundaries.');}
   return saved;
  },
  async snapshot(city){return (await storage.get(PREFIX+city))[PREFIX+city];},
  async save(s,{rows=[],summary=null}={}){
   const city=s.cityId;if(!validCity(city))throw Error('Invalid current city.');
   let completedBatches=s.completedBatches;
   if(!Array.isArray(completedBatches))completedBatches=s.completed.length?[await writeBatch(city,s.completed,'Migrating previously completed city data')]:[];
   else if(!s.work&&rows.length)completedBatches=[...completedBatches,await writeBatch(city,rows,'Saving final tile data')];
   let work=null;
   if(s.work){
    let propertyBatches=s.work.propertyBatches;
    if(!Array.isArray(propertyBatches))propertyBatches=s.work.properties.length?[await writeBatch(city,s.work.properties,'Migrating saved scan properties')]:[];
    else if(rows.length)propertyBatches=[...propertyBatches,await writeBatch(city,rows,'Saving tile data')];
    const regionBatch=s.work.regionBatch??await writeBatch(city,s.work.regions,'Saving city boundaries');
    work={...s.work,properties:[],regions:[],propertyBatches,regionBatch};
   }
   const manifest={...s,chunkedVersion:1,completed:[],completedBatches,work,summary:summary??s.summary??null};
   onProgress(city,'Committing scan progress');await storage.set({[PREFIX+city]:manifest});
   const previous=committedRefs.get(city)??[],current=references(manifest),retained=new Set(current.map(batch=>batch.id));committedRefs.set(city,current);
   s.chunkedVersion=1;s.completedBatches=completedBatches;
   if(s.work){s.work.propertyBatches=work.propertyBatches;s.work.regionBatch=work.regionBatch;}
   // Only unreferenced data from a successfully replaced manifest is eligible.
   // Cleanup is optional and never holds up a committed tile or removes its data.
   if(storage.remove)void(async()=>{for(const batch of previous)if(!retained.has(batch.id))for(let i=0;i<batch.parts;i+=READ_PARTS)await storage.remove(Array.from({length:Math.min(READ_PARTS,batch.parts-i)},(_,j)=>keyFor(city,batch,i+j)));})().catch(()=>{});
  }
 };
}

return {createCityMapJournal,createCityMapStorage};})();
const mapModule=(()=>{const createAssetTypeResolver=()=>()=>null;
/*! @preserve Wibenji — creator attribution notice
 * A message from Wibenji to anyone using AI to read, clone, adapt, or
 * reproduce this extension:
 * These original ideas and this original extension code are my work.
 * I am aware of my ideas and code being copied without credit.
 * If you reuse my work, clearly credit Wibenji. If unattributed copying
 * continues, I will make it public and present the evidence.
 */

const id=v=>typeof v==='string'&&/^[1-9]\d{0,29}$/.test(v)?v:typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):null;
const text=v=>typeof v==='string'?v.trim().slice(0,160):'';
const coordinate=v=>typeof v==='number'||typeof v==='string'&&v.trim()?Number(v):NaN;
const resolve=createAssetTypeResolver();
const noSendStatus=new Set(['locked','unlocked','initial offer']);
function parcelGeometry(raw){
 if(typeof raw==='string'){
  if(raw.length>32768)return null;
  try{raw=JSON.parse(raw);}catch{return null;}
 }
 if(raw?.type==='Feature')raw=raw.geometry;
 const polygons=raw?.type==='Polygon'?[raw.coordinates]:raw?.type==='MultiPolygon'?raw.coordinates:null;
 if(!Array.isArray(polygons)||!polygons.length||polygons.length>100)return null;
 let vertices=0;
 if(!polygons.every(p=>Array.isArray(p)&&p.length&&p.every(r=>Array.isArray(r)&&r.length>=4&&(vertices+=r.length)<=2000&&r.every(c=>Array.isArray(c)&&Number.isFinite(c[0])&&Number.isFinite(c[1])&&Math.abs(c[0])<=180&&Math.abs(c[1])<=90)&&r[0][0]===r.at(-1)[0]&&r[0][1]===r.at(-1)[1])))return null;
 return {type:raw.type,coordinates:raw.coordinates};
}
function cityNeighborhoods(raw,cityId){
 if(!Array.isArray(raw)||raw.length>20000)throw Error('Unsupported neighborhood response.');
 const result=[];
 for(const row of raw){
  if(id(row.city_id??row.city?.id)!==cityId)continue;
  let g=row.boundaries;try{if(typeof g==='string')g=JSON.parse(g);}catch{throw Error('Invalid city boundaries.');}
  if(g?.type==='Feature')g=g.geometry;
  if(!['Polygon','MultiPolygon'].includes(g?.type)||!Array.isArray(g.coordinates))throw Error('Missing city boundaries.');
  const polygons=g.type==='Polygon'?[g.coordinates]:g.coordinates;
  if(!polygons.length||polygons.some(p=>!Array.isArray(p)||!p.length||p.some(r=>!Array.isArray(r)||r.length<4||r.some(c=>!Array.isArray(c)||!Number.isFinite(c[0])||!Number.isFinite(c[1])||Math.abs(c[0])>180||Math.abs(c[1])>85))))throw Error('Invalid city boundaries.');
  const points=polygons.flat(2),bounds={north:-85,south:85,east:-180,west:180};
  for(const [lng,lat] of points){bounds.north=Math.max(bounds.north,lat);bounds.south=Math.min(bounds.south,lat);bounds.east=Math.max(bounds.east,lng);bounds.west=Math.min(bounds.west,lng);}
  if(bounds.north<=bounds.south||bounds.east<=bounds.west)throw Error('Invalid city bounds.');
  result.push({name:text(row.name),polygons,bounds});
 }
 if(!result.length)throw Error('No published neighborhood boundaries found for this city.');
 return result;
}
const inBounds=(b,lat,lng)=>lat>=b.south&&lat<=b.north&&lng>=b.west&&lng<=b.east;
function inRing(x,y,ring){
 let inside=false;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const [xi,yi]=ring[i],[xj,yj]=ring[j],cross=(x-xi)*(yj-yi)-(y-yi)*(xj-xi);
  if(Math.abs(cross)<1e-12&&x>=Math.min(xi,xj)&&x<=Math.max(xi,xj)&&y>=Math.min(yi,yj)&&y<=Math.max(yi,yj))return true;
  if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;
 }return inside;
}
const inPolygon=(x,y,rings)=>inRing(x,y,rings[0])&&!rings.slice(1).some(ring=>inRing(x,y,ring));

// Clip the segment's parameter interval against the open rectangle.
function segmentInsideTile(a,b,tile){
 let from=0,to=1;
 for(const [axis,low,high] of [[0,tile.west,tile.east],[1,tile.south,tile.north]]){
  const delta=b[axis]-a[axis];
  if(delta===0){if(a[axis]<=low||a[axis]>=high)return false;continue;}
  const start=(low-a[axis])/delta,end=(high-a[axis])/delta;
  from=Math.max(from,Math.min(start,end));
  to=Math.min(to,Math.max(start,end));
  if(from>=to)return false;
 }
 return true;
}

function tileIntersectsCity(tile,regions){
 const x=(tile.west+tile.east)/2,y=(tile.south+tile.north)/2;
 return regions.some(({bounds,polygons})=>{
  if(tile.east<=bounds.west||tile.west>=bounds.east||tile.north<=bounds.south||tile.south>=bounds.north)return false;
  return polygons.some(rings=>inPolygon(x,y,rings)||rings.some(ring=>
   ring.some((point,i)=>segmentInsideTile(point,ring[(i+1)%ring.length],tile))
  ));
 });
}

function mapProperties(rows,cityId,regions,{includeLandings=false}={}){
 const result=new Map();
 for(const row of rows){
  const propertyId=id(row?.prop_id);if(!propertyId)continue;
  const explicitCity=id(row.city_id??row.city?.id),lat=coordinate(row.centerlat??row.lat),lng=coordinate(row.centerlng??row.lng);
  if(explicitCity&&explicitCity!==cityId)continue;
  const region=regions.find(r=>inBounds(r.bounds,lat,lng)&&r.polygons.some(p=>inPolygon(lng,lat,p)));
  if(!region)continue;
  if(!Array.isArray(row.models)||row.models.length>20000)throw Error('Map response has no readable model list; scan paused.');
  const sendable=!row.terminal_id&&!noSendStatus.has(text(row.status).toLowerCase());
  const sources=new Map();
  for(const model of row.models){
   const sourceInstanceId=id(model?.propModelID);
   if(!sourceInstanceId)continue;
   const isPlant=model.modelType==='plant';
   const isService=model.modelType==='building'&&model.subType==='service'&&model.constructionStatus==='completed';
   if(!isPlant&&!isService)continue;
   const sourceKind=isPlant?'plant':'structure';
   const sourceModel=text(sourceKind==='plant'?model.lods?.[0]?.modelUrl??model.model:model.model),type=resolve({propertyId,sourceInstanceId,sourceKind,sourceModel});
   const modelLat=coordinate(model.lat),modelLng=coordinate(model.lng);
   const position=validHotspotPosition(modelLat,modelLng)?{lat:modelLat,lng:modelLng}:{};
   sources.set(sourceKind+':'+sourceInstanceId,{sourceKind,sourceInstanceId,sourceModel,sourceTypeName:'',...(sourceKind==='structure'&&id(model.nftID)?{nativeUrl:'https://play.upland.me/nft/structures/'+id(model.nftID)+'/structure/recipe'}:{}),...type,...position,collectible:true,readyAt:0});
  }
  if(!sources.size&&(!includeLandings||!sendable))continue;
  const geometry=sources.size&&includeLandings?parcelGeometry(row.boundaries):null;
  const address=text(row.full_address);
  result.set(propertyId,{propertyId,cityId,lat,lng,address,...(sendFee(row.teleport_price)!==undefined?{sendFee:sendFee(row.teleport_price)}:{}),neighborhood:region?.name??'',sources:[...sources.values()],...(!sendable?{sendable:false}:{}),...(geometry?{geometry}:{}),...(sources.size?{label:address||'Property '+propertyId,url:'https://play.upland.me/?prop_id='+propertyId,readyAt:0,lastActionAt:0,cycles:[]}:{})});
 }
 return [...result.values()];
}
function mergeMapProperties(personal=[],scanned=[],{preferScannedModel=false}={}){
 const result=new Map(personal.map(p=>[p.propertyId,p]));
 for(const map of scanned){
  const old=result.get(map.propertyId);if(old?.cityId&&String(old.cityId)!==map.cityId)continue;
  if(!old&&map.lastActionAt===0&&map.sources.length&&map.sources.every(s=>s.collectible&&(s.readyAt??0)>=map.readyAt)&&map.sources.some(s=>(s.readyAt??0)===map.readyAt)){result.set(map.propertyId,map);continue;}
  const timers=new Map((old?.sources??[]).map(s=>[s.sourceKind+':'+s.sourceInstanceId,s]));
  const sources=map.sources.filter(s=>s.collectible).map(s=>({...s,...timers.get(s.sourceKind+':'+s.sourceInstanceId),...(old?.propertyCooldownReadyAt?{readyAt:Math.max(old.propertyCooldownReadyAt,timers.get(s.sourceKind+':'+s.sourceInstanceId)?.readyAt??s.readyAt??0)}:{}),...(preferScannedModel?{sourceModel:s.sourceModel}:{})}));
  if(!sources.length)continue;
  result.set(map.propertyId,{...map,...old,cityId:map.cityId,label:old?.label||map.label,sources,readyAt:Math.min(...sources.map(s=>s.readyAt??0)),lastActionAt:old?.lastActionAt??0});
 }
 return [...result.values()];
}
const HOTSPOT_RADIUS=60;
const PLANTS_PER_STRUCTURE=50;
function hotspotSettings(preferences={}){
 const rate=preferences.hotspotPlantsPerStructure;
 return {hotspotIgnorePlants:preferences.hotspotIgnorePlants===true,hotspotPlantsPerStructure:Number.isSafeInteger(rate)&&rate>0?rate:PLANTS_PER_STRUCTURE,hotspotCalculation:['maximum-coverage','balanced','lowest-fees'].includes(preferences.hotspotCalculation)?preferences.hotspotCalculation:'maximum-coverage'};
}
// Only verified fee fields enter this normalizer; listing prices are unrelated.
function sendFee(value){
 if(typeof value!=='number'&&(typeof value!=='string'||!value.trim()))return undefined;
 const fee=Number(value);return Number.isFinite(fee)&&fee>=0?fee:undefined;
}
function compareHotspots(a,b,preferences={}){
 const as=a.hotspotScore??0,bs=b.hotspotScore??0;
 const productive=Number(bs>0)-Number(as>0);if(productive)return productive;
 const af=sendFee(a.sendFee),bf=sendFee(b.sendFee),mode=preferences.hotspotCalculation;
 const known=Number(af===undefined)-Number(bf===undefined);
 let order=0;
 if(mode==='balanced'||mode==='lowest-fees'){
  if(known)return known;
  if(af!==undefined&&bf!==undefined){
   if(mode==='lowest-fees')order=af-bf;
   else if(af===0||bf===0)order=Number(bf===0)-Number(af===0);
   else order=bs/Math.sqrt(bf)-as/Math.sqrt(af);
  }
 }
 return order||bs-as||known||(af!==undefined&&bf!==undefined?af-bf:0)||(a.hotspotDistance??0)-(b.hotspotDistance??0)||a.propertyId.localeCompare(b.propertyId);
}
const EARTH_RADIUS=6371008.8;
const MAX_CHORD_SQUARED=(2*EARTH_RADIUS*Math.sin(HOTSPOT_RADIUS/(2*EARTH_RADIUS)))**2;
const radians=degrees=>degrees*Math.PI/180;
const validHotspotPosition=(lat,lng)=>Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=85.051129&&Math.abs(lng)<=180;
const deadPlant=s=>s.sourceKind==='plant'&&typeof s.sourceModel==='string'&&/_Dead(?=\/|\.gl(?:tf|b)$|$)/i.test(s.sourceModel.split(/[?#]/,1)[0]);
const hotspotCollectible=s=>s.collectible&&!deadPlant(s);
function hotspotPosition(lat,lng){
 const a=radians(lat),b=radians(lng),r=EARTH_RADIUS*Math.cos(a);
 return [r*Math.cos(b),r*Math.sin(b),EARTH_RADIUS*Math.sin(a)];
}

// Accumulate whole plant units before converting to structure equivalents.
function hotspotPoints(property){
 const points=new Map();
 for(const source of property.sources??[]){
  if(!hotspotCollectible(source))continue;
  const location=validHotspotPosition(source.lat,source.lng)?source:property;
  const {lat,lng}=location;
  if(!validHotspotPosition(lat,lng))continue;
  const key=lng+','+lat,weight=source.sourceKind==='structure'?PLANTS_PER_STRUCTURE:1;
  const previous=points.get(key);
  if(previous)previous[2]+=weight;
  else points.set(key,[lng,lat,weight]);
 }
 return [...points.values()];
}

// Index in three-dimensional metres to share the distance rule across pathing modes.
function nearbySourcePoints(properties,pointsFor){
 const cells=new Map();
 const cellFor=point=>point.map(value=>Math.floor(value/HOTSPOT_RADIUS));
 for(const property of properties)for(const [lng,lat,weight,readyAt=0,source] of pointsFor(property)){
  const point=hotspotPosition(lat,lng),key=cellFor(point).join(',');
  if(!cells.has(key))cells.set(key,[]);
  cells.get(key).push({point,weight,readyAt,source,cityId:property.cityId,propertyId:property.propertyId});
 }
 return function* (property,excludedPropertyId){
  const point=hotspotPosition(property.lat,property.lng),[x,y,z]=cellFor(point);
  for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(let dz=-1;dz<=1;dz++){
   for(const other of cells.get(`${x+dx},${y+dy},${z+dz}`)??[]){
    if(other.cityId!==property.cityId||excludedPropertyId!==undefined&&other.propertyId===excludedPropertyId)continue;
    const distance=(point[0]-other.point[0])**2+(point[1]-other.point[1])**2+(point[2]-other.point[2])**2;
    if(distance<=MAX_CHORD_SQUARED)yield {weight:other.weight,readyAt:other.readyAt,distance,source:other.source};
   }
  }
 };
}

function nearbySourceWeight(properties,pointsFor){
 const nearby=nearbySourcePoints(properties,pointsFor);
 return (property,excludedPropertyId)=>{
  if(!validHotspotPosition(property.lat,property.lng))return null;
  let score=0;
  for(const {weight} of nearby(property,excludedPropertyId))score+=weight;
  return score;
 };
}

function cityMapHotspots(properties){
 const scoreNearby=nearbySourceWeight(properties,hotspotPoints);
 const rows=properties.flatMap(p=>{
  const score=scoreNearby(p);
  if(!score&&!p.sources.length)return [];
  const sources=p.sources.filter(hotspotCollectible),structures=sources.filter(s=>s.sourceKind==='structure'),plants=sources.filter(s=>s.sourceKind==='plant');
  const counts=new Map();for(const s of structures){const name=s.sourceTypeName||'Unknown structure';counts.set(name,(counts.get(name)??0)+1);}
  const url=p.url??'https://play.upland.me/?prop_id='+p.propertyId;
  return [{...p,label:p.label||p.address||'Property '+p.propertyId,url,readyAt:p.readyAt??0,lastActionAt:p.lastActionAt??0,cycles:p.cycles??[],hotspotScore:(score??PLANTS_PER_STRUCTURE*structures.length+plants.length)/PLANTS_PER_STRUCTURE,structureCount:structures.length,plantCount:plants.length,structureTypeCount:counts.size,troveCount:0,structures:[...counts].map(([name,count])=>({name,count})),propertyUrl:url}];
 });
 return rows.filter(p=>p.hotspotScore>0||p.sources.some(hotspotCollectible)).sort((a,b)=>b.hotspotScore-a.hotspotScore||b.structureTypeCount-a.structureTypeCount||a.propertyId.localeCompare(b.propertyId)).map((p,i)=>({...p,rank:i+1}));
}

function rankHotspotLandings(properties,at,starred=false,preferences,candidateIds=null){
 const {hotspotIgnorePlants,hotspotPlantsPerStructure}=hotspotSettings(preferences);
 const nearby=nearbySourcePoints(properties,p=>{
  const keys=starred?new Set(p.starredSourceKeys??[]):null;
  return p.sources.flatMap(s=>{
   if(!hotspotCollectible(s)||hotspotIgnorePlants&&s.sourceKind==='plant'||keys&&!keys.has(s.sourceKind+':'+s.sourceInstanceId))return [];
   const {lat,lng}=validHotspotPosition(s.lat,s.lng)?s:p;
   return validHotspotPosition(lat,lng)?[[lng,lat,s.sourceKind==='structure'?hotspotPlantsPerStructure:1,s.readyAt]]:[];
  });
 });
 const landings=properties.flatMap(p=>{
   if(candidateIds&&!candidateIds.has(p.propertyId))return [];
  if(p.sendable===false)return [];
  const deadOnly=p.sources.length>0&&p.sources.every(deadPlant);
  const hasLocalMatch=!deadOnly&&p.availableTroves?.some(t=>t.starred);
  if(!validHotspotPosition(p.lat,p.lng))return !deadOnly&&(!starred||hasLocalMatch)?[p]:[];
  let ready=0,refreshAt=Infinity,distance=0;
  for(const point of nearby(p)){
   if(point.readyAt>at)refreshAt=Math.min(refreshAt,point.readyAt);
   else{ready+=point.weight;distance+=point.distance*point.weight;}
  }
  if(!ready&&!Number.isFinite(refreshAt))return starred&&hasLocalMatch?[{...p,hotspotScore:0}]:[];
  return [{...p,hotspotScore:ready/hotspotPlantsPerStructure,hotspotDistance:distance,hotspotRefreshAt:Number.isFinite(refreshAt)?refreshAt:null,readyAt:ready?0:refreshAt}];
 });
 return landings.sort((a,b)=>compareHotspots(a,b,preferences)).map((p,i)=>({...p,rank:i+1}));
}

function rankNativeArrivals(properties,arrivals,at,starred,preferences,candidateIds=null){
 const {hotspotIgnorePlants,hotspotPlantsPerStructure}=hotspotSettings(preferences);
 const sourcesByProperty=new Map(properties.map(p=>{
  const keys=starred?new Set(p.starredSourceKeys??[]):null;
  return [p.propertyId,p.sources.filter(s=>hotspotCollectible(s)&&(!hotspotIgnorePlants||s.sourceKind!=='plant')&&(!keys||keys.has(s.sourceKind+':'+s.sourceInstanceId)))];
 }));
 const ranked=properties.flatMap(p=>{
   if(candidateIds&&!candidateIds.has(p.propertyId))return [];
  if(p.sendable===false)return [];
  let readyStructures=0,readyPlants=0,refreshAt=Infinity;
  for(const id of arrivals[p.propertyId]??[])for(const source of sourcesByProperty.get(id)??[]){
   const readyAt=source.readyAt??0;
   if(readyAt>at)refreshAt=Math.min(refreshAt,readyAt);
   else if(source.sourceKind==='plant')readyPlants++;
   else readyStructures++;
  }
  const score=readyStructures+readyPlants/hotspotPlantsPerStructure;
  if(!score&&!Number.isFinite(refreshAt))return [];
  return [{...p,nativeArrival:true,hotspotScore:score,hotspotRefreshAt:Number.isFinite(refreshAt)?refreshAt:null,readyAt:score?0:refreshAt}];
 });
 return ranked.sort((a,b)=>compareHotspots(a,b,preferences)).map((p,i)=>({...p,rank:i+1}));
}

return {cityNeighborhoods,mapProperties,cityMapHotspots,tileIntersectsCity};})();
const scanModule=(()=>{const {cityNeighborhoods,mapProperties,cityMapHotspots,tileIntersectsCity}=mapModule;const {createCityMapJournal}=journalModule;

const CITY_MAP_KEY='troveCityMapV1:';
const NEIGHBORHOODS='troveCityNeighborhoodsV1',INDEX='troveCityMapIndexV1',THROTTLE='troveCityMapThrottleV1';
const validCity=v=>typeof v==='string'&&/^[1-9]\d{0,8}$/.test(v);
// Leave headroom below the live test that returned data at 0.026° by 0.066°.
const MAX_LAT_SPAN = 0.025;
const MAX_LNG_SPAN = 0.060;

function limitNextTile(tiles) {
 const tile = tiles[0];
 const height = tile.north - tile.south;
 const width = tile.east - tile.west;
 if (height <= MAX_LAT_SPAN && width <= MAX_LNG_SPAN) return tile;

 const rows=Math.ceil(height/MAX_LAT_SPAN),columns=Math.ceil(width/MAX_LNG_SPAN),parts=[];
 for(let row=0;row<rows;row++)for(let column=0;column<columns;column++)parts.push({...tile,
  south:tile.south+height*row/rows,north:row===rows-1?tile.north:tile.south+height*(row+1)/rows,
  west:tile.west+width*column/columns,east:column===columns-1?tile.east:tile.west+width*(column+1)/columns});
 tiles.splice(0,1,...parts);return parts[0];
}

function cityWork(regions,startedAt){
 const bounds={north:-85,south:85,east:-180,west:180};
   for(const r of regions){bounds.north=Math.max(bounds.north,r.bounds.north);bounds.south=Math.min(bounds.south,r.bounds.south);bounds.east=Math.max(bounds.east,r.bounds.east);bounds.west=Math.min(bounds.west,r.bounds.west);}
 const pending=[{...bounds,depth:0}],tiles=[];
 while(pending.length){
  if(!tileIntersectsCity(pending[0],regions)){pending.shift();continue;}
  const tile=limitNextTile(pending);
  pending.shift();
  if(tileIntersectsCity(tile,regions))tiles.push(tile);
 }
 return {regions,tiles,properties:[],done:0,requests:0,startedAt};
}

const split=t=>{const lat=(t.north+t.south)/2,lng=(t.east+t.west)/2;return [{north:lat,south:t.south,east:lng,west:t.west},{north:lat,south:t.south,east:t.east,west:lng},{north:t.north,south:lat,east:lng,west:t.west},{north:t.north,south:lat,east:t.east,west:lng}].map(b=>({...b,depth:t.depth+1}));};
function createCityMapScan({storage,fetchImpl=(...args)=>fetch(...args),onUpdate=()=>{},onProgress=()=>{},now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 let queue=Promise.resolve();const pending=new Map(),cityViews=new Map(),checkpoints=new Map(),ownWrites=new Map(),loads=new Map();let retryAt=0;
 let lastProgressAt=0,lastProgressPhase='';
 const report=(cityId,phase)=>{const category=cityId+':'+phase.split(' · ',1)[0],at=now();if(category===lastProgressPhase&&at-lastProgressAt<500)return;lastProgressAt=at;lastProgressPhase=category;onProgress({cityId,phase,at});};
 const journal=createCityMapJournal(storage,{onProgress:report});
 const serial=fn=>{const work=queue.then(fn);queue=work.catch(()=>{});return work;};
 const get=async k=>(await storage.get(k))[k];
 let throttleReady=null;
 const restoreThrottle=()=>throttleReady??=(async()=>{const saved=await get(THROTTLE);if(Number.isFinite(saved?.retryAt))retryAt=Math.max(retryAt,saved.retryAt);})().catch(error=>{throttleReady=null;throw error;});
 const read=async cityId=>{if(!validCity(cityId))throw Error('Invalid current city.');if(checkpoints.has(cityId))return checkpoints.get(cityId);if(loads.has(cityId))return loads.get(cityId);
  const loading=(async()=>{const saved=await journal.read(cityId);
  if(saved?.boundaryScoped){checkpoints.set(cityId,saved);if(checkpoints.size>2)checkpoints.delete(checkpoints.keys().next().value);return saved;}
  // Older results have no coordinates, so their boundary membership cannot be verified.
  const work=saved?.work?.regions?.length?cityWork(saved.work.regions,now()):null;
  return {cityId,status:work?'paused':'idle',completed:[],work,boundaryScoped:true};})();
  loads.set(cityId,loading);try{return await loading;}finally{if(loads.get(cityId)===loading)loads.delete(cityId);}
 };
 const sourceProperties=properties=>properties.filter(p=>p.sources.length);
 const view=s=>{const properties=sourceProperties(s.work?s.work.properties:s.completed);return {cityId:s.cityId,status:s.status,remaining:s.work?.tiles.length??0,scannedTiles:(s.work?s.work.scannedTiles:s.scannedTiles)??[],nextTile:s.work?.tiles.length?s.work.tiles[0]:null,done:s.work?.done??s.done??0,requests:s.work?.requests??s.requests??0,parcels:(s.work?s.work.properties:s.completed).length,properties:properties.length,plants:properties.reduce((n,p)=>n+p.sources.filter(s=>s.sourceKind==='plant').length,0),structures:properties.reduce((n,p)=>n+p.sources.filter(s=>s.sourceKind==='structure').length,0),startedAt:s.work?.startedAt??s.startedAt,finishedAt:s.finishedAt??null,message:s.message??'',timings:s.timings??null,needsStart:s.preparing===true,requestDelayMs:s.requestDelayMs??250,retryAt:Math.max(retryAt,s.retryAt??0)};};
 const invalidateCity=(cityId,revision)=>{if(revision&&ownWrites.get(cityId)===revision)return;cityViews.delete(cityId);checkpoints.delete(cityId);};
 const save=async (s,rows=[])=>{
  report(s.cityId,'Saving scan checkpoint');const at=now();s.checkpointRevision=crypto.randomUUID();ownWrites.set(s.cityId,s.checkpointRevision);
  const {scannedTiles,nextTile,...summary}=view(s);
  try{await journal.save(s,{rows,summary});}catch(error){checkpoints.delete(s.cityId);throw error;}
  if(s.timings)s.timings.saveMs=now()-at;
  checkpoints.set(s.cityId,s);cityViews.delete(s.cityId);onUpdate(s.cityId,{status:s.status,terminal:s.retryExhausted===true,done:s.work?.done??s.done??0});return view(s);
 };
 const request=async (path,cityId)=>{
  // MV3 workers may be terminated if fetch headers take 30 seconds. Allow a
  // longer body download separately, without leaving a dead message channel.
  const controller=new AbortController();let phase='headers',timer=setTimer(()=>controller.abort(),25000);
  try{
   report(cityId,'Waiting for API response headers');
   const response=await fetchImpl('https://api.prod.upland.me/api/'+path,{method:'GET',credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal,headers:{accept:'application/json'}});
   report(cityId,'Downloading and decoding API response');
   clearTimer(timer);phase='body';timer=setTimer(()=>controller.abort(),60000);
   if(response.status===429||response.status===503){const value=response.headers?.get?.('Retry-After'),seconds=Number(value);if(value)retryAt=now()+Math.max(0,Number.isFinite(seconds)?seconds*1000:Date.parse(value)-now()||0);}
   if(!response.ok){
    let detail='';
    try{const body=await response.json(),message=body?.message??body?.error?.message??body?.error;if(typeof message==='string')detail=' '+message.trim().slice(0,300);}catch{}
    throw Object.assign(Error('Map API request failed (HTTP '+response.status+').'+detail),{status:response.status,retryable:[408,429,500,502,503,504].includes(response.status),smaller:[400,413,414,422].includes(response.status)});
   }
   try{return await response.json();}catch(error){if(controller.signal.aborted)throw error;throw Object.assign(Error('Map API returned invalid or truncated JSON: '+error.message),{smaller:true});}
  }catch(error){
   if(controller.signal.aborted)throw Object.assign(Error('Map API response timed out after '+(phase==='headers'?25:60)+' seconds ('+phase+').'),{retryable:true,smaller:true});
   if(error instanceof TypeError)throw Object.assign(Error('Map API network failure: '+error.message),{retryable:true});
   throw error;
  }
  finally{clearTimer(timer);}
 };
 const subdivide=s=>{
  const t=s.work?.tiles[0];
  if(!t||t.depth>=12||s.work.tiles.length>20000)return false;
  s.work.tiles.splice(0,1,...split(t).filter(tile=>tileIntersectsCity(tile,s.work.regions)));return true;
 };
 const recover=async(s,error)=>{
  s.status='paused';s.failures=(s.failures??0)+1;
  if(error.status===429)s.requestDelayMs=Math.min(5000,Math.max(1000,(s.requestDelayMs??250)*2));
  const reduced=error.smaller&&s.failures<6&&subdivide(s);
  s.retryAt=Math.max(retryAt,error.retryable?now()+Math.min(60000,3000*2**(s.failures-1)):0);
  if(error.retryable){retryAt=s.retryAt;await storage.set({[THROTTLE]:{retryAt}});}
  if(s.failures<6&&(reduced||error.retryable)){
   s.message=error.message+(reduced?' Retrying with smaller map tiles.':'')+(s.retryAt>now()?' Retrying in '+Math.ceil((s.retryAt-now())/1000)+' seconds.':'')+' Attempt '+s.failures+' of 6.';
   return save(s);
  }
  s.retryExhausted=true;s.message=error.message+(s.failures>=6?' Paused after 6 consecutive failures. Resume to try again.':' Scan paused.');
  // Preserve the original failure if saving the error checkpoint also fails.
  try{await save(s);}catch{}
  throw Error(s.message);
 };
 const allProperties=s=>{const byId=new Map(s.completed.map(p=>[p.propertyId,p]));for(const p of s.work?.properties??[])byId.set(p.propertyId,p);return [...byId.values()];};
 const cityView=cityId=>{
  if(cityViews.has(cityId))return cityViews.get(cityId);
  const work=read(cityId).then(s=>{
   if(s.status==='idle')return null;
   const properties=allProperties(s),hotspots=cityMapHotspots(properties),scanRevision=crypto.randomUUID();
   return {properties,hotspots,scanRevision,scan:view(s),status:s.status==='complete'?'ready':'partial',arrivals:null};
  }).catch(error=>{if(cityViews.get(cityId)===work)invalidateCity(cityId);throw error;});
  cityViews.set(cityId,work);
  if(cityViews.size>2)cityViews.delete(cityViews.keys().next().value);
  return work;
 };
 return {
  invalidateCity,
  snapshot:async cityId=>{
   if(!validCity(cityId))throw Error('Invalid current city.');
   if(checkpoints.has(cityId))return view(checkpoints.get(cityId));
   const saved=await journal.snapshot(cityId);
   if(saved?.chunkedVersion===1&&saved.summary)return {...saved.summary,scannedTiles:(saved.work?saved.work.scannedTiles:saved.scannedTiles)??[],nextTile:saved.work?.tiles[0]??null,retryAt:Math.max(retryAt,saved.retryAt??0)};
   return view(await read(cityId));
  },
  start:(cityId,{restart=false}={})=>serial(async()=>{
   await restoreThrottle();
   report(cityId,'Loading saved city scan');
   const s=await read(cityId);
   if(s.retryExhausted){s.failures=0;s.retryExhausted=false;}
   if(restart){s.restartRequested=true;s.preparing=true;}
   restart=restart||s.restartRequested===true;
   if(!s.work)s.preparing=true;
   if(Math.max(retryAt,s.retryAt??0)>now())return save(s);
   if(s.work&&!restart){s.status='paused';s.message='';return save(s);}
   s.preparing=true;
   try{
   let cached=await get(NEIGHBORHOODS);if(!cached||now()-cached.at>7*86400000){cached={at:now(),rows:await request('neighborhood',cityId)};cityNeighborhoods(cached.rows,cityId);await storage.set({[NEIGHBORHOODS]:cached});}
   s.work=cityWork(cityNeighborhoods(cached.rows,cityId),now());s.boundaryScoped=true;s.status='paused';s.message='';
   s.preparing=false;s.restartRequested=false;s.failures=0;s.retryAt=0;
   const index=await get(INDEX)??[];if(!index.includes(cityId))await storage.set({[INDEX]:[...index,cityId]});return await save(s);
   }catch(error){return recover(s,error);}
  }),
  step:cityId=>{
   if(pending.has(cityId))return pending.get(cityId);
   const work=serial(async()=>{
    report(cityId,'Reading saved scan checkpoint');
    await restoreThrottle();
    const s=await read(cityId);if(!s.work)return view(s);
    if(s.retryExhausted)throw Error(s.message);
    if(Math.max(retryAt,s.retryAt??0)>now())return view(s);
    let requesting=true,saving=false;
    try{
     const t=limitNextTile(s.work.tiles);s.work.requests++;
     const apiAt=now(),body=await request('map?'+new URLSearchParams({north:t.north,south:t.south,east:t.east,west:t.west,marker:'true'}),cityId),processingAt=now();
     report(cityId,'Processing returned map properties');
     requesting=false;
     let rows,clustered=false;
     if(Array.isArray(body))rows=body;
     else if(Array.isArray(body?.properties)){rows=body.properties;clustered=Number(body.total??body.count??0)>rows.length;}
     else if(Array.isArray(body?.clusters)){rows=body.clusters;clustered=true;}
     else throw Error('Unsupported Map response. Scan paused.');
     // CityRelease returned a complete 15,094-row array. Small dense areas do
     // not need repeated queries; subdivide only at a conservative large cap.
     const dense=clustered||rows.length>100000||rows.some(p=>p?.prop_id==null);
     let changedRows=[];
     if(dense){if(!subdivide(s))throw Error('Map remains incomplete at the scan limit.');}
     else{
      const properties=mapProperties(rows,cityId,s.work.regions,{includeLandings:true}),byId=new Map(s.work.properties.map(p=>[p.propertyId,p]));for(const p of properties)byId.set(p.propertyId,p);
      changedRows=properties;
      const updated=[...byId.values()];
      // City-wide record counts are not storage quotas. The journal saves
      // bounded tile deltas; real storage failures propagate from its writes.
      s.work.properties=updated;s.work.tiles.shift();s.work.done++;
      s.work.scannedTiles=[...(s.work.scannedTiles??[]).slice(-511),t];
     }
     s.failures=0;s.retryAt=0;s.requestDelayMs=Math.max(250,(s.requestDelayMs??250)-50);s.message='';s.status='paused';
     if(!s.work.tiles.length){
      s.completed=s.work.properties;
      s.completedBatches=s.work.propertyBatches;
      s.scannedTiles=s.work.scannedTiles;s.done=s.work.done;s.requests=s.work.requests;s.startedAt=s.work.startedAt;s.work=null;s.finishedAt=now();s.status='complete';
     }
     s.timings={apiMs:processingAt-apiAt,processingMs:now()-processingAt,saveMs:0};
     saving=true;return await save(s,changedRows);
    }catch(error){if(saving){checkpoints.delete(cityId);throw Error('City map checkpoint save failed: '+error.message+'. Resume waits for any pending disk write and reloads the last durable checkpoint.');}return recover(s,requesting?error:Error(error.message));}
   });
   pending.set(cityId,work);work.finally(()=>{if(pending.get(cityId)===work)pending.delete(cityId);}).catch(()=>{});return work;
  },
  city:async (cityId,{includeArrivals=false}={})=>{
   const cached=await cityView(cityId);
   if(!cached)return null;
   const {hotspots,scanRevision,scan,status}=cached;
   if(includeArrivals&&cached.arrivals===null){
    const hotspotIds=new Set(hotspots.map(p=>p.propertyId));
    cached.arrivals=cached.properties.filter(p=>p.sendable!==false&&!hotspotIds.has(p.propertyId));
   }
   return {id:cityId,name:'City '+cityId,status,localMap:true,hotspots,scanRevision,scan:{...scan,retryAt:Math.max(retryAt,scan.retryAt)},...(includeArrivals?{arrivalLandings:cached.arrivals}:{})};
  },
  hasLanding:async (cityId,propertyId)=>allProperties(await read(cityId)).some(p=>p.propertyId===propertyId&&p.sendable!==false),
  properties:async cityId=>{
   if(cityId)return sourceProperties(allProperties(await read(cityId)));
   const index=await get(INDEX)??[],cities=await Promise.all(index.map(read));
   return cities.flatMap(s=>sourceProperties(allProperties(s)));
  },
  cities:async()=>{const index=await get(INDEX)??[];return Promise.all(index.map(async cityId=>{const s=await read(cityId);return {id:cityId,name:'City '+cityId,localMap:true,status:s.status==='complete'?'ready':'partial',total:sourceProperties(allProperties(s)).length,hotspots:cityMapHotspots(allProperties(s))};}));}
 };
}

return {createCityMapScan};})();
const {createCityMapScan}=scanModule;const {createCityMapJournal}=journalModule;
// Wibenji — full-city GitHub feasibility experiment; not a production updater.
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const cityId=process.env.CITY_ID??'32';
if(!/^[1-9]\d{0,8}$/.test(cityId))throw Error('Invalid CITY_ID');
const preview=process.argv.includes('--preview'),smoke=process.argv.includes('--smoke');
const started=Date.now(),budgetMs=45*60*1000,maxRequests=2000;
const output=process.env.OUTPUT_DIR??'output';await mkdir(output,{recursive:true});
const values={},requests=[],stats={statuses:{},bytes:0,networkErrors:0};
const storage={get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(values[k])])),set:async rows=>{for(const [key,value]of Object.entries(rows))values[key]=structuredClone(value);}};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let lastProgress=0,summary=null,state=null,error=null;
const fixtureNeighborhood=[{city_id:Number(cityId),name:'Benchmark fixture',boundaries:JSON.stringify({type:'Polygon',coordinates:[[[0,0],[.008,0],[.008,.003],[0,.003],[0,0]]]})}];
const fixtureMap=[{prop_id:'123',city_id:Number(cityId),centerlat:.001,centerlng:.004,full_address:'Fixture',status:'owned',models:[{propModelID:'11',modelType:'plant',lat:.001,lng:.004,model:'plants/fixture/lod-0.gltf'}]}];
const fetchImpl=async(url,options)=>{
 if(requests.length>=maxRequests)throw Error('Benchmark request budget reached');
 const at=Date.now(),record={index:requests.length+1,kind:url.includes('/map?')?'map':'neighborhood',startedMs:at-started};requests.push(record);
 try{
  const response=smoke?new Response(JSON.stringify(record.kind==='map'?fixtureMap:fixtureNeighborhood),{status:200,headers:{'content-type':'application/json'}}):await fetch(url,options);
  record.status=response.status;record.retryAfter=response.headers.get('retry-after');stats.statuses[response.status]=(stats.statuses[response.status]??0)+1;
  return {ok:response.ok,status:response.status,headers:response.headers,json:async()=>{
   try{const raw=await response.text();record.bytes=Buffer.byteLength(raw);stats.bytes+=record.bytes;const data=JSON.parse(raw);const rows=Array.isArray(data)?data:data?.properties;record.rows=rows?.length??null;return data;}
   catch(cause){record.bodyError=cause.message;throw cause;}
   finally{record.durationMs=Date.now()-at;console.log(JSON.stringify({event:'request',...record}));}
  }};
 }catch(cause){stats.networkErrors++;record.error=cause.message;record.durationMs=Date.now()-at;console.log(JSON.stringify({event:'request',...record}));throw cause;}
};
const scanner=createCityMapScan({storage,fetchImpl,onProgress:progress=>{
 if(Date.now()-lastProgress<15000)return;lastProgress=Date.now();console.log(JSON.stringify({event:'phase',elapsedMs:Date.now()-started,phase:progress.phase}));
}});
let scanFinished=null,rankingMs=null,exportBytes=null,exportSha256=null,hotspots=null;
try{
 state=await scanner.start(cityId);
 console.log(JSON.stringify({event:'started',cityId,initialTiles:state.remaining,preview,smoke}));
 if(preview){console.log(JSON.stringify({event:'preview',cityId,state}));process.exit(0);}
 while(state.status!=='complete'){
  if(Date.now()-started>=budgetMs)throw Error('45-minute benchmark budget reached; city incomplete');
  if(requests.length>=maxRequests)throw Error('2000-request benchmark budget reached; city incomplete');
  const delay=Math.max(250,state.requestDelayMs??0,(state.retryAt??0)-Date.now());
  if(Date.now()+delay-started>=budgetMs)throw Error('Retry wait exceeds benchmark time budget; city incomplete');
  await sleep(delay);
  state=state.needsStart?await scanner.start(cityId):await scanner.step(cityId);
  console.log(JSON.stringify({event:'progress',elapsedMs:Date.now()-started,status:state.status,done:state.done,remaining:state.remaining,parcels:state.parcels,sourceProperties:state.properties,plants:state.plants,structures:state.structures,message:state.message,retryAt:state.retryAt}));
  if(state.status!=='complete'&&!state.remaining&&!state.needsStart)throw Error('No pending work without completion');
 }
 scanFinished=Date.now();
 const rankingStarted=Date.now(),city=await scanner.city(cityId,{includeArrivals:true});rankingMs=Date.now()-rankingStarted;hotspots=city.hotspots.length;
 const saved=await createCityMapJournal(storage).read(cityId);
 const data=JSON.stringify({schemaVersion:1,provider:'WibenjiTroveScanExperiment',cityId,fetchedAt:new Date().toISOString(),complete:true,typeNameEnrichment:false,personalCooldowns:false,properties:saved.completed});
 exportBytes=Buffer.byteLength(data);exportSha256=createHash('sha256').update(data).digest('hex');await writeFile(output+'/city-'+cityId+'.json',data);
}catch(cause){error=cause.message;try{state=await scanner.snapshot(cityId);}catch{}}
finally{
 summary={experiment:'full-city-scan-v1',cityId,smoke,githubActions:process.env.GITHUB_ACTIONS==='true',startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),complete:state?.status==='complete'&&!error,elapsedMs:Date.now()-started,scanMs:scanFinished?scanFinished-started:null,rankingMs,httpRequests:requests.length,mapRequests:requests.filter(r=>r.kind==='map').length,httpStatuses:stats.statuses,rateLimits:stats.statuses[429]??0,serviceUnavailable:stats.statuses[503]??0,networkErrors:stats.networkErrors,decodedResponseBytes:stats.bytes,exportBytes,exportSha256,hotspots,scan:state,error,storageAdapter:'in-memory structured-clone journal; excludes Chrome disk latency',typeNameEnrichment:false};
 await writeFile(output+'/metrics.json',JSON.stringify(summary,null,2));await writeFile(output+'/requests.json',JSON.stringify(requests,null,2));console.log('FINAL_METRICS '+JSON.stringify(summary));
 if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,'\n### Full city scan benchmark\n\n~~~json\n'+JSON.stringify(summary,null,2)+'\n~~~\n');
}
if(!summary.complete)process.exitCode=1;
