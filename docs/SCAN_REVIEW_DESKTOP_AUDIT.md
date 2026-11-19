# Scan review desktop audit ? November 19, 2026

Brian reported that the newly merged review was oversized, hid the controls, showed unequal scan/reference sizes and jumped when confirming. He requested an audit and a more pleasant experience, then clarified desktop browser usability is the priority. This authorizes this bounded implementation and local review; PR1049 approval does not authorize merging this follow-up.

## Observed problems and changes

- At 1366?768 the Review saved cards entry left the first image at y781, below the viewport. Repeated progress/count/help rows and two sticky control bars consumed most of the available height. The batch toolbar is compact, retains the visible Inventory box/section and Add action, and moves activity/capacity details into a disclosure. Review layout, mode and filter share one wrapping desktop row; repeated explanation becomes Review help. Jump to card replaces the duplicate expanding card grid.
- Image sizes followed available page width and viewport caps independently. The scan canvas also depended on its intrinsic dimensions. Simple review now shares one aspect-ratio frame and explicit contained image/canvas sizing; desktop focused review caps the pair together using browser height and places the card details/actions alongside. The two-column overview uses smaller matched frames. Original bytes, private previews and explicit original inspection are unchanged.
- Successful saves focused replacement controls without preventScroll. Navigation always scrolled even when the new card occupied the same visible position; resizing the sticky toolbar could also trigger a second scroll. Focus now preserves scroll, navigation reveals only an obscured/offscreen target, toolbar observation only measures offsets, and the focused workspace reserves space while the next review loads. Browser scroll anchoring is disabled within this changing review workspace.

## Verification and limits

Pending source-bound production build, measured desktop browser workflows and exact-head CI. Preserve original failure evidence and distinguish author qualification, user acceptance, merge and deployment. Retain current-batch-only all-confirmed Inventory selection, frozen preview/rollback/replay protection, original images, unsaved correction persistence and explicit attention reasons. No production actions or physical scanning. Private baseline screenshots/geometry and runtime identities are kept under .local-data/scan-review-density-20261119.
