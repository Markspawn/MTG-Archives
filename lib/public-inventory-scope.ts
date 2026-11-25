export type PublicInventoryMember = {
  username: string;
  ownerPlayerId: string;
  displayName: string;
  hidePricing: boolean;
};

export type PublicInventoryParams = Record<string, string | string[] | undefined>;

// Scope comes from the route's resolved account, never a visitor's query string.
export function scopedPublicInventoryParams(params: PublicInventoryParams, member?: PublicInventoryMember): PublicInventoryParams {
  if (!member) return params;
  const next = { ...params };
  delete next.owner;
  delete next.ownerId;
  if (member.hidePricing) {
    delete next.priceMin;
    delete next.priceMax;
    if (["preferredPriceLabel", "priceUsd"].includes(String(next.sort))) {
      delete next.sort;
      delete next.sortDir;
    }
  }
  return next;
}

// Omit prices from the public client payload as well as the visible controls.
export function publicInventoryRowsWithoutPricing<T extends object>(rows: T[]): T[] {
  return rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) =>
    !key.startsWith("price") && key !== "preferredPriceLabel",
  )) as T);
}
