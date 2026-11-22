/** Ignore is a review disposition. Physical identity/count and saved decisions
 * remain intact; only a new, revision-bound action may restore active work. */
export function acquisitionIgnoreTransition(candidate: {
  revision: number; ignored?: boolean; excluded: boolean; receipt?: unknown;
}, action: "ignore" | "restore", revision: number) {
  if (candidate.receipt) throw new Error("Capture card is already committed; use Inventory to change it");
  if (candidate.excluded) throw new Error("Capture card unavailable");
  if (candidate.revision !== revision) throw new Error("Capture card changed; reload before changing its ignored state");
  const ignored = action === "ignore";
  if (Boolean(candidate.ignored) === ignored) throw new Error("Capture card changed; reload its ignored state");
  return {ignored, revision: revision + 1};
}
