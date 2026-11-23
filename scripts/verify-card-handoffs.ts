import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import {
  getHandoffOptions,
  getHandoffHistory,
  giveInventoryCard,
} from "../lib/card-handoffs";
import { handoffStamp, type HandoffInput } from "../lib/card-handoff-policy";

export async function seedCardHandoffFixture(db: PrismaClient, tag: string) {
  const ids = ["owner", "recipient", "admin"].map((role) => tag + "-" + role);
  for (const [i, id] of ids.entries()) {
    await db.player.create({ data: { id, name: id, displayName: id } });
    await db.user.create({
      data: {
        id,
        username: id,
        displayName: id,
        passwordHash: "fixture-only",
        playerId: id,
        role: i === 2 ? "ADMIN" : "PLAYER",
      },
    });
  }
  const card = await db.card.create({
    data: {
      name: "Handoff card " + tag,
      scryfallId: randomUUID(),
      setCode: "tst",
      collectorNumber: "7",
      typeLine: "Creature",
      rarity: "common",
      lang: "en",
      finishes: ["nonfoil", "foil"],
    },
  });
  const box = await db.inventoryLocation.create({
    data: {
      ownerPlayerId: ids[0],
      name: "Handoff box",
      normalizedName: "handoff-box",
      type: "Box",
    },
  });
  const foreignBox = await db.inventoryLocation.create({
    data: {
      ownerPlayerId: ids[1],
      name: "Private other box",
      normalizedName: "private-other",
      type: "Box",
    },
  });
  const deckLocation = await db.inventoryLocation.create({
    data: {
      ownerPlayerId: ids[0],
      name: "Committed deck",
      normalizedName: "deck",
      kind: "DECK",
      systemManaged: true,
      type: "Deck",
    },
  });
  const lot = {
    currentOwnerId: ids[0],
    originalOpenerId: ids[1],
    cardId: card.id,
    foil: true,
    foilStatus: "FOIL" as const,
    condition: "LP",
    language: "JA",
    notes: "Preserved lot note",
    locationId: box.id,
    locationSection: "B",
    sourceType: "MANUAL" as const,
  };
  const source = await db.inventoryItem.create({
    data: { ...lot, quantity: 10 },
  });
  const single = await db.inventoryItem.create({
    data: { ...lot, quantity: 1, notes: "Single-copy lot" },
  });
  const duplicate = await db.inventoryItem.create({
    data: { ...lot, quantity: 2, notes: "Duplicate-request lot" },
  });
  const deck = await db.inventoryItem.create({
    data: { ...lot, quantity: 2, locationId: deckLocation.id },
  });
  const foreign = await db.inventoryItem.create({
    data: {
      ...lot,
      currentOwnerId: ids[1],
      locationId: foreignBox.id,
      quantity: 9,
    },
  });
  return {
    tag,
    ids,
    cardId: card.id,
    cardName: card.name,
    sourceId: source.id,
    singleId: single.id,
    duplicateId: duplicate.id,
    deckId: deck.id,
    foreignId: foreign.id,
    boxId: box.id,
  };
}
export async function cleanCardHandoffFixture(
  db: PrismaClient,
  f: Awaited<ReturnType<typeof seedCardHandoffFixture>>,
) {
  const trades = await db.trade.findMany({
    where: {
      OR: [
        { proposerPlayerId: { in: f.ids } },
        { receiverPlayerId: { in: f.ids } },
      ],
    },
    select: { id: true },
  });
  await db.tradeLine.deleteMany({
    where: { tradeId: { in: trades.map((t) => t.id) } },
  });
  await db.trade.deleteMany({ where: { id: { in: trades.map((t) => t.id) } } });
  await db.tradeWishlistItem.deleteMany({
    where: { ownerUserId: { in: f.ids } },
  });
  await db.inventoryAuditLog.deleteMany({
    where: { changedByUserId: { in: f.ids } },
  });
  await db.cardHandoff.deleteMany({ where: { actorUserId: { in: f.ids } } });
  await db.inventoryItem.deleteMany({
    where: { currentOwnerId: { in: f.ids } },
  });
  await db.inventoryLocation.deleteMany({
    where: { ownerPlayerId: { in: f.ids } },
  });
  await db.round.deleteMany({ where: { id: f.tag + "-round" } });
  await db.season.deleteMany({ where: { id: f.tag + "-season" } });
  await db.league.deleteMany({ where: { id: f.tag + "-league" } });
  await db.user.deleteMany({ where: { id: { in: f.ids } } });
  await db.player.deleteMany({ where: { id: { in: f.ids } } });
  await db.card.delete({ where: { id: f.cardId } });
}
async function fingerprint(db: PrismaClient) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "InventoryItem",
    "InventoryAuditLog",
    "CardHandoff",
    "Trade",
    "TradeLine",
    "TradeWishlistItem",
    "User",
    "Player",
    "InventoryLocation",
    "Card",
    "League",
    "Season",
    "Round",
  ])
    result[table] = await db.$queryRawUnsafe(
      `SELECT count(*)::text AS count,md5(COALESCE(string_agg(row_to_json(t)::text,chr(31) ORDER BY row_to_json(t)::text),'')) AS hash FROM "${table}" t`,
    );
  return result;
}
export async function verifyCardHandoffs(db: PrismaClient) {
  const baseline = await fingerprint(db),
    f = await seedCardHandoffFixture(db, "handoff-" + randomUUID()),
    [owner, recipient, admin] = f.ids;
  const actor = { userId: owner, adminMode: false },
    recipientActor = { userId: recipient, adminMode: false };
  const stock = async () =>
    Number(
      (await db.inventoryItem.aggregate({ _sum: { quantity: true } }))._sum
        .quantity ?? 0,
    );
  const quantity = async (id: string) =>
    (await db.inventoryItem.findUniqueOrThrow({ where: { id } })).quantity;
  const request = async (
    id: string,
    quantity: number,
    target: HandoffInput["recipient"] = {
      type: "EXTERNAL",
      name: "Pat O’Brien",
    },
  ): Promise<HandoffInput> => ({
    requestId: randomUUID(),
    inventoryItemId: id,
    expectedStamp: handoffStamp(
      await db.inventoryItem.findUniqueOrThrow({ where: { id } }),
    ),
    quantity,
    kind: "GIFT",
    recipient: target,
  });
  let trigger: string | undefined;
  try {
    const original = await db.inventoryItem.findUniqueOrThrow({
        where: { id: f.sourceId },
      }),
      initial = await stock();
    const outside = await request(f.sourceId, 2);
    const given = await giveInventoryCard(db, actor, outside);
    assert.equal(given.internal, false);
    assert.equal(await quantity(f.sourceId), 8);
    assert.equal(await stock(), initial - 2);
    const replay = await Promise.all([
      giveInventoryCard(db, actor, outside),
      giveInventoryCard(db, actor, outside),
    ]);
    assert(replay.every((r) => r.replay));
    assert.equal(await quantity(f.sourceId), 8);
    await assert.rejects(
      giveInventoryCard(db, actor, { ...outside, quantity: 1 }),
      /already used/,
    );
    await assert.rejects(getHandoffOptions(db, recipientActor, [f.sourceId]));
    await assert.rejects(
      giveInventoryCard(
        db,
        { userId: recipient, adminMode: true },
        await request(f.sourceId, 1),
      ),
      /unavailable/,
    );
    await assert.rejects(
      giveInventoryCard(
        db,
        actor,
        await request(f.sourceId, 1, { type: "ARCHIVE", playerId: owner }),
      ),
      /another person/,
    );
    const wish = await db.tradeWishlistItem.create({
      data: {
        ownerUserId: recipient,
        targetOwnerPlayerId: owner,
        cardId: f.cardId,
        quantity: 3,
      },
    });
    const internal = await request(f.sourceId, 3, {
      type: "ARCHIVE",
      playerId: recipient,
    });
    const received = await giveInventoryCard(db, actor, internal);
    assert.equal(received.internal, true);
    assert.equal(await stock(), initial - 2);
    assert.equal(await quantity(f.sourceId), 5);
    const receipt = await db.cardHandoff.findUniqueOrThrow({
        where: { id: received.id },
      }),
      newLot = await db.inventoryItem.findUniqueOrThrow({
        where: { id: receipt.receivedInventoryItemId! },
        include: { location: true },
      });
    assert.equal(newLot.quantity, 3);
    assert.equal(newLot.currentOwnerId, recipient);
    assert.equal(newLot.location!.normalizedName, "unassigned");
    assert.equal(newLot.location!.parentLocationId, null);
    assert.equal(newLot.locationSection, null);
    for (const field of [
      "originalOpenerId",
      "foilStatus",
      "condition",
      "language",
      "notes",
      "acquiredFromPullId",
      "roundId",
    ] as const)
      assert.equal(newLot[field], original[field]);
    assert.equal(newLot.sourceType, "TRADE");
    assert.equal(await quantity(f.foreignId), 9);
    assert.equal(
      (await db.tradeWishlistItem.findUniqueOrThrow({ where: { id: wish.id } }))
        .status,
      "FULFILLED",
    );
    assert.equal(
      await db.trade.count({ where: { proposerPlayerId: owner } }),
      0,
      "Immediate gifts do not create an acceptance workflow",
    );
    const incoming = await getHandoffHistory(db, recipientActor, {
      direction: "received",
    });
    assert.equal(incoming.rows.length, 1);
    assert.equal(incoming.rows[0].senderName, owner);
    assert(!JSON.stringify(incoming).includes(original.notes!));
    assert(!JSON.stringify(incoming).includes("Handoff box"));
    assert.equal(
      (await getHandoffHistory(db, recipientActor, {})).rows.length,
      0,
    );
    await assert.rejects(
      getHandoffHistory(db, recipientActor, { ownerId: owner }),
      /own handoff/,
    );
    console.log(
      "Handoff SQL PASS: named external history, immediate Unassigned receipt, attribution/provenance, wishlist, privacy and exact stock conservation",
    );

    const trade = await db.trade.create({
      data: {
        proposerPlayerId: owner,
        receiverPlayerId: recipient,
        offeredInventoryItemId: f.sourceId,
        status: "PROPOSED",
        lines: {
          create: {
            side: "PROPOSER",
            inventoryItemId: f.sourceId,
            quantity: 2,
            snapshotJson: { cardId: f.cardId },
          },
        },
      },
    });
    assert.equal(
      (await getHandoffOptions(db, actor, [f.sourceId])).lots[0].available,
      3,
    );
    await assert.rejects(
      giveInventoryCard(db, actor, await request(f.sourceId, 4)),
      /unreserved/,
    );
    await giveInventoryCard(db, actor, await request(f.sourceId, 3));
    assert.equal(await quantity(f.sourceId), 2);
    assert.equal(
      (await db.tradeLine.findFirstOrThrow({ where: { tradeId: trade.id } }))
        .quantity,
      2,
    );
    await db.trade.update({
      where: { id: trade.id },
      data: { status: "CANCELLED" },
    });
    const legacy = await db.trade.create({
      data: {
        proposerPlayerId: owner,
        receiverPlayerId: recipient,
        offeredInventoryItemId: f.sourceId,
        status: "PROPOSED",
      },
    });
    await assert.rejects(
      giveInventoryCard(db, actor, await request(f.sourceId, 2)),
      /unreserved/,
    );
    assert.equal(
      (await getHandoffOptions(db, actor, [f.sourceId])).lots[0].available,
      1,
    );
    await db.trade.update({
      where: { id: legacy.id },
      data: { status: "CANCELLED" },
    });
    await assert.rejects(
      giveInventoryCard(db, actor, await request(f.deckId, 1)),
      /deck/,
    );
    await db.league.create({
      data: { id: f.tag + "-league", name: f.tag, slug: f.tag },
    });
    await db.season.create({
      data: {
        id: f.tag + "-season",
        leagueId: f.tag + "-league",
        name: f.tag,
        year: 2026,
        startDate: new Date(),
      },
    });
    await db.round.create({
      data: {
        id: f.tag + "-round",
        seasonId: f.tag + "-season",
        name: f.tag,
        monthNumber: 1,
        startDate: new Date(),
      },
    });
    await db.inventoryItem.update({
      where: { id: f.sourceId },
      data: { roundId: f.tag + "-round" },
    });
    const roundGift = await giveInventoryCard(
      db,
      actor,
      await request(f.sourceId, 1, { type: "ARCHIVE", playerId: recipient }),
    );
    const roundReceipt = await db.cardHandoff.findUniqueOrThrow({
      where: { id: roundGift.id },
    });
    assert.equal(
      (
        await db.inventoryItem.findUniqueOrThrow({
          where: { id: roundReceipt.receivedInventoryItemId! },
        })
      ).roundId,
      f.tag + "-round",
    );
    await db.inventoryItem.update({
      where: { id: f.sourceId },
      data: { roundId: null },
    });
    const stale = await request(f.sourceId, 1);
    await db.inventoryItem.update({
      where: { id: f.sourceId },
      data: { locationSection: "C" },
    });
    await assert.rejects(giveInventoryCard(db, actor, stale), /changed/);
    assert.equal(await quantity(f.sourceId), 1);
    await db.user.update({
      where: { id: recipient },
      data: { isActive: false },
    });
    await assert.rejects(
      giveInventoryCard(
        db,
        actor,
        await request(f.sourceId, 1, { type: "ARCHIVE", playerId: recipient }),
      ),
      /no longer active/,
    );
    await db.user.update({
      where: { id: recipient },
      data: { isActive: true },
    });
    await db.inventoryLocation.update({
      where: { id: newLot.locationId! },
      data: { active: false },
    });
    await assert.rejects(
      giveInventoryCard(
        db,
        actor,
        await request(f.sourceId, 1, { type: "ARCHIVE", playerId: recipient }),
      ),
      /Unassigned/,
    );
    await db.inventoryLocation.update({
      where: { id: newLot.locationId! },
      data: { active: true },
    });
    const adminResult = await giveInventoryCard(
      db,
      { userId: admin, adminMode: true },
      await request(f.sourceId, 1),
    );
    assert.equal(
      (
        await db.cardHandoff.findUniqueOrThrow({
          where: { id: adminResult.id },
        })
      ).actorUserId,
      admin,
    );
    await db.user.update({ where: { id: admin }, data: { role: "PLAYER" } });
    await assert.rejects(
      giveInventoryCard(
        db,
        { userId: admin, adminMode: true },
        await request(f.sourceId, 1),
      ),
      /unavailable/,
    );
    await db.user.update({ where: { id: admin }, data: { role: "ADMIN" } });
    console.log(
      "Handoff SQL PASS: fresh ownership/admin role, current source, committed-deck and legacy/line reservations, inactive recipients/destinations and retained round provenance",
    );

    let withdrawn = false;
    const snapshotClient = db.$extends({
      query: {
        user: {
          findUnique: async ({ args, query }) => {
            const user = await query(args);
            if (args.where.id === admin && !withdrawn) {
              withdrawn = true;
              await db.user.update({
                where: { id: admin },
                data: { role: "PLAYER" },
              });
              await db.inventoryItem.update({
                where: { id: f.duplicateId },
                data: { quantity: 3 },
              });
            }
            return user;
          },
        },
      },
    });
    try {
      const frozen = await getHandoffOptions(
        snapshotClient as unknown as PrismaClient,
        { userId: admin, adminMode: true },
        [f.duplicateId],
      );
      assert(withdrawn);
      assert.equal(
        frozen.lots[0].available,
        2,
        "Permission and stock must share the same database snapshot",
      );
      assert.equal(await quantity(f.duplicateId), 3);
      await assert.rejects(
        getHandoffOptions(db, { userId: admin, adminMode: true }, [
          f.duplicateId,
        ]),
      );
    } finally {
      await db.user.update({ where: { id: admin }, data: { role: "ADMIN" } });
      await db.inventoryItem.update({
        where: { id: f.duplicateId },
        data: { quantity: 2 },
      });
    }
    console.log(
      "Handoff SQL PASS: actual concurrent role withdrawal cannot combine old permission with newly changed private stock",
    );
    const one = await request(f.singleId, 1),
      two = await request(f.singleId, 1);
    const contested = await Promise.allSettled([
      giveInventoryCard(db, actor, one),
      giveInventoryCard(db, actor, two),
    ]);
    assert.equal(contested.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(await quantity(f.singleId), 0);
    await db.inventoryItem.delete({ where: { id: f.singleId } });
    assert(
      (await getHandoffHistory(db, actor, {})).rows.some(
        (r) => r.quantity === 1 && r.cardId === f.cardId,
      ),
    );
    const duplicate = await request(f.duplicateId, 1);
    const settled = await Promise.allSettled([
      giveInventoryCard(db, actor, duplicate),
      giveInventoryCard(db, actor, duplicate),
    ]);
    const results = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    assert.equal(results.filter((r) => r.replay).length, 1);
    assert.equal(await quantity(f.duplicateId), 1);
    const beforeRollback = await fingerprint(db),
      rollback = await request(f.duplicateId, 1, {
        type: "ARCHIVE",
        playerId: recipient,
      });
    trigger = "handoff_fail_" + randomUUID().replaceAll("-", "");
    assert(/^[a-z0-9_]+$/.test(trigger));
    await db.$executeRawUnsafe(
      `CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."changedByUserId"='${owner.replaceAll("'", "''")}' THEN RAISE EXCEPTION 'controlled handoff audit failure'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER "${trigger}" BEFORE INSERT ON "InventoryAuditLog" FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`,
    );
    await assert.rejects(giveInventoryCard(db, actor, rollback));
    await db.$executeRawUnsafe(
      `DROP TRIGGER "${trigger}" ON "InventoryAuditLog"`,
    );
    await db.$executeRawUnsafe(`DROP FUNCTION "${trigger}"()`);
    trigger = undefined;
    assert.deepEqual(await fingerprint(db), beforeRollback);
    await giveInventoryCard(db, actor, rollback);
    assert.equal(await quantity(f.duplicateId), 0);
    console.log(
      "Handoff SQL PASS: concurrent duplicate/competing confirmations, immutable history after source deletion, actual audit-failure rollback and safe retry",
    );

    const example = await db.cardHandoff.findFirstOrThrow({
      where: { fromPlayerId: owner },
    });
    await db.cardHandoff.createMany({
      data: Array.from({ length: 51 }, () => ({
        actorUserId: owner,
        requestId: randomUUID(),
        requestHash: "a".repeat(64),
        fromPlayerId: owner,
        senderName: owner,
        recipientName: "Pagination recipient",
        kind: "GIFT",
        cardId: f.cardId,
        cardName: "Pagination card",
        quantity: 1,
        sourceInventoryItemId: f.sourceId,
        snapshot: example.snapshot as Prisma.InputJsonValue,
      })),
    });
    const page1 = await getHandoffHistory(db, actor, {
        query: "Pagination card",
      }),
      page2 = await getHandoffHistory(db, actor, {
        query: "Pagination card",
        before: page1.next!,
      });
    assert.equal(page1.rows.length, 50);
    assert.equal(page2.rows.length, 1);
    assert.equal(
      new Set([...page1.rows, ...page2.rows].map((r) => r.id)).size,
      51,
    );
    assert.equal(page2.next, null);
    assert.equal(
      (
        await getHandoffHistory(db, recipientActor, {
          query: "Pagination card",
          direction: "all",
        })
      ).rows.length,
      0,
    );
    console.log(
      "Handoff SQL PASS: stable keyset history across pages, exact printing/person search and recipient isolation",
    );
  } finally {
    if (trigger) {
      await db.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "InventoryAuditLog"`,
      );
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${trigger}"()`);
    }
    await cleanCardHandoffFixture(db, f);
  }
  assert.deepEqual(await fingerprint(db), baseline);
  console.log(
    "Handoff SQL PASS: all fixture tables restored exactly to their original fingerprints",
  );
}
if (
  basename(process.argv[1] ?? "") === "verify-card-handoffs.ts" &&
  process.argv.includes("--run")
) {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    process.env.MTG_HANDOFF_TEST !== "1" ||
    !["handoff_fixture", "inventory_delete_fixture"].includes(
      url.pathname.slice(1),
    )
  )
    throw Error("Explicit isolated handoff fixture database required");
  const db = new PrismaClient();
  verifyCardHandoffs(db)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
