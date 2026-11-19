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
