"use client";
import { useEffect, useId, useRef, useState } from "react";
import type {
  HuntActionInput,
  HuntActionResult,
} from "@/lib/card-hunt-action-policy";
import type { CardHuntInput } from "@/lib/card-hunt-service";
import type { getHuntActionContext } from "@/lib/card-hunt-actions";
import type { HuntPick } from "@/lib/card-hunt";
import {
  verifiedHuntOutcome,
  type FrozenHuntAction,
} from "@/lib/card-hunt-pending";
export type { FrozenHuntAction } from "@/lib/card-hunt-pending";
import {
  filterButtonClass,
  filterInputClass,
  filterPrimaryButtonClass,
  filterSelectClass,
} from "./filterStyles";

export type HuntActionContext = Awaited<
  ReturnType<typeof getHuntActionContext>
>;
export const huntPendingKey = (actorUserId: string) =>
  "mtg-card-hunt-action:" + actorUserId;

export function CardHuntActionDialog({
  action,
  hunt,
  picks,
  context,
  frozen,
  onFreeze,
  onKnown,
  onClose,
}: {
  action: "COMMIT" | "GIVE";
  hunt: CardHuntInput;
  picks: HuntPick[];
  context: HuntActionContext;
  frozen: FrozenHuntAction | null;
  onFreeze: (value: FrozenHuntAction | null) => void;
  onKnown: (result: HuntActionResult, input: HuntActionInput) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    title = useId(),
    peopleId = useId();
  const [type, setType] = useState<"EXTERNAL" | "ARCHIVE">("EXTERNAL"),
    [name, setName] = useState(""),
    [player, setPlayer] = useState("");
  const [kind, setKind] = useState<"GIFT" | "TRADE">("GIFT"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [storageFailed, setStorageFailed] = useState(false);
  useEffect(() => {
    const node = dialog.current,
      opener = document.activeElement;
    if (!node) return;
    node.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      node.close();
      document.body.style.overflow = overflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  const quantity = frozen
    ? frozen.input.selected.reduce((sum, pick) => sum + pick.quantity, 0)
    : picks.reduce((sum, pick) => sum + pick.quantity, 0);
  const commit = action === "COMMIT";
  const summary =
    frozen?.summary ??
    picks.map((pick) => ({
      name: pick.name,
      quantity: pick.quantity,
      destination: pick.sourceLabel ?? "Pasted list",
      printing: `${pick.setCode.toUpperCase()} #${pick.collectorNumber} · ${pick.finish}`,
    }));
  async function confirm() {
    if (busy) return;
    const wasPending = Boolean(frozen);
    const value: FrozenHuntAction = frozen ?? {
      version: 1,
      recipientLabel: commit
        ? "the selected decks"
        : type === "ARCHIVE"
          ? (context.recipients.find((person) => person.id === player)
              ?.displayName ?? "")
          : name.trim(),
      summary,
      input: {
        requestId: crypto.randomUUID(),
        hunt,
        selected: picks.map((pick) => ({
          requestId: pick.requestId,
          inventoryItemId: pick.inventoryItemId,
          quantity: pick.quantity,
          stamp: pick.stamp!,
          ...(pick.targetStamp ? { targetStamp: pick.targetStamp } : {}),
        })),
        ...(commit
          ? { action: "COMMIT" as const }
          : {
              action: "GIVE" as const,
              kind,
              recipient:
                type === "ARCHIVE"
                  ? { type: "ARCHIVE" as const, playerId: player }
                  : { type: "EXTERNAL" as const, name: name.trim() },
            }),
      },
    };
    onFreeze(value);
    setBusy(true);
    setError("");
    try {
      sessionStorage.setItem(
        huntPendingKey(context.actorUserId),
        JSON.stringify(value),
      );
      window.dispatchEvent(new Event("mtg-card-hunt-action-pending"));
    } catch {
      setStorageFailed(true);
    }
    try {
      const response = await fetch("/api/card-hunt/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value.input),
        signal: AbortSignal.timeout(30000),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.definite && (!wasPending || data.outcomeKnown)) {
          onFreeze(null);
          try {
            sessionStorage.removeItem(huntPendingKey(context.actorUserId));
            window.dispatchEvent(new Event("mtg-card-hunt-action-pending"));
          } catch {}
        }
        throw Error(
          data.error ??
            "The confirmation could not be verified. Check the same confirmation.",
        );
      }
      if (!verifiedHuntOutcome(data, value.input))
        throw Error(
          "The returned outcome could not be verified. Check the same confirmation.",
        );
      try {
        sessionStorage.removeItem(huntPendingKey(context.actorUserId));
        window.dispatchEvent(new Event("mtg-card-hunt-action-pending"));
      } catch {}
      onFreeze(null);
      onKnown(data, value.input);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The confirmation could not be verified. Check the same confirmation.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] p-5 text-[var(--app-text)] backdrop:bg-black/70"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={title} className="text-xl font-semibold">
          {frozen
            ? "Check hunt confirmation"
            : commit
              ? "Commit selected cards"
              : "Give / trade selected cards"}
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
      {error && (
        <p role="alert" className="mt-3 rounded border border-red-600 p-3">
          {error}
        </p>
      )}
      {storageFailed && (
        <p role="status" className="mt-3">
          Your browser could not save the pending confirmation. Keep this page
          open until its outcome is verified.
        </p>
      )}
      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        {frozen ? (
          <p className="rounded border border-amber-600 p-3">
            Verify the same confirmation: {quantity} copies →{" "}
            {frozen.recipientLabel}. Retrying will not commit or give the cards
            twice.
          </p>
        ) : (
          <>
            <p>
              {quantity} selected copies.{" "}
              {commit
                ? "Each pull goes to its named deck. The preferred printing in the deck list stays unchanged."
                : "These copies will leave your available inventory and appear in your handoff history."}
            </p>
            {!commit && (
              <>
                <div className="flex flex-wrap gap-4">
                  <label>
                    <input
                      type="radio"
                      name="recipientType"
                      checked={type === "EXTERNAL"}
                      onChange={() => setType("EXTERNAL")}
                    />{" "}
                    Someone outside Archive
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="recipientType"
                      checked={type === "ARCHIVE"}
                      onChange={() => setType("ARCHIVE")}
                    />{" "}
                    Archive user
                  </label>
                </div>
                {type === "EXTERNAL" ? (
                  <label className="block">
                    Recipient name
                    <input
                      aria-label="Recipient name"
                      required
                      maxLength={120}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      list={peopleId}
                      className={filterInputClass + " mt-1 w-full"}
                    />
                    <datalist id={peopleId}>
                      {context.recentPeople.map((person) => (
                        <option key={person} value={person} />
                      ))}
                    </datalist>
                  </label>
                ) : (
                  <label className="block">
                    Archive recipient
                    <select
                      aria-label="Archive recipient"
                      required
                      value={player}
                      onChange={(event) => setPlayer(event.target.value)}
                      className={filterSelectClass + " mt-1 w-full"}
                    >
                      <option value="">Choose someone</option>
                      {context.recipients.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {type === "ARCHIVE" && (
                  <p className="text-sm">
                    Transfers immediately to the recipient’s Unassigned
                    location.
                  </p>
                )}
                <label className="block">
                  Record as
                  <select
                    aria-label="Record as"
                    value={kind}
                    onChange={(event) =>
                      setKind(event.target.value as typeof kind)
                    }
                    className={filterSelectClass + " ml-2"}
                  >
                    <option value="GIFT">Given away</option>
                    <option value="TRADE">Traded away</option>
                  </select>
                </label>
              </>
            )}
          </>
        )}
        <div className="max-h-64 overflow-y-auto rounded border border-[var(--app-border)]">
          <ul className="divide-y divide-[var(--app-border)]">
            {summary.map((line, index) => (
              <li key={index} className="p-3 text-sm">
                <span className="font-medium">
                  {line.quantity} × {line.name}
                </span>
                <span className="block text-[var(--app-muted)]">
                  {line.printing} · {commit ? "To deck" : "For"}:{" "}
                  {line.destination}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <button
          type="submit"
          disabled={
            busy ||
            (!frozen &&
              !commit &&
              (type === "EXTERNAL" ? !name.trim() : !player))
          }
          className={filterPrimaryButtonClass}
        >
          {busy
            ? "Checking confirmation…"
            : frozen
              ? "Check same confirmation"
              : commit
                ? `Confirm commit of ${quantity} copies`
                : `Confirm handoff of ${quantity} copies`}
        </button>
      </form>
    </dialog>
  );
}
