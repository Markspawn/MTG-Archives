import assert from "node:assert/strict";
import test from "node:test";
import {acquisitionBatchSegments} from "../lib/acquisition-batch-state";

test("exclusive card states fill the saved total without double-counting confirmed or added copies", () => {
  const states={queued:20,evaluated:30,confirmed:25,inventory:23,ignored:2};
  const segments=acquisitionBatchSegments(100,states);
  assert.deepEqual(segments.map(stage=>stage.count),[20,30,25,23,2]);
  assert.deepEqual(segments.map(stage=>stage.width),[20,30,25,23,2]);
  assert.equal(segments.reduce((sum,stage)=>sum+stage.count,0),100);
  const completed=acquisitionBatchSegments(100,{queued:0,evaluated:0,confirmed:0,inventory:98,ignored:2});
  assert.equal(completed[3].width,98);assert.equal(completed[4].width,2);
});

test("empty batches and one-card segments preserve exact quantities and finite proportional widths", () => {
  assert(acquisitionBatchSegments(0,{queued:0,evaluated:0,confirmed:0,inventory:0,ignored:0}).every(stage=>stage.width===0));
  const large=acquisitionBatchSegments(150000,{queued:1,evaluated:0,confirmed:0,inventory:149999,ignored:0});
  assert.equal(large[0].count,1);assert(large[0].width>0 && large[0].width<.001);
  assert.equal(large.reduce((sum,stage)=>sum+stage.count,0),150000);
});

test("inconsistent, negative, fractional and unsafe totals cannot paint a misleading distribution", () => {
  const states={queued:20,evaluated:30,confirmed:25,inventory:23,ignored:2};
  for(const [total,patch] of [[101,{}],[100,{queued:-1}],[100,{queued:20.5}],[-1,{}],[Infinity,{}]] as const)
    assert.throws(()=>acquisitionBatchSegments(total,{...states,...patch}),/add up/);
});
