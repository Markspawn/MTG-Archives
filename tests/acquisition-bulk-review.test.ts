import {test} from "node:test";
import assert from "node:assert/strict";
import {acquisitionBulkReviewBlock} from "../lib/acquisition-bulk-review";
import {acquisitionCommitSelectionSchema} from "../lib/acquisition-commit";
import {randomUUID} from "node:crypto";
import type {AcquisitionCardReview} from "../lib/acquisition-review";

const defaults={finish:"NONFOIL" as const,condition:"NM" as const,language:"en" as const};
function record(): AcquisitionCardReview {
  return {photoId:randomUUID(),position:0,revision:0,defaults,review:null,printing:null,recognitionStatus:"COMPLETE",
    suggestions:[{printing:{id:"card",name:"Fixture",setCode:"tst",collectorNumber:"1",lang:"en",imageUri:null,finishes:["nonfoil","foil"]},reasons:[]}],
    evidence:{identifiers:{languages:[]}} as unknown as AcquisitionCardReview["evidence"]};
}
test("matching proposal is bulk eligible, including case-normalized observed language",()=>{
  const r=record();assert.equal(acquisitionBulkReviewBlock(r,defaults),null);
  r.evidence!.identifiers.languages=["EN"];assert.equal(acquisitionBulkReviewBlock(r,defaults),null);
});
test("intentional exclusions report actionable reasons",()=>{
  assert.match(acquisitionBulkReviewBlock(record(),defaults,true)!,/Unsaved correction/);
  const noMatch=record();noMatch.suggestions=[];assert.match(acquisitionBulkReviewBlock(noMatch,defaults)!,/No printing/);
  assert.match(acquisitionBulkReviewBlock(record(),{...defaults,condition:null})!,/batch condition/);
  const unknown=record();unknown.suggestions[0].printing.lang=null;assert.match(acquisitionBulkReviewBlock(unknown,defaults)!,/no language/);
  const foreign=record();foreign.suggestions[0].printing.lang="ja";assert.match(acquisitionBulkReviewBlock(foreign,defaults)!,/JA.*EN/);
  assert.match(acquisitionBulkReviewBlock(record(),{...defaults,finish:"UNKNOWN"})!,/finish/);
});

test("an explicit English batch default overrides OCR-only language disagreements",()=>{
  for(const languages of [["fr"],["ja"],["en","fr"],["FR","de","EN"]]){
    const r=record();r.evidence!.identifiers.languages=languages;
    assert.equal(acquisitionBulkReviewBlock(r,defaults),null);
    assert.deepEqual(r.evidence!.identifiers.languages,languages); // Keep the observed evidence.
    assert.equal(r.suggestions[0].printing.lang,"en");
  }
});

test("English-default language tolerance keeps other exclusions and printing identity",()=>{
  const r=record();r.evidence!.identifiers.languages=["fr"];
  assert.match(acquisitionBulkReviewBlock(r,defaults,true)!,/Unsaved correction/);
  assert.match(acquisitionBulkReviewBlock(r,{...defaults,condition:null})!,/batch condition/);
  assert.match(acquisitionBulkReviewBlock(r,{...defaults,finish:"UNKNOWN"})!,/finish/);
  r.suggestions[0].printing.lang="fr";
  assert.match(acquisitionBulkReviewBlock(r,defaults)!,/FR.*EN/);
  assert.equal(r.suggestions[0].printing.lang,"fr");
  r.suggestions[0].printing.lang=null;
  assert.match(acquisitionBulkReviewBlock(r,defaults)!,/no language/);
});

test("non-English batch defaults retain their existing OCR language checks",()=>{
  const r=record();r.suggestions[0].printing.lang="fr";
  const french={...defaults,language:"fr" as const};
  r.evidence!.identifiers.languages=["fr"];
  assert.equal(acquisitionBulkReviewBlock(r,french),null);
  r.evidence!.identifiers.languages=["en","fr"];
  assert.match(acquisitionBulkReviewBlock(r,french)!,/EN.*FR/);
});
test("saved per-card choices are never overwritten by bulk defaults",()=>{
  const r=record();r.review={cardId:"card",finish:"FOIL",condition:"LP",language:"en",actorId:"user"};
  assert.match(acquisitionBulkReviewBlock(r,defaults)!,/saved review/);
});
test("one confirmation accepts 1001 distinct copies while rejecting duplicate identities",()=>{
  const photoIds=Array.from({length:1001},()=>randomUUID());
  assert.equal(acquisitionCommitSelectionSchema.parse({photoIds,locationId:"box",section:"A"}).photoIds.length,1001);
  assert.equal(acquisitionCommitSelectionSchema.safeParse({photoIds:[photoIds[0],photoIds[0]],locationId:"box",section:"A"}).success,false);
});
