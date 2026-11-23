import Link from "next/link";
import { requireLogin, getAccessScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Nav } from "@/components/Nav";
import { getHandoffHistory, HandoffError } from "@/lib/card-handoffs";
export const dynamic = "force-dynamic";
export default async function HandoffHistory({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireLogin(),
    scope = await getAccessScope(user),
    params = await searchParams;
  const value = (key: string) =>
    typeof params[key] === "string" ? (params[key] as string) : undefined;
  const admin = scope?.mode === "admin";
  const owners = admin
    ? await prisma.player.findMany({
        select: { id: true, displayName: true },
        orderBy: { displayName: "asc" },
      })
    : [];
  let history;
  try {
    history = await getHandoffHistory(
      prisma,
      { userId: user.id, adminMode: admin },
      {
        ownerId: value("owner"),
        cardId: value("cardId"),
        query: value("q"),
        direction: value("direction"),
        before: value("before"),
      },
    );
  } catch (error) {
    if (!(error instanceof HandoffError)) throw error;
    return (
      <main className="p-6">
        <Nav />
        <h1>Handoff history</h1>
        <p role="alert">{error.message}</p>
        <Link href="/inventory/handoffs">Start over</Link>
        {admin && (
          <form>
            <label>
              Inventory owner
              <select name="owner">
                {owners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </label>
            <button>View history</button>
          </form>
        )}
      </main>
    );
  }
  const nextQuery = new URLSearchParams({
    direction: history.direction,
    ...(value("q") ? { q: value("q")! } : {}),
    ...(value("cardId") ? { cardId: value("cardId")! } : {}),
    ...(admin ? { owner: history.ownerId } : {}),
  });
  if (history.next) nextQuery.set("before", history.next);
  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <Nav />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/inventory" className="text-sm underline">
            Inventory
          </Link>
          <h1 className="mt-2 text-2xl font-semibold">
            Gifts and traded-away cards
          </h1>
        </div>
        <Link href="/trades?view=history" className="underline">
          Negotiated trade history
        </Link>
      </div>
      <p className="text-sm">
        Record a gift or outside trade from a card’s Give / trade away action.
        Archive recipients receive their copies immediately in Unassigned. These
        records stay here after cards leave your collection.
      </p>
      <form className="flex flex-col items-stretch gap-3 rounded border border-[var(--app-border)] p-4 sm:flex-row sm:flex-wrap sm:items-end">
        {admin && (
          <label className="min-w-0">
            Inventory owner
            <select
              name="owner"
              defaultValue={history.ownerId}
              className="mt-1 block max-w-full rounded border bg-[var(--app-control)] p-2"
            >
              {owners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
        {value("cardId") && (
          <input type="hidden" name="cardId" value={value("cardId")} />
        )}
        <label className="min-w-0 flex-1">
          Search cards or people
          <input
            type="search"
            name="q"
            maxLength={120}
            defaultValue={history.query}
            className="mt-1 block w-full rounded border bg-[var(--app-control)] p-2"
          />
        </label>
        <label>
          Show
          <select
            name="direction"
            defaultValue={history.direction}
            className="mt-1 block w-full rounded border bg-[var(--app-control)] p-2 sm:w-auto"
          >
            <option value="given">Given / traded away</option>
            <option value="received">Received</option>
            <option value="all">Both directions</option>
          </select>
        </label>
        <button className="rounded border px-3 py-2">Filter history</button>
        <Link href="/inventory/handoffs" className="py-2 underline">
          Clear filters
        </Link>
      </form>
      {!history.rows.length && (
        <p role="status">
          No matching handoffs yet. Give a card from Inventory to create a
          record.
        </p>
      )}
      <ol className="space-y-3">
        {history.rows.map((row) => (
          <li
            key={row.id}
            className="flex min-w-0 gap-3 rounded border border-[var(--app-border)] p-4"
          >
            {row.facts.card.imageUri && (
              <img
                src={row.facts.card.imageUri}
                alt=""
                className="h-24 w-[69px] shrink-0 rounded object-contain"
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="break-words font-semibold">
                {row.quantity} × {row.cardName}
              </p>
              <p className="break-words">
                {row.incoming
                  ? `Received from ${row.senderName}`
                  : `${row.kind === "TRADE" ? "Traded away" : "Given"} to ${row.recipientName}`}{" "}
                · {row.internal ? "Archive user" : "Outside Archive"}
              </p>
              <p className="text-sm">
                {row.facts.card.setCode.toUpperCase()} #
                {row.facts.card.collectorNumber} · {row.facts.lot.foilStatus} ·{" "}
                {row.facts.lot.condition} · {row.facts.lot.language}
              </p>
              <time className="text-sm" dateTime={row.at}>
                {new Date(row.at).toLocaleString("en-US", {
                  timeZone: "UTC",
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}{" "}
                UTC
              </time>
              {row.incoming && (
                <p className="text-sm">Delivered to your Unassigned location</p>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="flex gap-4">
        {value("before") && (
          <Link
            href={
              "/inventory/handoffs?" +
              new URLSearchParams({
                ...Object.fromEntries(nextQuery),
                before: "",
              })
            }
            className="underline"
          >
            Newest handoffs
          </Link>
        )}
        {history.next && (
          <Link href={"/inventory/handoffs?" + nextQuery} className="underline">
            Older handoffs
          </Link>
        )}
      </div>
    </main>
  );
}
