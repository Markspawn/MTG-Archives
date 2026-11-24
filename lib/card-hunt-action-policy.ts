import { z } from "zod";
import { handoffInput, handoffHash } from "./card-handoff-policy";
import { cardHuntInput } from "./card-hunt-service";

const selection = z
  .object({
    requestId: z.string().min(1).max(500),
    inventoryItemId: z.string().min(1).max(200),
    quantity: z.number().int().positive().max(2147483647),
    stamp: z.string().regex(/^[a-f0-9]{64}$/),
    targetStamp: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const base = {
  requestId: z.string().uuid(),
  hunt: cardHuntInput,
  selected: z.array(selection).min(1).max(500),
};
export const huntActionInput = z
  .discriminatedUnion("action", [
    z.object({ ...base, action: z.literal("COMMIT") }).strict(),
    z
      .object({
        ...base,
        action: z.literal("GIVE"),
        kind: handoffInput.shape.kind,
        recipient: handoffInput.shape.recipient,
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    const keys = value.selected.map((move) =>
      JSON.stringify([move.requestId, move.inventoryItemId]),
    );
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", message: "Choose each pull only once." });
  });
export type HuntActionInput = z.infer<typeof huntActionInput>;
export function huntActionHash(input: HuntActionInput) {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return handoffHash({
    ...input,
    selected: [...input.selected].sort(
      (a, b) =>
        compare(a.requestId, b.requestId) ||
        compare(a.inventoryItemId, b.inventoryItemId),
    ),
  });
}
export type HuntActionResult = {
  requestId: string;
  status: "APPLIED" | "REJECTED";
  action: "COMMIT" | "GIVE";
  quantity: number;
  entries: number;
  message: string;
  destinations: Array<{ name: string; quantity: number; deckId?: string }>;
  handoffIds: string[];
  stockUpdates: Array<{ id: string; stamp: string }>;
  replay?: boolean;
};
