// Weak/cheap-model detection for the Story-tab ingestion UI (story-state
// plan, open question 5 — resolved 2026-07-29: warn, informational only).
//
// No provider exposes a queryable capability tier, and nothing in this
// codebase carries one either — checked `connectionProfileStore`,
// `settingsStore`, and the provider catalog (`src/api/providerCatalog.ts`);
// none has a `tier`/`quality`/`contextWindow`/`pricing` field, and the
// catalog's `category` (frontier/open/aggregator/specialty/local) is
// per-PROVIDER, not per-model — OpenAI is "frontier" but still offers
// `gpt-4o-mini`, so it can't answer "is THIS model weak".
//
// This is therefore a manually-maintained heuristic on the model id
// string, not a measurement. It will need occasional updates as new
// budget-tier models ship. Biased toward recall over precision: missing
// a weak model is silent, but flagging a strong one just shows an extra
// (dismissable, non-blocking) note.

const WEAK_MODEL_PATTERNS: RegExp[] = [
  // Common budget/small-tier naming across providers.
  /\bmini\b/i,
  /\bnano\b/i,
  /\btiny\b/i,
  /\bmicro\b/i,
  /\blite\b/i,
  /\bsmall\b/i,
  /\binstant\b/i,
  // Anthropic's fast/cheap tier.
  /\bhaiku\b/i,
  // Explicit small parameter counts (open-weight models: 1b, 3b, 7b, 8b,
  // 0.5b...). Deliberately single-digit-only via the boundary before the
  // digit — "13b"/"30b"/"70b" have a digit immediately before the last
  // one, so no boundary forms there and they correctly don't match.
  /\b(0\.5|1|2|3|4|7|8|9)b\b/i,
];

/** True when `modelId` matches a known weak/cheap-tier naming pattern.
 *  Always false for an empty/missing id — no model selected yet isn't a
 *  reason to warn about model strength. */
export function isWeakModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  return WEAK_MODEL_PATTERNS.some((re) => re.test(modelId));
}
