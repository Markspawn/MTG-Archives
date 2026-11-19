// Disposable presentation fixture for scans-review-experience.spec.ts.
// Run only in the owned Linux review container with the exact guarded database.
// No scanner, recognition worker, Inventory write or shared installation is used.
import {PrismaClient,Prisma} from '@prisma/client';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {writeFile,link} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {createAcquisitionSession,executeAcquisitionCommand,reserveAcquisitionCaptureSlot,beginAcquisitionPhoto,finalizeAcquisitionPhoto} from '../../lib/acquisition-store';
import {inspectAcquisitionPhoto,writeAcquisitionPhotoBytes,canonicalizeAcquisitionPhoto} from '../../lib/acquisition-files';
import {ensureCorrectionAccount} from '../../lib/acquisition-correction-library';
const p=new PrismaClient();
async function main(){
 const url=new URL(process.env.DATABASE_URL??'http://invalid');
 if(process.env.MTG_SCANS_EXPERIENCE_TEST!=='1'||url.pathname!=='/review_pending_performance'||!['127.0.0.1','localhost','mtg-scans-experience-db','mtg-scan-actions-db'].includes(url.hostname))throw Error('Explicit owned disposable scan-review database required');
 const user='scan-experience-'+randomUUID(),token=randomBytes(32).toString('base64url'),passwordHash=randomBytes(32).toString('hex');
 await p.player.create({data:{id:user,name:user,displayName:user}});
 await p.user.create({data:{id:user,username:user,displayName:user,passwordHash,playerId:user}});
 await p.authSession.create({data:{userId:user,tokenHash:createHash('sha256').update(token).digest('hex'),credentialHash:createHash('sha256').update(passwordHash).digest('hex'),expiresAt:new Date(Date.now()+86400000)}});
 await p.inventoryLocation.create({data:{id:user,name:'Review box',normalizedName:user,ownerPlayerId:user,type:'BOX',
   storageLayout:{capacity:2000,sections:[{name:'Section A',capacity:2000}]}}});
 await p.$transaction(tx=>ensureCorrectionAccount(tx,user));
 await p.correctionLibraryAccount.update({where:{ownerPlayerId:user},data:{sampleBasisPoints:0}});
 const printing={id:'printing-'+randomUUID(),name:'Review comparison card',setCode:'tst',collectorNumber:'14',lang:'en',imageUri:'/scan-fixture.svg',finishes:['nonfoil','foil']};
 await p.card.create({data:{...printing,scryfallId:randomUUID(),typeLine:'Creature',rarity:'common'}});
 const actor={userId:user,adminMode:false};
 const capture=await createAcquisitionSession(p,actor,{requestKey:randomUUID(),ownerPlayerId:user,locationId:user,section:'Section A',policy:{kind:'UNTARGETED'},run:{providerId:'phone-photo-v1',runId:randomUUID(),enforcement:'NONE',controls:['STOP']}});
 const batch=capture.session.id;
 await executeAcquisitionCommand(p,actor,batch,{requestKey:randomUUID(),revision:capture.revision,command:'START'});
 await p.acquisitionSession.update({where:{id:batch},data:{reviewDefaults:{finish:'NONFOIL',condition:'NM',language:'en',openerPlayerId:user}}});
 const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840"><rect width="600" height="840" rx="24" fill="#181c26"/><rect x="25" y="25" width="550" height="790" rx="18" fill="#c6ddbc"/><text x="45" y="80" font-size="32">Review comparison card</text><rect x="45" y="110" width="510" height="400" fill="#4e8974"/><circle cx="300" cy="300" r="120" fill="#e5dca2"/><text x="45" y="570" font-size="30">Creature</text><text x="45" y="640" font-size="24">A scan-review layout fixture.</text><text x="45" y="780" font-size="26">TST 014 ? EN</text></svg>');
 await writeFile('/app/public/scan-fixture.svg',svg);
 const bytes=await sharp(svg).jpeg().toBuffer(), metadata=await inspectAcquisitionPhoto(bytes,'image/jpeg'),photos=[],slots=[];
 for(let i=0;i<14;i++){
  const reserved=await reserveAcquisitionCaptureSlot(p,actor,batch,randomUUID());slots.push(reserved.slot.id);
  const photo=await beginAcquisitionPhoto(p,actor,batch,{slotId:reserved.slot.id,uploadKey:randomUUID(),generation:0,metadata});photos.push(photo.id);
  await writeAcquisitionPhotoBytes(photo.id,bytes,'raw',photo.digest);await finalizeAcquisitionPhoto(p,actor,batch,photo.id);
  const prepared=await canonicalizeAcquisitionPhoto(photo.id,photo.digest,new AbortController().signal);
  await p.acquisitionProcessingJob.updateMany({where:{artifact:{sourceId:photo.id},stage:'photo-canonical-v1'},data:{status:'COMPLETE',output:prepared}});
 }
 await p.acquisitionSession.update({where:{id:batch},data:{phase:'COMPLETE'}});
 const run=await p.acquisitionRun.findUniqueOrThrow({where:{sessionId:batch}});
 await writeFile('/tmp/scans-experience-fixture.json',JSON.stringify({user,token,batch,runId:run.id,printing,photos,slots}));
 if(process.env.MTG_SCAN_ACTIONS_TEST==='1') {
   const large=await createAcquisitionSession(p,actor,{requestKey:randomUUID(),ownerPlayerId:user,locationId:user,section:'Section A',policy:{kind:'UNTARGETED'},
     run:{providerId:'phone-photo-v1',runId:randomUUID(),enforcement:'NONE',controls:['STOP']}});
   const largeRun=await p.acquisitionRun.findUniqueOrThrow({where:{sessionId:large.session.id}});
   await p.acquisitionSession.update({where:{id:large.session.id},data:{phase:'COMPLETE'}});
   const canonical=await p.acquisitionProcessingJob.findFirstOrThrow({where:{runId:run.id,stage:'photo-canonical-v1',artifact:{sourceId:photos[0]}}});
   const copySlots=[],copyPhotos=[],artifacts=[],candidates=[],observations=[],jobs:Prisma.AcquisitionProcessingJobCreateManyInput[]=[];
   for(let position=0;position<501;position++) {
     const id=randomUUID(),slotId=randomUUID(),artifactId=randomUUID(),candidateId=randomUUID();
     copySlots.push({id:slotId,runId:largeRun.id,requestKey:id,position,generation:1});
     copyPhotos.push({id,runId:largeRun.id,slotId,uploadKey:id,generation:1,...metadata,ready:true,readyAt:new Date()});
     artifacts.push({id:artifactId,runId:largeRun.id,sourceId:id,digest:metadata.digest});
     candidates.push({id:candidateId,runId:largeRun.id,physicalId:slotId,identityKind:'EPISODE',acquisitionOrder:position,spatialOrder:0,
       expectedSides:['FRONT'],provisional:false,uncertainty:[],revision:0,review:{cardId:printing.id,finish:'NONFOIL',condition:'NM',language:'en',openerPlayerId:user,actorId:user}});
     observations.push({id:randomUUID(),runId:largeRun.id,sourceId:id,artifactId,candidateId,side:'FRONT'});
     jobs.push({id:randomUUID(),runId:largeRun.id,artifactId,candidateId,candidateRevision:0,stage:'photo-canonical-v1',versionKey:'scan-actions-fixture',
       status:'COMPLETE',input:{},output:canonical.output as Prisma.InputJsonValue});
     const uploads=path.join(process.env.UPLOADS_DATA_PATH!,'acquisition-v1');
     for(const suffix of ['original','preview.jpg'])await link(path.join(uploads,`${photos[0]}.${suffix}`),path.join(uploads,`${id}.${suffix}`));
   }
   await p.acquisitionCaptureSlot.createMany({data:copySlots});await p.acquisitionPhoto.createMany({data:copyPhotos});
   await p.acquisitionArtifact.createMany({data:artifacts});await p.acquisitionCandidate.createMany({data:candidates});
   await p.acquisitionObservation.createMany({data:observations});await p.acquisitionProcessingJob.createMany({data:jobs});
   await writeFile('/tmp/scan-actions-large-fixture.json',JSON.stringify({batch:large.session.id,runId:largeRun.id,user,token,printing,locationId:user,section:'Section A'}));
 }
 console.log(JSON.stringify({seeded:photos.length,batch,inventoryWrites:0}));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>p.$disconnect());
