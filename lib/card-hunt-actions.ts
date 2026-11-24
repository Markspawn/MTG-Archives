import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { buildCardHunt, CardHuntError } from "./card-hunt-service";
import { huntMatches } from "./card-hunt";
import { handoffStamp } from "./card-handoff-policy";
import { giveInventoryCardInTransaction, HandoffError } from "./card-handoffs";
import {
  huntActionInput,
  huntActionHash,
  type HuntActionInput,
  type HuntActionResult,
} from "./card-hunt-action-policy";
import {
  activeDeckTradeStatuses,
  assertDeckUnreserved,
  DeckTradeWriteError,
  lockDeckOwners,
  lockDeckRows,
} from "./deck-write-fence";
import { ensureDeckLocation } from "./deck-commitments";
import { isSystemDeckLocation } from "./deck-inventory";
import { lockInventoryDestinations } from "./inventory-capacity";
import { buildReservedInventoryQuantities } from "./trade-lines";
import { recordInventoryAudit } from "./inventory-audit";
import { writeInventoryReceipt } from "./inventory-receipt";

type Tx = Prisma.TransactionClient;
async function owner(tx: Tx, userId: string) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR SHARE`;
  const user = await tx.user.findUnique({
    where: { id: userId },
    include: { player: true },
  });
  if (
    !user?.isActive ||
    user.forcePasswordChange ||
    !user.playerId ||
    !user.player?.active
  )
    throw new HandoffError("Sign in with an active inventory account.", 403);
  return { ...user, playerId: user.playerId };
}
async function receipt(
  tx: Tx,
  userId: string,
  input: HuntActionInput,
  hash: string,
  playerId: string,
) {
  const row = await tx.cardHuntAction.findUnique({
    where: {
      actorUserId_requestId: {
        actorUserId: userId,
        requestId: input.requestId,
      },
    },
  });
  if (!row) return null;
  if (row.ownerPlayerId !== playerId || row.requestHash !== hash)
    throw new HandoffError(
      "This confirmation belongs to a different action or inventory owner.",
      409,
    );
  return { ...(row.resultJson as unknown as HuntActionResult), replay: true };
}
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
async function save(
  tx: Tx,
  userId: string,
  playerId: string,
  input: HuntActionInput,
  hash: string,
  result: HuntActionResult,
) {
  await tx.cardHuntAction.create({
    data: {
      actorUserId: userId,
      ownerPlayerId: playerId,
      requestId: input.requestId,
      requestHash: hash,
      action: input.action,
      resultJson: json(result),
    },
  });
  return result;
}
async function reserved(tx: Tx, ids: string[]) {
  const statuses = [...activeDeckTradeStatuses];
  const [lines, legacy] = await Promise.all([
    tx.tradeLine.findMany({
      where: {
        inventoryItemId: { in: ids },
        trade: { status: { in: statuses } },
      },
      select: { inventoryItemId: true, quantity: true },
    }),
    tx.trade.findMany({
      where: {
        status: { in: statuses },
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
async function apply(
  tx: Tx,
  userId: string,
  input: HuntActionInput,
  hash: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ":" + input.requestId},241124))`;
  const actor = await owner(tx, userId);
  const previous = await receipt(tx, userId, input, hash, actor.playerId);
  if (previous) return previous;

  // Deck owner gates precede Deck, InventoryItem and location locks throughout the app.
  const deckIds = [
    ...new Set(
      input.hunt.sources?.flatMap((source) =>
        source.kind === "DECK" ? [source.deckId] : [],
      ) ?? (input.hunt.deckId ? [input.hunt.deckId] : []),
    ),
  ].sort();
  await lockDeckOwners(tx, [userId]);
  const owned = await tx.deck.count({
    where: {
      id: { in: deckIds },
      ownerUserId: userId,
      commanderLeagueDeck: null,
    },
  });
  if (owned !== deckIds.length)
    throw new CardHuntError(
      "A selected deck is unavailable or no longer belongs to you.",
      409,
    );
  await lockDeckRows(tx, deckIds);
  const decks = await tx.deck.findMany({
    where: {
      id: { in: deckIds },
      ownerUserId: userId,
      commanderLeagueDeck: null,
    },
    include: { ownerUser: { select: { playerId: true } } },
  });
  if (
    decks.length !== deckIds.length ||
    decks.some((deck) => deck.ownerUser.playerId !== actor.playerId)
  )
    throw new CardHuntError(
      "A selected deck is unavailable or no longer belongs to your inventory.",
      409,
    );
  if (input.action === "COMMIT")
    for (const deck of decks) await assertDeckUnreserved(tx, deck.id);

  const ids = [
    ...new Set(input.selected.map((move) => move.inventoryItemId)),
  ].sort();
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "InventoryItem" WHERE id IN (${Prisma.join(ids)}) AND "currentOwnerId"=${actor.playerId} ORDER BY id FOR UPDATE`,
  );
  const stock = await tx.inventoryItem.findMany({
    where: { id: { in: ids }, currentOwnerId: actor.playerId },
    include: { card: true, location: true },
  });
  if (stock.length !== ids.length)
    throw new CardHuntError(
      "Some selected copies are no longer available. Refresh the hunt.",
      409,
    );
  const locationIds = [
    ...new Set(
      stock.flatMap((item) => (item.locationId ? [item.locationId] : [])),
    ),
  ].sort();
  // Lock source geometry as well as stock; changing a shelf must not invalidate a reviewed pull mid-write.
  for (let offset = 0; offset < locationIds.length; offset += 100)
    await lockInventoryDestinations(
      tx,
      locationIds.slice(offset, offset + 100),
    );
  const freshStock = await tx.inventoryItem.findMany({
    where: { id: { in: ids }, currentOwnerId: actor.playerId },
    include: { card: true, location: true },
  });
  const byId = new Map(freshStock.map((item) => [item.id, item]));
  const held = await reserved(tx, ids);
  const totals = new Map<string, number>();
  for (const move of input.selected) {
    const item = byId.get(move.inventoryItemId)!;
    if (
      item.currentOwnerId !== actor.playerId ||
      handoffStamp(item) !== move.stamp ||
      (item.location &&
        (!item.location.active ||
          item.location.ownerPlayerId !== actor.playerId ||
          isSystemDeckLocation(item.location)))
    )
      throw new CardHuntError(
        "A selected copy, owner or storage location changed. Refresh the hunt.",
        409,
      );
    totals.set(item.id, (totals.get(item.id) ?? 0) + move.quantity);
  }
  for (const [id, quantity] of totals)
    if (quantity > byId.get(id)!.quantity - (held.get(id) ?? 0))
      throw new CardHuntError(
        "The selected quantity is no longer available after trade reservations. Nothing was moved.",
        409,
      );

  // Ensure/lock deck storage before reading committed totals. Existing deck
  // writers also touch this row; a snapshot that waited behind them must retry.
  const locations = new Map<string, string>();
  if (input.action === "COMMIT") {
    for (const deck of decks) {
      const location = await ensureDeckLocation(tx, deck);
      locations.set(deck.id, location.id);
    }
    if (locations.size)
      await lockInventoryDestinations(tx, [...locations.values()]);
  }
  const plan = await buildCardHunt(tx, actor, input.hunt);
  const lines = new Map(plan.lines.map((line) => [line.request.id, line]));
  const perRequest = new Map<string, number>();
  for (const move of input.selected) {
    const line = lines.get(move.requestId),
      item = byId.get(move.inventoryItemId)!;
    if (
      !line ||
      !huntMatches(line.request, {
        ...item,
        ownerId: item.currentOwnerId,
        reserved: 0,
        name: item.card.name,
        oracleId: item.card.oracleId,
        setCode: item.card.setCode,
        collectorNumber: item.card.collectorNumber,
        finish: item.foilStatus,
        location: null,
      })
    )
      throw new CardHuntError(
        "A selected printing no longer matches its requested card. Refresh the hunt.",
        409,
      );
    if (line.request.deckId && line.request.targetStamp !== move.targetStamp)
      throw new CardHuntError(
        "A destination deck row changed. Refresh the hunt.",
        409,
      );
    if (
      input.action === "COMMIT" &&
      (!line.request.deckId || !line.request.deckCardId)
    )
      throw new CardHuntError(
        "Select pulls from saved decks to commit. Pasted-list pulls can be given away.",
        409,
      );
    perRequest.set(
      move.requestId,
      (perRequest.get(move.requestId) ?? 0) + move.quantity,
    );
  }
  for (const [id, quantity] of perRequest)
    if (quantity > lines.get(id)!.needed)
      throw new CardHuntError(
        "A deck or list needs fewer copies now. Refresh the hunt before confirming.",
        409,
      );

  const destinations = new Map<
    string,
    { name: string; quantity: number; deckId?: string }
  >();
  const handoffIds: string[] = [];
  if (input.action === "GIVE") {
    // One history receipt per physical source lot. Duplicate list demands consume its aggregate once.
    for (const id of ids) {
      const result = await giveInventoryCardInTransaction(
        tx,
        { userId, adminMode: false },
        {
          requestId: randomUUID(),
          inventoryItemId: id,
          expectedStamp: input.selected.find(
            (move) => move.inventoryItemId === id,
          )!.stamp,
          quantity: totals.get(id)!,
          kind: input.kind,
          recipient: input.recipient,
        },
      );
      handoffIds.push(result.id);
      const destination = destinations.get(result.recipientName) ?? {
        name: result.recipientName,
        quantity: 0,
      };
      destination.quantity += result.quantity;
      destinations.set(result.recipientName, destination);
    }
  } else {
    for (const move of input.selected) {
      const request = lines.get(move.requestId)!.request,
        deck = decks.find((deck) => deck.id === request.deckId)!;
      const item = await tx.inventoryItem.findUniqueOrThrow({
        where: { id: move.inventoryItemId },
      });
      const after = await tx.inventoryItem.update({
        where: { id: item.id },
        data: { quantity: { decrement: move.quantity } },
      });
      const metadata = {
        huntRequestId: input.requestId,
        deckId: deck.id,
        deckName: deck.name,
        deckCardId: request.deckCardId!,
        sourceInventoryItemId: item.id,
        sourceLocationId: item.locationId,
        sourceSection: item.locationSection,
        quantityMoved: move.quantity,
      };
      const reason = `Committed ${move.quantity} ${byId.get(item.id)!.card.name} to ${deck.name} from Card Hunt.`;
      await recordInventoryAudit({
        tx,
        action: "bulk_committed_to_deck",
        actingUserId: userId,
        inventoryItemId: item.id,
        before: json(item) as Prisma.InputJsonObject,
        after: json(after) as Prisma.InputJsonObject,
        metadata,
        reason,
      });
      const {
        currentOwnerId,
        originalOpenerId,
        cardId,
        foilStatus,
        sourceType,
        condition,
        language,
        acquiredFromPullId,
        roundId,
        notes,
      } = item;
      await writeInventoryReceipt(tx, {
        lot: {
          currentOwnerId,
          originalOpenerId,
          cardId,
          foilStatus,
          sourceType,
          condition,
          language,
          acquiredFromPullId,
          roundId,
          notes,
          quantity: move.quantity,
          locationId: locations.get(deck.id)!,
          locationSection: null,
        },
        merge: null,
        audit: {
          action: "bulk_committed_to_deck",
          actingUserId: userId,
          metadata,
          reason,
        },
      });
      const destination = destinations.get(deck.id) ?? {
        name: deck.name,
        deckId: deck.id,
        quantity: 0,
      };
      destination.quantity += move.quantity;
      destinations.set(deck.id, destination);
    }
  }
  const updates = await tx.inventoryItem.findMany({
    where: { id: { in: ids } },
  });
  const quantity = input.selected.reduce((sum, move) => sum + move.quantity, 0);
  const result: HuntActionResult = {
    requestId: input.requestId,
    status: "APPLIED",
    action: input.action,
    quantity,
    entries: input.selected.length,
    message:
      input.action === "COMMIT"
        ? `Committed ${quantity} copies to ${destinations.size} ${destinations.size === 1 ? "deck" : "decks"}.`
        : `${input.kind === "TRADE" ? "Traded" : "Gave"} ${quantity} copies to ${[...destinations.values()][0].name}.`,
    destinations: [...destinations.values()],
    handoffIds,
    stockUpdates: updates.map((item) => ({
      id: item.id,
      stamp: handoffStamp(item),
    })),
  };
  return save(tx, userId, actor.playerId, input, hash, result);
}

export async function performHuntAction(
  db: PrismaClient,
  userId: string,
  raw: unknown,
): Promise<HuntActionResult> {
  const input = huntActionInput.parse(raw),
    hash = huntActionHash(input);
  for (let attempt = 0; ; attempt++)
    try {
      return await db.$transaction((tx) => apply(tx, userId, input, hash), {
        isolationLevel: "Serializable",
        timeout: 60000,
        maxWait: 10000,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        attempt < 2 &&
        (error.code === "P2034" ||
          error.code === "P2002" ||
          (error.code === "P2010" &&
            ["40001", "40P01"].includes(String(error.meta?.code))))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
        continue;
      }
      if (
        error instanceof CardHuntError ||
        error instanceof DeckTradeWriteError ||
        (error instanceof HandoffError &&
          error.status !== 401 &&
          error.status !== 403)
      ) {
        // A rejected attempt is closed under the same gate in a fresh snapshot.
        // This either recovers a prior success or fences a late request from applying.
        return db.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ":" + input.requestId},241124))`;
            const actor = await owner(tx, userId),
              previous = await receipt(tx, userId, input, hash, actor.playerId);
            if (previous) return previous;
            return save(tx, userId, actor.playerId, input, hash, {
              requestId: input.requestId,
              status: "REJECTED",
              action: input.action,
              quantity: 0,
              entries: 0,
              message: error.message,
              destinations: [],
              handoffIds: [],
              stockUpdates: [],
            });
          },
          { isolationLevel: "ReadCommitted", timeout: 20000, maxWait: 10000 },
        );
      }
      throw error;
    }
}

export async function getHuntActionContext(db: PrismaClient, userId: string) {
  return db.$transaction(
    async (tx) => {
      const actor = await owner(tx, userId);
      const [recipients, people] = await Promise.all([
        tx.player.findMany({
          where: {
            active: true,
            id: { not: actor.playerId },
            users: { some: { isActive: true } },
          },
          select: { id: true, displayName: true },
          orderBy: [{ displayName: "asc" }, { id: "asc" }],
        }),
        tx.cardHandoff.findMany({
          where: { fromPlayerId: actor.playerId, toPlayerId: null },
          distinct: ["recipientName"],
          select: { recipientName: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
      ]);
      return {
        actorUserId: userId,
        recipients,
        recentPeople: people.map((person) => person.recipientName),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
