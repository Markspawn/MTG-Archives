"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { getHandoffOptions } from "@/lib/card-handoffs";
import type { HandoffInput } from "@/lib/card-handoff-policy";
import {
  filterButtonClass,
  filterInputClass,
  filterPrimaryButtonClass,
  filterSelectClass,
} from "./filterStyles";
type Options = Awaited<ReturnType<typeof getHandoffOptions>>;
type Pending = { input: HandoffInput; cardName: string; recipientName: string };
export function CardHandoffDialog({
  itemIds,
  cardName,
  onClose,
  onSuccess,
}: {
  itemIds: string[];
  cardName: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    title = useId(),
    peopleId = useId();
  const [options, setOptions] = useState<Options | null>(null),
    [source, setSource] = useState("");
  const [quantity, setQuantity] = useState(1),
    [type, setType] = useState<"EXTERNAL" | "ARCHIVE">("EXTERNAL"),
    [name, setName] = useState(""),
    [player, setPlayer] = useState("");
  const [kind, setKind] = useState<"GIFT" | "TRADE">("GIFT"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [huntPending, setHuntPending] = useState(false);
  useEffect(() => {
    if (!options) return;
    const check = () => {
      try {
        setHuntPending(
          Boolean(
            sessionStorage.getItem(
              "mtg-card-hunt-action:" + options.actorUserId,
            ),
          ),
        );
      } catch {}
    };
    check();
    window.addEventListener("mtg-card-hunt-action-pending", check);
    return () =>
      window.removeEventListener("mtg-card-hunt-action-pending", check);
  }, [options]);
  const requestId = useRef<string | null>(null);
  const lot = options?.lots.find((l) => l.id === source);
  const sourceKey = JSON.stringify(itemIds);
  useEffect(() => {
    const node = dialog.current,
      opener = document.activeElement;
    if (!node) return;
    node.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      if (node.open) node.close();
      document.body.style.overflow = overflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    void fetch("/api/inventory/handoffs/options", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemIds: JSON.parse(sourceKey) }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw Error(data.error || "Unable to load available copies.");
        if (!live) return;
        setOptions(data);
        setSource(
          data.lots.find(
            (l: Options["lots"][number]) => !l.blocked && l.available > 0,
          )?.id ??
            data.lots[0]?.id ??
            "",
        );
        try {
          const saved = sessionStorage.getItem(
            "mtg-card-handoff:" + data.actorUserId,
          );
          if (saved) {
            const previous = JSON.parse(saved);
            if (
              previous?.input?.requestId &&
              previous.cardName &&
              previous.recipientName
            )
              setPending(previous);
          }
        } catch {
          /* Storage is optional; in-memory request identity remains stable. */
        }
      })
      .catch((e) => {
        if (live)
          setError(
            e instanceof Error ? e.message : "Unable to load available copies.",
          );
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [sourceKey]);
  async function submit() {
    if (busy || !options || (huntPending && !pending)) return;
    const recipient =
      type === "ARCHIVE"
        ? { type: "ARCHIVE" as const, playerId: player }
        : { type: "EXTERNAL" as const, name: name.trim() };
    if (
      !pending &&
      (!lot ||
        lot.blocked ||
        quantity < 1 ||
        quantity > lot.available ||
        !Number.isInteger(quantity) ||
        (type === "EXTERNAL" ? !name.trim() : !player))
    )
      return;
    const frozen = pending ?? {
      input: {
        requestId: requestId.current ?? (requestId.current = options.requestId),
        inventoryItemId: lot!.id,
        expectedStamp: lot!.stamp,
        quantity,
        kind,
        recipient,
      },
      cardName: lot!.cardName,
      recipientName:
        type === "ARCHIVE"
          ? options.recipients.find((p) => p.id === player)!.displayName
          : name.trim(),
    };
    setPending(frozen);
    setBusy(true);
    setError("");
    const storageKey = "mtg-card-handoff:" + options.actorUserId;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(frozen));
      window.dispatchEvent(new Event("mtg-card-handoff-pending"));
    } catch {}
    try {
      const response = await fetch("/api/inventory/handoffs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(frozen.input),
          signal: AbortSignal.timeout(30000),
        }),
        result = await response.json();
      if (!response.ok) {
        // A rejected retry (for example an expired login) cannot disprove a
        // previously committed request whose acknowledgement was lost.
        if (result.definite && (!pending || result.outcomeKnown)) {
          setPending(null);
          requestId.current = null;
          try {
            sessionStorage.removeItem(storageKey);
            window.dispatchEvent(new Event("mtg-card-handoff-pending"));
          } catch {}
        }
        throw Error(
          result.error ||
            "The result could not be verified. Retry the same confirmation.",
        );
      }
      try {
        sessionStorage.removeItem(storageKey);
        window.dispatchEvent(new Event("mtg-card-handoff-pending"));
      } catch {}
      onSuccess(
        `${result.quantity} ${result.quantity === 1 ? "copy" : "copies"} of ${frozen.cardName} ${frozen.input.kind === "TRADE" ? "traded" : "given"} to ${result.recipientName}${result.internal ? " · saved to their Unassigned location" : " · recorded in your handoff history"}.`,
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The result could not be verified. Retry the same confirmation.",
      );
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || Boolean(pending) || huntPending;
  return (
    <dialog
      ref={dialog}
      aria-labelledby={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg max-h-[90dvh] overflow-y-auto break-words rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] p-5 text-[var(--app-text)] backdrop:bg-black/70"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={title} className="text-xl font-semibold">
          Give / trade away
        </h2>
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className={filterButtonClass}
        >
          Close
        </button>
      </div>
      <p className="mt-2 font-semibold">{pending?.cardName ?? cardName}</p>
      {huntPending && !pending && (
        <p role="status" className="mt-3 rounded border border-amber-600 p-3">
          A Card Hunt confirmation needs verification first.{" "}
          <a href="/card-hunt" className="underline">
            Open Card Hunt to check it.
          </a>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded border border-red-600 p-3">
          {error}
        </p>
      )}
      {!options && !error && (
        <p role="status" className="mt-3">
          Loading available copies…
        </p>
      )}
      {options && (
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {pending ? (
            <p className="rounded border border-amber-600 p-3">
              Verify the previous confirmation: {pending.input.quantity} ×{" "}
              {pending.cardName} → {pending.recipientName}. Retrying this same
              confirmation will not give the cards twice.
            </p>
          ) : (
            <>
              {options.lots.length > 1 ? (
                <label className="block">
                  From
                  <select
                    className={filterSelectClass + " mt-1 w-full"}
                    value={source}
                    onChange={(e) => {
                      setSource(e.target.value);
                      setQuantity(1);
                    }}
                    disabled={disabled}
                  >
                    {options.lots.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.location}
                        {l.section ? " / " + l.section : ""} · {l.finish} ·{" "}
                        {l.condition} · {l.language} · {l.available} available
                        {l.blocked ? " (unavailable)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="text-sm">
                  From {lot?.owner}: {lot?.location}
                  {lot?.section ? " / " + lot.section : ""} · {lot?.finish} ·{" "}
                  {lot?.condition} · {lot?.language} · {lot?.available ?? 0}{" "}
                  available
                </p>
              )}
              {lot?.blocked && <p role="status">{lot.blocked}</p>}
              {Boolean(lot?.reserved) && (
                <p className="text-sm">
                  {lot?.reserved} copies are reserved in active trades. Only
                  unreserved copies can be given.
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <label>
                  Copies
                  <input
                    type="number"
                    min={1}
                    max={lot?.available ?? 1}
                    required
                    value={quantity}
                    onChange={(e) => setQuantity(Number(e.target.value))}
                    className={filterInputClass + " mt-1 w-full"}
                    disabled={disabled}
                  />
                </label>
                <label>
                  Record as
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value as typeof kind)}
                    className={filterSelectClass + " mt-1 w-full"}
                    disabled={disabled}
                  >
                    <option value="GIFT">Given away</option>
                    <option value="TRADE">Traded away</option>
                  </select>
                </label>
              </div>
              <fieldset className="space-y-2">
                <legend className="font-semibold">Who is receiving it?</legend>
                <label className="mr-3 inline-flex gap-2">
                  <input
                    type="radio"
                    name={title}
                    checked={type === "EXTERNAL"}
                    onChange={() => setType("EXTERNAL")}
                    disabled={disabled}
                  />
                  Outside Archive
                </label>
                <label className="inline-flex gap-2">
                  <input
                    type="radio"
                    name={title}
                    checked={type === "ARCHIVE"}
                    onChange={() => setType("ARCHIVE")}
                    disabled={disabled}
                  />
                  Archive user
                </label>
                {type === "EXTERNAL" ? (
                  <label className="block">
                    Recipient name
                    <input
                      autoFocus
                      required
                      maxLength={120}
                      list={peopleId}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className={filterInputClass + " mt-1 w-full"}
                      disabled={disabled}
                    />
                    <datalist id={peopleId}>
                      {options.recentPeople.map((n) => (
                        <option key={n} value={n} />
                      ))}
                    </datalist>
                  </label>
                ) : (
                  <label className="block">
                    Archive recipient
                    <select
                      required
                      value={player}
                      onChange={(e) => setPlayer(e.target.value)}
                      className={filterSelectClass + " mt-1 w-full"}
                      disabled={disabled}
                    >
                      <option value="">Choose a person</option>
                      {options.recipients.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </fieldset>
              <p className="rounded border border-[var(--app-border)] p-3 text-sm">
                {type === "ARCHIVE"
                  ? "Your confirmation immediately removes these copies from this inventory and adds them to the recipient’s Unassigned location."
                  : "Your confirmation removes these copies from this inventory and saves who received them in your private history."}
              </p>
            </>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className={filterPrimaryButtonClass}
              disabled={
                busy ||
                (huntPending && !pending) ||
                (!pending &&
                  (!lot || Boolean(lot.blocked) || lot.available < 1))
              }
            >
              {busy
                ? "Confirming…"
                : pending
                  ? "Retry same confirmation"
                  : `Confirm ${kind === "TRADE" ? "trade away" : "give"} · ${quantity} ${quantity === 1 ? "copy" : "copies"}`}
            </button>
            <a href="/inventory/handoffs" className="text-sm underline">
              Handoff history
            </a>
          </div>
        </form>
      )}
    </dialog>
  );
}
