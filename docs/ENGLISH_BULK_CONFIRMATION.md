# English batch defaults in bulk confirmation

Brian requested that an explicitly English batch assume English instead of requiring individual review solely because OCR reports another language. This concerns the operator's bulk-confirm action, related to recognition/review tracker [#307](https://github.com/sefaction/MTG-Archives/issues/307).

Previously, `acquisitionBulkReviewBlock` rejected an otherwise eligible English printing when scan language observations contained a different language. With batch language `en`, that OCR-only veto no longer excludes the card. The bulk preview explains the English assumption. The existing selected printing supplies the saved `en` language.

The selected printing still needs to be English. A genuinely non-English printing is not relabelled. Saved per-card reviews, missing proposals/languages/condition, finish choices, unsaved drafts and existing server revision/source/ownership checks retain their behavior. Non-English batch defaults keep their existing OCR-language checks. The raw observations and recognition proposals remain available; no OCR, ranking or automatic-acceptance policy changes.

Bulk confirmation continues to save reviews only. Inventory addition is a separate explicit action. Frozen requests and uncertain-response retries retain the originally approved printing and attributes.

## Regression coverage

- Unit cases cover foreign/mixed OCR observations with an English batch, preservation of other exclusions and selected printing identity, and unchanged French-batch language checks.
- `tests/ui/acquisition-english-bulk.spec.ts` exercises actual uploads, persisted controlled language evidence, normal review reads, bulk POST saves and exact-request replay in an explicitly owned disposable runtime. It refuses other container owners and database identities.
- The six-card fixture includes two English printings with conflicting language observations, a foreign printing, an already saved foreign-language choice, an unresolved finish choice and an unmatched card. Desktop and phone checks cover preview eligibility and explanatory text. Actual saves and source/Inventory comparisons establish that the new choice does not overwrite saved reviews or add copies.
- The fixture then changes the batch to French and checks that an OCR disagreement remains excluded, before restoring English. Synthetic evidence is not an OCR-accuracy or physical-scanner qualification.

Runtime source identities, outcomes, retained failures and current-head CI are recorded in the owning checkpoint and PR. Author verification, independent review, merge, production deployment and user acceptance remain separate.

Author qualification passes all 38 focused controls, full typecheck/production build and the actual six-card desktop/phone save/replay/conservation workflow. All 1,491 runtime manifest inputs match. The initial new-test nullability error is retained and corrected. A fixture-only finish-choice input was refreshed after the successful build; compiled application inputs remain exact and final-head CI covers the final test. No production operation occurred.
