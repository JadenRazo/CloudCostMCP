/**
 * Normalize an upstream effective/publication date into an ISO string.
 * Falls back to "now" when the value is absent or unparseable so downstream
 * consumers always see a valid ISO date.
 */
export function resolveEffectiveDate(effectiveDate?: string): string {
  if (effectiveDate) {
    const t = new Date(effectiveDate);
    if (!Number.isNaN(t.getTime())) return t.toISOString();
  }
  return new Date().toISOString();
}
