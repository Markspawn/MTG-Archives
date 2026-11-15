import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import { getCollectionAdditions } from "../../lib/collection-additions-store";

const url = new URL(process.env.DATABASE_URL!);
assert.ok(
  ["127.0.0.1", "localhost", "mtg-dashboard-additions-db"].includes(
    url.hostname,
  ),
);
assert.ok(
  ["/trade_audit_fixture", "/dashboard_additions_review"].includes(
    url.pathname,
  ),
);
const db = new PrismaClient();
const rollback = new Error("rollback disposable additions fixture");
let checked = false;
try {
  await db.$transaction(
    async (tx) => {
      const tag = `additions-${randomUUID()}`;
      const owner = await tx.player.create({ data: { name: tag, displayName: tag } });
      const other = await tx.player.create({ data: { name: `${tag}-other`, displayName: `${tag}-other` } });
      const card = await tx.card.create({
        data: {
          scryfallId: tag,
          name: tag,
          typeLine: "Artifact",
          setCode: "tst",
          collectorNumber: "1",
          rarity: "common",
          prices: { usd: "2", usd_foil: null },
        },
      });
      const corrected = await tx.card.create({
        data: {
          scryfallId: `${tag}-corrected`,
          name: tag,
          typeLine: "Artifact",
          setCode: "tst",
          collectorNumber: "2",
          rarity: "common",
          prices: { usd: "4" },
        },
      });
      const item = await tx.inventoryItem.create({
        data: {
          cardId: corrected.id,
          currentOwnerId: owner.id,
          originalOpenerId: null,
          quantity: 1,
          condition: "NM",
        },
      });
      const now = new Date("2026-11-15T12:00:00Z");
      const at = (hours: number, offset = 0) =>
        new Date(now.getTime() - hours * 3600000 + offset);
      async function receipt(
        hours: number,
        quantity: number,
        extra: Record<string, any> = {},
        action = "acquisition_committed",
        before: Record<string, any> = { quantity: 0 },
        offset = 0,
      ) {
        await tx.inventoryAuditLog.create({
          data: {
            changeType: action,
            beforeJson: before,
            afterJson: {
              currentOwnerId: owner.id,
              cardId: card.id,
              foilStatus: "NONFOIL",
              quantity,
              ...extra,
            },
            createdAt: at(hours, offset),
          },
        });
      }
      await receipt(1, 2);
      await receipt(24, 105, { quantityAdded: 5 }, "inventory_added", {
        quantity: 100,
      });
      await receipt(24, 1, {}, "acquisition_committed", { quantity: 0 }, -1);
      await receipt(72, 103, { quantityImported: 3 }, "import_committed", {
        quantity: 100,
      });
      await receipt(72, 4, {}, "acquisition_committed", {}, -1);
      await receipt(168, 5);
      await receipt(168, 6, {}, "acquisition_committed", {}, -1);
      await receipt(720, 7);
      await receipt(720, 8, {}, "acquisition_committed", {}, -1);
      await receipt(-1, 9);
      await receipt(
        1,
        3,
        {
          newOwnerId: owner.id,
          previousOwnerId: other.id,
          quantityTransferred: 3,
        },
        "trade_completed",
      );
      await receipt(
        1,
        91,
        {
          newOwnerId: owner.id,
          previousOwnerId: owner.id,
          quantityTransferred: 9,
        },
        "trade_completed",
        { quantity: 100 },
      );
      await receipt(
        1,
        0,
        {
          newOwnerId: null,
          previousOwnerId: owner.id,
          quantityTransferred: 9,
          deleted: true,
        },
        "trade_completed",
        { quantity: 9 },
      );
      await receipt(1, 999, { currentOwnerId: other.id });
      for (const action of [
        "inventory_restored",
        "inventory_edited",
        "location_moved",
        "returned_from_deck",
        "quantity_adjusted",
      ])
        await receipt(1, 1000, {}, action);
      await receipt(1, 2, { foilStatus: "FOIL" });
      // Historical creation audit lost its FK on deletion; the stable snapshot ID
      // still finds the restored/corrected lot without counting its restore event.
      await receipt(1, 1, { id: item.id });
      await receipt(1, 1); // Deleted lot still counts as a historical addition.
      for (const bad of ["bad", 9999999999, -1, 1.2])
        await receipt(1, bad as any);
      await receipt(1, 0);
      const started = performance.now();
      const result = await getCollectionAdditions(
        tx,
        owner.id,
        "scryfall",
        now,
      );
      assert.deepEqual(
        result.map((r) => [r.copies, r.valueUsd, r.unpricedCopies]),
        [
          [14, 26, 2],
          [18, 34, 2],
          [27, 52, 2],
          [40, 78, 2],
        ],
      );
      assert.ok(
        (await getCollectionAdditions(tx, other.id, "scryfall", now)).every(
          (r) => r.copies === 999,
        ),
      );
      console.log(
        JSON.stringify({
          kind: "collection-additions-postgres-pass",
          cases:
            "rolling boundaries, future dates, merged receipts, incoming/outgoing/same-owner trades, owner isolation, restored/corrected/deleted lots, malformed quantities, exact finish and partial pricing",
          queryMs: Math.round(performance.now() - started),
          summaries: result,
        }),
      );
      checked = true;
      throw rollback;
    },
    {
      timeout: 20000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  );
} catch (error) {
  if (error !== rollback) throw error;
} finally {
  await db.$disconnect();
}
assert.ok(checked);
