import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { InventoryItem } from "@prisma/client";
import { handoffInput, handoffStamp } from "../lib/card-handoff-policy";
const input = {
  requestId: randomUUID(),
  inventoryItemId: "lot-a",
  expectedStamp: "a".repeat(64),
  quantity: 1,
  kind: "GIFT",
  recipient: { type: "EXTERNAL", name: "  Pat   O’Brien  " },
};
test("external recipients keep their name without empty/control text or hidden account fields", () => {
  const parsed = handoffInput.parse(input);
  assert.deepEqual(parsed.recipient, { type: "EXTERNAL", name: "Pat O’Brien" });
  for (const name of [" ", "a".repeat(121), "Pat\nOther", "Pat\u0000Other"])
    assert.throws(() =>
      handoffInput.parse({ ...input, recipient: { type: "EXTERNAL", name } }),
    );
  assert.throws(() =>
    handoffInput.parse({
      ...input,
      recipient: { ...input.recipient, playerId: "someone" },
    }),
  );
  assert.throws(() =>
    handoffInput.parse({
      ...input,
      recipient: { type: "ARCHIVE", playerId: "person", name: "forged name" },
    }),
  );
});
test("a handoff must name one positive whole quantity and one exact frozen request", () => {
  for (const quantity of [0, -1, 1.5, NaN, Infinity, 2147483648])
    assert.throws(() => handoffInput.parse({ ...input, quantity }));
  assert.throws(() => handoffInput.parse({ ...input, requestId: "retry" }));
  assert.throws(() => handoffInput.parse({ ...input, expectedStamp: "" }));
  assert.throws(() => handoffInput.parse({ ...input, kind: "DELETE" }));
});
test("source revisions detect changed ownership, copies, physical storage and provenance", () => {
  const lot = {
    id: "lot",
    currentOwnerId: "owner",
    cardId: "printing",
    quantity: 5,
    locationId: "box",
    locationSection: "B",
    originalOpenerId: "opener",
    foilStatus: "NONFOIL",
    foil: false,
    condition: "NM",
    language: "EN",
    sourceType: "MANUAL",
    roundId: null,
    acquiredFromPullId: null,
    notes: "original note",
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  } as InventoryItem;
  const stamp = handoffStamp(lot);
  assert.equal(stamp, handoffStamp({ ...lot }));
  for (const changed of [
    { currentOwnerId: "other" },
    { cardId: "other printing" },
    { quantity: 4 },
    { locationId: "deck" },
    { locationSection: "C" },
    { originalOpenerId: null },
    { foilStatus: "FOIL" },
    { condition: "LP" },
    { language: "JA" },
    { sourceType: "TRADE" },
    { roundId: "league" },
    { acquiredFromPullId: "pull" },
    { notes: "new note" },
    { updatedAt: new Date("2026-01-02T00:00:00Z") },
  ])
    assert.notEqual(
      handoffStamp({ ...lot, ...changed } as InventoryItem),
      stamp,
    );
});
