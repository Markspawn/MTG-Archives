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
