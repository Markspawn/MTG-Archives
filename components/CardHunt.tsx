"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { HuntFinish, HuntMode, HuntPick, HuntPlan } from "@/lib/card-hunt";
import type { buildCardHunt, CardHuntInput } from "@/lib/card-hunt-service";
import type {
  HuntActionInput,
  HuntActionResult,
} from "@/lib/card-hunt-action-policy";
import { advanceHunt, huntPickKey } from "@/lib/card-hunt-progress";
import { parsePendingHuntAction } from "@/lib/card-hunt-pending";
import {
  CardHuntActionDialog,
  huntPendingKey,
  type FrozenHuntAction,
  type HuntActionContext,
} from "./CardHuntActionDialog";
import {
  filterButtonClass,
  filterInputClass,
  filterSelectClass,
  filterPrimaryButtonClass,
} from "./filterStyles";
type Result = Awaited<ReturnType<typeof buildCardHunt>>;
const finishLabel = (value: string) =>
  ({ FOIL: "Foil", NONFOIL: "Nonfoil", ETCHED: "Etched" })[value] ?? value;
export type CardHuntContext = {
  id: string;
  scope: "card" | "printing";
  setCode: string;
  collectorNumber?: string;
  finish?: Exclude<HuntFinish, "ANY">;
};

