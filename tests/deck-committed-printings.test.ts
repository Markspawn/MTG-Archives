import assert from "node:assert/strict";
import test from "node:test";
import { planCommittedDeckPrintings } from "../lib/deck-committed-printings";

const row = (id: string, cardId: string | null, quantity = 4, oracleId: string | null = "ring") => ({ id, cardId, quantity, oracleId, cardName: "Sol Ring" });
const stock = (cardId: string, quantity: number, oracleId: string | null = "ring", name = "Sol Ring") => ({ cardId, quantity, card: { id: cardId, oracleId, name } });

test("alternate pulled printing replaces the deck printing without changing demand", () => {
  const [plan] = planCommittedDeckPrintings([row("a", "preferred", 2)], [stock("actual", 2)]);
  assert.deepEqual(plan.printings, [{ cardId: "actual", quantity: 2 }]);
  assert.equal(plan.changed, true);
  assert.equal(plan.committed, 2);
});
test("mixed committed printings become separate quantities; unfilled demand stays preferred", () => {
  const [plan] = planCommittedDeckPrintings([row("a", "preferred")], [stock("preferred", 1), stock("alternate", 1)]);
  assert.deepEqual(plan.printings, [{ cardId: "preferred", quantity: 3 }, { cardId: "alternate", quantity: 1 }]);
  assert.equal(plan.committed, 2);
});
test("every exact printing is allocated before alternatives across deck rows/sections", () => {
  const plans = planCommittedDeckPrintings([row("a", "missing", 2), row("b", "actual", 2)], [stock("actual", 3)]);
  assert.deepEqual(plans.map(plan => plan.committed), [1, 2]);
  assert.deepEqual(plans[0].printings, [{ cardId: "missing", quantity: 1 }, { cardId: "actual", quantity: 1 }]);
  assert.equal(plans[1].changed, false);
});
test("the same physical copies cannot satisfy duplicate deck rows twice", () => {
  const plans = planCommittedDeckPrintings([row("a", "preferred", 2), row("b", "preferred", 2)], [stock("preferred", 3)]);
  assert.deepEqual(plans.map(plan => plan.committed), [2, 1]);
  assert(plans.every(plan => !plan.changed));
});
test("unresolved rows accept actual cards by normalized name", () => {
  const [plan] = planCommittedDeckPrintings([{ ...row("a", null, 1, null), cardName: " sol  ring " }], [stock("actual", 1)]);
  assert.deepEqual(plan.printings, [{ cardId: "actual", quantity: 1 }]);
});
test("different oracle IDs, surplus stock, zero lots and untouched demand cannot rewrite cards", () => {
  const rows = [row("a", "preferred", 2)];
  assert.equal(planCommittedDeckPrintings(rows, [stock("other", 10, "other")])[0].changed, false);
  assert.equal(planCommittedDeckPrintings(rows, [stock("alternate", 0)])[0].changed, false);
  const [plan] = planCommittedDeckPrintings(rows, [stock("preferred", 100), stock("alternate", 2)]);
  assert.equal(plan.committed, 2);
  assert.deepEqual(plan.printings, [{ cardId: "preferred", quantity: 2 }]);
});
test("a split deck list is stable on subsequent reconciliation", () => {
  const items = [stock("preferred", 1), stock("alternate", 2), stock("third", 1)];
  const first = planCommittedDeckPrintings([row("a", "preferred", 5)], items)[0];
  const split = first.printings.map((part, index) => row(String(index), part.cardId, part.quantity));
  const again = planCommittedDeckPrintings(split, items);
  assert(again.every(plan => !plan.changed));
  assert.equal(again.reduce((sum, plan) => sum + plan.committed, 0), 4);
  assert.equal(split.reduce((sum, item) => sum + item.quantity, 0), 5);
});
test("Masters of Evil basics: one committed printing leaves the other printing unfilled", () => {
  const cards = ["Island", "Mountain", "Swamp"];
  const rows = cards.flatMap(name => ["a", "b"].map(printing => ({ id: name + printing, cardId: name + printing, oracleId: name, cardName: name, quantity: 1 })));
  const committed = cards.map(name => stock(name + "a", 1, name, name));
  const plans = planCommittedDeckPrintings(rows, committed);
  assert.deepEqual(plans.map(plan => plan.committed), [1, 0, 1, 0, 1, 0]);
  assert.equal(plans.reduce((sum, plan) => sum + plan.committed, 0), 3);
  assert(plans.every(plan => !plan.changed));
});
