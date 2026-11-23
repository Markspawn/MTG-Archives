import { Prisma, type PrismaClient } from "@prisma/client";
import { isAdminUser } from "./auth-policy";
import { handoffHash, handoffInput, handoffStamp } from "./card-handoff-policy";
import { ensureDefaultLocation } from "./inventory-locations";
import { lockInventoryDestinations } from "./inventory-capacity";
import { recordInventoryAudit } from "./inventory-audit";
import { writeInventoryReceipt } from "./inventory-receipt";
import { receivedTradeInventoryData } from "./trade-inventory";
import { buildReservedInventoryQuantities } from "./trade-lines";
import { fulfillCompletedTradeWishlists } from "./trade-wishlist";
import { z } from "zod";
import { randomUUID } from "node:crypto";

type Db = Prisma.TransactionClient;
export type HandoffActor = { userId: string; adminMode: boolean };
export class HandoffError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
const activeStatuses = [
  "PROPOSED",
  "ACCEPTED_PENDING_EXCHANGE",
  "PARTIALLY_COMMITTED",
] as const;
async function actorFor(db: Db, actor: HandoffActor) {
  const user = await db.user.findUnique({
    where: { id: actor.userId },
    include: { player: true },
  });
  const admin = actor.adminMode && isAdminUser(user, user?.player);
  if (
    !user?.isActive ||
    user.forcePasswordChange ||
    (!admin && (!user.playerId || !user.player?.active))
  )
    throw new HandoffError("Sign in with an active inventory account.");
  return { user, admin };
}
async function reserved(db: Db, ids: string[]) {
  const [lines, legacy] = await Promise.all([
    db.tradeLine.findMany({
      where: {
        inventoryItemId: { in: ids },
        trade: { status: { in: [...activeStatuses] } },
      },
      select: { inventoryItemId: true, quantity: true },
    }),
    db.trade.findMany({
      where: {
        status: { in: [...activeStatuses] },
        lines: { none: {} },
        OR: [
          { offeredInventoryItemId: { in: ids } },
          { requestedInventoryItemId: { in: ids } },
        ],
      },
      select: { offeredInventoryItemId: true, requestedInventoryItemId: true },
    }),
  ]);
  return buildReservedInventoryQuantities(lines, legacy);
}
function unavailable(
  location: {
    kind: string;
    systemManaged: boolean;
    type: string | null;
  } | null,
) {
  if (
    location?.kind === "DECK" ||
    location?.systemManaged ||
    location?.type === "Deck"
  )
    return "Return committed cards from the deck first.";
  return null;
}

