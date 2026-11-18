import assert from "node:assert/strict";
import {randomBytes, randomUUID, createHash} from "node:crypto";
import {mkdir, writeFile, link, rm} from "node:fs/promises";
import path from "node:path";
import {PrismaClient} from "@prisma/client";
import sharp from "sharp";
import {createAcquisitionSession, executeAcquisitionCommand, reserveAcquisitionCaptureSlot,
  beginAcquisitionPhoto, finalizeAcquisitionPhoto, getAcquisitionPhoto, getAcquisitionProgress,
  getAcquisitionCardReview} from "../../lib/acquisition-store";
import {inspectAcquisitionPhoto, writeAcquisitionPhotoBytes, canonicalizeAcquisitionPhoto} from "../../lib/acquisition-files";
import {ensureCorrectionAccount} from "../../lib/acquisition-correction-library";
import {getAcquisitionBatchDashboard} from "../../lib/acquisition-batch-dashboard";

const url = new URL(process.env.DATABASE_URL ?? "http://invalid");
if (process.env.MTG_ACQUISITION_PERFORMANCE_TEST !== "1" ||
  !["127.0.0.1", "localhost", "mtg-pending-performance-db"].includes(url.hostname) ||
  !["/trade_audit_fixture", "/review_pending_performance"].includes(url.pathname))
  throw Error("Explicit isolated performance database required");
const keep = process.env.MTG_PERFORMANCE_KEEP_FIXTURE === "1";
if (keep && url.pathname !== "/review_pending_performance") throw Error("Only the owned local review fixture may be retained");
const db = new PrismaClient();
const tag = `performance-${randomUUID()}`, actor = {userId: tag, adminMode: false};
const root = path.resolve(process.env.UPLOADS_DATA_PATH ?? `.local-data/${tag}`);
const oldRoot = process.env.UPLOADS_DATA_PATH;
process.env.UPLOADS_DATA_PATH = root;
const ids: string[] = [], photoIds: string[] = [];
let successful = false;

