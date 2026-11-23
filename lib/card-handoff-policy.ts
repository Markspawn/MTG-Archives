import { createHash } from "node:crypto";
import type { InventoryItem } from "@prisma/client";
import { z } from "zod";

const identity = z.string().min(1).max(200);
export const handoffInput = z
  .object({
    requestId: z.string().uuid(),
    inventoryItemId: identity,
    expectedStamp: z.string().regex(/^[a-f0-9]{64}$/),
    quantity: z.number().int().positive().max(2147483647),
    kind: z.enum(["GIFT", "TRADE"]),
    recipient: z.discriminatedUnion("type", [
      z.object({ type: z.literal("ARCHIVE"), playerId: identity }).strict(),
      z
        .object({
          type: z.literal("EXTERNAL"),
          name: z
            .string()
            .trim()
            .min(1)
            .max(120)
            .refine(
              (value) => !/[\u0000-\u001f\u007f]/.test(value),
              "Enter a recipient name without control characters",
            )
            .transform((value) => value.replace(/\s+/g, " ")),
        })
        .strict(),
    ]),
  })
  .strict();
export type HandoffInput = z.infer<typeof handoffInput>;
export const handoffHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function handoffStamp(item: InventoryItem) {
  return handoffHash([
    item.id,
    item.currentOwnerId,
    item.cardId,
    item.quantity,
    item.locationId,
    item.locationSection,
    item.originalOpenerId,
    item.foilStatus,
    item.foil,
    item.condition,
    item.language,
    item.sourceType,
    item.roundId,
    item.acquiredFromPullId,
    item.notes,
    item.updatedAt.toISOString(),
  ]);
}
