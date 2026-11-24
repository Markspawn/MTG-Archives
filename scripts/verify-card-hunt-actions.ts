import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient, type DeckCard } from "@prisma/client";
import { buildCardHunt, type CardHuntInput } from "../lib/card-hunt-service";
import {
  performHuntAction,
  getHuntActionContext,
} from "../lib/card-hunt-actions";
import { ensureDeckLocation } from "../lib/deck-commitments";
import { getDeckRowCommittedQuantity, syncCommittedDeckPrintings } from "../lib/deck-committed-printings";
import { lockWritableDeck } from "../lib/deck-write-fence";
import { advanceHunt } from "../lib/card-hunt-progress";
import { handoffStamp } from "../lib/card-handoff-policy";
import type { HuntActionInput } from "../lib/card-hunt-action-policy";
import type { HuntPick } from "../lib/card-hunt";

export async function seedHuntActions(db: PrismaClient, tag: string) {
  const password = randomUUID(),
    passwordHash = await bcrypt.hash(password, 4);
  for (const role of ["owner", "recipient", "other"]) {
    const id = `${tag}-${role}`;
    await db.player.create({
      data: {
        id,
        name: id,
        displayName:
          role === "owner"
            ? "Hunt owner"
            : role === "recipient"
              ? "Archive recipient"
              : "Other owner",
      },
    });
    await db.user.create({
      data: { id, username: id, displayName: id, passwordHash, playerId: id },
    });
  }
  const owner = `${tag}-owner`,
    recipient = `${tag}-recipient`,
    other = `${tag}-other`;
  const box = await db.inventoryLocation.create({
    data: {
      id: `${tag}-box`,
      ownerPlayerId: owner,
      name: "Blue Box",
      normalizedName: "blue-box",
      type: "Box",
    },
  });
  const inactive = await db.inventoryLocation.create({
    data: {
      id: `${tag}-inactive`,
      ownerPlayerId: owner,
      name: "Inactive Box",
      normalizedName: "inactive-box",
      active: false,
    },
  });
  const oracle = randomUUID();
  const preferred = await db.card.create({
    data: {
      id: `${tag}-preferred`,
      scryfallId: randomUUID(),
      oracleId: oracle,
      name: `Sol Ring ${tag}`,
      setCode: "tst",
      collectorNumber: "1",
      typeLine: "Artifact",
      rarity: "common",
    },
  });
  const alternate = await db.card.create({
    data: {
      id: `${tag}-alternate`,
      scryfallId: randomUUID(),
      oracleId: oracle,
      name: preferred.name,
      setCode: "alt",
      collectorNumber: "2",
      typeLine: "Artifact",
      rarity: "common",
    },
  });
  const signet = await db.card.create({
    data: {
      id: `${tag}-signet`,
      scryfallId: randomUUID(),
      oracleId: randomUUID(),
      name: `Signet ${tag}`,
      setCode: "tst",
      collectorNumber: "3",
      typeLine: "Artifact",
      rarity: "common",
    },
  });
  const deckA = await db.deck.create({
      data: { id: `${tag}-deck-a`, ownerUserId: owner, name: "Deck A" },
    }),
    deckB = await db.deck.create({
      data: { id: `${tag}-deck-b`, ownerUserId: owner, name: "Deck B" },
    });
  const foreignDeck = await db.deck.create({
    data: {
      id: `${tag}-foreign`,
      ownerUserId: other,
      name: "Private other deck",
    },
  });
  const deckRows = [];
  for (const deck of [deckA, deckB])
    deckRows.push(
      await db.deckCard.create({
        data: {
          deckId: deck.id,
          cardId: preferred.id,
          oracleId: oracle,
          cardName: preferred.name,
          quantity: 2,
        },
      }),
    );
  const a = await db.$transaction((tx) =>
    ensureDeckLocation(tx, { ...deckA, ownerUser: { playerId: owner } }),
  );
  const ring = await db.inventoryItem.create({
    data: {
      id: `${tag}-ring`,
      currentOwnerId: owner,
      originalOpenerId: recipient,
      cardId: alternate.id,
      quantity: 6,
      foilStatus: "NONFOIL",
      condition: "LP",
      language: "JA",
      sourceType: "ACQUISITION",
      notes: "Preserve this lot",
      locationId: box.id,
      locationSection: "B",
    },
  });
  const token = await db.inventoryItem.create({
    data: {
      id: `${tag}-signet-lot`,
      currentOwnerId: owner,
      originalOpenerId: null,
      cardId: signet.id,
      quantity: 2,
      condition: "NM",
      language: "EN",
      sourceType: "MANUAL",
      locationId: box.id,
      locationSection: "C",
    },
  });
  await db.inventoryItem.createMany({
    data: [
      {
        id: `${tag}-committed`,
        currentOwnerId: owner,
        cardId: preferred.id,
        quantity: 1,
        condition: "NM",
        locationId: a.id,
      },
      {
        id: `${tag}-inactive-lot`,
        currentOwnerId: owner,
        cardId: alternate.id,
        quantity: 100,
        condition: "NM",
        locationId: inactive.id,
      },
      {
        id: `${tag}-other-lot`,
        currentOwnerId: other,
        cardId: alternate.id,
        quantity: 100,
        condition: "NM",
      },
    ],
  });
  const trade = await db.trade.create({
    data: {
      id: `${tag}-trade`,
      proposerPlayerId: owner,
      receiverPlayerId: recipient,
      createdByUserId: owner,
      status: "PROPOSED",
    },
  });
  await db.tradeLine.create({
    data: {
      tradeId: trade.id,
      side: "PROPOSER",
      inventoryItemId: ring.id,
      quantity: 1,
      snapshotJson: { synthetic: true },
    },
  });
  await db.trade.create({
    data: {
      proposerPlayerId: owner,
      receiverPlayerId: recipient,
      createdByUserId: owner,
      status: "ACCEPTED_PENDING_EXCHANGE",
      offeredInventoryItemId: ring.id,
    },
  });
  const hunt: CardHuntInput = {
    sources: [
      { kind: "DECK", id: "a", deckId: deckA.id },
      { kind: "DECK", id: "b", deckId: deckB.id },
      { kind: "LIST", id: "c", label: "For Pat", text: `1 ${preferred.name}` },
    ],
    mode: "preferences",
    finish: "ANY",
    includeMaybeboard: false,
    ignoreBasicLands: false,
  };
  return {
    tag,
    password,
    owner,
    recipient,
    other,
    box,
    inactive,
    preferred,
    alternate,
    signet,
    deckA,
    deckB,
    foreignDeck,
    deckRows,
    ring,
    token,
    trade,
    hunt,
  };
}
const selected = (picks: HuntPick[]) =>
  picks.map((pick) => ({
    requestId: pick.requestId,
    inventoryItemId: pick.inventoryItemId,
    quantity: pick.quantity,
    stamp: pick.stamp!,
    ...(pick.targetStamp ? { targetStamp: pick.targetStamp } : {}),
  }));
