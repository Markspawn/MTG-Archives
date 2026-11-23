import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {basename} from "node:path";
import {PrismaClient} from "@prisma/client";
import {seedBatchStateFixture,cleanBatchStateFixture} from "./verify-acquisition-batch-state";
import {createConnectorAuthorization,exchangeConnectorToken,connectorAccess,revokeConnectorToken} from "../lib/scan-connector-auth";
import {CONNECTOR_CLIENT_ID,connectorResource,pkceChallenge} from "../lib/scan-connector-policy";
import {connectorBatch,listConnectorBatches,listConnectorCards} from "../lib/scan-connector-tools";
import {connectorEvidenceTicket} from "../lib/scan-connector-evidence";
import {credentialDigest} from "../lib/scan-connector-policy";
import {createAcquisitionSession,saveAcquisitionReview} from "../lib/acquisition-store";
import {buildRestoreCredentialFence} from "../lib/backup";

export async function seedScanConnectorFixture(db:PrismaClient,tag:string){
  const fixture=await seedBatchStateFixture(db,tag),runId=fixture.captures[1].runId;
  const candidate=await db.acquisitionCandidate.findFirstOrThrow({where:{runId}});
  const slot=await db.acquisitionCaptureSlot.create({data:{runId,requestKey:randomUUID(),position:0,generation:1}});
  const photo=await db.acquisitionPhoto.create({data:{runId,slotId:slot.id,generation:1,uploadKey:randomUUID(),ready:true,readyAt:new Date(),bytes:500,mediaType:"image/png",width:300,height:420,digest:"a".repeat(64),inputKind:"CARD_SCAN"}});
  await db.acquisitionCandidate.update({where:{id:candidate.id},data:{physicalId:slot.id}});
  const artifact=await db.acquisitionArtifact.create({data:{runId,sourceId:photo.id,digest:photo.digest}});
  await db.acquisitionObservation.create({data:{runId,sourceId:photo.id,artifactId:artifact.id,candidateId:candidate.id,side:"FRONT"}});
  return {...fixture,otherEntry:{photoId:photo.id,candidateId:candidate.id,slotId:slot.id}};
}