export function CardHunt({
  decks = [],
  initialDeckId,
  card,
}: {
  decks?: Array<{ id: string; name: string }>;
  initialDeckId?: string;
  card?: CardHuntContext;
}) {
  const [selectedDecks, setSelectedDecks] = useState<string[]>(
      initialDeckId ? [initialDeckId] : [],
    ),
    [deckSearch, setDeckSearch] = useState("");
  const [lists, setLists] = useState<
    Array<{ id: string; label: string; text: string }>
  >([]);
  const [finish, setFinish] = useState<HuntFinish>("ANY"),
    [mode, setMode] = useState<HuntMode>("preferences");
  const [includeMaybeboard, setIncludeMaybeboard] = useState(false),
    [ignoreBasicLands, setIgnoreBasicLands] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [result, setResult] = useState<Result | null>(null),
    [lastInput, setLastInput] = useState<CardHuntInput | null>(null);
  const [boxPage, setBoxPage] = useState(0),
    [filter, setFilter] = useState(""),
    [showLines, setShowLines] = useState(false),
    [linePage, setLinePage] = useState(0);
  const [selection, setSelection] = useState<Record<string, number>>({}),
    [given, setGiven] = useState(0),
    [needsRefresh, setNeedsRefresh] = useState(false);
  const [context, setContext] = useState<HuntActionContext | null>(null),
    [contextError, setContextError] = useState("");
  const [frozen, setFrozen] = useState<FrozenHuntAction | null>(null),
    [action, setAction] = useState<"COMMIT" | "GIVE" | null>(null);
  const [corruptPending, setCorruptPending] = useState(false),
    [otherPending, setOtherPending] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/card-hunt/context", { signal: controller.signal })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw Error(
            value.error ?? "Actions are unavailable. Reload after signing in.",
          );
        if (controller.signal.aborted) return;
        setContext(value);
        let saved: string | null = null;
        try {
          saved = sessionStorage.getItem(huntPendingKey(value.actorUserId));
        } catch {}
        if (saved)
          try {
            setFrozen(parsePendingHuntAction(saved));
          } catch {
            setCorruptPending(true);
          }
      })
      .catch((caught) => {
        if (!controller.signal.aborted)
          setContextError(
            caught instanceof Error
              ? caught.message
              : "Actions are unavailable.",
          );
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!context) return;
    const check = () => {
      try {
        setOtherPending(
          Boolean(
            sessionStorage.getItem("mtg-card-handoff:" + context.actorUserId),
          ),
        );
      } catch {}
    };
    check();
    window.addEventListener("mtg-card-handoff-pending", check);
    return () => window.removeEventListener("mtg-card-handoff-pending", check);
  }, [context]);
  const blocked = Boolean(frozen) || corruptPending || otherPending;
  function clearPlan() {
    setResult(null);
    setSelection({});
    setError("");
    setMessage("");
    setGiven(0);
    setNeedsRefresh(false);
  }
  async function generate(event?: FormEvent) {
    event?.preventDefault();
    if (blocked || busy) return;
    const input: CardHuntInput = {
      mode,
      finish,
      includeMaybeboard,
      ignoreBasicLands,
      ...(card
        ? { card: { id: card.id, scope: card.scope, finish: card.finish } }
        : {
            sources: [
              ...decks
                .filter((deck) => selectedDecks.includes(deck.id))
                .map((deck) => ({
                  kind: "DECK" as const,
                  id: `deck:${deck.id}`,
                  deckId: deck.id,
                })),
              ...lists.map((list) => ({ ...list, kind: "LIST" as const })),
            ],
          }),
    };
    setBusy(true);
    clearPlan();
    setLastInput(input);
    try {
      const response = await fetch("/api/card-hunt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const value = await response.json();
      if (!response.ok)
        throw Error(value.error ?? "The hunt could not be prepared.");
      setResult(value);
      setBoxPage(0);
      setLinePage(0);
      setFilter("");
      setShowLines(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The hunt could not be prepared.",
      );
    } finally {
      setBusy(false);
    }
  }
  const allPicks = result?.boxes.flatMap((box) => box.picks) ?? [];
  const chosen = allPicks
    .filter((pick) => selection[huntPickKey(pick)] !== undefined)
    .map((pick) => ({ ...pick, quantity: selection[huntPickKey(pick)] }));
  const quantity = chosen.reduce(
    (sum, pick) => sum + (Number.isFinite(pick.quantity) ? pick.quantity : 0),
    0,
  );
  const invalid = chosen.some(
    (pick) =>
      !Number.isSafeInteger(pick.quantity) ||
      pick.quantity < 1 ||
      pick.quantity >
        (allPicks.find((source) => huntPickKey(source) === huntPickKey(pick))
          ?.quantity ?? 0),
  );
  const actionDisabled =
    !chosen.length ||
    invalid ||
    chosen.length > 500 ||
    blocked ||
    needsRefresh ||
    !context;
  const boxes =
    result?.boxes.filter((box) => {
      const term = filter.trim().toLowerCase();
      return (
        !term ||
        box.name.toLowerCase().includes(term) ||
        box.picks.some((pick) =>
          `${pick.name} ${pick.section ?? ""} ${pick.setCode} ${pick.collectorNumber} ${pick.sourceLabel ?? ""}`
            .toLowerCase()
            .includes(term),
        )
      );
    }) ?? [];
  function toggle(pick: HuntPick, checked: boolean) {
    setSelection((previous) => {
      const next = { ...previous };
      if (checked) next[huntPickKey(pick)] = pick.quantity;
      else delete next[huntPickKey(pick)];
      return next;
    });
  }
  function known(value: HuntActionResult, input: HuntActionInput) {
    setAction(null);
    setFrozen(null);
    setSelection({});
    if (value.status === "REJECTED") {
      setError(
        value.message +
          " No cards were moved by this confirmation. Refresh the hunt to continue.",
      );
      setNeedsRefresh(true);
      return;
    }
    setMessage(value.message);
    setResult((previous) =>
      previous ? advanceHunt(previous, input.selected, value) : null,
    );
    if (value.action === "GIVE")
      setGiven((previous) => previous + value.quantity);
  }
  return (
    <div className="space-y-5">
      {frozen && (
        <div role="status" className="app-panel space-y-2 border-amber-600 p-4">
          <p>
            A previous hunt confirmation needs verification before another
            action.
          </p>
          <button
            type="button"
            className={filterPrimaryButtonClass}
            onClick={() => setAction(frozen.input.action)}
          >
            Check pending confirmation
          </button>
        </div>
      )}
      {corruptPending && (
        <p role="alert" className="app-panel p-4">
          The saved pending confirmation could not be read. Keep the original
          tab and check your deck or handoff history before starting another
          action.
        </p>
      )}
      {otherPending && (
        <p role="status" className="app-panel p-4">
          An earlier individual card handoff needs verification.{" "}
          <Link className="underline" href="/inventory">
            Open Inventory and check the pending handoff.
          </Link>
        </p>
      )}
      <form
        onSubmit={(event) => void generate(event)}
        className="app-panel p-4 sm:p-5"
      >
        <fieldset
          disabled={busy || blocked}
          onChange={clearPlan}
          className="min-w-0 space-y-4 disabled:opacity-70"
        >
          {card ? (
            <p className="text-sm font-medium">
              {card.scope === "card"
                ? "All printings and finishes"
                : `Printing ${card.setCode.toUpperCase()} #${card.collectorNumber ?? "—"} · ${card.finish ? finishLabel(card.finish) : "All finishes"}`}
            </p>
          ) : (
            <>
              <section aria-label="Decks to hunt" className="space-y-2">
                <h2 className="font-semibold">Saved decks</h2>
                <p className="text-sm text-[var(--app-muted)]">
                  Choose one or more decks. Each deck gets its own copies.
                </p>
                {decks.length > 8 && (
                  <label className="block text-sm">
                    Find a deck
                    <input
                      aria-label="Find a deck"
                      value={deckSearch}
                      onChange={(event) => setDeckSearch(event.target.value)}
                      className={filterInputClass + " mt-1 w-full"}
                    />
                  </label>
                )}
                <div className="max-h-48 space-y-1 overflow-y-auto rounded border border-[var(--app-border)] p-2">
                  {decks
                    .filter((deck) =>
                      deck.name
                        .toLowerCase()
                        .includes(deckSearch.trim().toLowerCase()),
                    )
                    .map((deck) => (
                      <label
                        key={deck.id}
                        className="flex min-h-10 items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={selectedDecks.includes(deck.id)}
                          onChange={(event) =>
                            setSelectedDecks((previous) =>
                              event.target.checked
                                ? [...previous, deck.id]
                                : previous.filter((id) => id !== deck.id),
                            )
                          }
                        />
                        {deck.name}
                      </label>
                    ))}
                  {!decks.length && (
                    <p className="text-sm">
                      No personal decks yet. Paste a list below.
                    </p>
                  )}
                </div>
              </section>
              <section aria-label="Pasted lists" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-semibold">Pasted lists</h2>
                  <button
                    type="button"
                    className={filterButtonClass}
                    onClick={() => {
                      setLists((previous) => [
                        ...previous,
                        {
                          id: crypto.randomUUID(),
                          label: `List ${previous.length + 1}`,
                          text: "",
                        },
                      ]);
                      clearPlan();
                    }}
                  >
                    Add pasted list
                  </button>
                </div>
                {lists.map((list, index) => (
                  <div
                    key={list.id}
                    className="space-y-2 rounded border border-[var(--app-border)] p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="min-w-0 flex-1 text-sm">
                        List name
                        <input
                          aria-label={`List ${index + 1} name`}
                          required
                          maxLength={100}
                          value={list.label}
                          onChange={(event) =>
                            setLists((previous) =>
                              previous.map((item) =>
                                item.id === list.id
                                  ? { ...item, label: event.target.value }
                                  : item,
                              ),
                            )
                          }
                          className={filterInputClass + " mt-1 w-full"}
                        />
                      </label>
                      <button
                        type="button"
                        className={filterButtonClass}
                        onClick={() => {
                          setLists((previous) =>
                            previous.filter((item) => item.id !== list.id),
                          );
                          clearPlan();
                        }}
                      >
                        Remove list {index + 1}
                      </button>
                    </div>
                    <label className="block text-sm">
                      Cards to find
                      <textarea
                        aria-label={`Cards to find in list ${index + 1}`}
                        required
                        maxLength={100000}
                        value={list.text}
                        onChange={(event) =>
                          setLists((previous) =>
                            previous.map((item) =>
                              item.id === list.id
                                ? { ...item, text: event.target.value }
                                : item,
                            ),
                          )
                        }
                        className={filterInputClass + " mt-1 min-h-32 w-full"}
                        placeholder={
                          "1 Sol Ring\n3 Forest (M21) 274\n1 Arcane Signet *F*"
                        }
                      />
                    </label>
                  </div>
                ))}
                <p className="text-xs text-[var(--app-muted)]">
                  Combine up to 20 decks/lists and 1,000 card lines. Quantities
                  add across all sources. Each pasted list keeps its name.
                </p>
              </section>
            </>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {!card && (
              <label className="block text-sm">
                Finish preference
                <select
                  aria-label="Finish preference"
                  value={finish}
                  onChange={(event) =>
                    setFinish(event.target.value as HuntFinish)
                  }
                  className={filterSelectClass + " mt-1 w-full"}
                >
                  <option value="ANY">Any finish</option>
                  <option value="FOIL">Prefer foil</option>
                  <option value="NONFOIL">Prefer nonfoil</option>
                  <option value="ETCHED">Prefer etched</option>
                </select>
              </label>
            )}
            <label className="block text-sm">
              Pull priority
              <select
                aria-label="Pull priority"
                value={mode}
                onChange={(event) => setMode(event.target.value as HuntMode)}
                className={filterSelectClass + " mt-1 w-full"}
              >
                <option value="preferences">My preferences first</option>
                <option value="boxes">Optimize boxes</option>
              </select>
            </label>
          </div>
          {!card && (
            <>
              <p className="text-sm text-[var(--app-muted)]">
                {mode === "preferences"
                  ? "Prioritize your finish preference and requested printing, then group by box. Other available copies can fill gaps."
                  : "Favor boxes that cover more of the combined hunt. Printing and finish preferences break ties; substitutions are marked."}
              </p>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={includeMaybeboard}
                    onChange={(event) =>
                      setIncludeMaybeboard(event.target.checked)
                    }
                  />
                  Include maybeboard
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={ignoreBasicLands}
                    onChange={(event) =>
                      setIgnoreBasicLands(event.target.checked)
                    }
                  />
                  Ignore basic lands in decks
                </label>
              </div>
            </>
          )}
          <button type="submit" className={filterPrimaryButtonClass}>
            {busy ? "Finding your cards…" : card ? "Find copies" : "Build hunt"}
          </button>
        </fieldset>
        <p className="mt-3 text-xs text-[var(--app-muted)]">
          Planning uses your available storage copies and does not reserve or
          move cards. Cards committed to decks and active trade reservations are
          excluded.
        </p>
      </form>
      {contextError && (
        <p role="status" className="app-panel p-4">
          {contextError}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="app-panel space-y-2 border-red-700 p-4 text-red-300"
        >
          <p>{error}</p>
          {needsRefresh && (
            <button
              type="button"
              className={filterButtonClass}
              onClick={() => void generate()}
            >
              Refresh hunt
            </button>
          )}
        </div>
      )}
      {message && (
        <p role="status" className="app-panel p-4">
          {message}{" "}
          <Link href="/inventory/handoffs" className="underline">
            Handoff history
          </Link>
        </p>
      )}
      {busy && <p role="status">Checking storage and available copies…</p>}
      {result && (
        <section aria-label="Hunt results" className="space-y-4">
          <div className="app-panel p-4">
            <h2 className="break-words text-xl font-semibold">
              {result.title}
            </h2>
            <p role="status" className="mt-2">
              {card && !result.planned
                ? "No copies are currently available in storage."
                : `${result.boxes.length} boxes · ${result.planned} to pull · ${result.shortage} short${result.alreadyInDeck ? ` · ${result.alreadyInDeck} already committed` : ""}`}
            </p>
            {given > 0 && (
              <p className="mt-2 text-sm">
                {given} copies given/traded in this hunt.
              </p>
            )}
            {result.sources.length > 0 && (
              <p className="mt-2 break-words text-sm text-[var(--app-muted)]">
                For: {result.sources.map((source) => source.label).join(" · ")}
              </p>
            )}
            {result.ignoredBasicLandCopies > 0 && (
              <p className="mt-2 text-sm">
                {result.ignoredBasicLandCopies} basic land copies skipped.
                {!result.lines.length && " No other cards to hunt."}
              </p>
            )}
            <p className="mt-2 text-xs text-[var(--app-muted)]">
              Availability is rechecked when you confirm. Box optimization is a
              practical grouping suggestion, not a guaranteed minimum. Build
              hunt starts a fresh plan.
            </p>
            {result.warnings.length > 0 && (
              <details className="mt-3 text-sm">
                <summary>List notes ({result.warnings.length})</summary>
                <ul className="mt-2 list-inside list-disc">
                  {result.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          {result.shortage > 0 && (
            <div className="app-panel p-4">
              <h3 className="font-semibold">Still needed</h3>
              <ul className="mt-2 space-y-1 text-sm">
                {result.lines
                  .filter((line) => line.shortage > 0)
                  .map((line) => (
                    <li key={line.request.id} className="break-words">
                      {line.shortage} × {line.request.name} —{" "}
                      {line.request.sourceLabel ?? "This hunt"}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {result.lines.length > 0 && (
            <div className="app-panel p-4">
              <button
                type="button"
                onClick={() => setShowLines((previous) => !previous)}
                aria-expanded={showLines}
                className="text-sm underline"
              >
                {showLines ? "Hide" : "Show"} requested cards and alternate
                printings
              </button>
              {showLines && (
                <div className="mt-3 space-y-3">
                  {result.lines
                    .slice(linePage * 25, (linePage + 1) * 25)
                    .map((line) => (
                      <div
                        key={line.request.id}
                        className="min-w-0 border-b border-[var(--app-border)] pb-3 text-sm"
                      >
                        <p className="break-words font-medium">
                          {line.request.quantity} × {line.request.name} ·{" "}
                          {line.request.sourceLabel ?? "This hunt"}
                        </p>
                        <p>
                          {line.planned} planned · {line.shortage} short
                          {line.request.alreadyInDeck
                            ? ` · ${line.request.alreadyInDeck} already in deck`
                            : ""}
                        </p>
                        {line.alternativeCount > 0 && (
                          <p className="mt-1 break-words text-[var(--app-muted)]">
                            Other available printings:{" "}
                            {line.alternatives
                              .map(
                                (alt) =>
                                  `${alt.setCode.toUpperCase()} ${alt.collectorNumber} ${finishLabel(alt.finish)} (${alt.available})`,
                              )
                              .join("; ")}
                            {line.alternativeCount > line.alternatives.length
                              ? `; showing ${line.alternatives.length} of ${line.alternativeCount}`
                              : ""}
                            . Quantities are shared across the hunt.
                          </p>
                        )}
                      </div>
                    ))}
                  {result.lines.length > 25 && (
                    <Pagination
                      page={linePage}
                      total={Math.ceil(result.lines.length / 25)}
                      onChange={setLinePage}
                      label="Requested cards"
                    />
                  )}
                </div>
              )}
            </div>
          )}
          {allPicks.length > 0 && (
            <div
              className="app-panel sticky top-3 z-10 space-y-3 bg-[var(--app-surface)] p-3 shadow-lg"
              aria-label="Selected hunt cards"
            >
              <div className="flex flex-wrap items-center gap-3">
                <strong aria-live="polite">
                  {quantity} copies selected ({chosen.length} pulls)
                </strong>
                <button
                  type="button"
                  disabled={blocked || needsRefresh}
                  className={filterButtonClass}
                  onClick={() =>
                    setSelection(
                      Object.fromEntries(
                        allPicks.map((pick) => [
                          huntPickKey(pick),
                          pick.quantity,
                        ]),
                      ),
                    )
                  }
                >
                  Select all {allPicks.length} pulls
                </button>
                <button
                  type="button"
                  disabled={blocked}
                  className={filterButtonClass}
                  onClick={() => setSelection({})}
                >
                  Clear selection
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={
                    actionDisabled || chosen.some((pick) => !pick.deckId)
                  }
                  className={filterPrimaryButtonClass}
                  onClick={() => setAction("COMMIT")}
                >
                  Commit selected to decks
                </button>
                <button
                  type="button"
                  disabled={actionDisabled}
                  className={filterPrimaryButtonClass}
                  onClick={() => setAction("GIVE")}
                >
                  Give / trade selected
                </button>
              </div>
              {chosen.some((pick) => !pick.deckId) && (
                <p className="text-xs text-[var(--app-muted)]">
                  Commit selects saved-deck pulls. Pasted-list pulls can be
                  given away.
                </p>
              )}
              {(invalid || chosen.length > 500) && (
                <p role="alert" className="text-sm text-red-300">
                  Choose whole quantities within each pull and up to 500 pulls
                  per confirmation.
                </p>
              )}
            </div>
          )}
          {result.boxes.length > 0 && (
            <label className="block text-sm">
              Find a box, section, card or destination
              <input
                className={filterInputClass + " mt-1 w-full"}
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                  setBoxPage(0);
                }}
              />
            </label>
          )}
          {boxes.slice(boxPage * 10, (boxPage + 1) * 10).map((box) => (
            <HuntBox
              key={box.id}
              box={box}
              selection={selection}
              disabled={blocked || needsRefresh}
              onToggle={toggle}
              onQuantity={(pick, quantity) =>
                setSelection((previous) => ({
                  ...previous,
                  [huntPickKey(pick)]: quantity,
                }))
              }
              onSelectBox={() =>
                setSelection((previous) => ({
                  ...previous,
                  ...Object.fromEntries(
                    box.picks.map((pick) => [huntPickKey(pick), pick.quantity]),
                  ),
                }))
              }
            />
          ))}
          {result.boxes.length > 0 && !boxes.length && (
            <p>No matching boxes.</p>
          )}
          {boxes.length > 10 && (
            <Pagination
              page={boxPage}
              total={Math.ceil(boxes.length / 10)}
              onChange={setBoxPage}
              label="Boxes"
            />
          )}
        </section>
      )}
      {action && context && (frozen || lastInput) && (
        <CardHuntActionDialog
          action={frozen?.input.action ?? action}
          hunt={frozen?.input.hunt ?? lastInput!}
          picks={chosen}
          context={context}
          frozen={frozen}
          onFreeze={setFrozen}
          onKnown={known}
          onClose={() => setAction(null)}
        />
      )}
    </div>
  );
}
function Pagination({
  page,
  total,
  onChange,
  label,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
  label: string;
}) {
  return (
    <nav
      aria-label={label}
      className="flex flex-wrap items-center gap-3 text-sm"
    >
      <button
        type="button"
        className="underline disabled:opacity-40"
        disabled={!page}
        onClick={() => onChange(page - 1)}
      >
        Previous
      </button>
      <span>
        Page {page + 1} of {total}
      </span>
      <button
        type="button"
        className="underline disabled:opacity-40"
        disabled={page + 1 >= total}
        onClick={() => onChange(page + 1)}
      >
        Next
      </button>
    </nav>
  );
}
function HuntBox({
  box,
  selection,
  disabled,
  onToggle,
  onQuantity,
  onSelectBox,
}: {
  box: HuntPlan["boxes"][number];
  selection: Record<string, number>;
  disabled: boolean;
  onToggle: (pick: HuntPick, value: boolean) => void;
  onQuantity: (pick: HuntPick, value: number) => void;
  onSelectBox: () => void;
}) {
  const [visible, setVisible] = useState(50);
  return (
    <section
      className="app-panel min-w-0 p-4"
      aria-label={`Pull from ${box.name}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="break-words text-lg font-semibold">{box.name}</h3>
        <button
          type="button"
          disabled={disabled}
          className={filterButtonClass}
          onClick={onSelectBox}
        >
          Select this box
        </button>
      </div>
      <p className="mt-1 text-sm text-[var(--app-muted)]">
        {box.picks.reduce((sum, pick) => sum + pick.quantity, 0)} copies to pull
      </p>
      <ul className="mt-3 divide-y divide-[var(--app-border)]">
        {box.picks.slice(0, visible).map((pick) => {
          const checked = selection[huntPickKey(pick)] !== undefined;
          return (
            <li
              key={huntPickKey(pick)}
              className="flex min-w-0 items-start gap-3 py-3"
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(event) => onToggle(pick, event.target.checked)}
                aria-label={`Select ${pick.name} for ${pick.sourceLabel ?? "this hunt"}, ${box.name}, section ${pick.section ?? "unassigned"}, ${pick.setCode} ${pick.collectorNumber}`}
                className="mt-1 shrink-0"
              />
              <div className="min-w-0 flex-1 break-words text-sm">
                <p className="font-medium">
                  {pick.quantity} × {pick.name}
                </p>
                <p className="mt-1 font-medium text-[var(--app-accent)]">
                  For {pick.sourceLabel ?? "this hunt"}
                  {pick.deckId ? " · Deck" : " · List"}
                </p>
                <p className="mt-1">
                  Section {pick.section || "unassigned"} ·{" "}
                  {pick.setCode.toUpperCase()} #{pick.collectorNumber} ·{" "}
                  {finishLabel(pick.finish)} · {pick.language} ·{" "}
                  {pick.condition}
                </p>
                {(pick.alternatePrinting || pick.finishCompromise) && (
                  <p className="mt-1 text-amber-300">
                    {[
                      pick.alternatePrinting && "Alternate printing",
                      pick.finishCompromise &&
                        "Different finish from preference",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
                {checked && (
                  <label className="mt-2 flex flex-wrap items-center gap-2">
                    Copies selected
                    <input
                      aria-label={`Copies of ${pick.name} for ${pick.sourceLabel ?? "this hunt"} from ${box.name}`}
                      type="number"
                      min={1}
                      max={pick.quantity}
                      step={1}
                      disabled={disabled}
                      value={
                        Number.isNaN(selection[huntPickKey(pick)])
                          ? ""
                          : selection[huntPickKey(pick)]
                      }
                      onChange={(event) =>
                        onQuantity(pick, Number(event.target.value))
                      }
                      className={filterInputClass + " w-24"}
                    />
                  </label>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {visible < box.picks.length && (
        <button
          type="button"
          className="mt-2 text-sm underline"
          onClick={() => setVisible((previous) => previous + 50)}
        >
          Show more cards ({box.picks.length - visible} remaining)
        </button>
      )}
      <p className="mt-2 text-xs text-[var(--app-muted)]">
        Selections stay checked while you filter or page through this hunt. No
        cards move until you confirm.
      </p>
    </section>
  );
}
