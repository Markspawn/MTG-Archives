import { finishForFoilStatus, selectPreferredCardPrice } from "./price-history";

export const additionPeriods = [
  { label: "24 hours", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "7 days", hours: 168 },
  { label: "30 days", hours: 720 },
] as const;

export type AdditionGroup = {
  foilStatus: string;
  prices: unknown;
  copies24h: bigint | number;
  copies3d: bigint | number;
  copies7d: bigint | number;
  copies30d: bigint | number;
};

/** Do not substitute a foil price for a normal copy or sum different currencies. */
export function additionPriceUsd(
  prices: unknown,
  foilStatus: string,
  preferredProvider: string,
) {
  const source = (prices ?? {}) as Record<string, any>;
  const finish = finishForFoilStatus(foilStatus);
  const key = finish === "normal" ? "usd" : `usd_${finish}`;
  const mtgjson = Object.fromEntries(
    Object.entries(source.mtgjson ?? {}).map(([provider, values]) => [
      provider,
      { [finish]: (values as Record<string, unknown>)?.[finish] },
    ]),
  );
  const selected = selectPreferredCardPrice(
    undefined,
    { [key]: source[key], mtgjson },
    { finish, preferredProvider },
  );
  return selected?.currency === "USD" && selected.amount >= 0
    ? selected.amount
    : null;
}

export function summarizeCollectionAdditions(
  groups: AdditionGroup[],
  preferredProvider = "scryfall",
) {
  const summaries = additionPeriods.map((period) => ({
    ...period,
    copies: 0,
    valueUsd: 0,
    unpricedCopies: 0,
  }));
  for (const group of groups) {
    const price = additionPriceUsd(
      group.prices,
      group.foilStatus,
      preferredProvider,
    );
    const quantities = [
      group.copies24h,
      group.copies3d,
      group.copies7d,
      group.copies30d,
    ];
    quantities.forEach((quantity, i) => {
      const copies = Number(quantity);
      if (!Number.isSafeInteger(copies) || copies < 0)
        throw new Error("Invalid addition count");
      summaries[i].copies += copies;
      if (price === null) summaries[i].unpricedCopies += copies;
      else summaries[i].valueUsd += copies * price;
    });
  }
  return summaries;
}
