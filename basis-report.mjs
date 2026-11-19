// Wibenji — clearly scoped publication summary; full coverage stays distinct.
import {BASIS_VERSION,BASIS_RADIUS_METRES} from './build-lists.mjs';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
const dir='reports/basis-status';await mkdir(dir,{recursive:true});
const gh=(...args)=>execFileSync('gh',[...args,'--repo','vibenji/upland-city-hotspots'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000});
gh('release','download','current-data','--pattern','index.json','--dir',dir,'--clobber');
const index=JSON.parse(await readFile(dir+'/index.json','utf8'));
const cities=index.cities.map(c=>({id:c.id,name:c.name,mapComplete:c.complete===true&&c.dataset?.allParcels===true,feeScope:c.rankings?.feeScope,basisCoverage:c.rankings?.basisCoverage??null,fullCandidateCoverage:c.rankings?.feeCoverage??null,basisReady:c.complete===true&&!!c.rankings?.url&&(c.rankings?.feeCoverage?.complete===true||c.rankings?.basisVersion===BASIS_VERSION&&c.rankings?.basisRadiusMetres===BASIS_RADIUS_METRES&&c.rankings?.basisCoverage?.complete===true)}));
const report={schemaVersion:1,generatedAt:new Date().toISOString(),basis:'published index metadata; not an independent full-payload freshness audit',scope:'Top 500 coverage targets plus at most one nearest landing within 40m per leading 250; full city maps remain intact',complete:cities.length>0&&cities.every(c=>c.basisReady),cities};
const markdown='# Wibenji · Fast basis publication\n\n'+cities.filter(c=>c.basisReady).length+'/'+cities.length+' cities have complete published maps and fee coverage for the stated basis. This does not claim every eligible city landing has a current fee.\n\n'+report.scope+'. Known fee facts are retained until refreshed.\n\n| City | Full map | Basis ready | Fee scope | Basis fees | All candidates (fresh) |\n|---|---|---|---|---|---|\n'+cities.map(c=>'| '+[c.name,c.mapComplete?'yes':'no',c.basisReady?'yes':'no',c.feeScope,c.basisCoverage?c.basisCoverage.known+'/'+c.basisCoverage.total:'full coverage',c.fullCandidateCoverage?c.fullCandidateCoverage.known+'/'+c.fullCandidateCoverage.total:'unknown'].join(' | ')+' |').join('\n')+'\n';
await writeFile(dir+'/basis-status.json',JSON.stringify(report,null,2));await writeFile(dir+'/basis-status.md',markdown);
gh('release','upload','current-data',dir+'/basis-status.json',dir+'/basis-status.md','--clobber');gh('release','edit','current-data','--notes-file',dir+'/basis-status.md');
if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,markdown);
console.log(JSON.stringify({event:'basis-publication-summary',ready:cities.filter(c=>c.basisReady).length,total:cities.length,complete:report.complete}));if(!report.complete)process.exitCode=1;
