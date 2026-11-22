import {test,expect} from "@playwright/test";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {writeFileSync} from "node:fs";
import sharp from "sharp";

function database<T>(body:string):T {
  const app=process.env.MTG_IGNORE_TEST_CONTAINER??"";
  if(process.env.MTG_IGNORE_TEST!=="1"||!/^[a-f0-9]{64}$/.test(app))throw Error("Explicit isolated Ignore fixture required");
  const state=JSON.parse(execFileSync("docker",["inspect",app],{encoding:"utf8",windowsHide:true}))[0];
  if(state.Config.Labels["mtg.archive.owner"]!=="ignore-scan-1050-20261122")throw Error("Wrong fixture owner");
  return JSON.parse(execFileSync("docker",["exec","-i",app,"node"],{encoding:"utf8",windowsHide:true,timeout:30000,
    input:`const {PrismaClient,Prisma}=require('@prisma/client'),fs=require('fs'),crypto=require('crypto');const p=new PrismaClient();(async()=>{const u=new URL(process.env.DATABASE_URL);if(u.hostname!=='mtg-ignore-db'||u.pathname!=='/review_ignore1050')throw Error('Wrong fixture database');${body}})().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>p.$disconnect());`}));
}

test("Ignore, Undo and Restore preserve saved choices and scans across desktop/phone reloads",async({page,baseURL},testInfo)=>{
  test.skip(process.env.MTG_IGNORE_TEST!=="1","Requires this task's isolated synthetic review runtime");
  expect(baseURL).toBe("http://127.0.0.1:13365");test.setTimeout(180000);
  const tag=`ignore-ui-${randomUUID()}`,password=randomUUID(),headers={origin:baseURL!};
  const card={id:tag+'-card',name:'Ignored scan fixture',setCode:'tst',collectorNumber:'1',lang:'en',imageUri:null,finishes:['nonfoil']};
  database(`const n=${JSON.stringify(tag)};await p.player.create({data:{id:n,name:n,displayName:n}});await p.user.create({data:{id:n,username:n,displayName:n,playerId:n,passwordHash:await require('bcryptjs').hash(${JSON.stringify(password)},10)}});await p.inventoryLocation.create({data:{id:n,name:'Ignore review box',normalizedName:n,ownerPlayerId:n,type:'Box',storageLayout:{capacity:20,sections:[{name:'A',capacity:20}]}}});await p.card.create({data:{...${JSON.stringify(card)},scryfallId:crypto.randomUUID(),typeLine:'Creature',rarity:'common'}});return true;`);
  await page.goto('/login');await page.getByLabel(/username or email/i).fill(tag);await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole('button',{name:'Log in',exact:true}).click();await page.waitForURL(/\/dashboard/);
  const created=await page.request.post('/api/acquisition',{headers,data:{requestKey:randomUUID(),locationId:tag,section:'A',quantity:3}});
  expect(created.ok(),await created.text()).toBe(true);const batch=(await created.json()).id as string,endpoint=`/api/acquisition/${batch}/review`;
  const photos:string[]=[];
  for(let i=0;i<3;i++){
    const bytes=await sharp({create:{width:300,height:420,channels:3,background:['#335577','#557733','#775533'][i]}}).jpeg().toBuffer();
    const reserved=await page.request.post(`/api/acquisition/${batch}`,{headers,data:{action:'reserve',requestKey:randomUUID()}});expect(reserved.ok()).toBe(true);const {slot}=await reserved.json();
    const uploaded=await page.request.post(`/api/acquisition/${batch}/photos?slot=${slot.id}&key=${randomUUID()}&generation=${slot.generation}&inputKind=CARD_SCAN`,{headers:{...headers,'content-type':'image/jpeg'},data:bytes});
    expect(uploaded.ok(),await uploaded.text()).toBe(true);photos.push((await uploaded.json()).id);
  }
  // Persisted controlled proposals test review actions, not native accuracy.
  database(`const run=await p.acquisitionRun.findUniqueOrThrow({where:{sessionId:${JSON.stringify(batch)}}});await p.acquisitionSession.update({where:{id:run.sessionId},data:{phase:'COMPLETE'}});await p.acquisitionProcessingJob.updateMany({where:{runId:run.id,status:'PENDING'},data:{status:'FAILED',errorCode:'CONTROLLED_UI_FIXTURE'}});for(const [i,id]of ${JSON.stringify(photos)}.entries()){const photo=await p.acquisitionPhoto.findUniqueOrThrow({where:{id}}),c=await p.acquisitionCandidate.findUniqueOrThrow({where:{runId_physicalId:{runId:run.id,physicalId:photo.slotId}}}),a=await p.acquisitionArtifact.findFirstOrThrow({where:{runId:run.id,sourceId:id}});await p.acquisitionProcessingJob.create({data:{runId:run.id,candidateId:c.id,artifactId:a.id,candidateRevision:c.revision,stage:'photo-recognition-v1',versionKey:crypto.createHash('sha256').update(id).digest('hex'),status:'COMPLETE',input:{photoId:id,digest:photo.digest},output:{native:{geometry:{status:'PROPOSED'},orientations:[{rotationDegrees:0,text:{title:['Ignored scan fixture'],footer:['EN']},lines:[]}]},proposals:{status:'CONFLICT',automaticAcceptance:false,totalProposals:1,truncated:false,proposals:[{card:${JSON.stringify(card)},reasons:['TITLE_TEXT'],nameDistance:0}],evidence:{setCodes:[],collectors:[],languages:['en']}}}}});}return true;`);
  const savedRecord=await (await page.request.get(`${endpoint}?photoId=${photos[0]}`)).json();
  const saved=await page.request.post(endpoint,{headers,data:{action:'accept',photoId:photos[0],revision:savedRecord.revision,
    decision:{cardId:card.id,language:'en',finish:'NONFOIL',condition:'LP'},evidenceTokens:{current:savedRecord.evidenceToken}}});
  expect(saved.ok(),await saved.text()).toBe(true);
  const snapshot=()=>database<any>(`const tables=['InventoryItem','Card','AcquisitionPhoto','AcquisitionCaptureSlot','AcquisitionObservation','AcquisitionArtifact'];const result={};for(const table of tables){const q='SELECT count(*)::text AS count,md5(COALESCE(string_agg(row_to_json(t)::text,chr(31) ORDER BY row_to_json(t)::text),repeat(chr(32),0))) AS hash FROM "'+table+'" t';result[table]=await p.$queryRawUnsafe(q);}const originals=[];for(const photo of await p.acquisitionPhoto.findMany({where:{purgedAt:null,ready:true},orderBy:{id:'asc'}})){const bytes=fs.readFileSync(process.env.UPLOADS_DATA_PATH+'/acquisition-v1/'+photo.id+'.original'),digest=crypto.createHash('sha256').update(bytes).digest('hex');if(digest!==photo.digest||bytes.length!==photo.bytes)throw Error('Original changed');originals.push({id:photo.id,digest,bytes:bytes.length});}return{tables:result,originals};`);
  const before=snapshot(),reviewBefore=database<any>(`return p.acquisitionCandidate.findFirstOrThrow({where:{run:{sessionId:${JSON.stringify(batch)}},acquisitionOrder:0},select:{review:true,physicalId:true,countConfirmed:true}});`);
  await page.setViewportSize({width:1366,height:900});await page.goto(`/imports/scan?batch=${batch}`);
  await page.getByRole('button',{name:'Two-column list',exact:true}).click();
  const first=page.getByTestId('capture-card-1'),second=page.getByTestId('capture-card-2');
  await first.getByRole('button',{name:'Ignore scan',exact:true}).click();await expect(first).toBeHidden();
  await expect(page.getByTestId('scan-review-summary')).toContainText('1 ignored');
  await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(first).toBeVisible();
  await expect(page.getByTestId('scan-review-summary')).toContainText('0 ignored');
  await first.getByRole('button',{name:'Ignore scan',exact:true}).click();await expect(first).toBeHidden();
  await page.reload();await expect(page.getByTestId('scan-review-summary')).toContainText('1 ignored');
  await second.getByRole('button',{name:'Focus card 2',exact:true}).click();
  await second.getByRole('button',{name:'Ignore and next',exact:true}).click();await expect(second).toBeHidden();
  await expect(page.getByTestId('capture-card-3')).toBeVisible();
  await expect(page.getByTestId('scan-review-summary')).toContainText('2 ignored');
  await page.getByRole('combobox',{name:'Show cards',exact:true}).selectOption('ignored');await expect(first).toBeVisible();
  await expect(first.getByRole('img',{name:'Ignored scan 1',exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('ignored-desktop.png')});
  await page.setViewportSize({width:390,height:844});await expect(first.getByRole('button',{name:'Restore scan',exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('ignored-phone.png')});
  await first.getByRole('button',{name:'Restore scan',exact:true}).click();
  await expect(first).toBeHidden();await page.getByRole('combobox',{name:'Show cards',exact:true}).selectOption('all');
  await page.reload();await expect(page.getByTestId('scan-review-summary')).toContainText('1 ignored');
  await expect.poll(()=>database<any>(`return p.acquisitionCandidate.findFirstOrThrow({where:{run:{sessionId:${JSON.stringify(batch)}},acquisitionOrder:0},select:{review:true,physicalId:true,countConfirmed:true}});`)).toEqual(reviewBefore);
  const after=snapshot();expect(after).toEqual(before);
  const bulk=page.getByRole('region',{name:'Bulk match review',exact:true});await bulk.getByRole('button',{name:'Bulk Confirm Match',exact:true}).click();
  await expect(bulk.getByRole('button',{name:'Confirm 1 selected matches',exact:true})).toBeEnabled();
  await expect(bulk.getByRole('checkbox',{name:`Card 2: ${card.name}`,exact:true})).toHaveCount(0);
  writeFileSync(testInfo.outputPath('conservation.json'),JSON.stringify({before,after,reviewBefore,conserved:true},null,2));
  database(`fs.writeFileSync('/tmp/ignore-ui-fixture.json',JSON.stringify({batch:${JSON.stringify(batch)},user:${JSON.stringify(tag)},photos:${JSON.stringify(photos)}}));return true;`);
});
