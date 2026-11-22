import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {createAcquisitionSession, executeAcquisitionCommand, saveAcquisitionReview,
  getAcquisitionProgress, getAcquisitionCardReview} from "../lib/acquisition-store";
import {previewAcquisitionCommit, previewConfirmedAcquisitionCommit, commitAcquisitionCards} from "../lib/acquisition-commit-service";
import {getAcquisitionBatchDashboard} from "../lib/acquisition-batch-dashboard";
import {requestAcquisitionRerun, runAcquisitionRerunOnce} from "../lib/acquisition-rerun";
import {claimAcquisitionJobs, completeAcquisitionJob, heartbeatAcquisitionJob, type ClaimedAcquisitionJob} from "../lib/acquisition-jobs";
import {enqueueReadyRecognition} from "../lib/acquisition-recognition-worker";
import {readScannerCapacity} from "../lib/scanner-capacity";

export async function verifyAcquisitionIgnore(db: PrismaClient) {
  assert.equal(await db.acquisitionSession.count(),0,"Requires a fresh disposable database");
  const tag=`ignore-${randomUUID()}`, ids=["owner","other","admin"].map(n=>`${tag}-${n}`);
  const [owner,other,admin]=ids.map((userId,i)=>({userId,adminMode:i===2}));
  for (const [i,id] of ids.entries()) {
    await db.player.create({data:{id,name:id,displayName:id}});
    await db.user.create({data:{id,username:id,displayName:id,passwordHash:"fixture-only",playerId:id,role:i===2?"ADMIN":"PLAYER"}});
  }
  await db.inventoryLocation.create({data:{id:owner.userId,name:tag,normalizedName:tag,ownerPlayerId:owner.userId,type:"Box",
    storageLayout:{capacity:1000,sections:[{name:"A",capacity:1000}]}}});
  const card=await db.card.create({data:{name:tag,scryfallId:randomUUID(),typeLine:"Creature",setCode:"tst",collectorNumber:"1",rarity:"common",lang:"en",finishes:["nonfoil"]}});
  const inventory=await db.inventoryItem.create({data:{cardId:card.id,currentOwnerId:owner.userId,locationId:owner.userId,locationSection:"A",quantity:7,condition:"NM"}});
  const saved=await createAcquisitionSession(db,owner,{requestKey:randomUUID(),ownerPlayerId:owner.userId,locationId:owner.userId,section:"A",
    policy:{kind:"MANUAL",quantity:3},run:{providerId:"phone-photo-v1",runId:randomUUID(),enforcement:"NONE",controls:["STOP"]}});
  await executeAcquisitionCommand(db,owner,saved.session.id,{requestKey:"start",revision:0,command:"START"});
  const sessionId=saved.session.id, run=await db.acquisitionRun.findUniqueOrThrow({where:{sessionId}}),where={runId:run.id};
  const review={cardId:card.id,finish:"NONFOIL",condition:"LP",language:"en",actorId:owner.userId,openerPlayerId:other.userId};
  const entries=[];
  for(let position=0;position<3;position++) {
    const slot=await db.acquisitionCaptureSlot.create({data:{...where,requestKey:randomUUID(),position,generation:1}});
    const photo=await db.acquisitionPhoto.create({data:{...where,slotId:slot.id,generation:1,uploadKey:randomUUID(),ready:true,
      readyAt:new Date(),bytes:500,mediaType:"image/png",width:600,height:840,digest:"a".repeat(64),inputKind:"CARD_SCAN"}});
    const candidate=await db.acquisitionCandidate.create({data:{...where,physicalId:slot.id,identityKind:"EPISODE",acquisitionOrder:position,spatialOrder:0,
      expectedSides:["FRONT"],provisional:false,uncertainty:[],revision:0,countConfirmed:true,...(position!==1?{review}:{})}});
    const artifact=await db.acquisitionArtifact.create({data:{...where,sourceId:photo.id,digest:photo.digest}});
    await db.acquisitionObservation.create({data:{...where,sourceId:photo.id,candidateId:candidate.id,artifactId:artifact.id,side:"FRONT"}});
    await db.acquisitionProcessingJob.create({data:{...where,candidateId:candidate.id,artifactId:artifact.id,candidateRevision:0,stage:"photo-canonical-v1",
      versionKey:"fixture",status:"COMPLETE",input:{photoId:photo.id,digest:photo.digest},output:{photoId:photo.id}}});
    entries.push({candidate,photo,artifact,slot});
  }
  const [confirmed,pending,added]=entries;
  await db.acquisitionSession.update({where:{id:sessionId},data:{phase:"COMPLETE"}});
  await db.acquisitionCommit.create({data:{...where,actorUserId:owner.userId,requestKey:randomUUID(),requestDigest:"b".repeat(64),snapshot:{},
    members:{create:{candidateId:added.candidate.id,inventoryItemId:inventory.id,snapshot:{}}}}});
  const originalPhotos=await db.acquisitionPhoto.findMany({where,orderBy:{id:"asc"}}), originalSlots=await db.acquisitionCaptureSlot.findMany({where,orderBy:{id:"asc"}});
  const originalObservations=await db.acquisitionObservation.findMany({where,orderBy:{id:"asc"}}), originalReceipt=await db.acquisitionCommitMember.findMany({where});
  const row=(entry:typeof confirmed)=>db.acquisitionCandidate.findUniqueOrThrow({where:{id:entry.candidate.id}});
  const action=(entry:typeof confirmed,kind:"ignore"|"restore",revision:number,who=owner,requestKey=randomUUID())=>
    saveAcquisitionReview(db,who,sessionId,{action:kind,photoId:entry.photo.id,revision,requestKey});
  const capacity=()=>db.$transaction(tx=>readScannerCapacity(tx,{locationId:owner.userId,ownerPlayerId:owner.userId,section:"A"}));
  try {
    assert.equal((await capacity()).pendingTotal,2);
    const selection={locationId:owner.userId,section:"A",photoIds:[confirmed.photo.id]};
    const frozen=await previewAcquisitionCommit(db,owner,sessionId,selection);
    await assert.rejects(action(confirmed,"ignore",0,other),/unavailable/);
    await assert.rejects(action(confirmed,"ignore",0,{...admin,adminMode:false}),/unavailable/);
    await assert.rejects(action(added,"ignore",0),/already committed/);
    const key=randomUUID();
    const both=await Promise.all([1,2].map(()=>action(confirmed,"ignore",0,owner,key)));
    assert.equal(both.filter(r=>r.replay).length,1);
    assert.equal((await row(confirmed)).revision,1);assert.deepEqual((await row(confirmed)).review,review);
    await assert.rejects(action(confirmed,"restore",0),/changed/);
    await assert.rejects(action(confirmed,"restore",1,owner,key),/request changed/);
    await assert.rejects(saveAcquisitionReview(db,owner,sessionId,{action:"pending",photoId:confirmed.photo.id,revision:1}),/unavailable/);
    await assert.rejects(commitAcquisitionCards(db,owner,sessionId,{...selection,requestKey:randomUUID(),previewToken:frozen.token,overfillReason:null}),/unavailable/);
    await assert.rejects(previewConfirmedAcquisitionCommit(db,owner,sessionId,{locationId:owner.userId,section:"A",excludedPhotoIds:[]}),/Choose complete confirmed/);
    assert.equal((await getAcquisitionCardReview(db,owner,sessionId,confirmed.photo.id)).ignored,true);
    assert.equal((await capacity()).pendingTotal,1);
    const native=await db.acquisitionProcessingJob.create({data:{...where,candidateId:pending.candidate.id,artifactId:pending.artifact.id,candidateRevision:0,
      stage:"photo-recognition-v1",versionKey:"old-lease",status:"RUNNING",attempts:1,leaseToken:"fixture-lease",leaseExpiresAt:new Date(Date.now()+90000),input:{photoId:pending.photo.id,digest:pending.photo.digest}}});
    await action(pending,"ignore",0);
    assert.equal(await heartbeatAcquisitionJob(db,native as ClaimedAcquisitionJob),false);
    assert.equal(await completeAcquisitionJob(db,native as ClaimedAcquisitionJob,{}),"SUPERSEDED");
    await db.acquisitionProcessingJob.create({data:{...where,candidateId:pending.candidate.id,artifactId:pending.artifact.id,candidateRevision:1,
      stage:"photo-recognition-v1",versionKey:"ignored-current-revision",input:{photoId:pending.photo.id,digest:pending.photo.digest}}});
    assert.equal((await claimAcquisitionJobs(db,{workerId:tag,stages:["photo-recognition-v1"]})).length,0);
    await requestAcquisitionRerun(db,owner,{scope:"MINE",requestKey:randomUUID()});
    assert.equal((await runAcquisitionRerunOnce(db)).queued,0);
    assert.equal(await enqueueReadyRecognition(db,"b".repeat(64),"c".repeat(64)),0);
    const dashboard=await getAcquisitionBatchDashboard(db,owner,{view:"all"});
    assert.equal(dashboard.rows[0].captured,3);assert.equal(dashboard.rows[0].ignored,2);assert.equal(dashboard.rows[0].added,1);
    assert.equal(dashboard.rows[0].confirmed,1);assert.equal(dashboard.rows[0].processing,0);assert.equal(dashboard.rows[0].pending,false);
    assert.equal(dashboard.totals.ignored,2);assert.equal((await capacity()).pendingTotal,0);
    await action(confirmed,"restore",1,admin);
    assert.deepEqual((await row(confirmed)).review,review);assert.equal((await capacity()).pendingTotal,1);
    assert.equal((await previewAcquisitionCommit(db,owner,sessionId,selection)).count,1);
    const retry=await action(confirmed,"ignore",0,owner,key);assert.equal(retry.replay,true);
    assert.equal((await row(confirmed)).ignored,false,"Old Ignore receipt must not re-ignore a restored scan");
    await action(pending,"restore",1);
    assert.equal(await enqueueReadyRecognition(db,"b".repeat(64),"c".repeat(64)),1);
    const progress=await getAcquisitionProgress(db,owner,sessionId);
    assert.equal(progress.reservedSlots,3);assert.equal(progress.availableSlots,0);
    assert.equal(progress.slots.find(s=>s.id===confirmed.slot.id)?.ignored,false);
    const revision=(await row(pending)).revision;
    const race=await Promise.allSettled([
      action(pending,"ignore",revision),
      saveAcquisitionReview(db,owner,sessionId,{action:"accept",photoId:pending.photo.id,revision,decision:{cardId:card.id,language:"en",condition:"NM",finish:"NONFOIL"}}),
    ]);
    assert.equal(race.filter(r=>r.status==="fulfilled").length,1);
    assert.deepEqual(await db.acquisitionPhoto.findMany({where,orderBy:{id:"asc"}}),originalPhotos);
    assert.deepEqual(await db.acquisitionCaptureSlot.findMany({where,orderBy:{id:"asc"}}),originalSlots);
    assert.deepEqual(await db.acquisitionObservation.findMany({where,orderBy:{id:"asc"}}),originalObservations);
    assert.deepEqual(await db.acquisitionCommitMember.findMany({where}),originalReceipt);
    assert.deepEqual(await db.inventoryItem.findUniqueOrThrow({where:{id:inventory.id}}),inventory);
    console.log("Ignore/Restore SQL: ownership, exact replay, saved choice, closed counts, holds, native/rerun fences, stale commit and concurrent review conservation PASS");
  } finally {
    const owned={ownerPlayerId:{in:ids}};
    await db.correctionCaptureOutbox.deleteMany({where:{blob:{ownerPlayerId:{in:ids}}}});
    await db.correctionRetentionPin.deleteMany({where:owned});await db.correctionReviewEvent.deleteMany({where:owned});
    await db.correctionEvidence.deleteMany({where:owned});await db.correctionExample.deleteMany({where:owned});
    await db.correctionBlob.deleteMany({where:owned});await db.correctionLibraryAccess.deleteMany({where:owned});
    await db.correctionLibraryAccount.deleteMany({where:owned});
    await db.acquisitionCommitMember.deleteMany({where});await db.acquisitionCommit.deleteMany({where});
    await db.acquisitionProcessingTurn.deleteMany({where});await db.acquisitionProcessingJob.deleteMany({where});
    await db.acquisitionCommand.deleteMany({where});await db.acquisitionPhoto.deleteMany({where});await db.acquisitionCaptureSlot.deleteMany({where});
    await db.acquisitionCountCorrection.deleteMany({where});await db.acquisitionObservation.deleteMany({where});await db.acquisitionEvent.deleteMany({where});
    await db.acquisitionCandidate.deleteMany({where});await db.acquisitionArtifact.deleteMany({where});await db.acquisitionRun.delete({where:{id:run.id}});
    await db.acquisitionSession.delete({where:{id:sessionId}});await db.acquisitionRecognitionRerun.deleteMany({where:{actorUserId:{in:ids}}});
    await db.inventoryItem.delete({where:{id:inventory.id}});await db.inventoryLocation.delete({where:{id:owner.userId}});
    await db.user.deleteMany({where:{id:{in:ids}}});await db.player.deleteMany({where:{id:{in:ids}}});await db.card.delete({where:{id:card.id}});
    assert.equal(await db.acquisitionSession.count(),0);assert.equal(await db.user.count(),0);assert.equal(await db.inventoryItem.count(),0);
  }
}
if(process.argv.includes("--run")) {
  const url=new URL(process.env.DATABASE_URL||"http://invalid");
  if(process.env.MTG_LOCAL_PILOT_TEST!=="1" || !["localhost","127.0.0.1","[::1]","mtg-ignore-db"].includes(url.hostname) || !url.pathname.startsWith("/acquisition_"))
    throw new Error("Requires opt-in and a fresh disposable local acquisition_* database");
  const db=new PrismaClient();verifyAcquisitionIgnore(db).catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
}
