export type AcquisitionBatchStates = {
  queued: number;
  evaluated: number;
  confirmed: number;
  inventory: number;
  ignored: number;
};

const stages = [
  {key: "queued", label: "Queued / evaluating", color: "bg-blue-500"},
  {key: "evaluated", label: "Evaluated · unconfirmed", color: "bg-amber-400"},
  {key: "confirmed", label: "Confirmed · not added", color: "bg-violet-500"},
  {key: "inventory", label: "In Inventory", color: "bg-emerald-500"},
  {key: "ignored", label: "Ignored", color: "bg-slate-400"},
] as const;

/** These are exclusive counts from PostgreSQL, not the overlapping dashboard
 * totals. Preserve tiny portions rather than distorting them with a minimum. */
export function acquisitionBatchSegments(total: number, states: AcquisitionBatchStates) {
  if (!Number.isSafeInteger(total) || total < 0 ||
      stages.some(stage => !Number.isSafeInteger(states[stage.key]) || states[stage.key] < 0) ||
      stages.reduce((sum, stage) => sum + states[stage.key], 0) !== total)
    throw new Error("Batch state counts must add up to the saved total");
  return stages.map(stage => ({...stage, count: states[stage.key],
    width: total === 0 ? 0 : states[stage.key] / total * 100}));
}
