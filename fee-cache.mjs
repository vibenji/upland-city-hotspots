// Wibenji — recoverable public fee checkpoint; data slots precede their pointer.
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {makeFeeCache,validateFeeCache} from './fee-state.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function createFeeCacheStore(cityId,{load,save}){
 if(!/^[1-9]\d{0,8}$/.test(cityId))throw Error('Invalid fee cache city');
 const pointerName='fees-'+cityId+'-checkpoint.json',backupName='fees-'+cityId+'-checkpoint-backup.json';let current=null;
 const slotName=slot=>'fees-'+cityId+'-cache-'+slot+'.json.gz';
 const decode=(compressed,at)=>{const raw=gunzipSync(compressed,{maxOutputLength:80000000}),value=JSON.parse(raw.toString('utf8')),records=validateFeeCache(value,cityId,at);return {value,records,sha256:sha(raw),compressedSha256:sha(compressed)};};
 return {
  async load(at=Date.now()){
   let lastError=null;
   for(const name of [pointerName,backupName])try{
    const bytes=await load(name);if(!bytes)continue;const pointer=JSON.parse(bytes.toString('utf8'));
    if(pointer.schemaVersion!==1||pointer.cityId!==cityId||!['a','b'].includes(pointer.slot))throw Error('Invalid fee checkpoint pointer');
    const compressed=await load(slotName(pointer.slot));if(!compressed||sha(compressed)!==pointer.compressedSha256)throw Error('Fee checkpoint compressed checksum mismatch');
    const decoded=decode(compressed,at);if(decoded.sha256!==pointer.sha256)throw Error('Fee checkpoint checksum mismatch');current=pointer;return decoded.records;
   }catch(error){lastError=error;}
   // gh --clobber can remove a pointer before its upload fails. Each gzip slot
   // also carries a complete city/schema/timestamp validated cache, including CRC.
   const candidates=[];
   for(const slot of ['a','b'])try{const bytes=await load(slotName(slot));if(bytes){const decoded=decode(bytes,at);candidates.push({slot,...decoded});}}catch(error){lastError=error;}
   candidates.sort((a,b)=>Date.parse(b.value.updatedAt)-Date.parse(a.value.updatedAt)||Object.keys(b.records).length-Object.keys(a.records).length);
   if(candidates.length){const best=candidates[0];current={schemaVersion:1,cityId,slot:best.slot,sha256:best.sha256,compressedSha256:best.compressedSha256};return best.records;}
   if(lastError)throw lastError;current=null;return {};
  },
  async save(records,at=Date.now(),progress={}){
   const value=makeFeeCache(cityId,records,at);validateFeeCache(value,cityId,at);
   const slot=current?.slot==='a'?'b':'a',raw=Buffer.from(JSON.stringify(value)),compressed=gzipSync(raw,{level:6});
   const pointer={schemaVersion:1,cityId,slot,updatedAt:value.updatedAt,records:Object.keys(records).length,sha256:sha(raw),compressedSha256:sha(compressed),...progress};
   await save(slotName(slot),compressed);
   if(current)await save(backupName,Buffer.from(JSON.stringify(current,null,2)));
   await save(pointerName,Buffer.from(JSON.stringify(pointer,null,2)));current=pointer;return pointer;
  }
 };
}
