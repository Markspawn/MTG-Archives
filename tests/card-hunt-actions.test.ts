import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { cardHuntInput } from "../lib/card-hunt-service";
import {
  huntActionInput,
  huntActionHash,
  type HuntActionResult,
} from "../lib/card-hunt-action-policy";
import { advanceHunt, huntPickKey } from "../lib/card-hunt-progress";
import { planCardHunt, type HuntStock } from "../lib/card-hunt";
import {
  parsePendingHuntAction,
  verifiedHuntOutcome,
} from "../lib/card-hunt-pending";

const stock: HuntStock = {
  id: "lot",
  ownerId: "owner",
  quantity: 5,
  reserved: 1,
  cardId: "card",
  oracleId: "oracle",
  name: "Card",
  setCode: "tst",
  collectorNumber: "1",
  finish: "NONFOIL",
  language: "EN",
  condition: "NM",
  stamp: "a".repeat(64),
  location: {
    id: "box",
    name: "Box",
    section: "B",
    ownerId: "owner",
    active: true,
    isDeck: false,
  },
};
const hunt = {
  sources: [
    { kind: "DECK" as const, id: "a", deckId: "deck-a" },
    { kind: "DECK" as const, id: "b", deckId: "deck-b" },
    { kind: "LIST" as const, id: "c", label: "For Pat", text: "1 Card" },
  ],
  mode: "preferences" as const,
  finish: "ANY" as const,
  includeMaybeboard: false,
  ignoreBasicLands: false,
};
test("pending confirmations retain the same request across reload and malformed or partial acknowledgements cannot clear it", () => {
  const input = huntActionInput.parse({
    requestId: randomUUID(),
    action: "GIVE",
    kind: "GIFT",
    recipient: { type: "EXTERNAL", name: "Pat" },
    hunt,
    selected: [
      {
        requestId: "a",
        inventoryItemId: "lot",
        quantity: 2,
        stamp: "a".repeat(64),
      },
    ],
  });
  const frozen = {
    version: 1,
    input,
    recipientLabel: "Pat",
    summary: [
      { name: "Card", quantity: 2, destination: "For Pat", printing: "TST1" },
    ],
  };
  assert.deepEqual(parsePendingHuntAction(JSON.stringify(frozen)), frozen);
  for (const raw of [
    "{",
    JSON.stringify({ ...frozen, input: { ...input, selected: null } }),
    JSON.stringify({ ...frozen, version: 2 }),
    JSON.stringify({
      ...frozen,
      input: { ...input, selected: [{ ...input.selected[0], stamp: "bad" }] },
    }),
  ])
    assert.throws(() => parsePendingHuntAction(raw));
  const result: HuntActionResult = {
    requestId: input.requestId,
    status: "APPLIED",
    action: "GIVE",
    quantity: 2,
    entries: 1,
    message: "Given",
    destinations: [{ name: "Pat", quantity: 2 }],
    handoffIds: ["receipt"],
    stockUpdates: [{ id: "lot", stamp: "b".repeat(64) }],
  };
  assert(verifiedHuntOutcome(result, input));
  assert(!verifiedHuntOutcome({ ...result, requestId: randomUUID() }, input));
  assert(!verifiedHuntOutcome({ ...result, quantity: 1 }, input));
  assert(!verifiedHuntOutcome({ ...result, entries: 2 }, input));
  assert(!verifiedHuntOutcome({ ...result, stockUpdates: [null] }, input));
  assert(!verifiedHuntOutcome({}, input));
});
test("combined sources are explicit, bounded and cannot repeat a deck or source identity", () => {
  assert(cardHuntInput.safeParse(hunt).success);
  assert(!cardHuntInput.safeParse({ ...hunt, deckId: "another" }).success);
  assert(
    !cardHuntInput.safeParse({
      ...hunt,
      sources: [
        hunt.sources[0],
        { kind: "DECK", id: "other", deckId: "deck-a" },
      ],
    }).success,
  );
  assert(
    !cardHuntInput.safeParse({
      ...hunt,
      sources: [
        hunt.sources[0],
        { kind: "LIST", id: "a", label: "Other", text: "1 Card" },
      ],
    }).success,
  );
  assert(
    !cardHuntInput.safeParse({
      ...hunt,
      sources: Array.from({ length: 21 }, (_, i) => ({
        kind: "LIST",
        id: String(i),
        label: "List",
        text: "1 Card",
      })),
    }).success,
  );
  assert(
    !cardHuntInput.safeParse({
      ...hunt,
      sources: [
        { kind: "LIST", id: "a", label: "A", text: "x".repeat(60000) },
        { kind: "LIST", id: "b", label: "B", text: "x".repeat(60000) },
      ],
    }).success,
  );
});
test("multiple destinations add demand and use physical stock only once", () => {
  const requests = [
    {
      id: "a",
      name: "Card",
      quantity: 3,
      alreadyInDeck: 1,
      sourceLabel: "Deck A",
      deckId: "deck-a",
      deckCardId: "row-a",
      targetStamp: "b".repeat(64),
    },
    {
      id: "b",
      name: "Card",
      quantity: 2,
      sourceLabel: "Deck B",
      deckId: "deck-b",
      deckCardId: "row-b",
    },
    { id: "c", name: "Card", quantity: 1, sourceLabel: "For Pat" },
  ];
  for (const mode of ["preferences", "boxes"] as const) {
    const plan = planCardHunt({
      ownerId: "owner",
      requests,
      stock: [stock],
      mode,
      finish: "ANY",
    });
    assert.equal(plan.requested, 6);
    assert.equal(plan.alreadyInDeck, 1);
    assert.equal(plan.planned, 4);
    assert.equal(plan.shortage, 1);
    assert.equal(
      plan.boxes
        .flatMap((box) => box.picks)
        .reduce((sum, pick) => sum + pick.quantity, 0),
      4,
    );
    for (const pick of plan.boxes.flatMap((box) => box.picks)) {
      assert.equal(pick.stamp, stock.stamp);
      assert.equal(
        pick.sourceLabel,
        requests.find((row) => row.id === pick.requestId)!.sourceLabel,
      );
    }
  }
});
test("confirmation hashes normalize selection ordering and reject duplicate, negative or unstamped selections", () => {
  const a = {
      requestId: "a",
      inventoryItemId: "lot",
      quantity: 1,
      stamp: "a".repeat(64),
      targetStamp: "b".repeat(64),
    },
    b = { ...a, requestId: "b" };
  const input = huntActionInput.parse({
    requestId: randomUUID(),
    action: "COMMIT",
    hunt,
    selected: [a, b],
  });
  assert.equal(
    huntActionHash(input),
    huntActionHash({ ...input, selected: [b, a] }),
  );
  assert(!huntActionInput.safeParse({ ...input, selected: [a, a] }).success);
  for (const quantity of [0, -1, 1.5, Infinity, 2147483648])
    assert(
      !huntActionInput.safeParse({ ...input, selected: [{ ...a, quantity }] })
        .success,
    );
  assert(
    !huntActionInput.safeParse({
      ...input,
      selected: [{ ...a, stamp: "guessed" }],
    }).success,
  );
  assert(
    !huntActionInput.safeParse({ ...input, ownerPlayerId: "other" }).success,
  );
  assert(
    !huntActionInput.safeParse({
      ...input,
      action: "GIVE",
      kind: "GIFT",
      recipient: { type: "EXTERNAL", name: " " },
    }).success,
  );
});
test("completed pulls are removed without reoffering gifts, and shared-lot revisions refresh remaining picks", () => {
  const plan = planCardHunt({
    ownerId: "owner",
    requests: [
      { id: "a", name: "Card", quantity: 2, sourceLabel: "A" },
      { id: "b", name: "Card", quantity: 2, sourceLabel: "B" },
    ],
    stock: [stock],
    mode: "boxes",
    finish: "ANY",
  });
  const before = JSON.stringify(plan),
    pick = plan.boxes[0].picks[0];
  const result: HuntActionResult = {
    requestId: randomUUID(),
    status: "APPLIED",
    action: "GIVE",
    quantity: 1,
    entries: 1,
    message: "Given",
    destinations: [{ name: "Pat", quantity: 1 }],
    handoffIds: ["history"],
    stockUpdates: [{ id: "lot", stamp: "c".repeat(64) }],
  };
  const next = advanceHunt(plan, [{ ...pick, quantity: 1 }], result);
  assert.equal(next.planned, 3);
  assert.equal(next.alreadyInDeck, 0);
  assert.equal(
    next.boxes
      .flatMap((box) => box.picks)
      .reduce((sum, pick) => sum + pick.quantity, 0),
    3,
  );
  assert(next.boxes[0].picks.every((pick) => pick.stamp === "c".repeat(64)));
  assert.equal(JSON.stringify(plan), before);
  const commit = advanceHunt(plan, [{ ...pick, quantity: 1 }], {
    ...result,
    action: "COMMIT",
  });
  assert.equal(commit.alreadyInDeck, 1);
  assert.equal(
    commit.lines.find((line) => line.request.id === pick.requestId)!.request
      .alreadyInDeck,
    1,
  );
  assert.equal(
    advanceHunt(plan, [pick], { ...result, status: "REJECTED" }),
    plan,
  );
  assert.notEqual(
    huntPickKey(pick),
    huntPickKey({ ...pick, requestId: "other" }),
  );
});
