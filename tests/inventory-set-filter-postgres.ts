// Explicit disposable-database qualification; never run against an installation.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { buildInventoryWhereFromFilters, parseInventoryFilters } from "../lib/inventory-filters";
import { buildPublicInventoryWhere } from "../lib/public-collection";

const target = new URL(process.env.DATABASE_URL || "postgresql://invalid/invalid");
assert.equal(process.env.MTG_SET_FILTER_DATABASE_TEST, "1");
assert.equal(target.hostname, "mtg-set-filter-db");
assert.equal(target.pathname, "/review_set_filter");
const db = new PrismaClient();
const tag = `set-filter-${randomUUID()}`;
const cards = [
  ["mar", "MAR", "Marvel Universe", "draw a card"],
  ["mom", "mom", "March of the Machine", "draw a card"],
  ["mat", "mat", "March of the Machine: The Aftermath", "draw a card"],
  ["msh", "msh", "Marvel Super Heroes", "draw a card"],
  ["custom", "xyz", "March", "draw a card"],
  ["bonus", "bns", "Marvel Universe Bonus", "draw a card"],
  ["null", "nul", null, "draw a card"],
  ["mar2", "mar", "Marvel Universe", "gain life"],
] as const;
const results: Array<{ name: string; pass: boolean; error?: string }> = [];
const rollback = new Error("Rollback disposable set-filter fixture");

async function main() {
  const inventoryBefore = await db.inventoryItem.count();
  const cardsBefore = await db.card.count();
  try {
    await db.$transaction(async (tx) => {
      for (const owner of ["own", "public-peer", "private-peer"]) {
        const id = `${tag}-${owner}`;
        await tx.player.create({ data: { id, name: id, displayName: id } });
        await tx.user.create({ data: { id, username: id, displayName: id, passwordHash: "unused-fixture", playerId: id,
          inventoryDefaultVisibility: owner === "private-peer" ? "PRIVATE" : "PUBLIC" } });
      }
      for (const [key, setCode, setName, oracleText] of cards) {
        const id = `${tag}-${key}`;
        await tx.card.create({ data: { id, scryfallId: id, name: `${tag} ${key}`, setCode, setName,
          oracleText, collectorNumber: key, typeLine: "Creature", rarity: "common" } });
        for (const owner of ["own", "public-peer", "private-peer"]) {
          const ownerId = `${tag}-${owner}`;
          await tx.inventoryItem.create({ data: { id: `${id}-${owner}`, cardId: id, currentOwnerId: ownerId,
            originalOpenerId: ownerId, quantity: owner === "private-peer" ? 99 : 2, sourceType: "MANUAL", condition: "NM" } });
        }
      }
      for (const surface of ["private", "public"] as const) {
        const check = async (name: string, params: Record<string, string | string[]>, expected: string[], owners: number) => {
          try {
            const where = surface === "private"
              ? buildInventoryWhereFromFilters(parseInventoryFilters(params), { playerId: `${tag}-own` })
              : buildPublicInventoryWhere({ ...params, owner: [`${tag}-own`, `${tag}-public-peer`, `${tag}-private-peer`] });
            const rows = await tx.inventoryItem.findMany({ where, orderBy: { id: "asc" }, select: { cardId: true, quantity: true, currentOwnerId: true } });
            assert.deepEqual([...new Set(rows.map(r => r.cardId.slice(tag.length + 1)))].sort(), [...expected].sort());
            assert.equal(rows.length, expected.length * owners);
            assert.equal(rows.reduce((n, r) => n + r.quantity, 0), expected.length * owners * 2);
            assert(rows.every(r => !r.currentOwnerId.endsWith("private-peer")));
            assert.equal(await tx.inventoryItem.count({ where }), rows.length);
            results.push({ name: `${surface}: ${name}`, pass: true });
          } catch (error) {
            results.push({ name: `${surface}: ${name}`, pass: false, error: String(error) });
          }
        };
        const owners = surface === "public" ? 2 : 1;
        await check("code MAR excludes unrelated names", { set: "MaR" }, ["mar", "mar2"], owners);
        await check("multiple sets are a union", { set: ["MAR", "mat", "mar"] }, ["mar", "mar2", "mat"], owners);
        await check("full names match without prefixes", { set: "mArVeL uNiVeRsE" }, ["mar", "mar2"], owners);
        await check("literal full name does not admit a longer name", { set: "March" }, ["custom"], owners);
        await check("other filters still intersect", { set: "mar", oracleText: "draw a card" }, ["mar"], owners);
        await check("unknown code returns no cards", { set: "unknown-set" }, [], owners);
        await check("null name is valid with exact code", { set: "NUL" }, ["null"], owners);
        await check("general text search remains partial", surface === "public" ? { q: "March" } : { cardName: "March" }, ["mom", "mat", "custom"], owners);
      }
      throw rollback;
    }, { timeout: 30000 });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  assert.equal(await db.inventoryItem.count(), inventoryBefore);
  assert.equal(await db.card.count(), cardsBefore);
  assert.equal(await db.user.count({ where: { id: { startsWith: tag } } }), 0);
  assert.equal(await db.player.count({ where: { id: { startsWith: tag } } }), 0);
  console.log(JSON.stringify({ results, fixtureRolledBack: true }));
  if (results.some(r => !r.pass)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
