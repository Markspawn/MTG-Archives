import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { getGlobalPublicInventory } from "../lib/public-collection";
import { getPublicInventoryMember } from "../lib/public-inventory-member";

export async function seedPersonalizedInventory(tag: string) {
  const password = randomUUID();
  const passwordHash = await bcrypt.hash(password, 4);
  for (const role of ["shop", "other", "empty", "inactive", "special"]) {
    const id = `${tag}-${role}`;
    await prisma.player.create({ data: { id, name: id, displayName: id } });
    await prisma.user.create({ data: { id, username: role === "special" ? `${tag}/ #~%2F` : id, displayName: `${role} collection`, passwordHash, playerId: id, isActive: role !== "inactive", inventoryDefaultVisibility: "PUBLIC" } });
    await prisma.inventoryLocation.create({ data: { id: `${id}-public`, name: `${role} public shelf`, normalizedName: `${role}-public`, ownerPlayerId: id, type: "Box", visibility: "PUBLIC" } });
    await prisma.inventoryLocation.create({ data: { id: `${id}-private`, name: `${role} secret shelf`, normalizedName: `${role}-private`, ownerPlayerId: id, type: "Box", visibility: "PRIVATE" } });
  }
  for (let i = 0; i < 13; i++) {
    const id = `${tag}-card-${i}`;
    await prisma.card.create({ data: { id, scryfallId: id, name: `${tag} Card ${String(i).padStart(2,"0")}`, setCode: "tst", setName: "Storefront test", collectorNumber: String(i), rarity: "common", typeLine: "Creature", prices: { usd: "12.34", eur: "10.25" } } });
    for (const role of ["shop", "other", "special"]) await prisma.inventoryItem.create({ data: { condition: "NM", id: `${tag}-${role}-item-${i}`, cardId: id, currentOwnerId: `${tag}-${role}`, originalOpenerId: `${tag}-${role}`, locationId: `${tag}-${role}-public`, quantity: role === "shop" ? 2 : 7 } });
  }
  await prisma.card.create({ data: { id: `${tag}-other-only`, scryfallId: `${tag}-other-only`, name: `${tag} OtherExclusive`, setCode: "oth", collectorNumber: "1", rarity: "rare", typeLine: "Artifact" } });
  await prisma.inventoryItem.create({ data: { condition: "NM", id: `${tag}-other-exclusive`, cardId: `${tag}-other-only`, currentOwnerId: `${tag}-other`, originalOpenerId: `${tag}-other`, locationId: `${tag}-other-public`, quantity: 10 } });
  await prisma.inventoryItem.create({ data: { condition: "NM", id: `${tag}-private-item`, cardId: `${tag}-card-0`, currentOwnerId: `${tag}-shop`, originalOpenerId: `${tag}-shop`, locationId: `${tag}-shop-private`, quantity: 100 } });
  return { username: `${tag}-shop`, other: `${tag}-other`, special: `${tag}/ #~%2F`, empty: `${tag}-empty`, inactive: `${tag}-inactive`, password, tag };
}

async function verify() {
  const url = new URL(process.env.DATABASE_URL!);
  assert.equal(process.env.MTG_STOREFRONT_TEST, "1");
  assert.equal(url.hostname, "mtg-storefront-db");
  assert.equal(url.pathname, "/storefront_qualification");
  const before = await prisma.inventoryItem.aggregate({ _sum: { quantity: true }, _count: true });
  const tag = `storefront-${randomUUID()}`;
  try {
    const f = await seedPersonalizedInventory(tag);
    const member = await getPublicInventoryMember(f.username);
    assert(member && !member.hidePricing);
    for (const displayMode of ["exact", "grouped"]) {
      for (const owner of [f.other, [f.other, f.username], "", undefined]) {
        const result = await getGlobalPublicInventory({ owner, displayMode, pageSize: "10", page: "2" }, member);
        assert.equal(result.totalMatchingCount, 13);
        assert.equal(result.inventory.length, 3);
        assert(result.inventory.every(i => i.currentOwnerId === member.ownerPlayerId && i.quantity === 2));
        assert(result.allPublicInventory.every(i => i.currentOwnerId === member.ownerPlayerId));
        assert.deepEqual(result.publicProfiles.map(p => p.ownerPlayerId), [member.ownerPlayerId]);
        assert.deepEqual(result.publicLocations.map(l => l.name), ["shop public shelf"]);
      }
      const none = await getGlobalPublicInventory({ owner: f.other, displayMode, locationName: "other public shelf" }, member);
      assert.equal(none.totalMatchingCount, 0);
    }
    const general = await getGlobalPublicInventory({ cardName: tag, displayMode: "grouped" });
    assert(general.inventory.some(i => i.currentOwnerId === f.other));
    assert.equal(await getPublicInventoryMember(f.inactive), null);
    assert.equal(await getPublicInventoryMember("missing-"+tag), null);
    const empty = await getPublicInventoryMember(f.empty); assert(empty);
    assert.equal((await getGlobalPublicInventory({}, empty)).totalMatchingCount, 0);
    await prisma.user.update({ where: { username: f.username }, data: { publicInventoryHidePricing: true } });
    assert.equal((await getPublicInventoryMember(f.username))?.hidePricing, true);
    console.log("Storefront SQL PASS: owner override, exact/grouped pages, drawer companions, owner/location metadata, visibility, empty/inactive and saved preference");
  } finally {
    await prisma.inventoryItem.deleteMany({ where: { id: { startsWith: tag } } });
    await prisma.inventoryLocation.deleteMany({ where: { id: { startsWith: tag } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: tag } } });
    await prisma.player.deleteMany({ where: { id: { startsWith: tag } } });
    await prisma.card.deleteMany({ where: { id: { startsWith: tag } } });
  }
  assert.deepEqual(await prisma.inventoryItem.aggregate({ _sum: { quantity: true }, _count: true }), before);
  console.log("Storefront SQL PASS: fixture stock restored exactly");
}
if (process.argv.includes("--run")) verify().catch(e => { console.error(e); process.exitCode=1; }).finally(() => prisma.$disconnect());
