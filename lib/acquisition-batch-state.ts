export type AcquisitionBatchStates = {
  queued: number;
  evaluated: number;
  confirmed: number;
  inventory: number;
  ignored: number;
};

const stages = [
  {key: "queued", label: "Queued / evaluating"},
  {key: "evaluated", label: "Evaluated · unconfirmed"},
  {key: "confirmed", label: "Confirmed · not added"},
  {key: "inventory", label: "In Inventory"},
  {key: "ignored", label: "Ignored"},
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