const historyFacts = z.object({
  card: z.object({
    setCode: z.string(),
    collectorNumber: z.string(),
    imageUri: z.string().nullable(),
  }),
  lot: z.object({
    foilStatus: z.string(),
    condition: z.string(),
    language: z.string(),
  }),
});
type HistoryInput = {
  ownerId?: string;
  cardId?: string;
  query?: string;
  direction?: string;
  before?: string;
};
export function getHandoffHistory(
  db: PrismaClient,
  actor: HandoffActor,
  input: HistoryInput,
) {
  return db.$transaction((tx) => readHandoffHistory(tx, actor, input), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    timeout: 10000,
  });
}
async function readHandoffHistory(
  db: Db,
  actor: HandoffActor,
  input: HistoryInput,
) {
  const access = await actorFor(db, actor),
    ownerId = access.admin
      ? input.ownerId || access.user.playerId
      : access.user.playerId;
  if (!ownerId)
    throw new HandoffError("Choose an inventory owner to see their history.");
  if (input.ownerId && input.ownerId !== ownerId)
    throw new HandoffError("You can only view your own handoff history.", 403);
  const direction =
    input.direction === "received"
      ? "received"
      : input.direction === "all"
        ? "all"
        : "given";
  const query = (input.query ?? "").trim().slice(0, 120);
  let boundary: Prisma.CardHandoffWhereInput = {};
  if (input.before) {
    try {
      const cursor = z
        .object({ id: z.string().min(1).max(200), at: z.string().datetime() })
        .strict()
        .parse(
          JSON.parse(
            Buffer.from(input.before.slice(0, 1024), "base64url").toString(
              "utf8",
            ),
          ),
        );
      boundary = {
        OR: [
          { createdAt: { lt: new Date(cursor.at) } },
          { createdAt: new Date(cursor.at), id: { lt: cursor.id } },
        ],
      };
    } catch {
      throw new HandoffError(
        "That history page is invalid. Start from the first page.",
        400,
      );
    }
  }
  const rows = await db.cardHandoff.findMany({
    where: {
      AND: [
        direction === "all"
          ? { OR: [{ fromPlayerId: ownerId }, { toPlayerId: ownerId }] }
          : direction === "received"
            ? { toPlayerId: ownerId }
            : { fromPlayerId: ownerId },
        ...(input.cardId ? [{ cardId: input.cardId }] : []),
        ...(query
          ? [
              {
                OR: [
                  {
                    cardName: { contains: query, mode: "insensitive" as const },
                  },
                  {
                    recipientName: {
                      contains: query,
                      mode: "insensitive" as const,
                    },
                  },
                  {
                    senderName: {
                      contains: query,
                      mode: "insensitive" as const,
                    },
                  },
                ],
              },
            ]
          : []),
        boundary,
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 51,
  });
  const last = rows[49];
  return {
    ownerId,
    direction,
    query,
    rows: rows.slice(0, 50).map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      cardId: row.cardId,
      cardName: row.cardName,
      quantity: row.quantity,
      kind: row.kind,
      incoming: row.toPlayerId === ownerId,
      internal: Boolean(row.toPlayerId),
      senderName: row.senderName,
      recipientName: row.recipientName,
      // Never send source notes, location, transaction hashes or other receipt
      // internals to a recipient's rendered history.
      facts: historyFacts.parse(row.snapshot),
    })),
    next:
      rows.length > 50
        ? Buffer.from(
            JSON.stringify({ id: last.id, at: last.createdAt.toISOString() }),
          ).toString("base64url")
        : null,
  };
}
export function getHandoffOptions(
  db: PrismaClient,
  actor: HandoffActor,
  itemIds: string[],
) {
  return db.$transaction((tx) => readHandoffOptions(tx, actor, itemIds), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    timeout: 10000,
  });
}
async function readHandoffOptions(
  db: Db,
  actor: HandoffActor,
  itemIds: string[],
) {
  const access = await actorFor(db, actor);
  if (
    !itemIds.length ||
    itemIds.length > 1000 ||
    itemIds.some((id) => !id || id.length > 200)
  )
    throw new HandoffError("Choose a card printing first.");
  const items = await db.inventoryItem.findMany({
    where: {
      id: { in: [...new Set(itemIds)] },
      quantity: { gt: 0 },
      ...(access.admin ? {} : { currentOwnerId: access.user.playerId! }),
    },
    include: {
      location: true,
      card: { select: { name: true, setCode: true, collectorNumber: true } },
      currentOwner: { select: { displayName: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (!items.length)
    throw new HandoffError(
      "This card is no longer available in your inventory.",
    );
  if (
    new Set(items.map((i) => i.cardId)).size !== 1 ||
    new Set(items.map((i) => i.currentOwnerId)).size !== 1
  )
    throw new HandoffError("Choose one owner's exact card printing.");
  const holds = await reserved(
    db,
    items.map((i) => i.id),
  );
  const [recipients, people] = await Promise.all([
    db.player.findMany({
      where: {
        active: true,
        id: { not: items[0].currentOwnerId },
        users: { some: { isActive: true } },
      },
      select: { id: true, displayName: true },
      orderBy: { displayName: "asc" },
    }),
    db.cardHandoff.findMany({
      where: { fromPlayerId: items[0].currentOwnerId, toPlayerId: null },
      distinct: ["recipientName"],
      select: { recipientName: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  return {
    actorUserId: access.user.id,
    requestId: randomUUID(),
    recipients,
    recentPeople: people.map((p) => p.recipientName),
    lots: items.map((item) => ({
      id: item.id,
      stamp: handoffStamp(item),
      owner: item.currentOwner.displayName,
      cardName: item.card.name,
      setCode: item.card.setCode,
      collectorNumber: item.card.collectorNumber,
      location: item.location?.name ?? "Unassigned",
      section: item.locationSection,
      finish: item.foilStatus,
      condition: item.condition,
      language: item.language,
      available: Math.max(0, item.quantity - (holds.get(item.id) ?? 0)),
      reserved: holds.get(item.id) ?? 0,
      blocked: unavailable(item.location),
    })),
  };
}
/** Immediate handoff is explicitly authorized by Brian, November23. Ordinary
 * negotiated trades retain their acceptance/two-confirmation workflow. */
export async function giveInventoryCard(
  db: PrismaClient,
  actor: HandoffActor,
  raw: unknown,
) {
  const input = handoffInput.parse(raw),
    requestHash = handoffHash(input);
  for (let attempt = 0; ; attempt++)
    try {
      return await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${actor.userId + ":" + input.requestId}, 231123))`;
          await tx.$queryRaw`SELECT id FROM "User" WHERE id=${actor.userId} FOR SHARE`;
          const access = await actorFor(tx, actor);
          const replay = await tx.cardHandoff.findUnique({
            where: {
              actorUserId_requestId: {
                actorUserId: actor.userId,
                requestId: input.requestId,
              },
            },
          });
          if (replay) {
            if (replay.requestHash !== requestHash)
              throw new HandoffError(
                "This confirmation was already used for a different handoff. Open a new one.",
              );
            if (!access.admin && replay.fromPlayerId !== access.user.playerId)
              throw new HandoffError("This handoff is unavailable.");
            return {
              id: replay.id,
              recipientName: replay.recipientName,
              quantity: replay.quantity,
              internal: Boolean(replay.toPlayerId),
              replay: true,
            };
          }
          // Deck stock is never changed by this workflow, so no deck-owner lock is
          // needed. Recheck the fresh location after taking the shared stock lock.
          await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id=${input.inventoryItemId} FOR UPDATE`;
          const source = await tx.inventoryItem.findUnique({
            where: { id: input.inventoryItemId },
            include: {
              location: true,
              currentOwner: true,
              card: {
                select: {
                  name: true,
                  setCode: true,
                  collectorNumber: true,
                  imageUri: true,
                },
              },
            },
          });
          if (
            !source ||
            (!access.admin && source.currentOwnerId !== access.user.playerId)
          )
            throw new HandoffError(
              "This inventory is unavailable or belongs to another person.",
            );
          const blocked = unavailable(source.location);
          if (blocked) throw new HandoffError(blocked);
          if (handoffStamp(source) !== input.expectedStamp)
            throw new HandoffError(
              "This card changed. Reopen the handoff to review the current copies.",
            );
          const holds = await reserved(tx, [source.id]);
          if (input.quantity > source.quantity - (holds.get(source.id) ?? 0))
            throw new HandoffError(
              "That many unreserved copies are no longer available.",
            );
          let recipientName: string,
            toPlayerId: string | null = null,
            receivedInventoryItemId: string | null = null;
          let destinationId: string | null = null;
          if (input.recipient.type === "ARCHIVE") {
            toPlayerId = input.recipient.playerId;
            if (toPlayerId === source.currentOwnerId)
              throw new HandoffError(
                "Choose another person. Use Move to reorganize your own cards.",
              );
            await tx.$queryRaw`SELECT id FROM "Player" WHERE id=${toPlayerId} FOR SHARE`;
            const recipient = await tx.player.findFirst({
              where: {
                id: toPlayerId,
                active: true,
                users: { some: { isActive: true } },
              },
            });
            if (!recipient)
              throw new HandoffError(
                "That Archive recipient is no longer active.",
              );
            recipientName = recipient.displayName;
            // Serialize default creation even when the recipient has no locations.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${toPlayerId}, 231124))`;
            const location = await ensureDefaultLocation(tx, toPlayerId);
            await lockInventoryDestinations(tx, [location.id]);
            const fresh = await tx.inventoryLocation.findUniqueOrThrow({
              where: { id: location.id },
            });
            if (
              !fresh.active ||
              fresh.kind !== "NORMAL" ||
              fresh.systemManaged ||
              fresh.ownerPlayerId !== toPlayerId ||
              fresh.parentLocationId ||
              fresh.normalizedName !== "unassigned"
            )
              throw new HandoffError(
                "The recipient's Unassigned location is unavailable. Ask them to restore it first.",
              );
            destinationId = fresh.id;
          } else recipientName = input.recipient.name;
          const snapshot = {
            card: { id: source.cardId, ...source.card },
            lot: {
              cardId: source.cardId,
              originalOpenerId: source.originalOpenerId,
              foilStatus: source.foilStatus,
              condition: source.condition,
              language: source.language,
              notes: source.notes,
              sourceType: source.sourceType,
              roundId: source.roundId,
              acquiredFromPullId: source.acquiredFromPullId,
            },
            source: {
              inventoryItemId: source.id,
              ownerPlayerId: source.currentOwnerId,
              locationId: source.locationId,
              locationName: source.location?.name ?? "Unassigned",
              section: source.locationSection,
            },
            destination: {
              locationId: destinationId,
              name: toPlayerId ? "Unassigned" : null,
            },
            quantity: input.quantity,
          };
          const receipt = await tx.cardHandoff.create({
            data: {
              actorUserId: actor.userId,
              requestId: input.requestId,
              requestHash,
              fromPlayerId: source.currentOwnerId,
              toPlayerId,
              senderName: source.currentOwner.displayName,
              recipientName,
              kind: input.kind,
              cardId: source.cardId,
              cardName: source.card.name,
              quantity: input.quantity,
              sourceInventoryItemId: source.id,
              snapshot,
            },
          });
          const after = await tx.inventoryItem.update({
            where: { id: source.id },
            data: { quantity: { decrement: input.quantity } },
          });
          const reason = `${input.kind === "TRADE" ? "Traded away" : "Given"} ${input.quantity} ${source.card.name} to ${recipientName}.`;
          const metadata = {
            handoffId: receipt.id,
            quantityGiven: input.quantity,
            recipientName,
            recipientPlayerId: toPlayerId,
          };
          await recordInventoryAudit({
            tx,
            action: "card_given_away",
            actingUserId: actor.userId,
            inventoryItemId: source.id,
            before: {
              ...snapshot.lot,
              currentOwnerId: source.currentOwnerId,
              quantity: source.quantity,
              locationId: source.locationId,
            },
            after: {
              ...snapshot.lot,
              currentOwnerId: source.currentOwnerId,
              quantity: after.quantity,
              locationId: source.locationId,
            },
            metadata,
            reason,
          });
          if (toPlayerId && destinationId) {
            const data = receivedTradeInventoryData(
              source,
              input.quantity,
              toPlayerId,
              destinationId,
            );
            const received = await writeInventoryReceipt(tx, {
              lot: data,
              merge: null,
              audit: {
                action: "card_received",
                actingUserId: actor.userId,
                reason,
                metadata: {
                  handoffId: receipt.id,
                  senderName: source.currentOwner.displayName,
                  quantityReceived: input.quantity,
                },
              },
            });
            receivedInventoryItemId = received.inventory.id;
            await tx.cardHandoff.update({
              where: { id: receipt.id },
              data: { receivedInventoryItemId },
            });
            await fulfillCompletedTradeWishlists(tx, {
              proposerPlayerId: source.currentOwnerId,
              receiverPlayerId: toPlayerId,
              offeredCards: [
                { cardId: source.cardId, quantity: input.quantity },
              ],
              requestedCards: [],
            });
          }
          return {
            id: receipt.id,
            recipientName,
            quantity: input.quantity,
            internal: Boolean(toPlayerId),
            replay: false,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 20000,
          maxWait: 10000,
        },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        attempt < 2 &&
        (error.code === "P2034" ||
          (error.code === "P2010" &&
            ["40001", "40P01"].includes(String(error.meta?.code))))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
        continue;
      }
      throw error;
    }
}
