import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {createAcquisitionSession, executeAcquisitionCommand, saveAcquisitionReview} from "../lib/acquisition-store";
import {getAcquisitionBatchDashboard} from "../lib/acquisition-batch-dashboard";
import {PRINTING_STAGE} from "../lib/acquisition-printing";

/** Controlled local metadata fixture. No recognition, scanning or stock command
 * is invoked; receipt/stock seed rows exist only in the opted-in test database. */
export async function seedBatchStateFixture(db: PrismaClient, tag: string) {
  const ids=["owner","other","admin"].map(name=>tag+"-"+name);
  for(const [i,id] of ids.entries()) {
    await db.player.create({data:{id,name:id,displayName:id}});
    await db.user.create({data:{id,username:id,displayName:id,passwordHash:"fixture-only",playerId:id,role:i===2?"ADMIN":"PLAYER"}});
    if(i<2)await db.inventoryLocation.create({data:{id,name:i===0?"Batch state review box":"Other owner's box",normalizedName:id,
      ownerPlayerId:id,type:"Box",storageLayout:{capacity:1000,sections:[{name:"A",capacity:1000}]}}});
  }
  const card=await db.card.create({data:{name:tag,scryfallId:randomUUID(),typeLine:"Creature",setCode:"tst",collectorNumber:"1",rarity:"common",lang:"en",finishes:["nonfoil"]}});
  const inventory=await db.inventoryItem.create({data:{cardId:card.id,currentOwnerId:ids[0],locationId:ids[0],locationSection:"A",quantity:23,condition:"NM"}});
  const captures=[];
  for(let i=0;i<2;i++) {
    const saved=await createAcquisitionSession(db,{userId:ids[i],adminMode:false},{requestKey:randomUUID(),ownerPlayerId:ids[i],locationId:ids[i],
      section:"A",policy:{kind:"MANUAL",quantity:i===0?100:1},run:{providerId:"phone-photo-v1",runId:randomUUID(),enforcement:"NONE",controls:["STOP"]}});
    await executeAcquisitionCommand(db,{userId:ids[i],adminMode:false},saved.session.id,{requestKey:"start",revision:0,command:"START"});
    const run=await db.acquisitionRun.findUniqueOrThrow({where:{sessionId:saved.session.id}});
    captures.push({sessionId:saved.session.id,batchNumber:saved.batchNumber,runId:run.id});
    await db.acquisitionSession.update({where:{id:saved.session.id},data:{phase:"COMPLETE"}});
  }
  const runId=captures[0].runId;
  const entries=Array.from({length:100},(_,position)=>({slotId:randomUUID(),photoId:randomUUID(),candidateId:randomUUID(),artifactId:randomUUID(),position}));
  await db.acquisitionCaptureSlot.createMany({data:entries.map(e=>({id:e.slotId,runId,requestKey:randomUUID(),position:e.position,generation:1}))});
  await db.acquisitionPhoto.createMany({data:entries.map(e=>({id:e.photoId,runId,slotId:e.slotId,generation:1,uploadKey:randomUUID(),ready:true,readyAt:new Date(),
    bytes:500,mediaType:"image/png",width:300,height:420,digest:"a".repeat(64),inputKind:"CARD_SCAN"}))});
  const review={cardId:card.id,finish:"NONFOIL",condition:"NM",language:"en",actorId:ids[0]};
  await db.acquisitionCandidate.createMany({data:entries.map(e=>({id:e.candidateId,runId,physicalId:e.slotId,identityKind:"EPISODE",
    acquisitionOrder:e.position,spatialOrder:0,expectedSides:["FRONT"],provisional:false,uncertainty:[],revision:0,countConfirmed:true,
    ignored:e.position>=98,...(e.position>=50 && e.position!==75?{review}:{})}))});
  await db.acquisitionArtifact.createMany({data:entries.map(e=>({id:e.artifactId,runId,sourceId:e.photoId,digest:"a".repeat(64)}))});
  await db.acquisitionObservation.createMany({data:entries.map(e=>({runId,sourceId:e.photoId,artifactId:e.artifactId,candidateId:e.candidateId,side:"FRONT"}))});
  await db.acquisitionProcessingJob.createMany({data:entries.filter(e=>e.position>=20 && e.position<50 || e.position>=98).map(e=>({
    runId,candidateId:e.candidateId,artifactId:e.artifactId,candidateRevision:0,stage:PRINTING_STAGE,versionKey:"complete-fixture",status:"COMPLETE",
    input:{photoId:e.photoId,digest:"a".repeat(64)},createdAt:new Date("2026-01-02T00:00:00Z")}))});
  await db.acquisitionProcessingJob.createMany({data:[entries[0],entries[20]].map(e=>({runId,candidateId:e.candidateId,artifactId:e.artifactId,
    candidateRevision:0,stage:PRINTING_STAGE,versionKey:"older-failed-fixture",status:"FAILED",input:{photoId:e.photoId,digest:"a".repeat(64)},
    createdAt:new Date("2026-01-01T00:00:00Z")}))});
  const oldPhoto=await db.acquisitionPhoto.create({data:{runId,slotId:entries[1].slotId,generation:0,uploadKey:randomUUID(),ready:true,readyAt:new Date(),
    bytes:500,mediaType:"image/png",width:300,height:420,digest:"b".repeat(64),inputKind:"CARD_SCAN"}});
  const oldArtifact=await db.acquisitionArtifact.create({data:{runId,sourceId:oldPhoto.id,digest:oldPhoto.digest}});
  await db.acquisitionProcessingJob.create({data:{runId,candidateId:entries[1].candidateId,artifactId:oldArtifact.id,candidateRevision:0,stage:PRINTING_STAGE,
    versionKey:"old-photo-complete",status:"COMPLETE",input:{photoId:oldPhoto.id,digest:oldPhoto.digest},createdAt:new Date("2026-01-03T00:00:00Z")}});
  await db.acquisitionCandidate.create({data:{runId,physicalId:randomUUID(),identityKind:"DETECTION",acquisitionOrder:100,spatialOrder:0,
    expectedSides:["FRONT"],provisional:true,uncertainty:[],revision:0,excluded:true}});
  await db.acquisitionCommit.create({data:{runId,actorUserId:ids[0],requestKey:randomUUID(),requestDigest:"c".repeat(64),snapshot:{},
    members:{create:entries.filter(e=>e.position>=75 && e.position<98).map(e=>({candidateId:e.candidateId,inventoryItemId:inventory.id,snapshot:{}}))}}});
  await db.acquisitionCandidate.create({data:{runId:captures[1].runId,physicalId:randomUUID(),identityKind:"EPISODE",acquisitionOrder:0,spatialOrder:0,
    expectedSides:["FRONT"],provisional:false,uncertainty:[],revision:0,countConfirmed:true}});
  return {ids,cardId:card.id,inventoryId:inventory.id,captures,entries,oldPhotoId:oldPhoto.id};
}

