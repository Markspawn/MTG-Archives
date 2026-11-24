import { prisma } from "@/lib/prisma";
import { buildPublicInventoryWhere } from "@/lib/public-collection";
import type { PublicInventoryMember } from "@/lib/public-inventory-scope";

export async function getPublicInventoryMember(username: string): Promise<PublicInventoryMember | null> {
  const user = await prisma.user.findUnique({
    where: { username, isActive: true, player: { inventoryOwned: { some: buildPublicInventoryWhere({}) } } },
    select: { username: true, playerId: true, publicDisplayName: true, displayName: true, publicInventoryHidePricing: true },
  });
  if (!user?.playerId) return null;
  return {
    username: user.username,
    ownerPlayerId: user.playerId,
    displayName: user.publicDisplayName?.trim() || user.displayName,
    hidePricing: user.publicInventoryHidePricing,
  };
}
