# Scan review experience

Brian requested this redesign on November 19, 2026: make controls easy to find
and make it quick to compare each physical scan with its proposed printing,
then implement the plan. This authorizes the feature branch and PR; individual
merge approval and production deployment remain separate.

## Plan and acceptance

1. Open saved batches directly into review. Keep capture controls and batch
   settings reachable without placing setup instructions ahead of saved cards.
2. Default to focused review, with a bounded card navigator, previous/next
   navigation and a two-column overview showing both images for every card.
   Brian explicitly requested the two-column alternative during planning.
   Stack the overview on phones. Preserve the existing hundred-card server pages
   and unlimited pending backlog. Counts and filters explicitly cover one page.
3. Keep the scan and printing together at a useful size, with confirmation,
   correction, finish and skip controls alongside them. Provide Confirm and next;
   advance only after the server accepts the review. Inventory remains a separate
   preview/commit operation with its existing checks.
4. Keep drafts when navigating, filtering or changing views. Show unsaved status
   in the navigator, retain corrections through polling, and prevent page changes
   while live edits remain. Keep physical order and saved finish/opener defaults.
5. Keep recognition evidence and boundary repair available through Advanced;
   keep common review controls concise on desktop and usable at 390/320 pixels.
6. Verify navigation, failed saves, drafts, empty filters, last-card behavior,
   accessibility and desktop/phone layout in a disposable local Docker runtime.
   Run focused regression tests, types/lint, a production build and exact-head CI.

No recognition algorithm, physical scanner operation, production business action,
schema, ownership/privacy rule or Inventory acceptance rule changes are planned.
Existing performance delivery is PR #1048; issue #1004 retains its separate
affected-installation timing criteria. No new issue is created without verified
cross-node intake coordination.

## Author verification

The final compiled product is source-bound to 56cc3e6b. The production build,
TypeScript, changed-file lint, 47 focused draft/navigation/readiness/reload/finish
controls and three complete browser cases (1366, 390 and 320 pixels) pass.
Browser coverage includes both layouts, retained corrections across navigation,
view changes and reload, rejected-save non-advancement, actual acknowledged saves,
original opener/finish preservation, empty filters, final-card handling, sticky
control clearance, unchanged original metadata and zero Inventory additions.

The first browser run used an incorrect dropdown selector; it is preserved as a
harness failure. The second exposed a real phone overlap when a successful save
added an Inventory action to the sticky toolbar. Resize observation now keeps
only the focused card row clear, without repositioning an active field. All three
widths pass after that correction. Synthetic fixture setup errors are retained
separately. This establishes UI/manual-review behavior, not optical accuracy,
physical operation, production timing or independent user acceptance.

PR #1049 carries final-head CI and review status. Later changes are test coverage
and this evidence only; compiled product inputs remain identical. The stopped
local review app/database, compiled image and synthetic originals are retained;
temporary build/browser containers and two superseded images were retired and
the exact runtime owner released. The primary local installation was preserved.

## Reproducing the browser fixture

In an owned disposable Linux review runtime, migrate the empty database named
`review_pending_performance`, set `MTG_SCANS_EXPERIENCE_TEST=1`, then run
`npx tsx scripts/ci/scans-review-experience.ts` inside the web container. The helper
requires that exact local database name and an allowed local host, creates only
synthetic accounts/cards/photos, and writes its private session receipt to
`/tmp/scans-experience-fixture.json`. Keep processing workers stopped. Restart the
owned review web after seeding so its synthetic public image is discoverable.

Run `tests/ui/scans-review-experience.spec.ts` with the same opt-in flag,
`MTG_INVENTORY_TEST_CONTAINER` set to that immutable owned web container ID, a
single Chromium worker and base URL `http://127.0.0.1:13275`. The regression resets
only this fixture's reviews between widths and requires zero Inventory additions
and unchanged original metadata. Retire only the owned fixture resources after
recording results; the ordinary installation is not a test target.

## Follow-up: bulk confirmation and Inventory clicks

Brian explicitly requested clear reasons for bulk exclusions and one final
confirmation for all currently confirmed cards, with box/section visible at a
glance. This extends the same coherent PR1049; earlier results above are historical
and do not qualify the changed source until the follow-up checks pass.

Bulk exclusions remain deliberate for unsaved edits, absent proposals, incomplete
saved reviews, missing attributes and readable language conflicts. A concrete
loader defect discarded successful peers and aborted later groups when one
proposal request failed. Independent settled results now keep those peers and
identify failed reads for retry. Case-normalized language comparison avoids a
format-only conflict; actual conflicting evidence still requires individual review.
Exclusion reasons remain visible after partial confirmation with direct inspection.

The normal Inventory path is now Add all confirmed cards -> one confirmation
showing copy count, box, section and capacity. The server discovers ready cards
across bounded review pages and freezes the exact selection through the existing
preview token. Unsaved corrections, physical blockers and already added cards are
excluded; no extra confirmation click is needed to select/prepare the normal set.
The former500-copy operation ceiling is removed. Owner, current-photo/count,
capacity/overfill, stale-preview, atomic rollback and same-request replay checks
remain. Per-card choices stay under an optional disclosure. No production or
physical scanner operation is authorized by this UI follow-up.

### Follow-up qualification and current-batch scope

Brian clarified that adding confirmed cards must operate only on the batch being
viewed. Seven current production-mode browser cases pass: the three original
comparison/draft cases and four bulk/Inventory cases across1366/390/320 plus a
501-copy/six-page case. A neighboring batch with501 ready cards remains untouched
while eight confirmed cards from the viewed batch are added. The ordinary path
uses Add all confirmed cards and the final count/box/section confirmation; neither
manual selection nor a separate preview click is needed. The final Add button is
visible without scrolling at the tested viewport sizes. An interrupted response
after the real commit recovers through the identical request and returns one
receipt, with no duplicate Inventory copies.

The source-bound production build, types, changed-file lint and34 focused
exclusion/draft/navigation/reload controls pass. Required PostgreSQL ownership,
concurrency, rollback/replay and new all-confirmed exclusion/stale-preview checks
are exercised by CI. Full current-head CI/readiness is recorded on PR1049.
Compiled product head is e3768ad0; subsequent edits update evidence only.

The initial follow-up fixture declaration/type errors, disposable runtime export
assumption and intercepted-response teardown failure remain private evidence.
An additional real navigation regression was reproduced: Inspect from an open
Inventory panel left the card list hidden. Inspection now closes that panel and
reveals the physical card; all three viewport cases pass the direct return check.
Earlier failed intervals remain failures, separately from their corrected passes.

A named local sample-data review installation remains active at13285. Its web,
database, original scans and current image are protected; temporary build/browser
containers and superseded images are retired and the exact heavy-runtime claim
released. The regular local installation and production remain unchanged. The
preview uses generated data and establishes no optical/physical throughput or
reporter acceptance. Individual merge approval and deployment remain separate.