export async function cleanBatchStateFixture(db: PrismaClient, fixture: Awaited<ReturnType<typeof seedBatchStateFixture>>) {
  const runIds=fixture.captures.map(c=>c.runId),where={runId:{in:runIds}};
  await db.acquisitionCommitMember.deleteMany({where});await db.acquisitionCommit.deleteMany({where});
  await db.acquisitionProcessingTurn.deleteMany({where});await db.acquisitionProcessingJob.deleteMany({where});await db.acquisitionCommand.deleteMany({where});
  await db.acquisitionPhoto.deleteMany({where});await db.acquisitionCaptureSlot.deleteMany({where});await db.acquisitionCountCorrection.deleteMany({where});
  await db.acquisitionObservation.deleteMany({where});await db.acquisitionEvent.deleteMany({where});await db.acquisitionCandidate.deleteMany({where});
  await db.acquisitionArtifact.deleteMany({where});await db.acquisitionRun.deleteMany({where:{id:{in:runIds}}});
  await db.acquisitionSession.deleteMany({where:{id:{in:fixture.captures.map(c=>c.sessionId)}}});
  await db.inventoryItem.delete({where:{id:fixture.inventoryId}});await db.inventoryLocation.deleteMany({where:{ownerPlayerId:{in:fixture.ids}}});
  await db.user.deleteMany({where:{id:{in:fixture.ids}}});await db.player.deleteMany({where:{id:{in:fixture.ids}}});await db.card.delete({where:{id:fixture.cardId}});
}

