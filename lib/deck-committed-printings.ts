import type { Prisma } from "@prisma/client";
import { matchesDeckCardPrinting, type DeckCardCommitmentInput } from "./deck-commitments";

type Row = DeckCardCommitmentInput & { id: string };
type Stock = { cardId: string; quantity: number; card: { id: string; name: string; oracleId: string | null } };

/** Allocate each physical copy once, giving every row its exact printing first.
 * Unfilled copies retain their requested printing. The original row keeps that
 * printing when possible, so a partial hunt can continue against the same ID. */
export function planCommittedDeckPrintings(rows: Row[], stock: Stock[]) {
  const remaining = stock.map(item => Math.max(0, item.quantity));
  const plans = rows.map(row => ({ row, committed: 0, parts: new Map<string | null, number>() }));
  for (const exact of [true, false]) {
    for (const plan of plans) {
      for (let index = 0; index < stock.length && plan.committed < plan.row.quantity; index++) {
        const item = stock[index];
        const match = matchesDeckCardPrinting(plan.row, item);
        if (!remaining[index] || !match || (match === "exact") !== exact) continue;
        const quantity = Math.min(remaining[index], plan.row.quantity - plan.committed);
        remaining[index] -= quantity;
        plan.committed += quantity;
        plan.parts.set(item.cardId, (plan.parts.get(item.cardId) ?? 0) + quantity);
      }
    }
  }
  return plans.map(({ row, committed, parts }) => {
    const requested = row.cardId ?? null;
    const missing = Math.max(0, row.quantity - committed);
    if (missing) parts.set(requested, (parts.get(requested) ?? 0) + missing);
    const printings = [...parts].map(([cardId, quantity]) => ({ cardId, quantity }));
    printings.sort((a, b) => Number(b.cardId === requested) - Number(a.cardId === requested) || (a.cardId ?? "").localeCompare(b.cardId ?? ""));
    return { rowId: row.id, committed, printings, changed: printings.length !== 1 || printings[0]?.cardId !== requested || printings[0]?.quantity !== row.quantity };
  });
}

/** A row's capacity depends on the whole deck's allocation, not the sum of all
 * matching oracle copies. In particular, two one-copy basic-land printing rows
 * must not both claim the same committed land. Caller holds the writable deck. */
export async function getDeckRowCommittedQuantity(
  tx: Prisma.TransactionClient,
  deckId: string,
  rowId: string,
  committedItems: Stock[],
) {
  const rows = await tx.deckCard.findMany({
    where: { deckId },
    orderBy: [{ section: "asc" }, { id: "asc" }],
  });
  return planCommittedDeckPrintings(rows, committedItems).find(plan => plan.rowId === rowId)?.committed ?? 0;
}

/** Caller holds the deck owner gate and writable Deck lock, and has checked
 * ownership / trade reservations. This edits the deck list, never physical stock. */
export async function syncCommittedDeckPrintings(tx: Prisma.TransactionClient, deckId: string, ownerPlayerId: string, selectedRowIds?: string[]) {
  const rows = await tx.deckCard.findMany({ where: { deckId, quantity: { gt: 0 } }, orderBy: [{ section: "asc" }, { id: "asc" }] });
  const stock = await tx.inventoryItem.findMany({
    where: { currentOwnerId: ownerPlayerId, quantity: { gt: 0 }, location: { deckId } },
    include: { card: true }, orderBy: { id: "asc" },
  });
  const selected = selectedRowIds ? rows.filter(row => selectedRowIds.includes(row.id)) : rows;
  // Reconcile the whole selected card family so duplicate rows/sections cannot
  // claim the same physical copies. Unrelated rows remain untouched.
  const affected = (row: typeof rows[number]) => selected.some(target =>
    target.id === row.id || (target.oracleId && row.oracleId === target.oracleId) ||
    ((!target.oracleId || !row.oracleId) && target.cardName.trim().replace(/\s+/g, " ").toLowerCase() === row.cardName.trim().replace(/\s+/g, " ").toLowerCase()));
  const cards = new Map(stock.map(item => [item.cardId, item.card]));
  const plans = planCommittedDeckPrintings(rows, stock);
  const primary = new Map(plans.map(plan => [plan.rowId, { ...plan.printings[0] }]));
  const changed = new Set<string>();
  const removed = new Set<string>();
  const additions: Array<{ row: typeof rows[number]; cardId: string | null; quantity: number }> = [];
  for (const plan of plans) {
    const row = rows.find(row => row.id === plan.rowId)!;
    if (!affected(row) || !plan.changed) continue;
    changed.add(row.id);
    for (const part of plan.printings.slice(1)) {
      const sameMetadata = (candidate: typeof row) => candidate.section === row.section && candidate.notes === row.notes && candidate.isCommander === row.isCommander;
      const existing = rows.find(candidate => sameMetadata(candidate) && primary.get(candidate.id)?.cardId === part.cardId);
      if (existing) {
        primary.get(existing.id)!.quantity += part.quantity;
        changed.add(existing.id);
      } else {
        const added = additions.find(candidate => sameMetadata(candidate.row) && candidate.cardId === part.cardId);
        if (added) added.quantity += part.quantity;
        else additions.push({ row, ...part });
      }
    }
  }
  // A later partial pull can fully replace the last requested copies. Fold that
  // newly replaced row into an existing row for the same printing/section/notes.
  // Preserve intentionally separate original rows when their printing did not change.
  for (const row of rows) {
    const part = primary.get(row.id)!;
    if (!changed.has(row.id) || removed.has(row.id) || part.cardId === row.cardId) continue;
    const existing = rows.find(candidate => candidate.id !== row.id && !removed.has(candidate.id) &&
      candidate.section === row.section && candidate.notes === row.notes && candidate.isCommander === row.isCommander &&
      primary.get(candidate.id)?.cardId === part.cardId);
    if (existing) {
      primary.get(existing.id)!.quantity += part.quantity;
      changed.add(existing.id);
      removed.add(row.id);
    }
  }
  for (const row of rows) {
    if (!changed.has(row.id)) continue;
    if (removed.has(row.id)) {
      await tx.deckCard.delete({ where: { id: row.id } });
      continue;
    }
    const part = primary.get(row.id)!;
    const card = part.cardId ? cards.get(part.cardId) : null;
    await tx.deckCard.update({ where: { id: row.id }, data: {
      cardId: part.cardId, quantity: part.quantity,
      scryfallId: card?.scryfallId ?? row.scryfallId,
      oracleId: card?.oracleId ?? row.oracleId,
      cardName: card?.name ?? row.cardName,
    } });
  }
  for (const { row, ...part } of additions) {
      const card = part.cardId ? cards.get(part.cardId) : null;
      const data = {
        cardId: part.cardId, quantity: part.quantity,
        scryfallId: card?.scryfallId ?? row.scryfallId,
        oracleId: card?.oracleId ?? row.oracleId,
        cardName: card?.name ?? row.cardName,
      };
      await tx.deckCard.create({ data: { ...data, deckId, section: row.section, isCommander: row.isCommander, notes: row.notes } });
  }
  return changed.size;
}