export async function issueConnectorFixtureToken(db:PrismaClient,userId:string,allUsers=false,confirm=true){
  const verifier=randomUUID()+randomUUID(),redirect="https://chatgpt.com/connector_platform_oauth_redirect";
  const params=new URLSearchParams({response_type:"code",client_id:CONNECTOR_CLIENT_ID,redirect_uri:redirect,code_challenge:pkceChallenge(verifier),code_challenge_method:"S256",resource:connectorResource(),scope:"scans:read scans:confirm scans:all-users",state:randomUUID()});
  const callback=await createConnectorAuthorization(db,userId,params,{allUsers,confirm,adminMode:allUsers});
  const request=new URLSearchParams({grant_type:"authorization_code",client_id:CONNECTOR_CLIENT_ID,resource:connectorResource(),redirect_uri:redirect,code:new URL(callback).searchParams.get("code")!,code_verifier:verifier});
  const token=await exchangeConnectorToken(db,request);assert(token);return{token,request,params,verifier};
}
export async function verifyScanConnector(db:PrismaClient){
  assert.equal(await db.acquisitionSession.count(),0,"Fresh disposable acquisition database required");
  const fixture=await seedScanConnectorFixture(db,"connector-"+randomUUID()),[owner,other,admin]=fixture.ids;
  const batch=fixture.captures[0];const imageUri="https://cards.scryfall.io/normal/front/a/b/connector-fixture.jpg";
  await db.card.update({where:{id:fixture.cardId},data:{imageUri}});
  try{
    const normal=await issueConnectorFixtureToken(db,owner),foreign=await issueConnectorFixtureToken(db,other),adminOwn=await issueConnectorFixtureToken(db,admin),adminAll=await issueConnectorFixtureToken(db,admin,true),readOnly=await issueConnectorFixtureToken(db,owner,false,false);
    assert.equal((await listConnectorBatches(db,normal.token.access_token,{allUsers:false,afterBatchNumber:0})).batches.length,1);
    assert.equal((await listConnectorBatches(db,adminOwn.token.access_token,{allUsers:false,afterBatchNumber:0})).batches.length,0);
    await assert.rejects(listConnectorBatches(db,normal.token.access_token,{allUsers:true,afterBatchNumber:0}));
    await assert.rejects(listConnectorBatches(db,adminOwn.token.access_token,{allUsers:true,afterBatchNumber:0}));
    assert.equal((await listConnectorBatches(db,adminAll.token.access_token,{allUsers:true,afterBatchNumber:0})).batches.length,2);
    await assert.rejects(connectorBatch(db,await connectorAccess(db,foreign.token.access_token),batch.sessionId));
    await assert.rejects(connectorBatch(db,await connectorAccess(db,adminOwn.token.access_token),batch.sessionId));
    await connectorBatch(db,await connectorAccess(db,adminAll.token.access_token),batch.sessionId);
    await assert.rejects(createConnectorAuthorization(db,owner,normal.params,{allUsers:true,confirm:true,adminMode:true}));
    await assert.rejects(createConnectorAuthorization(db,admin,normal.params,{allUsers:true,confirm:true,adminMode:false}));
    await assert.rejects(connectorAccess(db,readOnly.token.access_token,["scans:read","scans:confirm"]));
    const first=await listConnectorCards(db,normal.token.access_token,batch.sessionId,-1);assert.equal(first.cards[0].photoId,fixture.entries[0].photoId);assert.equal(first.cards.length,20);
    const second=await listConnectorCards(db,normal.token.access_token,batch.sessionId,first.nextAfterPosition!);assert.equal(second.cards[0].position,20);
    assert.equal((await listConnectorCards(db,normal.token.access_token,batch.sessionId,39)).cards.length,10);
    assert.equal((await listConnectorCards(db,normal.token.access_token,batch.sessionId,49)).cards.length,0);
    console.log("Connector SQL PASS: own versus explicit admin-all scope; role checks; zero-position and whole-batch card pagination; ignored/confirmed/receipt exclusion");

    const immutable=async()=>({stock:await db.inventoryItem.findMany({orderBy:{id:"asc"}}),photos:await db.acquisitionPhoto.findMany({orderBy:{id:"asc"}}),slots:await db.acquisitionCaptureSlot.findMany({orderBy:{id:"asc"}}),receipts:await db.acquisitionCommitMember.findMany({orderBy:{candidateId:"asc"}})});
    const before=await immutable(),access=await connectorAccess(db,normal.token.access_token),photo=fixture.entries[0];
    const scanTicket=connectorEvidenceTicket(access.grant,{kind:"scan",sessionId:batch.sessionId,photoId:photo.photoId,digest:"a".repeat(64),generation:2,revision:0});
    const referenceTicket=connectorEvidenceTicket(access.grant,{kind:"reference",cardId:fixture.cardId,imageUriHash:credentialDigest(imageUri),imageDigest:"b".repeat(64)});
    const decision={cardId:fixture.cardId,language:"en",finish:"NONFOIL" as const,condition:"NM"};
    const request={action:"accept" as const,photoId:photo.photoId,revision:0,decision};
    const options={connector:{accessToken:normal.token.access_token,scanTicket,referenceTicket,reason:"Controlled image comparison supports this exact fixture printing."}};
    const otherBatch=fixture.captures[1],otherPhoto=fixture.otherEntry;
    const allAccess=await connectorAccess(db,adminAll.token.access_token),ownAdminAccess=await connectorAccess(db,adminOwn.token.access_token);
    const otherRequest={...request,photoId:otherPhoto.photoId};
    const adminOptions=(grant:typeof allAccess.grant,accessToken:string)=>({connector:{...options.connector,accessToken,
      scanTicket:connectorEvidenceTicket(grant,{kind:"scan",sessionId:otherBatch.sessionId,photoId:otherPhoto.photoId,digest:"a".repeat(64),generation:1,revision:0}),
      referenceTicket:connectorEvidenceTicket(grant,{kind:"reference",cardId:fixture.cardId,imageUriHash:credentialDigest(imageUri),imageDigest:"b".repeat(64)})}});
    await assert.rejects(saveAcquisitionReview(db,ownAdminAccess.actor,otherBatch.sessionId,otherRequest,adminOptions(ownAdminAccess.grant,adminOwn.token.access_token)));
    assert.deepEqual(await saveAcquisitionReview(db,allAccess.actor,otherBatch.sessionId,otherRequest,adminOptions(allAccess.grant,adminAll.token.access_token)),{replay:false});
    const otherHistory=await db.correctionReviewEvent.findFirstOrThrow({where:{sourceCandidateId:otherPhoto.candidateId}});
    assert.equal(otherHistory.ownerPlayerId,other);assert.equal(otherHistory.actorId,admin);assert.equal(otherHistory.origin,"ASSISTANT");
    await assert.rejects(saveAcquisitionReview(db,access.actor,batch.sessionId,request,{connector:{...options.connector,referenceTicket:"invalid"}}));
    await assert.rejects(saveAcquisitionReview(db,access.actor,batch.sessionId,{...request,decision:{...decision,condition:"LP"}},options));
    await assert.rejects(saveAcquisitionReview(db,access.actor,batch.sessionId,request,{connector:{...options.connector,accessToken:readOnly.token.access_token}}));
    assert.deepEqual(await saveAcquisitionReview(db,access.actor,batch.sessionId,request,options),{replay:false});
    assert.deepEqual(await saveAcquisitionReview(db,access.actor,batch.sessionId,request,options),{replay:true});
    const saved=await db.acquisitionCandidate.findUniqueOrThrow({where:{id:photo.candidateId}});assert.equal((saved.review as any).source,"CHATGPT_CONNECTOR");
    const history=await db.correctionReviewEvent.findFirstOrThrow({where:{sourceCandidateId:photo.candidateId}});assert.equal(history.origin,"ASSISTANT");assert.equal(history.classification,"ASSISTANT_SELECTION");
    const manual=fixture.entries[1];await saveAcquisitionReview(db,{userId:owner,adminMode:false},batch.sessionId,{action:"accept",photoId:manual.photoId,revision:0,decision});
    await assert.rejects(saveAcquisitionReview(db,access.actor,batch.sessionId,{...request,photoId:manual.photoId,revision:1},{connector:{...options.connector,scanTicket:connectorEvidenceTicket(access.grant,{kind:"scan",sessionId:batch.sessionId,photoId:manual.photoId,digest:"a".repeat(64),generation:2,revision:1})}}));
    const stale=fixture.entries[2];await db.acquisitionCandidate.update({where:{id:stale.candidateId},data:{revision:{increment:1}}});
    await assert.rejects(saveAcquisitionReview(db,access.actor,batch.sessionId,{...request,photoId:stale.photoId},{connector:{...options.connector,scanTicket:connectorEvidenceTicket(access.grant,{kind:"scan",sessionId:batch.sessionId,photoId:stale.photoId,digest:"a".repeat(64),generation:2,revision:0})}}));
    const duplicate=fixture.entries[3],duplicateRequest={...request,photoId:duplicate.photoId};
    const duplicateOptions={connector:{...options.connector,scanTicket:connectorEvidenceTicket(access.grant,{kind:"scan",sessionId:batch.sessionId,photoId:duplicate.photoId,digest:"a".repeat(64),generation:2,revision:0})}};
    assert.deepEqual((await Promise.all([saveAcquisitionReview(db,access.actor,batch.sessionId,duplicateRequest,duplicateOptions),saveAcquisitionReview(db,access.actor,batch.sessionId,duplicateRequest,duplicateOptions)])).map(x=>x.replay).sort(),[false,true]);
    assert.equal(await db.acquisitionCommand.count({where:{runId:batch.runId,requestKey:`review:${duplicate.candidateId}:1`}}),1);
    const replaced=fixture.entries[4];await db.acquisitionCaptureSlot.update({where:{id:replaced.slotId},data:{generation:3}});
    await assert.rejects(saveAcquisitionReview(db,access.actor,batch.sessionId,{...request,photoId:replaced.photoId},{connector:{...options.connector,scanTicket:connectorEvidenceTicket(access.grant,{kind:"scan",sessionId:batch.sessionId,photoId:replaced.photoId,digest:"a".repeat(64),generation:2,revision:0})}}));
    await db.acquisitionCaptureSlot.update({where:{id:replaced.slotId},data:{generation:2}});
    for(const index of [75,98]){const excluded=fixture.entries[index];await assert.rejects(saveAcquisitionReview(db,access.actor,batch.sessionId,{...request,photoId:excluded.photoId},{connector:{...options.connector,scanTicket:connectorEvidenceTicket(access.grant,{kind:"scan",sessionId:batch.sessionId,photoId:excluded.photoId,digest:"a".repeat(64),generation:2,revision:0})}}));}
    assert.deepEqual(await immutable(),before);
    const audit=await db.acquisitionCommand.findUniqueOrThrow({where:{runId_requestKey:{runId:batch.runId,requestKey:`review:${photo.candidateId}:1`}}});assert(!audit.payload.includes(normal.token.access_token));assert(!audit.payload.includes(scanTicket));
    console.log("Connector SQL PASS: actual atomic AI confirmation/replay, image proofs, defaults, human-choice/stale-source protection and separate unverified provenance; stock/photos/slots/receipts conserved");

    const bad=new URLSearchParams(normal.request);bad.set("code_verifier","wrong".repeat(10));assert.equal(await exchangeConnectorToken(db,bad),null);
    await connectorAccess(db,normal.token.access_token);
    const replay=await issueConnectorFixtureToken(db,owner);assert.equal(await exchangeConnectorToken(db,replay.request),null);await assert.rejects(connectorAccess(db,replay.token.access_token));
    const rotating=await issueConnectorFixtureToken(db,owner);const refresh=new URLSearchParams({grant_type:"refresh_token",client_id:CONNECTOR_CLIENT_ID,resource:connectorResource(),refresh_token:rotating.token.refresh_token,scope:"scans:read"});
    const refreshed=await exchangeConnectorToken(db,refresh);assert(refreshed);assert.equal(refreshed.scope,"scans:read");await assert.rejects(connectorAccess(db,rotating.token.access_token));await assert.rejects(connectorAccess(db,refreshed.access_token,["scans:confirm"]));
    assert.equal(await exchangeConnectorToken(db,refresh),null);await assert.rejects(connectorAccess(db,refreshed.access_token));
    const revocable=await issueConnectorFixtureToken(db,owner);await revokeConnectorToken(db,revocable.token.access_token);await assert.rejects(connectorAccess(db,revocable.token.access_token));
    const revoking=await issueConnectorFixtureToken(db,owner),revokingAccess=await connectorAccess(db,revoking.token.access_token),blocked=fixture.entries[5];
    let pending:Promise<unknown>|undefined;
    await db.$transaction(async tx=>{await tx.scanConnectorGrant.update({where:{id:revokingAccess.grant.id},data:{revokedAt:new Date()}});
      pending=saveAcquisitionReview(db,revokingAccess.actor,batch.sessionId,{...request,photoId:blocked.photoId},{connector:{...options.connector,accessToken:revoking.token.access_token,scanTicket:connectorEvidenceTicket(revokingAccess.grant,{kind:"scan",sessionId:batch.sessionId,photoId:blocked.photoId,digest:"a".repeat(64),generation:2,revision:0}),referenceTicket:connectorEvidenceTicket(revokingAccess.grant,{kind:"reference",cardId:fixture.cardId,imageUriHash:credentialDigest(imageUri),imageDigest:"b".repeat(64)})}});
      // Attach immediately while the grant row is locked so a rejection cannot
      // become an unhandled promise; no sleep or weakened writer path is used.
      pending.catch(()=>{});
    });
    await assert.rejects(pending!);assert.equal((await db.acquisitionCandidate.findUniqueOrThrow({where:{id:blocked.candidateId}})).review,null);
    const reset=await issueConnectorFixtureToken(db,owner);await db.user.update({where:{id:owner},data:{passwordHash:"changed-fixture-password"}});await assert.rejects(connectorAccess(db,reset.token.access_token));
    await db.user.update({where:{id:owner},data:{passwordHash:"fixture-only"}});
    await db.user.update({where:{id:admin},data:{role:"PLAYER"}});await assert.rejects(connectorAccess(db,adminAll.token.access_token));await db.user.update({where:{id:admin},data:{role:"ADMIN"}});
    await db.user.update({where:{id:owner},data:{isActive:false}});await assert.rejects(connectorAccess(db,normal.token.access_token));await db.user.update({where:{id:owner},data:{isActive:true,forcePasswordChange:true}});await assert.rejects(connectorAccess(db,normal.token.access_token));await db.user.update({where:{id:owner},data:{forcePasswordChange:false}});
    const oldOrigin=process.env.APP_BASE_URL;process.env.APP_BASE_URL="https://another.example.test";await assert.rejects(connectorAccess(db,normal.token.access_token));process.env.APP_BASE_URL=oldOrigin;
    console.log("Connector SQL PASS: PKCE/code replay, rotated refresh reuse revocation/downscope, explicit revoke and live password/role/account checks");

    const extra=[];
    for(let i=0;i<27;i++){const created=await createAcquisitionSession(db,{userId:owner,adminMode:false},{requestKey:randomUUID(),ownerPlayerId:owner,locationId:owner,section:"A",policy:{kind:"MANUAL",quantity:1},run:{providerId:"phone-photo-v1",runId:randomUUID(),enforcement:"NONE",controls:["STOP"]}});extra.push(created.session.id);}
    const page1=await listConnectorBatches(db,normal.token.access_token,{allUsers:false,afterBatchNumber:0});assert.equal(page1.batches.length,25);assert(page1.nextAfterBatchNumber);
    await db.acquisitionSession.update({where:{id:batch.sessionId},data:{updatedAt:new Date(Date.now()+1000)}});
    const page2=await listConnectorBatches(db,normal.token.access_token,{allUsers:false,afterBatchNumber:page1.nextAfterBatchNumber,throughBatchNumber:page1.throughBatchNumber});assert.equal(page2.batches.length,3);assert.equal(page2.nextAfterBatchNumber,null);assert.equal(new Set([...page1.batches,...page2.batches].map(x=>x.sessionId)).size,28);
    const runs=await db.acquisitionRun.findMany({where:{sessionId:{in:extra}},select:{id:true}});await db.acquisitionRun.deleteMany({where:{id:{in:runs.map(x=>x.id)}}});await db.acquisitionSession.deleteMany({where:{id:{in:extra}}});
    console.log("Connector SQL PASS: stable uncapped batch cursor across confirmations, no cross-user listing and no duplicated/skipped pages");
    const restored=await issueConnectorFixtureToken(db,owner);
    await assert.rejects(db.$transaction(async tx=>{await tx.$executeRawUnsafe(buildRestoreCredentialFence("public"));throw Error("controlled restore rollback");}),/controlled restore rollback/);
    await connectorAccess(db,restored.token.access_token);
    await db.$transaction(tx=>tx.$executeRawUnsafe(buildRestoreCredentialFence("public")));
    await assert.rejects(connectorAccess(db,restored.token.access_token));assert.deepEqual(await immutable(),before);
    console.log("Connector SQL PASS: restore credential fence revokes old connector authority atomically and rollback/source/stock remain conserved");
  }finally{
    // Assistant/human review controls create ordinary retained metadata; retire
    // only this fixture's library rows before removing its scoped accounts.
    const owners={ownerPlayerId:{in:fixture.ids}};
    await db.correctionRetentionPin.deleteMany({where:owners});await db.correctionReviewEvent.deleteMany({where:owners});await db.correctionExample.deleteMany({where:owners});await db.correctionEvidence.deleteMany({where:owners});await db.correctionCaptureOutbox.deleteMany({where:{blob:owners}});await db.correctionBlob.deleteMany({where:owners});await db.correctionDeletionTombstone.deleteMany({where:owners});await db.correctionLibraryAccess.deleteMany({where:owners});await db.correctionLibraryAccount.deleteMany({where:owners});
    await cleanBatchStateFixture(db,fixture);
  }
}
if(basename(process.argv[1]??"")==="verify-scan-connector.ts"&&process.argv.includes("--run")){
  const url=new URL(process.env.DATABASE_URL??"http://invalid");
  if(process.env.MTG_LOCAL_PILOT_TEST!=="1"||!["localhost","127.0.0.1","mtg-connector-db"].includes(url.hostname)||!url.pathname.startsWith("/acquisition_"))throw new Error("Explicit disposable local acquisition database required");
  const db=new PrismaClient();verifyScanConnector(db).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>db.$disconnect());
}