export async function verifyBatchStateInfographic(db: PrismaClient) {
  assert.equal(await db.acquisitionSession.count(),0,"Requires a fresh disposable database");
  const fixture=await seedBatchStateFixture(db,"batch-states-"+randomUUID());
  const owner={userId:fixture.ids[0],adminMode:false},other={userId:fixture.ids[1],adminMode:false},admin={userId:fixture.ids[2],adminMode:true};
  const read=()=>getAcquisitionBatchDashboard(db,owner,{view:"all",page:999});
  const check=(row:Awaited<ReturnType<typeof read>>["rows"][number],expected:{queued:number;evaluated:number;confirmed:number;inventory:number;ignored:number})=>{
    assert.deepEqual(row.states,expected);assert.equal(Object.values(row.states).reduce((a,b)=>a+b,0),row.captured);
  };
  try {
    const snapshot=async()=>({stock:await db.inventoryItem.findMany({orderBy:{id:"asc"}}),photos:await db.acquisitionPhoto.findMany({orderBy:{id:"asc"}}),
      slots:await db.acquisitionCaptureSlot.findMany({orderBy:{id:"asc"}}),candidates:await db.acquisitionCandidate.findMany({orderBy:{id:"asc"}}),
      receipts:await db.acquisitionCommitMember.findMany({orderBy:{candidateId:"asc"}})});
    const before=await snapshot();const initial=await read();assert.equal(initial.page,1);assert.equal(initial.total,1);
    check(initial.rows[0],{queued:20,evaluated:30,confirmed:25,inventory:23,ignored:2});assert.equal(initial.rows[0].captured,100);
    assert.equal((await getAcquisitionBatchDashboard(db,other,{view:"all"})).totals.captured,1);
    assert.equal((await getAcquisitionBatchDashboard(db,{...admin,adminMode:false},{view:"all"})).total,0);
    assert.equal((await getAcquisitionBatchDashboard(db,admin,{view:"all"})).totals.captured,101);
    assert.deepEqual(await snapshot(),before,"Dashboard reads must conserve stock/source/receipts");
    const runId=fixture.captures[0].runId,first=fixture.entries[0];
    await db.acquisitionProcessingJob.create({data:{runId,candidateId:first.candidateId,artifactId:first.artifactId,candidateRevision:0,stage:PRINTING_STAGE,
      versionKey:"new-complete",status:"COMPLETE",input:{photoId:first.photoId,digest:"a".repeat(64)}}});
    check((await read()).rows[0],{queued:19,evaluated:31,confirmed:25,inventory:23,ignored:2});
    const review={cardId:fixture.cardId,finish:"NONFOIL",condition:"NM",language:"en",actorId:owner.userId};
    await db.acquisitionCandidate.update({where:{id:fixture.entries[20].candidateId},data:{review}});
    check((await read()).rows[0],{queued:19,evaluated:30,confirmed:26,inventory:23,ignored:2});
    await db.acquisitionCommit.create({data:{runId,actorUserId:owner.userId,requestKey:randomUUID(),requestDigest:"d".repeat(64),snapshot:{},
      members:{create:{candidateId:fixture.entries[50].candidateId,inventoryItemId:fixture.inventoryId,snapshot:{}}}}});
    await db.inventoryItem.update({where:{id:fixture.inventoryId},data:{quantity:{increment:1}}});
    check((await read()).rows[0],{queued:19,evaluated:30,confirmed:25,inventory:24,ignored:2});
    const ignored=fixture.entries[1];
    await saveAcquisitionReview(db,owner,fixture.captures[0].sessionId,{action:"ignore",photoId:ignored.photoId,revision:0,requestKey:randomUUID()});
    check((await read()).rows[0],{queued:18,evaluated:30,confirmed:25,inventory:24,ignored:3});
    await saveAcquisitionReview(db,owner,fixture.captures[0].sessionId,{action:"restore",photoId:ignored.photoId,revision:1,requestKey:randomUUID()});
    check((await read()).rows[0],{queued:19,evaluated:30,confirmed:25,inventory:24,ignored:2});
    assert.deepEqual(await db.acquisitionPhoto.findMany({orderBy:{id:"asc"}}),before.photos);
    assert.deepEqual(await db.acquisitionCaptureSlot.findMany({orderBy:{id:"asc"}}),before.slots);
    assert.equal((await db.inventoryItem.findUniqueOrThrow({where:{id:fixture.inventoryId}})).quantity,24);
    console.log("Batch state SQL PASS:100 saved=20 queued+30 evaluated+25 confirmed+23 Inventory+2 ignored; live transitions, receipts without reviews, retries/old photos, owner/Admin Mode and read conservation");
  } finally {
    await cleanBatchStateFixture(db,fixture);
    assert.equal(await db.acquisitionSession.count(),0);assert.equal(await db.inventoryItem.count(),0);assert.equal(await db.user.count(),0);
  }
}

if(process.argv.includes("--run")) {
  const url=new URL(process.env.DATABASE_URL||"http://invalid");
  if(process.env.MTG_LOCAL_PILOT_TEST!=="1" || !["localhost","127.0.0.1","[::1]","mtg-batch-state-db"].includes(url.hostname) || !url.pathname.startsWith("/acquisition_"))
    throw new Error("Requires opt-in and a fresh disposable local acquisition_* database");
  const db=new PrismaClient();verifyBatchStateInfographic(db).catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.$disconnect());
}
