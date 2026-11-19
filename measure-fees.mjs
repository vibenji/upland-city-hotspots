// Wibenji — bounded runner-side rate test; no TLS bypass and no limit evasion.
import {appendFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {collectBasisFees,waitForFeeRetry} from './build-lists.mjs';
const base='https://github.com/vibenji/upland-city-hotspots/releases/download/current-data/';
const response=await fetch(base+'index.json?t='+Date.now());if(!response.ok)throw Error('Cannot read published index');const index=await response.json(),r=index.cities.find(c=>c.id==='9')?.rankings;
const throttleResponse=await fetch(base+'fee-throttle.json?t='+Date.now());let externalRetryAt=0;if(throttleResponse.ok){externalRetryAt=(await throttleResponse.json()).retryAt??0;}else if(throttleResponse.status!==404)throw Error('Cannot verify shared fee throttle: HTTP '+throttleResponse.status);
await waitForFeeRetry(index,{externalRetryAt});
const asset=await fetch(r.url);if(!asset.ok)throw Error('Cannot read benchmark property IDs');const compressed=Buffer.from(await asset.arrayBuffer());if(createHash('sha256').update(compressed).digest('hex')!==r.compressedSha256)throw Error('Benchmark asset checksum mismatch');const ids=Object.keys(JSON.parse(gunzipSync(compressed)).fees).slice(0,72);
if(ids.length<72)throw Error('Not enough verified public IDs for rate test');
const measurements=[];let retryAt=0;
for(const [i,profile]of [{concurrency:4,intervalMs:100},{concurrency:8,intervalMs:50},{concurrency:16,intervalMs:25}].entries()){
 const started=Date.now(),result=await collectBasisFees(ids.slice(i*24,i*24+24),{...profile,budgetMs:45000,maxRequests:24});
 const elapsedMs=Date.now()-started,successful=Object.keys(result.records).length;
 const measurement={...profile,requests:result.requests,successful,elapsedMs,perSecond:successful/(elapsedMs/1000),rateLimits:result.rateLimits,errors:result.errors};measurements.push(measurement);console.log(JSON.stringify({event:'bounded-rate-measurement',...measurement}));
 retryAt=Math.max(retryAt,result.retryAt);if(result.rateLimits||result.retryAt)break;
}
if(retryAt>Date.now()){const file='fee-throttle.json';await writeFile(file,JSON.stringify({schemaVersion:1,retryAt,observedAt:Date.now(),source:'bounded-rate-measurement'}));execFileSync('gh',['release','upload','current-data',file,'--clobber','--repo','vibenji/upland-city-hotspots'],{stdio:['ignore','pipe','pipe'],timeout:120000});}
const successful=measurements.filter(m=>m.successful===24&&!m.rateLimits&&!Object.keys(m.errors).length).sort((a,b)=>b.perSecond-a.perSecond),best=successful[0];
if(!best)throw Error('No valid runner-side HTTP benchmark; refusing to invent a working rate: '+JSON.stringify(measurements));
if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,'concurrency='+best.concurrency+'\ninterval='+best.intervalMs+'\nretry_at='+retryAt+'\n');
if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,'\n## Bounded fee rate measurement\n```json\n'+JSON.stringify({measurements,selected:best},null,2)+'\n```\n');
