import assert from "node:assert/strict";
import test from "node:test";
import { scopedPublicInventoryParams, publicInventoryRowsWithoutPricing } from "../lib/public-inventory-scope";
import { inventorySortHref } from "../components/inventorySortNavigation";

const member = { username: "shop", ownerPlayerId: "store-player", displayName: "Local Store", hidePricing: true };

test("sorting stays on the personalized collection route and resets only pagination", () => {
  const url = new URL(inventorySortHref("/public/inventory/shop", "cardName=Bolt&page=3&displayMode=grouped", "quantity", "desc"), "https://example.test");
  assert.equal(url.pathname, "/public/inventory/shop");
  assert.equal(url.searchParams.get("cardName"), "Bolt");
  assert.equal(url.searchParams.get("displayMode"), "grouped");
  assert.equal(url.searchParams.get("sort"), "quantity");
  assert.equal(url.searchParams.has("page"), false);
});

test("personalized browsing removes arbitrary owner overrides while preserving card filters", () => {
  const params = { owner: ["heather", "brian"], ownerId: "other", cardName: "Bolt", language: ["EN", "FR"], page: "2" };
  const next = scopedPublicInventoryParams(params, member);
  assert.equal(next.owner, undefined);
  assert.equal(next.ownerId, undefined);
  assert.deepEqual(next.language, ["EN", "FR"]);
  assert.equal(next.cardName, "Bolt");
  assert.equal(next.page, "2");
  assert.deepEqual(params.owner, ["heather", "brian"]);
});

test("price-free links discard price filters/sort but normal views retain them", () => {
  const params = { priceMin: "5", priceMax: "100", sort: "preferredPriceLabel", sortDir: "desc", finish: "foil", hidePricing: "0" };
  assert.deepEqual(scopedPublicInventoryParams(params, member), { finish: "foil", hidePricing: "0" });
  assert.deepEqual(scopedPublicInventoryParams(params, { ...member, hidePricing: false }), params);
  assert.equal(scopedPublicInventoryParams(params), params);
});

test("price-free client rows omit all quote and history fields without changing quantities or references", () => {
  const row = { cardName: "Bolt", quantity: 4, priceUsd: "12", priceEur: "10", priceHistory: [{ price: "3" }], preferredPriceLabel: "$12", printings: [{ quantity: 4 }] };
  assert.deepEqual(publicInventoryRowsWithoutPricing([row]), [{ cardName: "Bolt", quantity: 4, printings: row.printings }]);
  assert.equal(row.priceUsd, "12");
});