async function fingerprint(
  db: PrismaClient,
  tables = [
    "InventoryItem",
    "Card",
    "Deck",
    "DeckCard",
    "InventoryLocation",
    "Trade",
    "TradeLine",
    "TradeDeckBundle",
    "CardHandoff",
    "InventoryAuditLog",
    "User",
    "Player",
  ],
) {
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    assert.match(table, /^[A-Za-z_][A-Za-z0-9_]*$/);
    result[table] = await db.$queryRawUnsafe(
      `SELECT count(*)::text AS count,md5(COALESCE(string_agg(row_to_json(t)::text,chr(31) ORDER BY row_to_json(t)::text),'')) AS hash FROM "${table}" t`,
    );
  }
  return result;
}

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(process.env.MTG_HUNT_ACTION_TEST, "1");
  assert.equal(url.hostname, "mtg-hunt-actions-db");
  assert.equal(url.pathname, "/hunt_actions_fixture");
  const db = new PrismaClient();
  const business = await db.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' ORDER BY tablename`;
  const ownedTables = [
    "InventoryAuditLog",
    "CardHuntAction",
    "CardHandoff",
    "TradeDeckBundle",
    "TradeLine",
    "Trade",
    "InventoryItem",
    "DeckCard",
    "InventoryLocation",
    "Deck",
    "Card",
    "User",
    "Player",
  ];
  for (const table of ownedTables) {
    const [row] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM "${table}"`,
    );
    assert.equal(
      Number(row.n),
      0,
      "This verifier requires its freshly migrated empty fixture database.",
    );
  }
  const initialTables = await fingerprint(
    db,
    business.map((row) => row.tablename),
  );
  const f = await seedHuntActions(db, "hunt-actions-" + randomUUID());
  const actor = { id: f.owner, playerId: f.owner };
  const build = (hunt: CardHuntInput = f.hunt) =>
    db.$transaction((tx) => buildCardHunt(tx, actor, hunt), {
      isolationLevel: "RepeatableRead",
    });
  const fresh = async (id: string) =>
    db.inventoryItem.findUniqueOrThrow({ where: { id } });
  const totals = () => db.inventoryItem.aggregate({ _sum: { quantity: true } });
  const give = (
    hunt: CardHuntInput,
    picks: HuntPick[],
    recipient:
      | { type: "EXTERNAL"; name: string }
      | { type: "ARCHIVE"; playerId: string } = {
      type: "EXTERNAL",
      name: "Pat",
    },
  ): HuntActionInput => ({
    requestId: randomUUID(),
    action: "GIVE",
    kind: "GIFT",
    recipient,
    hunt,
    selected: selected(picks),
  });
  try {
    const before = await fingerprint(db),
      plan = await build();
    let picks = plan.boxes.flatMap((box) => box.picks);
    assert.equal(plan.requested, 5);
    assert.equal(plan.alreadyInDeck, 1);
    assert.equal(plan.planned, 4);
    assert.equal(plan.shortage, 0);
    assert(picks.every((pick) => pick.inventoryItemId === f.ring.id));
    assert.deepEqual(await fingerprint(db), before);
    assert.equal(new Set(picks.map((pick) => pick.sourceLabel)).size, 3);
    assert(picks.every((pick) => pick.stamp?.length === 64));
    const bOriginal = picks.filter((pick) => pick.deckId === f.deckB.id),
      blockedCommit: HuntActionInput = {
        requestId: randomUUID(),
        action: "COMMIT",
        hunt: f.hunt,
        selected: selected(bOriginal),
      };
    const bundle = await db.tradeDeckBundle.create({
      data: {
        tradeId: f.trade.id,
        side: "PROPOSER",
        deckId: f.deckB.id,
        snapshotJson: { synthetic: true },
        snapshotDigest: "a".repeat(64),
      },
    });
    const withBundle = await fingerprint(db);
    assert.equal(
      (await performHuntAction(db, f.owner, blockedCommit)).status,
      "REJECTED",
    );
    assert.deepEqual(await fingerprint(db), withBundle);
    await db.tradeDeckBundle.delete({ where: { id: bundle.id } });
    const beforeOverfill = await fingerprint(db);
    assert.equal(
      (
        await performHuntAction(db, f.owner, {
          ...blockedCommit,
          requestId: randomUUID(),
          selected: blockedCommit.selected.map((move) => ({
            ...move,
            quantity: 3,
          })),
        })
      ).status,
      "REJECTED",
    );
    assert.deepEqual(await fingerprint(db), beforeOverfill);
    await db.deckCard.update({
      where: { id: f.deckRows[1].id },
      data: { quantity: 3 },
    });
    const changedRow = await fingerprint(db);
    assert.equal(
      (
        await performHuntAction(db, f.owner, {
          ...blockedCommit,
          requestId: randomUUID(),
        })
      ).status,
      "REJECTED",
    );
    assert.deepEqual(await fingerprint(db), changedRow);
    await db.deckCard.update({
      where: { id: f.deckRows[1].id },
      data: { quantity: 2 },
    });
    picks = (await build()).boxes.flatMap((box) => box.picks);
    const nonB = picks.filter((pick) => pick.deckId !== f.deckB.id);
    assert.equal(
      nonB.reduce((n, pick) => n + pick.quantity, 0),
      2,
    );
    const gift = give(f.hunt, nonB),
      initial = (await totals())._sum.quantity!;
    const sent = await performHuntAction(db, f.owner, gift);
    assert.equal(sent.status, "APPLIED");
    assert.equal(sent.quantity, 2);
    assert.equal(sent.handoffIds.length, 1);
    assert.equal((await totals())._sum.quantity, initial - 2);
    const replay = await performHuntAction(db, f.owner, gift);
    assert.equal(replay.status, "APPLIED");
    assert(replay.replay);
    assert.equal(await db.cardHandoff.count(), 1);
    await assert.rejects(
      performHuntAction(db, f.owner, {
        ...gift,
        recipient: { type: "EXTERNAL", name: "Different" },
      }),
      /different action/,
    );
    const b = picks
      .filter((pick) => pick.deckId === f.deckB.id)
      .map((pick) => ({
        ...pick,
        stamp: sent.stockUpdates.find(
          (item) => item.id === pick.inventoryItemId,
        )!.stamp,
      }));
    const commit: HuntActionInput = {
      requestId: randomUUID(),
      action: "COMMIT",
      hunt: f.hunt,
      selected: selected(b),
    };
    const committed = await performHuntAction(db, f.owner, commit);
    assert.equal(committed.status, "APPLIED");
    assert.equal(committed.quantity, 2);
    assert.equal((await totals())._sum.quantity, initial - 2);
    const inB = await db.inventoryItem.findMany({
      where: { location: { deckId: f.deckB.id }, quantity: { gt: 0 } },
    });
    assert.equal(inB.length, 1);
    assert.equal(inB[0].quantity, 2);
    assert.equal(inB[0].originalOpenerId, f.recipient);
    assert.equal(inB[0].sourceType, "ACQUISITION");
    assert.equal(inB[0].notes, "Preserve this lot");
    assert.equal(inB[0].language, "JA");
    assert.equal(inB[0].cardId, f.alternate.id);
    assert.equal(
      (await db.deckCard.findUniqueOrThrow({ where: { id: f.deckRows[1].id } }))
        .cardId,
      f.alternate.id,
    );
    assert((await performHuntAction(db, f.owner, commit)).replay);
    assert.equal((await fresh(f.ring.id)).quantity, 2);
    // A reserved, unselected deck must not block or be touched by another pull.
    const extra = await db.card.create({
      data: {
        id: f.tag + "-extra",
        scryfallId: randomUUID(),
        oracleId: randomUUID(),
        name: "Extra " + f.tag,
        setCode: "tst",
        collectorNumber: "4",
        typeLine: "Artifact",
        rarity: "common",
      },
    });
    const deckC = await db.deck.create({
      data: { id: f.tag + "-deck-c", ownerUserId: f.owner, name: "Deck C" },
    });
    await db.deckCard.create({
      data: {
        deckId: deckC.id,
        cardId: extra.id,
        oracleId: extra.oracleId,
        cardName: extra.name,
        quantity: 1,
      },
    });
    await db.inventoryItem.create({
      data: {
        currentOwnerId: f.owner,
        cardId: extra.id,
        quantity: 1,
        condition: "NM",
        locationId: f.box.id,
      },
    });
    const aReserved = await db.tradeDeckBundle.create({
      data: {
        tradeId: f.trade.id,
        side: "PROPOSER",
        deckId: f.deckA.id,
        snapshotJson: { synthetic: true },
        snapshotDigest: "b".repeat(64),
      },
    });
    const aLocation = await db.inventoryLocation.findUniqueOrThrow({
      where: { deckId: f.deckA.id },
    });
    const ac: CardHuntInput = {
      ...f.hunt,
      sources: [
        { kind: "DECK", id: "a", deckId: f.deckA.id },
        { kind: "DECK", id: "c", deckId: deckC.id },
      ],
    };
    const cPicks = (await build(ac)).boxes
      .flatMap((box) => box.picks)
      .filter((pick) => pick.deckId === deckC.id);
    const preC = (await totals())._sum.quantity;
    assert.equal(
      (
        await performHuntAction(db, f.owner, {
          requestId: randomUUID(),
          action: "COMMIT",
          hunt: ac,
          selected: selected(cPicks),
        })
      ).status,
      "APPLIED",
    );
    assert.equal((await totals())._sum.quantity, preC);
    assert.deepEqual(
      await db.inventoryLocation.findUniqueOrThrow({
        where: { id: aLocation.id },
      }),
      aLocation,
    );
    await db.tradeDeckBundle.delete({ where: { id: aReserved.id } });
    console.log(
      "Hunt actions SQL PASS: additive combined demand, shared storage once, deck-specific committed subtraction, external history, exact replay, alternate printing and lot provenance conservation",
    );

    const list: CardHuntInput = {
      text: `2 ${f.signet.name}`,
      mode: "boxes",
      finish: "ANY",
      includeMaybeboard: false,
      ignoreBasicLands: false,
    };
    const signet = (await build(list)).boxes.flatMap((box) => box.picks);
    const internal = give(list, [{ ...signet[0], quantity: 1 }], {
      type: "ARCHIVE",
      playerId: f.recipient,
    });
    await db.user.update({
      where: { id: f.recipient },
      data: { isActive: false },
    });
    const inactiveRecipient = await fingerprint(db);
    assert.equal(
      (
        await performHuntAction(db, f.owner, {
          ...internal,
          requestId: randomUUID(),
        })
      ).status,
      "REJECTED",
    );
    assert.deepEqual(await fingerprint(db), inactiveRecipient);
    await db.user.update({
      where: { id: f.recipient },
      data: { isActive: true },
    });
    const n = (await totals())._sum.quantity;
    const delivered = await performHuntAction(db, f.owner, internal);
    assert.equal(delivered.status, "APPLIED");
    assert.equal((await totals())._sum.quantity, n);
    const received = await db.inventoryItem.findFirstOrThrow({
      where: {
        currentOwnerId: f.recipient,
        cardId: f.signet.id,
        quantity: { gt: 0 },
      },
      include: { location: true },
    });
    assert.equal(received.location?.normalizedName, "unassigned");
    assert.equal(received.originalOpenerId, null);
    assert.equal(received.quantity, 1);
    assert.equal(
      (
        await db.cardHandoff.findUniqueOrThrow({
          where: { id: delivered.handoffIds[0] },
        })
      ).toPlayerId,
      f.recipient,
    );
    await db.inventoryLocation.update({
      where: { id: received.location!.id },
      data: { active: false },
    });
    const inactiveDestination = await fingerprint(db);
    const nextSignet = (await build(list)).boxes.flatMap((box) => box.picks)[0];
    assert.equal(
      (
        await performHuntAction(
          db,
          f.owner,
          give(list, [{ ...nextSignet, quantity: 1 }], {
            type: "ARCHIVE",
            playerId: f.recipient,
          }),
        )
      ).status,
      "REJECTED",
    );
    assert.deepEqual(await fingerprint(db), inactiveDestination);
    await db.inventoryLocation.update({
      where: { id: received.location!.id },
      data: { active: true },
    });
    const last = (
      await build({ ...list, text: `1 ${f.signet.name}` })
    ).boxes.flatMap((box) => box.picks)[0];
    const one = give({ ...list, text: `1 ${f.signet.name}` }, [last]);
    const competing = await Promise.all([
      performHuntAction(db, f.owner, one),
      performHuntAction(db, f.owner, { ...one, requestId: randomUUID() }),
    ]);
    assert.equal(competing.filter((r) => r.status === "APPLIED").length, 1);
    assert.equal(competing.filter((r) => r.status === "REJECTED").length, 1);
    assert.equal((await fresh(f.token.id)).quantity, 0);
    assert.equal(
      (await performHuntAction(db, f.owner, one)).status,
      competing[0].status,
    );
    const applied = competing.find((result) => result.status === "APPLIED")!;
    const appliedInput =
      applied.requestId === one.requestId
        ? one
        : { ...one, requestId: applied.requestId };
    assert((await performHuntAction(db, f.owner, appliedInput)).replay);
    const rejected = competing.find((result) => result.status === "REJECTED")!;
    await db.inventoryItem.update({
      where: { id: f.token.id },
      data: { quantity: 1 },
    });
    assert.equal(
      (
        await performHuntAction(db, f.owner, {
          ...one,
          requestId: rejected.requestId,
        })
      ).status,
      "REJECTED",
    );
    assert.equal((await fresh(f.token.id)).quantity, 1);
    console.log(
      "Hunt actions SQL PASS: immediate Archive Unassigned delivery, private history, last-copy replay, competing writers and terminal rejected-request fence",
    );

    const denied = async (input: HuntActionInput, pattern: RegExp) => {
      const before = await fingerprint(db);
      const result = await performHuntAction(db, f.owner, input);
      assert.equal(result.status, "REJECTED");
      assert.match(result.message, pattern);
      assert.deepEqual(await fingerprint(db), before);
      return result;
    };
    const ringNow = await fresh(f.ring.id),
      request = (await build()).lines.find(
        (line) => line.request.deckId === f.deckA.id,
      )!.request;
    const reserved: HuntActionInput = {
      requestId: randomUUID(),
      action: "COMMIT",
      hunt: f.hunt,
      selected: [
        {
          requestId: request.id,
          inventoryItemId: ringNow.id,
          quantity: 1,
          stamp: handoffStamp(ringNow),
          targetStamp: request.targetStamp,
        },
      ],
    };
    await denied(reserved, /reservations/);
    await denied(
      {
        ...give(list, [
          { ...last, stamp: handoffStamp(await fresh(f.token.id)) },
        ]),
        selected: [
          { ...one.selected[0], inventoryItemId: `${f.tag}-other-lot` },
        ],
      },
      /no longer available/,
    );
    await denied(
      {
        ...reserved,
        requestId: randomUUID(),
        hunt: {
          ...f.hunt,
          sources: [{ kind: "DECK", id: "foreign", deckId: f.foreignDeck.id }],
        },
      },
      /no longer belongs/,
    );
    const stale = give(list, [
      { ...last, stamp: handoffStamp(await fresh(f.token.id)) },
    ]);
    await db.inventoryItem.update({
      where: { id: f.token.id },
      data: { locationSection: "Changed" },
    });
    await denied(stale, /changed/);
    const inactivePick = {
      ...last,
      stamp: handoffStamp(await fresh(f.token.id)),
    };
    await db.inventoryLocation.update({
      where: { id: f.box.id },
      data: { active: false },
    });
    await denied(give(list, [inactivePick]), /storage location changed/);
    await db.inventoryLocation.update({
      where: { id: f.box.id },
      data: { active: true },
    });
    const mixed = give(list, [
      { ...last, stamp: handoffStamp(await fresh(f.token.id)) },
    ]);
    mixed.selected.push({
      ...mixed.selected[0],
      requestId: "missing-row",
      inventoryItemId: ringNow.id,
      stamp: handoffStamp(await fresh(ringNow.id)),
    });
    await denied(mixed, /reservations|no longer matches/);
    const context = await getHuntActionContext(db, f.owner);
    assert(context.recipients.every((person) => person.id !== f.owner));
    assert(context.recentPeople.includes("Pat"));
    await db.user.update({ where: { id: f.owner }, data: { isActive: false } });
    await assert.rejects(
      performHuntAction(db, f.owner, appliedInput),
      /active inventory account/,
    );
    await db.user.update({ where: { id: f.owner }, data: { isActive: true } });
    console.log(
      "Hunt actions SQL PASS: modern/legacy reservations, stale revisions, inactive/foreign storage, foreign deck/account isolation and all-or-nothing rejection",
    );

    // A real database audit failure must roll back both source and destination.
    await db.inventoryItem.create({
      data: {
        id: f.tag + "-rollback-lot",
        currentOwnerId: f.owner,
        cardId: f.preferred.id,
        quantity: 1,
        condition: "NM",
        locationId: f.box.id,
      },
    });
    const rollbackList = {
      ...list,
      text: `1 ${f.signet.name}\n1 ${f.preferred.name}`,
    };
    const finalPicks = (await build(rollbackList)).boxes.flatMap(
      (box) => box.picks,
    );
    assert.equal(finalPicks.length, 2);
    const retry = give(rollbackList, finalPicks);
    const baseline = await fingerprint(db);
    await db.$executeRawUnsafe(
      `CREATE FUNCTION public.hunt_actions_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."inventoryItemId"='${f.token.id}' THEN RAISE EXCEPTION 'Owned hunt audit fixture'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER hunt_actions_fail_audit BEFORE INSERT ON "InventoryAuditLog" FOR EACH ROW EXECUTE FUNCTION public.hunt_actions_fail_audit()`,
    );
    await assert.rejects(
      performHuntAction(db, f.owner, retry),
      /Owned hunt audit fixture/,
    );
    assert.deepEqual(await fingerprint(db), baseline);
    assert.equal(
      await db.cardHuntAction.count({ where: { requestId: retry.requestId } }),
      0,
    );
    await db.$executeRawUnsafe(
      `DROP TRIGGER hunt_actions_fail_audit ON "InventoryAuditLog"`,
    );
    await db.$executeRawUnsafe(
      `DROP FUNCTION public.hunt_actions_fail_audit()`,
    );
    assert.equal(
      (await performHuntAction(db, f.owner, retry)).status,
      "APPLIED",
    );
    assert((await performHuntAction(db, f.owner, retry)).replay);
    console.log(
      "Hunt actions SQL PASS: actual audit-trigger rollback, unknown-outcome same-request retry and no duplicate receipt",
    );
    const repairDeck = await db.deck.create({ data: { ownerUserId: f.owner, name: "Historical mixed printings" } });
    const repairRow = await db.deckCard.create({ data: { deckId: repairDeck.id, cardId: f.preferred.id, oracleId: f.preferred.oracleId, cardName: f.preferred.name, quantity: 4, section: "SIDEBOARD", notes: "Keep my notes" } });
    const repairLocation = await db.$transaction(tx => ensureDeckLocation(tx, { ...repairDeck, ownerUser: { playerId: f.owner } }));
    await db.inventoryItem.createMany({ data: [f.preferred, f.alternate].map(card => ({ currentOwnerId: f.owner, cardId: card.id, quantity: 1, condition: "NM", locationId: repairLocation.id })) });
    await db.inventoryItem.create({ data: { currentOwnerId: f.owner, cardId: f.alternate.id, quantity: 2, condition: "NM", locationId: f.box.id } });
    const repair = () => db.$transaction(async tx => {
      await lockWritableDeck(tx, repairDeck.id, f.owner);
      return syncCommittedDeckPrintings(tx, repairDeck.id, f.owner);
    }, { isolationLevel: "Serializable" });
    const stockBeforeRepair = await fingerprint(db, ["InventoryItem", "InventoryAuditLog", "CardHuntAction", "CardHandoff"]);
    assert.equal(await repair(), 1);
    assert.deepEqual(await fingerprint(db, ["InventoryItem", "InventoryAuditLog", "CardHuntAction", "CardHandoff"]), stockBeforeRepair);
    let repairedRows = await db.deckCard.findMany({ where: { deckId: repairDeck.id } });
    assert.deepEqual(repairedRows.map(row => [row.cardId, row.quantity]).sort(), [[f.preferred.id, 3], [f.alternate.id, 1]].sort());
    assert(repairedRows.every(row => row.section === "SIDEBOARD" && row.notes === "Keep my notes"));
    const repairedFingerprint = await fingerprint(db);
    assert.equal(await repair(), 0);
    assert.deepEqual(await fingerprint(db), repairedFingerprint);
    const repairHunt: CardHuntInput = { ...f.hunt, sources: [{ kind: "DECK", id: "repair", deckId: repairDeck.id }], includeMaybeboard: true };
    const repairPlan = await build(repairHunt);
    const repairPick = repairPlan.boxes.flatMap(box => box.picks).find(pick => pick.deckCardId === repairRow.id)!;
    assert.equal(repairPick.quantity, 2);
    const firstCommit: HuntActionInput = { requestId: randomUUID(), action: "COMMIT", hunt: repairHunt, selected: selected([{ ...repairPick, quantity: 1 }]) };
    const beforeCommit = (await totals())._sum.quantity;
    const firstResult = await performHuntAction(db, f.owner, firstCommit);
    assert.equal(firstResult.status, "APPLIED");
    const next = advanceHunt(repairPlan, firstCommit.selected, firstResult);
    const nextPick = next.boxes.flatMap(box => box.picks).find(pick => pick.deckCardId === repairRow.id)!;
    assert.equal(nextPick.quantity, 1);
    assert.notEqual(nextPick.targetStamp, repairPick.targetStamp);
    const secondCommit: HuntActionInput = { requestId: randomUUID(), action: "COMMIT", hunt: repairHunt, selected: selected([nextPick]) };
    assert.equal((await performHuntAction(db, f.owner, secondCommit)).status, "APPLIED");
    assert.equal((await totals())._sum.quantity, beforeCommit);
    repairedRows = await db.deckCard.findMany({ where: { deckId: repairDeck.id } });
    assert.deepEqual(repairedRows.map(row => [row.cardId, row.quantity]).sort(), [[f.preferred.id, 1], [f.alternate.id, 3]].sort());
    assert(repairedRows.every(row => row.section === "SIDEBOARD" && row.notes === "Keep my notes"));
    const afterCommits = await fingerprint(db);
    assert((await performHuntAction(db, f.owner, firstCommit)).replay);
    assert((await performHuntAction(db, f.owner, secondCommit)).replay);
    assert.deepEqual(await fingerprint(db), afterCommits);
    assert.equal((await build(repairHunt)).planned, 0);
    console.log("Hunt actions SQL PASS: historical printing repair changes no inventory/history, mixed quantities/notes/sections conserved, idempotent repair, consecutive partial commits without rebuild, same-printing row reuse and exact replay");
    const basicsDeck = await db.deck.create({ data: { ownerUserId: f.owner, name: "Masters of Evil regression" } });
    const basicsLocation = await db.$transaction(tx => ensureDeckLocation(tx, { ...basicsDeck, ownerUser: { playerId: f.owner } }));
    const basicsRows: Array<{ row: DeckCard; offset: number }> = [];
    for (const [name, number] of [["Island", 198], ["Mountain", 202], ["Swamp", 200]] as const) {
      const oracle = randomUUID();
      for (const offset of [0, 1]) {
        const card = await db.card.create({ data: { scryfallId: randomUUID(), oracleId: oracle, name, setCode: "who", collectorNumber: String(number + offset), typeLine: `Basic Land — ${name}`, rarity: "common" } });
        const row = await db.deckCard.create({ data: { deckId: basicsDeck.id, cardId: card.id, oracleId: oracle, cardName: name, quantity: 1 } });
        basicsRows.push({ row, offset });
        await db.inventoryItem.create({ data: { currentOwnerId: f.owner, cardId: card.id, quantity: 1, condition: "NM", locationId: offset ? null : basicsLocation.id } });
      }
    }
    const beforeBasicChecks = await fingerprint(db);
    await db.$transaction(async tx => {
      await lockWritableDeck(tx, basicsDeck.id, f.owner);
      const stock = await tx.inventoryItem.findMany({ where: { currentOwnerId: f.owner, locationId: basicsLocation.id }, include: { card: true } });
      for (const { row, offset } of basicsRows)
        assert.equal(await getDeckRowCommittedQuantity(tx, basicsDeck.id, row.id, stock), offset ? 0 : 1);
    });
    assert.deepEqual(await fingerprint(db), beforeBasicChecks);
    console.log("Hunt actions SQL PASS: Masters of Evil basic-land capacity uses all deck rows, each exact copy once, matching loose printings remain eligible and read checks conserve every business table");
  } finally {
    await db.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS hunt_actions_fail_audit ON "InventoryAuditLog"`,
    );
    await db.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS public.hunt_actions_fail_audit()`,
    );
    // These tables were empty on entry. Preserve migrated system catalogs and all
    // other baseline rows; no cascading database-wide reset is used.
    for (const table of ownedTables)
      await db.$executeRawUnsafe(`DELETE FROM "${table}"`);
    assert.deepEqual(
      await fingerprint(
        db,
        business.map((row) => row.tablename),
      ),
      initialTables,
    );
    await db.$disconnect();
  }
  console.log(
    "Hunt actions SQL PASS: every initially empty business table restored",
  );
}
if (process.argv.includes("--run"))
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
