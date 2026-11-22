import {test,expect} from "@playwright/test";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {writeFileSync} from "node:fs";

function database<T>(body:string):T {
  const app=process.env.MTG_BATCH_STATE_CONTAINER??"";
  if(process.env.MTG_BATCH_STATE_TEST!=="1"||!/^[a-f0-9]{64}$/.test(app))throw Error("Explicit isolated batch-state fixture required");
  const state=JSON.parse(execFileSync("docker",["inspect",app],{encoding:"utf8",windowsHide:true}))[0];
  if(state.Config.Labels["mtg.archive.owner"]!=="batch-state-infographic-20261122")throw Error("Wrong fixture owner");
  return JSON.parse(execFileSync("docker",["exec","-i",app,"node","-r","tsx/cjs"],{encoding:"utf8",windowsHide:true,timeout:30000,
    input:`const {PrismaClient}=require('@prisma/client'),fs=require('fs'),crypto=require('crypto');const p=new PrismaClient();(async()=>{const u=new URL(process.env.DATABASE_URL);if(u.hostname!=='mtg-batch-state-db'||u.pathname!=='/review_batch_state')throw Error('Wrong fixture database');${body}})().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect());`}));
}

test("existing batch entries show exact state colors and refresh their whole-batch counts",async({page,baseURL},testInfo)=>{
  test.skip(process.env.MTG_BATCH_STATE_TEST!=="1","Requires this task's separate local review");
  expect(baseURL).toBe("http://127.0.0.1:13375");test.setTimeout(150000);
  const tag="batch-bar-ui-"+randomUUID(),password=randomUUID();
  const fixture=database<any>(`const seed=require('./scripts/verify-acquisition-batch-state.ts').seedBatchStateFixture;const f=await seed(p,${JSON.stringify(tag)});await p.user.update({where:{id:f.ids[0]},data:{passwordHash:await require('bcryptjs').hash(${JSON.stringify(password)},10)}});const source=await p.acquisitionPhoto.findFirstOrThrow({where:{runId:{notIn:f.captures.map(c=>c.runId)},ready:true,purgedAt:null}});const original=process.env.UPLOADS_DATA_PATH+'/acquisition-v1/';const rows=await p.acquisitionPhoto.findMany({where:{runId:{in:f.captures.map(c=>c.runId)}}});for(const photo of rows){fs.copyFileSync(original+source.id+'.original',original+photo.id+'.original');await p.acquisitionPhoto.update({where:{id:photo.id},data:{bytes:source.bytes,digest:source.digest,mediaType:source.mediaType,width:source.width,height:source.height}});await p.acquisitionArtifact.updateMany({where:{runId:photo.runId,sourceId:photo.id},data:{digest:source.digest}});}for(const job of await p.acquisitionProcessingJob.findMany({where:{runId:f.captures[0].runId},include:{artifact:true}}))await p.acquisitionProcessingJob.update({where:{id:job.id},data:{input:{photoId:job.artifact.sourceId,digest:source.digest}}});return f;`);
  const batch=fixture.captures[0];
  const snapshot=()=>database<any>(`const result={};for(const table of ['InventoryItem','Card','AcquisitionPhoto','AcquisitionCaptureSlot','AcquisitionObservation','AcquisitionArtifact'])result[table]=await p.$queryRawUnsafe('SELECT count(*)::text AS count,md5(COALESCE(string_agg(row_to_json(t)::text,chr(31) ORDER BY row_to_json(t)::text),repeat(chr(32),0))) AS hash FROM "'+table+'" t');const originals=[];for(const photo of await p.acquisitionPhoto.findMany({where:{ready:true,purgedAt:null},orderBy:{id:'asc'}})){const bytes=fs.readFileSync(process.env.UPLOADS_DATA_PATH+'/acquisition-v1/'+photo.id+'.original'),digest=crypto.createHash('sha256').update(bytes).digest('hex');if(digest!==photo.digest||bytes.length!==photo.bytes)throw Error('Original changed');originals.push({id:photo.id,digest,bytes:bytes.length});}return{tables:result,originals};`);
  const before=snapshot();
  await page.setViewportSize({width:1366,height:900});await page.goto('/login');
  await page.getByLabel(/username or email/i).fill(fixture.ids[0]);await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole('button',{name:'Log in',exact:true}).click();await page.waitForURL(/\/dashboard/);
  await page.goto('/imports/batches?view=all&q='+batch.batchNumber);
  const entry=page.getByRole('article',{name:'Batch '+batch.batchNumber,exact:true});
  const graphic=entry.getByRole('figure',{name:'Batch card states',exact:true});
  const counts=()=>graphic.locator('[role="img"] [data-state]').evaluateAll(nodes=>Object.fromEntries(nodes.map(n=>[(n as HTMLElement).dataset.state,Number((n as HTMLElement).dataset.count)])));
  await expect(graphic).toContainText('100 saved cards');
  expect(await counts()).toEqual({queued:20,evaluated:30,confirmed:25,inventory:23,ignored:2});
  const widths=await graphic.locator('[role="img"] [data-state]').evaluateAll(nodes=>nodes.map(n=>(n as HTMLElement).style.width));
  expect(widths).toEqual(['20%','30%','25%','23%','2%']);
  await expect(entry).toContainText('Batch state review box');await expect(entry).toContainText('A');
  await expect(entry.getByRole('link',{name:'Open batch',exact:true})).toHaveAttribute('href','/imports/scan?batch='+batch.sessionId);
  await expect(entry.getByRole('button',{name:'Cancel batch',exact:true})).toBeVisible();
  await expect(entry.getByRole('button',{name:'Move to Trash',exact:true})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'Batch pages'})).toContainText('Page 1 of 1');
  await expect(page.getByRole('checkbox',{name:'Update automatically',exact:true})).toBeChecked();
  await entry.scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath('batch-states-desktop.png'),fullPage:true});
  database(`const f=${JSON.stringify(fixture)};const photo=await p.acquisitionPhoto.findUniqueOrThrow({where:{id:f.entries[0].photoId}});await p.acquisitionProcessingJob.create({data:{runId:f.captures[0].runId,candidateId:f.entries[0].candidateId,artifactId:f.entries[0].artifactId,candidateRevision:0,stage:'photo-printing-evidence-v1',versionKey:'ui-transition',status:'COMPLETE',input:{photoId:photo.id,digest:photo.digest}}});return true;`);
  await page.getByRole('button',{name:'Refresh batches',exact:true}).click();
  await expect.poll(counts).toEqual({queued:19,evaluated:31,confirmed:25,inventory:23,ignored:2});
  database(`const f=${JSON.stringify(fixture)};await p.acquisitionCandidate.update({where:{id:f.entries[20].candidateId},data:{review:{cardId:f.cardId,finish:'NONFOIL',condition:'NM',language:'en',actorId:f.ids[0]}}});return true;`);
  await expect.poll(counts,{timeout:30000,intervals:[1000]}).toEqual({queued:19,evaluated:30,confirmed:26,inventory:23,ignored:2});
  expect(Object.values(await counts()).reduce((a,b)=>a+b,0)).toBe(100);
  for(const width of [1366,320]){
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(graphic).toContainText('Ignored');
    await entry.scrollIntoViewIfNeeded();
    await page.screenshot({path:testInfo.outputPath('batch-states-updated-'+width+'.png'),fullPage:true});
  }
  const after=snapshot();expect(after).toEqual(before);
  writeFileSync(testInfo.outputPath('conservation.json'),JSON.stringify({before,after,conserved:true,states:await counts(),manualAndAutomaticRefresh:true},null,2));
  database(`fs.writeFileSync('/tmp/batch-state-ui-fixture.json',JSON.stringify(${JSON.stringify({batch:batch.sessionId,user:fixture.ids[0]})}));return true;`);
});
