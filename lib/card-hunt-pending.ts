import type {
  HuntActionInput,
  HuntActionResult,
} from "./card-hunt-action-policy";
export type FrozenHuntAction = {
  version: 1;
  input: HuntActionInput;
  recipientLabel: string;
  summary: Array<{
    name: string;
    quantity: number;
    destination: string;
    printing: string;
  }>;
};
const stamp = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function parsePendingHuntAction(raw: string): FrozenHuntAction {
  if (raw.length > 1000000) throw Error("Unreadable pending confirmation");
  const value = JSON.parse(raw),
    input = value?.input;
  if (
    value?.version !== 1 ||
    typeof value.recipientLabel !== "string" ||
    !Array.isArray(value.summary) ||
    value.summary.length > 500 ||
    value.summary.some(
      (row: any) =>
        typeof row.name !== "string" ||
        typeof row.destination !== "string" ||
        typeof row.printing !== "string" ||
        !Number.isSafeInteger(row.quantity) ||
        row.quantity < 1,
    ) ||
    !input ||
    !["COMMIT", "GIVE"].includes(input.action) ||
    typeof input.requestId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(input.requestId) ||
    !input.hunt ||
    !Array.isArray(input.selected) ||
    !input.selected.length ||
    input.selected.length > 500 ||
    input.selected.some(
      (row: any) =>
        typeof row.requestId !== "string" ||
        typeof row.inventoryItemId !== "string" ||
        !Number.isSafeInteger(row.quantity) ||
        row.quantity < 1 ||
        !stamp(row.stamp) ||
        (row.targetStamp !== undefined && !stamp(row.targetStamp)),
    )
  )
    throw Error("Unreadable pending confirmation");
  return value;
}
export function verifiedHuntOutcome(
  value: unknown,
  input: HuntActionInput,
): value is HuntActionResult {
  const result = value as HuntActionResult;
  if (
    !result ||
    result.requestId !== input.requestId ||
    result.action !== input.action ||
    !["APPLIED", "REJECTED"].includes(result.status) ||
    typeof result.message !== "string" ||
    !Array.isArray(result.destinations) ||
    !Array.isArray(result.stockUpdates) ||
    !Array.isArray(result.handoffIds) ||
    (result.targetUpdates !== undefined &&
      (!Array.isArray(result.targetUpdates) || result.targetUpdates.some(
        row => !row || typeof row.requestId !== "string" || !stamp(row.stamp),
      ))) ||
    result.stockUpdates.some(
      (row) => !row || typeof row.id !== "string" || !stamp(row.stamp),
    ) ||
    result.destinations.some(
      (row) =>
        !row ||
        typeof row.name !== "string" ||
        !Number.isSafeInteger(row.quantity) ||
        row.quantity < 1,
    ) ||
    result.handoffIds.some((id) => typeof id !== "string")
  )
    return false;
  return result.status === "REJECTED"
    ? result.quantity === 0 && result.entries === 0
    : result.quantity ===
        input.selected.reduce((sum, row) => sum + row.quantity, 0) &&
        result.entries === input.selected.length &&
        result.destinations.reduce((sum, row) => sum + row.quantity, 0) ===
          result.quantity;
}
