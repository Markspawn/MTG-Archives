import {test,expect} from "@playwright/test";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {writeFileSync} from "node:fs";
import sharp from "sharp";

function database<T>(body:string):T {
  const app=process.env.MTG_ENGLISH_BULK_TEST_CONTAINER??"";
  if(process.env.MTG_ENGLISH_BULK_TEST!=="1"||!/^[a-f0-9]{64}$/.test(app))throw Error("Explicit isolated English bulk fixture required");
  const state=JSON.parse(execFileSync("docker",["inspect",app],{encoding:"utf8",windowsHide:true}))[0];
  if(state.Config.Labels["mtg.archive.owner"]!=="english-bulk-confirm-20261121")throw Error("Wrong fixture owner");
  return JSON.parse(execFileSync("docker",["exec","-i",app,"node"],{encoding:"utf8",windowsHide:true,timeout:30000,
    input:`const {PrismaClient,Prisma}=require('@prisma/client'),fs=require('fs'),crypto=require('crypto');const p=new PrismaClient();(async()=>{const u=new URL(process.env.DATABASE_URL);if(u.hostname!=='mtg-english-bulk-db'||u.pathname!=='/review_english_bulk')throw Error('Wrong fixture database');${body}})().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect());`}));
}

test("English batch bulk confirms noisy-language scans and preserves other choices",async({page,baseURL},testInfo)=>{
  test.skip(process.env.MTG_ENGLISH_BULK_TEST!=="1","Requires this task's isolated synthetic review runtime");
  expect(baseURL).toBe("http://127.0.0.1:13345");test.setTimeout(120000);
  const tag=`english-bulk-${randomUUID()}`,password=randomUUID(),headers={origin:baseURL!};
  const english={id:tag+'-en',name:'English bulk fixture',setCode:'tst',collectorNumber:'1',lang:'en',imageUri:null,finishes:['nonfoil']};
  const foreign={...english,id:tag+'-fr',name:'French printing fixture',lang:'fr'};
  const etched={...english,id:tag+'-etched',name:'Finish choice fixture',finishes:['foil','etched']};
  database(`const n=${JSON.stringify(tag)};await p.$transaction(async tx=>{await tx.player.create({data:{id:n,name:n,displayName:n}});await tx.user.create({data:{id:n,username:n,displayName:n,playerId:n,passwordHash:await require('bcryptjs').hash(${JSON.stringify(password)},10)}});await tx.inventoryLocation.create({data:{id:n,name:'English bulk review box',normalizedName:n,ownerPlayerId:n,type:'Box',storageLayout:{capacity:20,sections:[{name:'A',capacity:20}]}}});for(const card of ${JSON.stringify([english,foreign,etched])})await tx.card.create({data:{...card,scryfallId:crypto.randomUUID(),typeLine:'Creature',rarity:'common'}});});return true;`);
  await page.goto('/login');await page.getByLabel(/username or email/i).fill(tag);await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole('button',{name:'Log in',exact:true}).click();await page.waitForURL(/\/dashboard/);
  const created=await page.request.post('/api/acquisition',{headers,data:{requestKey:randomUUID(),locationId:tag,section:'A',quantity:6}});
  expect(created.ok(),await created.text()).toBe(true);const batch=(await created.json()).id as string,endpoint=`/api/acquisition/${batch}/review`;
  const defaults={finish:'NONFOIL',condition:'NM',language:'en'};
  const chosen=await page.request.post(endpoint,{headers,data:{action:'defaults',revision:0,defaults}});expect(chosen.ok(),await chosen.text()).toBe(true);
  const bytes=await sharp({create:{width:300,height:420,channels:3,background:'#335577'}}).jpeg().toBuffer(),photos:string[]=[];
  for(let i=0;i<6;i++){
    const reserved=await page.request.post(`/api/acquisition/${batch}`,{headers,data:{action:'reserve',requestKey:randomUUID()}});expect(reserved.ok()).toBe(true);const {slot}=await reserved.json();
    const uploaded=await page.request.post(`/api/acquisition/${batch}/photos?slot=${slot.id}&key=${randomUUID()}&generation=${slot.generation}&inputKind=CARD_SCAN`,{headers:{...headers,'content-type':'image/jpeg'},data:bytes});
    expect(uploaded.ok(),await uploaded.text()).toBe(true);photos.push((await uploaded.json()).id);
  }
  // Controlled persisted recognition evidence; no native OCR/accuracy claim.
  database(`const batch=${JSON.stringify(batch)},photos=${JSON.stringify(photos)},cards=${JSON.stringify([english,english,foreign,foreign,etched,null])},languages=['fr','ja','en','fr','fr','fr'];const run=await p.acquisitionRun.findUniqueOrThrow({where:{sessionId:batch}});if(await p.acquisitionProcessingJob.count({where:{runId:run.id,status:'RUNNING'}}))throw Error('Unexpected fixture worker');await p.acquisitionProcessingJob.updateMany({where:{runId:run.id,status:'PENDING'},data:{status:'FAILED',errorCode:'CONTROLLED_UI_FIXTURE'}});for(let i=0;i<photos.length;i++){const photo=await p.acquisitionPhoto.findUniqueOrThrow({where:{id:photos[i]}}),candidate=await p.acquisitionCandidate.findUniqueOrThrow({where:{runId_physicalId:{runId:run.id,physicalId:photo.slotId}}}),artifact=await p.acquisitionArtifact.findFirstOrThrow({where:{runId:run.id,sourceId:photo.id}});const proposals=cards[i]?[{card:cards[i],reasons:['TITLE_TEXT'],nameDistance:0}]:[];await p.acquisitionProcessingJob.create({data:{runId:run.id,candidateId:candidate.id,artifactId:artifact.id,candidateRevision:candidate.revision,stage:'photo-recognition-v1',versionKey:crypto.createHash('sha256').update(batch+i).digest('hex'),status:'COMPLETE',input:{photoId:photo.id,digest:photo.digest,manualAnalysis:null},output:{native:{geometry:{status:'PROPOSED'},orientations:[{rotationDegrees:0,text:{title:[cards[i]?.name??'Unknown'],footer:[languages[i].toUpperCase()]},lines:[]},{rotationDegrees:180,text:{title:[],footer:[]},lines:[]}]},proposals:{status:cards[i]?'CONFLICT':'NO_MATCH',automaticAcceptance:false,totalProposals:proposals.length,truncated:false,proposals,evidence:{setCodes:[],collectors:[],languages:[languages[i]]}}},createdAt:new Date(Date.now()+i)}});}return true;`);
  const savedRecord=await (await page.request.get(`${endpoint}?photoId=${photos[3]}`)).json();
  const manual=await page.request.post(endpoint,{headers,data:{action:'accept',photoId:photos[3],revision:savedRecord.revision,decision:{cardId:foreign.id,language:'fr',finish:'NONFOIL',condition:'LP'},evidenceTokens:{current:savedRecord.evidenceToken}}});
  expect(manual.ok(),await manual.text()).toBe(true);
  const before=database<any>(`const run=await p.acquisitionRun.findUniqueOrThrow({where:{sessionId:${JSON.stringify(batch)}}});return {candidates:await p.acquisitionCandidate.findMany({where:{runId:run.id},orderBy:{acquisitionOrder:'asc'},select:{id:true,review:true,revision:true,physicalId:true,countConfirmed:true,uncertainty:true,excluded:true}}),inventory:await p.inventoryItem.count()};`);
  const snapshot=()=>database<any>(`const tables=['InventoryItem','Card','AcquisitionPhoto','AcquisitionCaptureSlot','AcquisitionObservation','AcquisitionArtifact'];const result={};for(const table of tables){const q='SELECT count(*)::text AS count,md5(COALESCE(string_agg(row_to_json(t)::text,chr(31) ORDER BY row_to_json(t)::text),repeat(chr(32),0))) AS hash FROM "'+table+'" t';result[table]=await p.$queryRawUnsafe(q);}const originals=[];for(const id of ${JSON.stringify(photos)}){const photo=await p.acquisitionPhoto.findUniqueOrThrow({where:{id}}),data=fs.readFileSync(process.env.UPLOADS_DATA_PATH+'/acquisition-v1/'+id+'.original');const digest=crypto.createHash('sha256').update(data).digest('hex');if(digest!==photo.digest||data.length!==photo.bytes)throw Error('Original mismatch');originals.push({id,digest,bytes:data.length});}return {tables:result,originals};`);
  const sourceBefore=snapshot();
  const bodies:any[]=[];page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname===endpoint){const body=request.postDataJSON();if(body.action==='accept')bodies.push(body);}});
  await page.setViewportSize({width:1366,height:900});await page.goto(`/imports/scan?batch=${batch}`);
  const bulk=page.getByRole('region',{name:'Bulk match review',exact:true});
  await bulk.getByRole('button',{name:'Bulk Confirm Match',exact:true}).click();
  await expect(bulk.getByRole('button',{name:'Confirm 2 selected matches',exact:true})).toBeEnabled();
  await expect(bulk).toContainText('English batch: scan language warnings do not block bulk confirmation of English printings.');
  await expect(bulk).not.toContainText('The scan reports FR');
  await expect(bulk).toContainText('The proposed printing is FR');await expect(bulk).toContainText('Choose a finish supported');await expect(bulk).toContainText('No printing proposed');
  await bulk.getByRole('checkbox',{name:`Card 1: ${english.name}`,exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath('english-bulk-desktop.png')});
  await page.setViewportSize({width:390,height:844});await expect(bulk.getByRole('button',{name:'Confirm 2 selected matches',exact:true})).toBeEnabled();
  await page.screenshot({path:testInfo.outputPath('english-bulk-phone.png')});
  await page.setViewportSize({width:1366,height:900});await bulk.getByRole('button',{name:'Confirm 2 selected matches',exact:true}).click();
  await expect.poll(()=>database<number>(`return p.acquisitionCandidate.count({where:{run:{sessionId:${JSON.stringify(batch)}},review:{not:Prisma.DbNull}}});`)).toBe(3);
  expect(bodies).toHaveLength(2);expect(bodies.map(body=>body.decision.language)).toEqual(['en','en']);
  for(const body of bodies){const response=await page.request.post(endpoint,{headers,data:body});expect(response.ok(),await response.text()).toBe(true);expect((await response.json()).replay).toBe(true);}
  const after=database<any>(`const run=await p.acquisitionRun.findUniqueOrThrow({where:{sessionId:${JSON.stringify(batch)}}});return {candidates:await p.acquisitionCandidate.findMany({where:{runId:run.id},orderBy:{acquisitionOrder:'asc'},select:{id:true,review:true,revision:true,physicalId:true,countConfirmed:true,uncertainty:true,excluded:true}}),inventory:await p.inventoryItem.count()};`);
  expect(after.inventory).toBe(before.inventory);
  for(let i=0;i<6;i++){
    if(i<2){const {review,revision,...physical}=after.candidates[i],{review:oldReview,revision:oldRevision,...oldPhysical}=before.candidates[i];expect(physical).toEqual(oldPhysical);expect(revision).toBe(oldRevision+1);expect(review.language).toBe('en');expect(review.cardId).toBe(english.id);expect(oldReview).toBeNull();}
    else expect(after.candidates[i]).toEqual(before.candidates[i]);
  }
  const current=await (await page.request.get(`/api/acquisition/${batch}`)).json();
  const frenchDefaults=await page.request.post(endpoint,{headers,data:{action:'defaults',revision:current.defaultsRevision,defaults:{...defaults,language:'fr'}}});expect(frenchDefaults.ok()).toBe(true);
  await page.reload();await bulk.getByRole('button',{name:'Bulk Confirm Match',exact:true}).click();
  await expect(bulk.getByRole('button',{name:'Confirm 0 selected matches',exact:true})).toBeDisabled();
  await expect(bulk).toContainText('The scan reports EN, conflicting with batch FR');
  const latest=await (await page.request.get(`/api/acquisition/${batch}`)).json();
  expect((await page.request.post(endpoint,{headers,data:{action:'defaults',revision:latest.defaultsRevision,defaults}})).ok()).toBe(true);
  const sourceAfter=snapshot();expect(sourceAfter).toEqual(sourceBefore);
  writeFileSync(testInfo.outputPath('conservation.json'),JSON.stringify({sourceBefore,sourceAfter,before,after,conserved:true},null,2));
  database(`fs.writeFileSync('/tmp/english-bulk-fixture.json',JSON.stringify({batch:${JSON.stringify(batch)},user:${JSON.stringify(tag)},photos:${JSON.stringify(photos)}}));return true;`);
});
