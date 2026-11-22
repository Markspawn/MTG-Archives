import assert from "node:assert/strict";
import test from "node:test";
import {acquisitionIgnoreTransition} from "../lib/acquisition-ignore";
import {acquisitionReviewCounts, acquisitionSlotMatchesReviewFilter, nextAwaitingAcquisitionSlot,
  acquisitionReviewProblemCounts} from "../lib/acquisition-review-display";
import {captureSummary, candidateCommitReadiness, type CaptureSession} from "../lib/acquisition-domain";
import {scannerReservedSpace} from "../lib/scanner-capacity";
import {acquisitionReviewRequestSchema} from "../lib/acquisition-review";

test("ignore requires the current uncommitted physical card and restore is explicit", () => {
  const candidate={revision: 7, ignored: false, excluded: false, receipt: null};
  assert.deepEqual(acquisitionIgnoreTransition(candidate,"ignore",7),{revision:8,ignored:true});
  for(const patch of [{revision:8},{receipt:{id:"added"}},{excluded:true},{ignored:true}])
    assert.throws(()=>acquisitionIgnoreTransition({...candidate,...patch},"ignore",7));
  assert.deepEqual(acquisitionIgnoreTransition({...candidate,revision:8,ignored:true},"restore",8),{revision:9,ignored:false});
  assert.throws(()=>acquisitionIgnoreTransition(candidate,"restore",7));
});

test("98 added and two ignored finish review while all 100 physical scans remain counted", () => {
  const review={cardId:"card",finish:"NONFOIL",condition:"NM",language:"en"};
  const slots=Array.from({length:100},(_,position)=>({position,committed:position<98,ignored:position>=98,review,
    photos:[{ready:true,purgedAt:null}],physicalReadiness:{reasons:[]},reviewProblems:["conflict" as const]}));
  assert.deepEqual(acquisitionReviewCounts(slots),{scanned:100,all:98,ignored:2,awaiting:0,ready:0,added:98});
  assert.equal(slots.filter(s=>acquisitionSlotMatchesReviewFilter(s,"all")).length,98);
  assert.equal(slots.filter(s=>acquisitionSlotMatchesReviewFilter(s,"ignored")).length,2);
  assert.equal(acquisitionSlotMatchesReviewFilter(slots[98],"ready",true),false);
  assert.equal(acquisitionReviewProblemCounts(slots).conflict,0);
  assert.equal(nextAwaitingAcquisitionSlot(slots,97),null);
  const restored=slots.map(s=>s.position===98?{...s,ignored:false}:s);
  assert.equal(acquisitionReviewCounts(restored).ready,1);
  assert.deepEqual(restored[98].review,review);
});

test("ignore releases only its Inventory hold, without promoting overflow or authorizing another capture", () => {
  const candidates=Array.from({length:3},(_,i)=>({key:String(i),input:{id:String(i),order:[i,0],provisional:false,
    expectedSides:["FRONT"],identityKind:"EPISODE"},observations:[{id:String(i),artifactId:String(i),side:"FRONT"}],
    uncertainty:[],revision:0,excluded:false,ignored:i===0,countConfirmed:true,proposal:null,review:null}));
  const session={candidates,target:2,phase:"COMPLETE"} as unknown as CaptureSession;
  const summary=captureSummary(session);
  assert.equal(summary.physicalCandidates,3);assert.equal(summary.targetReached,true);
  assert.deepEqual(summary.allocated,["0","1"]);assert.deepEqual(summary.overflow,["2"]);
  assert(candidateCommitReadiness(session,"0").reasons.includes("UNAVAILABLE"));
  assert(candidateCommitReadiness(session,"2").reasons.includes("OVERFLOW"));
  assert.equal(scannerReservedSpace({reserved:100,candidateCount:100,slotCount:100,committedCount:98,ignoredCount:2}),0);
  assert.equal(scannerReservedSpace({reserved:100,candidateCount:20,slotCount:20,committedCount:0,ignoredCount:2}),98);
});

test("ignore/restore requests require a bounded revision, photo and idempotency key", () => {
  const input={action:"ignore",photoId:"10000000-0000-4000-8000-000000000001",requestKey:"10000000-0000-4000-8000-000000000002",revision:0};
  assert(acquisitionReviewRequestSchema.safeParse(input).success);
  assert(acquisitionReviewRequestSchema.safeParse({...input,action:"restore"}).success);
  for(const patch of [{revision:-1},{requestKey:""},{photoId:""},{all:true}])
    assert.equal(acquisitionReviewRequestSchema.safeParse({...input,...patch}).success,false);
});
