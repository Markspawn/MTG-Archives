import {acquisitionPreferredPrinting, type AcquisitionCardReview, type AcquisitionDefaults} from "./acquisition-review";
import {finishForPrinting} from "./acquisition-finish";

/** Explain the same safeguards used to decide which proposals may be bulk saved. */
export function acquisitionBulkReviewBlock(record: AcquisitionCardReview, defaults: AcquisitionDefaults, hasDraft = false): string | null {
  if (hasDraft) return "Unsaved correction: save or cancel it first.";
  if (record.review) return "This card already has a saved review; correct its saved details individually if needed.";
  const printing = acquisitionPreferredPrinting(record);
  if (!printing) return "No printing proposed yet. Wait for identification or find the printing manually.";
  if (!defaults.condition) return "Choose a batch condition before bulk confirmation.";
  if (!printing.lang) return "The proposed printing has no language. Choose its language individually.";
  const language = defaults.language?.toLowerCase();
  if (language && printing.lang.toLowerCase() !== language)
    return `The proposed printing is ${printing.lang.toUpperCase()}, but the batch is ${language.toUpperCase()}. Check the language individually.`;
  const conflicts = [...new Set(record.evidence?.identifiers.languages.map(value => value.toLowerCase()).filter(value => language && value !== language) ?? [])];
  if (conflicts.length) return `The scan reports ${conflicts.map(value => value.toUpperCase()).join(", ")}, conflicting with batch ${language!.toUpperCase()}. Check the scan and correct its language individually.`;
  if (!finishForPrinting(defaults.finish, printing)) return "Choose a finish supported by this printing before confirming.";
  return null;
}
