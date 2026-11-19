export function normalizeInventoryLanguage(value: string): string {
  return value.replace(/^ +| +$/g, "").toUpperCase() === "EN" ? "EN" : value;
}