async function main() {
  await mkdir(root, {recursive: true});
  const token = randomBytes(32).toString("base64url"), passwordHash = randomBytes(32).toString("hex");
  await db.player.create({data:{id:tag,name:tag,displayName:tag}});
  await db.user.create({data:{id:tag,username:tag,displayName:tag,playerId:tag,passwordHash}});
  await db.authSession.create({data:{userId:tag,tokenHash:createHash("sha256").update(token).digest("hex"),
    credentialHash:createHash("sha256").update(passwordHash).digest("hex"),expiresAt:new Date(Date.now()+3600000)}});
  await db.inventoryLocation.create({data:{id:tag,name:tag,normalizedName:tag,ownerPlayerId:tag,type:"BOX"}});
  await db.$transaction(tx => ensureCorrectionAccount(tx, tag));
  await db.correctionLibraryAccount.update({where:{ownerPlayerId:tag},data:{sampleBasisPoints:0}});
  const capture = await createAcquisitionSession(db, actor, {requestKey:randomUUID(),ownerPlayerId:tag,
    locationId:tag,section:"",policy:{kind:"UNTARGETED"},
    run:{providerId:"phone-photo-v1",runId:randomUUID(),enforcement:"NONE",controls:["STOP"]}});
  const batch = capture.session.id;
  await executeAcquisitionCommand(db,actor,batch,{requestKey:randomUUID(),revision:capture.revision,command:"START"});
  const reserved = await reserveAcquisitionCaptureSlot(db,actor,batch,randomUUID());
  const pixels=randomBytes(1620*2160*3);
  for(let i=0;i<pixels.length;i++)pixels[i]&=0xf0;
  const centre=Buffer.from('<svg width="1620" height="2160"><rect x="600" y="800" width="420" height="560" fill="#ee2222"/></svg>');
  const bytes=await sharp(pixels,{raw:{width:1620,height:2160,channels:3}}).composite([{input:centre}]).png().toBuffer();
  const metadata=await inspectAcquisitionPhoto(bytes,"image/png");
  const photo=await beginAcquisitionPhoto(db,actor,batch,{slotId:reserved.slot.id,uploadKey:randomUUID(),generation:0,metadata});
  photoIds.push(photo.id);
  await writeAcquisitionPhotoBytes(photo.id,bytes,"raw",photo.digest);
  await finalizeAcquisitionPhoto(db,actor,batch,photo.id);
  const prepared=await canonicalizeAcquisitionPhoto(photo.id,photo.digest,new AbortController().signal);
  await db.acquisitionProcessingJob.updateMany({where:{artifact:{sourceId:photo.id},stage:"photo-canonical-v1"},data:{status:"COMPLETE",output:prepared}});
  const originalSession=await db.acquisitionSession.findUniqueOrThrow({where:{id:batch}});
  const originalRun=await db.acquisitionRun.findUniqueOrThrow({where:{sessionId:batch}});
  ids.push(originalRun.id);
  await db.acquisitionSession.update({where:{id:batch},data:{phase:"COMPLETE"}});
  let batches=1;
  async function extend(target:number) {
    const sessions=[], runs=[];
    for(let b=batches;b<target;b++) {
      const id=`${tag}-batch-${b}`,runId=`${tag}-run-${b}`;ids.push(runId);
      sessions.push({id,createdByUserId:tag,ownerPlayerId:tag,locationId:tag,section:"",requestKey:id,
        requestPayload:originalSession.requestPayload,placement:originalSession.placement!,policy:originalSession.policy!,phase:"COMPLETE" as const});
      runs.push({id:runId,sessionId:id,sourceRunId:runId,providerId:originalRun.providerId,enforcement:originalRun.enforcement,controls:originalRun.controls});
    }
    for(let offset=0;offset<sessions.length;offset+=500){
      await db.acquisitionSession.createMany({data:sessions.slice(offset,offset+500) as any});
      await db.acquisitionRun.createMany({data:runs.slice(offset,offset+500)});
    }
    const first = batches===1 ? 0 : batches;
    for(let b=first;b<target;b++) {
      // Only the selected batch needs original files: this is a metadata/UI
      // backlog control, not a native-processing or storage-throughput claim.
      if(b===0 && await db.acquisitionCaptureSlot.count({where:{runId:originalRun.id}})>1) continue;
      const slots=[],photos=[],artifacts=[],candidates=[],observations=[],jobs=[];
      for(let position=b===0?1:0;position<100;position++) {
        const runId=ids[b],slotId=randomUUID(),id=randomUUID(),artifactId=randomUUID(),candidateId=randomUUID();
        slots.push({id:slotId,runId,requestKey:id,position,generation:1});
        photos.push({id,runId,slotId,uploadKey:id,generation:1,digest:photo.digest,bytes:photo.bytes,mediaType:photo.mediaType,
          width:photo.width,height:photo.height,ready:true,readyAt:new Date()});
        artifacts.push({id:artifactId,runId,sourceId:id,digest:photo.digest});
        candidates.push({id:candidateId,runId,physicalId:slotId,identityKind:"EPISODE",acquisitionOrder:position,spatialOrder:0,
          expectedSides:["FRONT"],provisional:false,uncertainty:[],revision:0});
        observations.push({id:randomUUID(),runId,sourceId:id,artifactId,candidateId,side:"FRONT"});
        jobs.push({id:randomUUID(),runId,artifactId,candidateId,candidateRevision:0,stage:"photo-canonical-v1",
          versionKey:"fixture-canonical",input:{},status:"COMPLETE" as const,output:prepared});
        if(b===0) {
          photoIds.push(id);
          for(const suffix of ["original","preview.jpg"])
            await link(path.join(root,"acquisition-v1",`${photo.id}.${suffix}`),path.join(root,"acquisition-v1",`${id}.${suffix}`));
        }
      }
      await db.acquisitionCaptureSlot.createMany({data:slots});
      await db.acquisitionPhoto.createMany({data:photos});
      await db.acquisitionArtifact.createMany({data:artifacts});
      await db.acquisitionCandidate.createMany({data:candidates});
      await db.acquisitionObservation.createMany({data:observations});
      await db.acquisitionProcessingJob.createMany({data:jobs});
    }
    batches=target;
  }
  const samples=[];
  const points=keep?[1,20,100,1000]:[1,20,100];
  for(const count of points) {
    await extend(count);
    const start=performance.now();
    const progress=await getAcquisitionProgress(db,actor,batch);
    const progressMs=performance.now()-start;
    assert.equal(progress.slots.length,100);assert.equal(progress.pagination.total,100);
    const imageStart=performance.now();
    for(let read=0;read<5;read++)assert.equal((await getAcquisitionPhoto(db,actor,batch,photo.id)).digest,photo.digest);
    const imageMetadataMeanMs=(performance.now()-imageStart)/5;
    const dashboardStart=performance.now();
    const dashboard=await getAcquisitionBatchDashboard(db,actor,{view:"pending"});
    const dashboardMs=performance.now()-dashboardStart;
    assert.equal(dashboard.total,count);assert.equal(dashboard.totals.captured,count*100);assert.equal(dashboard.rows.length,Math.min(25,count));
    const review=await getAcquisitionCardReview(db,actor,batch,photo.id);assert.equal(review.photoId,photo.id);
    samples.push({batches:count,cards:count*100,progressMs,imageMetadataMeanMs,dashboardMs});
  }
  // A correction publication holds the same owner lock used by upload sampling.
  // Existing-key ordinary review must finish before that lock is released.
  let locked!:()=>void, release!:()=>void;
  const ready=new Promise<void>(resolve=>{locked=resolve;}), hold=new Promise<void>(resolve=>{release=resolve;});
  const writer=db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${tag},715))`;
    locked();await hold;
  },{timeout:15000});
  await ready;
  try {
    await Promise.race([getAcquisitionCardReview(db,actor,batch,photo.id),new Promise((_,reject)=>setTimeout(()=>reject(Error("Review waited on upload-owner lock")),3000))]);
  } finally {release();await writer;}
  assert.equal(await db.inventoryItem.count({where:{currentOwnerId:tag}}),0);
  assert.equal(await db.acquisitionCommit.count({where:{run:{session:{ownerPlayerId:tag}}}}),0);
  await assert.rejects(getAcquisitionPhoto(db,{userId:"unrelated",adminMode:false},batch,photo.id));
  assert.equal((await db.acquisitionPhoto.findUniqueOrThrow({where:{id:photo.id}})).digest,metadata.digest);
  if(keep) await writeFile("/tmp/pending-performance-fixture.json",JSON.stringify({tag,token,batch,photoId:photo.id,originalDigest:photo.digest,
    originalBytes:photo.bytes,previewBytes:prepared.bytes,sourceWidth:1620,sourceHeight:2160,samples}));
  console.log(JSON.stringify({scope:"synthetic metadata/UI backlog; no native recognition or physical throughput claim",samples,
    privateOriginalBytes:photo.bytes,privatePreviewBytes:prepared.bytes,ownerLockIndependentReview:true,inventoryWrites:0}));
  successful=true;
}

async function cleanup() {
  if(keep&&successful)return;
  const where={run:{session:{ownerPlayerId:tag}}};
  for(const model of ["acquisitionProcessingJob","acquisitionProcessingTurn","acquisitionPhoto","acquisitionObservation",
    "acquisitionCountCorrection","acquisitionCandidate","acquisitionArtifact","acquisitionCaptureSlot","acquisitionCommand","acquisitionEvent"] as const)
    await (db[model] as any).deleteMany({where});
  await db.acquisitionRun.deleteMany({where:{session:{ownerPlayerId:tag}}});
  await db.acquisitionSession.deleteMany({where:{ownerPlayerId:tag}});
  await db.correctionLibraryAccount.deleteMany({where:{ownerPlayerId:tag}});
  await db.inventoryLocation.deleteMany({where:{ownerPlayerId:tag}});
  await db.authSession.deleteMany({where:{userId:tag}});
  await db.user.deleteMany({where:{id:tag}});await db.player.deleteMany({where:{id:tag}});
  for(const id of photoIds)for(const suffix of ["original","preview.jpg"])
    await rm(path.join(root,"acquisition-v1",`${id}.${suffix}`),{force:true});
}
void (async()=>{
  try{await main();}finally{try{await cleanup();}finally{process.env.UPLOADS_DATA_PATH=oldRoot;await db.$disconnect();}}
})().catch(error=>{console.error(error);process.exitCode=1;});
