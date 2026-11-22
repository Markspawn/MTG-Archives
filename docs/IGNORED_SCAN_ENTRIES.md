# Ignore an individual scan

Brian agreed the recoverable workflow for [issue1050](https://github.com/sefaction/MTG-Archives/issues/1050) in the MTG Archives project chat on November22,2026: "yes, sounds good."

Each retained, uncommitted scan has **Ignore scan** in the list and **Ignore and next** in focused review. There is no extra confirmation dialog. **Undo** immediately restores the last ignored entry; **Show cards → Ignored** keeps all ignored entries accessible with **Restore scan**. Ignoring does not delete an original image or a saved printing/finish/condition/language/opener choice. An unsaved correction must be saved or cancelled before this tab ignores its scan; a draft in another tab remains recoverable on Restore. Failed acknowledgements retain the original action for explicit retry.

Ignored entries leave active review, navigation, problem totals, bulk confirmation, recognition reruns and Inventory selection. Saved-review counts and the batch dashboard distinguish ignored from confirmed/added. A completed100scan batch with98added and2ignored has no remaining review work. Already-added entries cannot be ignored; use Inventory to manage those copies.

The physical slot, ordering, scanner target and overflow boundary stay unchanged. Ignoring releases that entry's pending Inventory storage hold but cannot create another physical feed slot or promote an overflow copy. Restore puts its hold and saved choice back; normal destination/overfill checks still apply before Inventory addition. Count reconciliation remains separate from the ignored disposition.

## Persistence and concurrent work

The additive `AcquisitionCandidate.ignored` column defaults false for all existing data. An authorized action takes the batch and destination locks, checks the current photo/generation/candidate revision, increments the candidate/batch revisions and records an actor-bound idempotent command. Exact retries replay; changed keys/bodies, stale tabs and already-committed copies cannot mutate the entry. Replaying an old Ignore after Restore does not ignore it again.

Ignored entries cannot accept ordinary review or Inventory commits, including a previously frozen preview. Recognition admission, lease renewal, publication, automatic confirmation, reference descendants and rerun expansion check the disposition. Source-only canonical preparation may still finish its immutable preview; it grants no recognition/review authority. Restore of an unreviewed scan requests fresh source-bound recognition while preserving any manual region. Existing human decisions remain untouched. Ignoring alone does not opt its original bytes into pressure cleanup.

## Verification and delivery

`tests/acquisition-ignore.test.ts` covers the100scan example, physical allocation/overflow, navigation, holds, guarded actions and request shape. `scripts/verify-acquisition-ignore.ts --run` requires an opted-in, fresh local `acquisition_*` database and verifies real ownership/Admin Mode, exact concurrent replay, stale commit and review rejection, late native publication, rerun exclusion, saved-choice restoration, closed-batch counts, capacity holds and concurrent Ignore/review serialization. It checks original metadata/slots/observations/receipts/Inventory conservation and cleans its own fixture. The required acquisition integrity CI job runs it after the existing rerun qualification.

The opted-in `tests/ui/acquisition-ignore.spec.ts` uses this task's separate local review/database only. It checks desktop and phone list/focus Ignore/Undo/Restore, reload, bulk exclusion, retained saved choices and all original byte hashes. It uses persisted controlled proposals; this is not a recognition-accuracy or physical scanner test.

This changes shared web and worker predicates. Once individually approved and merged, deploy all application services from the matching published release through the ordinary stop/pull-update/start procedure. Existing main-channel image references and fresh-pull settings stay. The normal web startup applies the additive migration; no environment, model or scanner setting changes are needed. Source readiness, exact-head CI, merge, named-installation rollout and user acceptance remain separate.
