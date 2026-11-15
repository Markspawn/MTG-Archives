import { Prisma, type PrismaClient } from "@prisma/client";
import {
  summarizeCollectionAdditions,
  type AdditionGroup,
} from "./collection-additions";

// Only actual receipt actions qualify. A newly created row can also be a split,
// move, deck return or restoration, so InventoryItem timestamps are insufficient.
const receiptActions = [
  "inventory_added",
  "import_committed",
  "acquisition_committed",
  "trade_completed",
];

function quantity(json: Prisma.Sql, field: string) {
  // Audit snapshots contain JSON numbers. Malformed/legacy facts must not crash
  // the dashboard or silently turn a whole merged stack into a new addition.
  return Prisma.sql`CASE WHEN jsonb_typeof(${json}->${field}) = 'number'
    AND (${json}->>${field}) ~ '^[0-9]{1,10}$'
    THEN CASE WHEN (${json}->>${field})::bigint <= 2147483647
      THEN (${json}->>${field})::bigint ELSE NULL END
    ELSE NULL END`;
}

export async function getCollectionAdditions(
  db: Pick<PrismaClient, "$queryRaw">,
  ownerId: string | null | undefined,
  preferredProvider = "scryfall",
  now = new Date(),
) {
  if (!ownerId) return summarizeCollectionAdditions([]);
  const after = Prisma.sql`a."afterJson"`;
  const before = Prisma.sql`a."beforeJson"`;
  const groups = await db.$queryRaw<AdditionGroup[]>(Prisma.sql`
    WITH receipts AS (
      SELECT a."createdAt", COALESCE(i."cardId", a."afterJson"->>'cardId') AS "cardId",
        COALESCE(i."foilStatus"::text, a."afterJson"->>'foilStatus',
          CASE WHEN a."afterJson"->>'foil' = 'true' THEN 'FOIL' ELSE 'NONFOIL' END) AS "foilStatus",
        CASE WHEN a."changeType" = 'trade_completed' THEN
          CASE WHEN a."afterJson"->>'newOwnerId' = ${ownerId}
            AND a."afterJson"->>'previousOwnerId' IS DISTINCT FROM ${ownerId}
            AND a."afterJson"->>'deleted' IS DISTINCT FROM 'true'
          THEN COALESCE(${quantity(after, "quantityTransferred")}, 0) ELSE 0 END
        ELSE COALESCE(${quantity(after, "quantityAdded")}, ${quantity(after, "quantityImported")},
          GREATEST(0, COALESCE(${quantity(after, "quantity")}, 0) - COALESCE(${quantity(before, "quantity")}, 0)))
        END AS copies
      FROM "InventoryAuditLog" a
      LEFT JOIN "InventoryItem" i ON i.id = COALESCE(a."inventoryItemId", a."afterJson"->>'id', a."afterJson"->>'inventoryItemId')
        AND i."currentOwnerId" = ${ownerId}
      WHERE a."createdAt" >= ${new Date(now.getTime() - 720 * 3600000)}
        AND a."createdAt" <= ${now}
        AND a."changeType" IN (${Prisma.join(receiptActions)})
        AND a."afterJson"->>'currentOwnerId' = ${ownerId}
    ), totals AS (
      SELECT "cardId", "foilStatus",
        SUM(copies) FILTER (WHERE "createdAt" >= ${new Date(now.getTime() - 24 * 3600000)}) AS "copies24h",
        SUM(copies) FILTER (WHERE "createdAt" >= ${new Date(now.getTime() - 72 * 3600000)}) AS "copies3d",
        SUM(copies) FILTER (WHERE "createdAt" >= ${new Date(now.getTime() - 168 * 3600000)}) AS "copies7d",
        SUM(copies) AS "copies30d"
      FROM receipts WHERE copies > 0 GROUP BY "cardId", "foilStatus"
    )
    SELECT t."foilStatus", c.prices,
      COALESCE(t."copies24h", 0)::bigint AS "copies24h",
      COALESCE(t."copies3d", 0)::bigint AS "copies3d",
      COALESCE(t."copies7d", 0)::bigint AS "copies7d", t."copies30d"::bigint AS "copies30d"
    FROM totals t LEFT JOIN "Card" c ON c.id = t."cardId"
  `);
  return summarizeCollectionAdditions(groups, preferredProvider);
}
