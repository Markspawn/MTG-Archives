# Scan Batches state infographic

Brian narrowed the November22 request to the existing entries on Scan Batches: a color infographic based on each batch's state, with all portions adding up to its saved card total. This is a compact display change; existing batch search, paging, controls, destination and automatic refresh behavior remain.

The bar and labelled counts use exclusive groups:

- Blue: queued or still evaluating.
- Amber: completed printing check, awaiting a complete saved review.
- Violet: complete saved review, not yet added.
- Green: an Inventory addition receipt.
- Gray: ignored, retained with the batch.

Receipt takes precedence, then Ignore, then a complete review, then a completed printing check. Every other saved candidate is queued/evaluating. This preserves the dashboard's existing evaluation definition; failed processing remains visible in its existing attention message. It does not change recognition or review policy.

The sum is calculated in the owner-authorized dashboard SQL, over the same physical candidates as Saved. Retries, older photos and multiple processing stages cannot create another slice. The existing summary tiles above the batch list retain their cumulative meanings; the help text distinguishes those totals from the exclusive per-batch breakdown.

All counts stay visible, including zero. Empty batches have an empty track, and tiny portions keep their true proportions. Labels and an accessible text alternative provide the counts independently of color. Width transitions honor reduced motion. The ordinary automatic refresh supplies new values; no extra polling, controls or drill-down behavior are added.

This follow-up is based on PR1061, which supplies Ignore and its counts. It does not modify or approve that PR. Each PR still needs individual merge approval. Source/local review/CI are separate from production delivery and user acceptance. Detailed temporary evidence belongs in the owning root checkpoint and private batch-state-infographic-20261122 folder.
