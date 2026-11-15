import assert from "node:assert/strict";
import test from "node:test";
import {
  additionPriceUsd,
  summarizeCollectionAdditions,
} from "../lib/collection-additions";
import { getCollectionAdditions } from "../lib/collection-additions-store";

test("summarizes physical copies and partial values independently for overlapping periods", () => {
  const result = summarizeCollectionAdditions([
    {
      foilStatus: "NONFOIL",
      prices: { usd: "2.50" },
      copies24h: 2n,
      copies3d: 3n,
      copies7d: 4n,
      copies30d: 10n,
    },
    {
      foilStatus: "FOIL",
      prices: { usd: "100", usd_foil: null },
      copies24h: 1,
      copies3d: 1,
      copies7d: 2,
      copies30d: 3,
    },
  ]);
  assert.deepEqual(
    result.map((r) => [r.copies, r.valueUsd, r.unpricedCopies]),
    [
      [3, 5, 1],
      [4, 7.5, 1],
      [6, 10, 2],
      [13, 25, 3],
    ],
  );
});

test("uses the requested finish and USD only, with zero prices still known", () => {
  assert.equal(
    additionPriceUsd({ usd: "0", usd_foil: "8" }, "NONFOIL", "scryfall"),
    0,
  );
  assert.equal(
    additionPriceUsd(
      { usd: "1", usd_foil: "8", usd_etched: "12" },
      "ETCHED",
      "scryfall",
    ),
    12,
  );
  assert.equal(additionPriceUsd({ usd: "1" }, "FOIL", "scryfall"), null);
  assert.equal(additionPriceUsd({ usd: "-1" }, "NONFOIL", "scryfall"), null);
  assert.equal(
    additionPriceUsd(
      {
        mtgjson: { cardmarket: { normal: { retail: { EUR: { amount: 9 } } } } },
      },
      "NONFOIL",
      "cardmarket",
    ),
    null,
  );
  assert.equal(
    additionPriceUsd(
      {
        usd: "1",
        mtgjson: { tcgplayer: { foil: { retail: { USD: { amount: 7 } } } } },
      },
      "FOIL",
      "tcgplayer",
    ),
    7,
  );
});

test("missing owner never queries or exposes history", async () => {
  const db = {
    $queryRaw: () => {
      throw new Error("must not query");
    },
  };
  const result = await getCollectionAdditions(db as any, null);
  assert.ok(
    result.every(
      (r) => r.copies === 0 && r.valueUsd === 0 && r.unpricedCopies === 0,
    ),
  );
});
