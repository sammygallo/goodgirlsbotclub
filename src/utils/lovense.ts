// ---------------------------------------------------------------------------
// Lovense domain logic — pure, dependency-free helpers shared by the store,
// the settings panel, the in-chat quick control, and the /lovense command.
//
// Covers: the Standard-API Function action vocabulary + ranges, a per-toy
// capability table (so the UI only offers functions a toy actually has), the
// parser/instruction for AI-driven control (characters embedding
// `[lovense: ...]` directives in their replies), and — for users with several
// toys, possibly spread across several pairings — target resolution (`@lush`)
// plus the planner that turns one directive into the set of per-toy commands
// that drive every applicable toy at once.
//
// Reference: https://developer.lovense.com/docs/standard-solutions/standard-api.html
// ---------------------------------------------------------------------------

/** Every Function action the Standard API accepts. Note "Thrusting" (not
 *  "Thrust") and "Oscillate"; "All" drives every function, "Stop" halts. */
export const LOVENSE_ACTIONS = [
  'Vibrate',
  'Rotate',
  'Pump',
  'Thrusting',
  'Fingering',
  'Suction',
  'Depth',
  'Stroke',
  'Oscillate',
  'All',
  'Stop',
] as const;
export type LovenseAction = (typeof LOVENSE_ACTIONS)[number];

/** Actions a user can map to a keyword or a simple intensity control. Excludes
 *  Stroke (needs a min–max range) and Stop (has its own control). */
export const SIMPLE_ACTIONS: LovenseAction[] = [
  'Vibrate',
  'Rotate',
  'Pump',
  'Thrusting',
  'Fingering',
  'Suction',
  'Depth',
  'Oscillate',
  'All',
];

export const LOVENSE_PRESETS = ['pulse', 'wave', 'fireworks', 'earthquake'] as const;
export type LovensePreset = (typeof LOVENSE_PRESETS)[number];

/** Per-action intensity ceiling. Pump/Depth are 0–3, Stroke is a 0–100
 *  position range, everything else is 0–20. */
export function actionMaxIntensity(action: LovenseAction): number {
  if (action === 'Pump' || action === 'Depth') return 3;
  if (action === 'Stroke') return 100;
  return 20;
}

/** Minimum width of a Stroke position range. The Standard API *silently
 *  ignores* a Stroke whose max−min is under 20, so a narrow range would look
 *  like a dead toy rather than an error. */
export const STROKE_MIN_SPAN = 20;

/** Order a Stroke range and widen it to the API's minimum span, keeping the
 *  midpoint and sliding inward at the 0/100 ends. */
export function normalizeStrokeRange(lo: number, hi: number): { min: number; max: number } {
  let a = Math.max(0, Math.min(100, Math.round(Math.min(lo, hi))));
  let b = Math.max(0, Math.min(100, Math.round(Math.max(lo, hi))));
  if (b - a >= STROKE_MIN_SPAN) return { min: a, max: b };
  const mid = (a + b) / 2;
  a = Math.round(mid - STROKE_MIN_SPAN / 2);
  b = a + STROKE_MIN_SPAN;
  if (a < 0) {
    b -= a;
    a = 0;
  }
  if (b > 100) {
    a -= b - 100;
    b = 100;
  }
  return { min: Math.max(0, a), max: Math.min(100, b) };
}

// ---------------------------------------------------------------------------
// Toy capability table
// ---------------------------------------------------------------------------
//
// The pairing callback reports each toy's `name` as a lowercase, generation-
// stripped "type" string ("lush", "max", "nora", "solace pro"). We map that to
// the Function actions the toy supports so the UI hides irrelevant controls.
// The server channel has no live GetToys, so this is our capability source;
// unrecognized toys fall back to a permissive set (the API 403s any function a
// toy genuinely lacks, so over-offering is only a cosmetic wart, whereas
// under-offering would hide a real capability).

const CAP: Record<string, LovenseAction[]> = {
  lush: ['Vibrate'],
  'lush mini': ['Vibrate'],
  'lush anal': ['Vibrate'],
  hush: ['Vibrate'],
  edge: ['Vibrate'],
  nora: ['Vibrate', 'Rotate'],
  max: ['Vibrate', 'Pump'],
  domi: ['Vibrate'],
  osci: ['Oscillate'],
  ambi: ['Vibrate'],
  diamo: ['Vibrate'],
  ferri: ['Vibrate'],
  gush: ['Vibrate'],
  hyphy: ['Vibrate'],
  gravity: ['Vibrate', 'Thrusting'],
  flexer: ['Vibrate', 'Fingering'],
  ridge: ['Vibrate', 'Rotate'],
  exomoon: ['Vibrate'],
  calor: ['Vibrate'],
  dolce: ['Vibrate'],
  quake: ['Vibrate'],
  vulse: ['Vibrate', 'Thrusting'],
  tenera: ['Suction'],
  solace: ['Thrusting', 'Depth'],
  'solace pro': ['Thrusting', 'Stroke', 'Depth'],
  lapis: ['Vibrate'],
  mission: ['Vibrate'],
  xmachine: ['Thrusting'],
  gemini: ['Vibrate'],
  spinel: ['Vibrate', 'Thrusting'],
  velvo: ['Vibrate', 'Rotate'],
  fizz: ['Suction', 'Oscillate'],
};

/** Pretty display names for known toy types (fallback: title-case the type). */
const DISPLAY: Record<string, string> = {
  lush: 'Lush',
  'lush mini': 'Lush Mini',
  'lush anal': 'Lush Anal',
  hush: 'Hush',
  edge: 'Edge',
  nora: 'Nora',
  max: 'Max',
  domi: 'Domi',
  osci: 'Osci',
  ambi: 'Ambi',
  diamo: 'Diamo',
  ferri: 'Ferri',
  gush: 'Gush',
  hyphy: 'Hyphy',
  gravity: 'Gravity',
  flexer: 'Flexer',
  ridge: 'Ridge',
  exomoon: 'Exomoon',
  calor: 'Calor',
  dolce: 'Dolce',
  quake: 'Quake',
  vulse: 'Vulse',
  tenera: 'Tenera',
  solace: 'Solace',
  'solace pro': 'Solace Pro',
  lapis: 'Lapis',
  mission: 'Mission',
  xmachine: 'Sex Machine',
  gemini: 'Gemini',
  spinel: 'Spinel',
  velvo: 'Velvo',
  fizz: 'Fizz',
};

/** Broad fallback for unrecognized toys — offer the common single-value
 *  functions and let the API reject any the toy lacks. */
const PERMISSIVE: LovenseAction[] = [
  'Vibrate',
  'Rotate',
  'Pump',
  'Thrusting',
  'Suction',
  'Oscillate',
];

function normalizeToyType(name: string): string {
  // Lowercase, collapse whitespace, drop a trailing generation number/spaces
  // ("Max 2" -> "max", "lush3" -> "lush"), but keep two-word types like
  // "solace pro" intact when the second word is not purely a number.
  const base = name.trim().toLowerCase().replace(/\s+/g, ' ');
  if (CAP[base]) return base;
  const stripped = base.replace(/[\s-]*\d+$/, '').trim();
  return stripped || base;
}

export interface ToyCapability {
  /** Function actions to offer for this toy. */
  actions: LovenseAction[];
  /** True when the toy type was recognized (vs. the permissive fallback). */
  known: boolean;
}

export function capabilitiesForToy(name?: string | null): ToyCapability {
  if (!name) return { actions: [...PERMISSIVE], known: false };
  const type = normalizeToyType(name);
  const actions = CAP[type];
  if (actions) return { actions: [...actions], known: true };
  return { actions: [...PERMISSIVE], known: false };
}

export function toyDisplayName(name?: string | null): string {
  if (!name) return 'Toy';
  const type = normalizeToyType(name);
  return DISPLAY[type] ?? (name.charAt(0).toUpperCase() + name.slice(1));
}

/** Union of the supported actions across a set of toys (for prompt hints and
 *  "All"-style broadcasts). Falls back to the permissive set when empty. */
export function unionCapabilities(names: (string | null | undefined)[]): LovenseAction[] {
  const set = new Set<LovenseAction>();
  for (const n of names) {
    for (const a of capabilitiesForToy(n).actions) set.add(a);
  }
  if (set.size === 0) return [...PERMISSIVE];
  return LOVENSE_ACTIONS.filter((a) => set.has(a));
}

// ---------------------------------------------------------------------------
// Toy identity: handles, matching, per-toy addressing
// ---------------------------------------------------------------------------
//
// A user can pair several Lovense apps ("pairings"), and each pairing can carry
// several toys. Every toy therefore needs a stable, human-typeable handle so a
// character can say `@lush` / `@solace` and the UI can show the same label.

/** One connected toy, as the targeting/planning layer sees it. */
export interface ToyRef {
  /** Lovense toy id (unique within a pairing). */
  id: string;
  /** Which pairing this toy is attached to. */
  pairingId: string;
  /** Lovense's reported toy type, e.g. "lush", "solace pro". */
  name?: string | null;
  /** User's nickname from the Lovense app, if any. */
  nickname?: string | null;
  /** User-assigned label for the owning pairing, e.g. "My phone". */
  pairingLabel?: string | null;
}

/** Strip a display string down to a comparable token: lowercase alphanumerics. */
function slug(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Stable `@handle` for each toy, in list order. Prefers the nickname, falls
 *  back to the toy type, and disambiguates duplicates with a 1-based suffix
 *  ("lush", "lush2") so two identical toys stay separately addressable. */
export function assignToyHandles(toys: ToyRef[]): string[] {
  // Track the handles actually emitted, not just the base slugs: a generated
  // "lush2" must not collide with a later toy genuinely nicknamed "Lush 2",
  // which would make one @handle drive two toys.
  const emitted = new Set<string>();
  return toys.map((t, i) => {
    const base = slug(t.nickname) || slug(toyDisplayName(t.name)) || `toy${i + 1}`;
    if (!emitted.has(base)) {
      emitted.add(base);
      return base;
    }
    let n = 2;
    while (emitted.has(`${base}${n}`)) n++;
    const handle = `${base}${n}`;
    emitted.add(handle);
    return handle;
  });
}

/** The handle for one toy within its list (convenience wrapper). */
export function toyHandle(toys: ToyRef[], index: number): string {
  return assignToyHandles(toys)[index] ?? `toy${index + 1}`;
}

/** Resolve one target token (already stripped of a leading "@") to the toys it
 *  names. Matches, in order: handle, 1-based index, nickname, toy type, pairing
 *  label, then an unambiguous prefix. Returns [] when nothing matches. */
export function resolveTargetToken(token: string, toys: ToyRef[]): ToyRef[] {
  // Raw Lovense toy id — how the UI addresses a toy the user picked from a list.
  const byId = toys.filter((t) => t.id === token.trim());
  if (byId.length) return byId;

  const q = slug(token);
  if (!q || toys.length === 0) return [];
  if (q === 'all' || q === 'both' || q === 'everything' || q === 'everytoy') return [...toys];

  const handles = assignToyHandles(toys);
  const byHandle = toys.filter((_, i) => handles[i] === q);
  if (byHandle.length) return byHandle;

  // "toy2" / "t2" / "2" → 1-based index into the toy list.
  const idx = q.match(/^(?:toy|t)?(\d+)$/);
  if (idx) {
    const n = parseInt(idx[1], 10);
    const hit = toys[n - 1];
    return hit ? [hit] : [];
  }

  const byNickname = toys.filter((t) => slug(t.nickname) === q);
  if (byNickname.length) return byNickname;

  const byType = toys.filter(
    (t) => slug(normalizeToyType(t.name ?? '')) === q || slug(toyDisplayName(t.name)) === q,
  );
  if (byType.length) return byType;

  const byPairing = toys.filter((t) => t.pairingLabel && slug(t.pairingLabel) === q);
  if (byPairing.length) return byPairing;

  // Prefix fallback ("@sol" → Solace Pro), but only when it names one toy type
  // — an ambiguous prefix must not silently drive the wrong toy.
  const byPrefix = toys.filter(
    (t, i) =>
      handles[i].startsWith(q) ||
      slug(t.nickname).startsWith(q) ||
      slug(normalizeToyType(t.name ?? '')).startsWith(q),
  );
  const distinct = new Set(byPrefix.map((t) => `${t.pairingId}:${t.id}`));
  return distinct.size === 1 ? byPrefix.slice(0, 1) : [];
}

/** Resolve a directive's target list. `null`/empty → every toy. Unresolvable
 *  tokens contribute nothing, so a directive naming a toy that isn't connected
 *  drives nothing rather than falling back to "everything". */
export function resolveTargets(tokens: string[] | null | undefined, toys: ToyRef[]): ToyRef[] {
  if (!tokens || tokens.length === 0) return [...toys];
  const out: ToyRef[] = [];
  const seen = new Set<string>();
  for (const tok of tokens) {
    for (const t of resolveTargetToken(tok, toys)) {
      const key = `${t.pairingId}:${t.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// AI-driven control: parse `[lovense: ...]` directives out of a message
// ---------------------------------------------------------------------------

export interface FunctionActionSpec {
  action: LovenseAction;
  intensity: number;
  /** Stroke range (0–100). Only set when action === 'Stroke'. */
  min?: number;
  max?: number;
}

/** A run of actions sharing one target. `targets: null` = every applicable toy. */
export interface TargetedActions {
  targets: string[] | null;
  actions: FunctionActionSpec[];
}

export type LovenseDirective =
  | { kind: 'function'; groups: TargetedActions[]; durationSec?: number }
  | { kind: 'preset'; name: LovensePreset; targets: string[] | null; durationSec?: number }
  | { kind: 'stop'; targets: string[] | null };

/** Casual → canonical action synonyms used when parsing AI directives. */
const SYNONYMS: Record<string, LovenseAction> = {
  vibrate: 'Vibrate',
  vibe: 'Vibrate',
  buzz: 'Vibrate',
  rotate: 'Rotate',
  spin: 'Rotate',
  twist: 'Rotate',
  pump: 'Pump',
  inflate: 'Pump',
  squeeze: 'Pump',
  thrust: 'Thrusting',
  thrusting: 'Thrusting',
  stroke: 'Thrusting', // bare "stroke" reads as thrust; a range → Stroke below
  finger: 'Fingering',
  fingering: 'Fingering',
  suction: 'Suction',
  suck: 'Suction',
  depth: 'Depth',
  oscillate: 'Oscillate',
  tap: 'Oscillate',
  all: 'All',
  everything: 'All',
  stop: 'Stop',
  off: 'Stop',
  halt: 'Stop',
};

const TAG_RE = /\[(?:lovense|toy)\s*:\s*([^\]]*)\]/gi;

function parseDurationSuffix(s: string): { text: string; durationSec?: number } {
  // Match "for 5s", "for 5 sec", "for 5 seconds", or a trailing "5s".
  const m = s.match(/\bfor\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)?\b/i)
    || s.match(/\b(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\b\s*$/i);
  if (!m) return { text: s };
  // Floor to 1s: a parsed directive must never request indefinite runtime
  // (timeSec:0 on the API means "run forever"). Indefinite is reserved for the
  // explicit manual quick-control dial, which never routes through the parser.
  const durationSec = Math.max(1, Math.round(parseFloat(m[1])));
  const text = s.slice(0, m.index) + s.slice((m.index ?? 0) + m[0].length);
  return { text, durationSec };
}

function clampToAction(action: LovenseAction, raw: number): number {
  const max = actionMaxIntensity(action);
  return Math.max(0, Math.min(max, Math.round(raw)));
}

function parseIntensityToken(action: LovenseAction, token: string): number {
  const t = token.trim();
  if (!t) return Math.round(actionMaxIntensity(action) * 0.6); // sensible default
  const pct = t.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pct) return clampToAction(action, (parseFloat(pct[1]) / 100) * actionMaxIntensity(action));
  const num = t.match(/-?\d+(?:\.\d+)?/);
  if (num) return clampToAction(action, parseFloat(num[0]));
  return Math.round(actionMaxIntensity(action) * 0.6);
}

/** Peel any leading target tokens off a segment.
 *
 *  Accepts the explicit `@name` form (always, so a character can name a toy the
 *  app doesn't know about yet) and a bare `name` / `name:` prefix, which is only
 *  treated as a target when it isn't an action word and it actually resolves
 *  against the connected toys — so plain `vibrate 15` and `stroke 20-80` keep
 *  their existing meaning. Several targets may stack: `@lush @nora vibrate 10`. */
function splitLeadingTarget(
  seg: string,
  toys: ToyRef[],
): { targets: string[] | null; rest: string } {
  let s = seg.trim();
  const targets: string[] = [];
  for (;;) {
    // Quoted form first — unambiguous for any nickname.
    const quoted = s.match(/^@"([^"]+)"\s*:?\s*/);
    if (quoted) {
      targets.push(quoted[1].trim());
      s = s.slice(quoted[0].length);
      continue;
    }
    if (s.startsWith('@')) {
      // A nickname may contain spaces ("@Left Lush"), so take the LONGEST run
      // of words after the @ that actually names a toy. Matching only the first
      // word would leave "Lush" behind, and the bare-word rule below would then
      // read it as a second target — broadening the command to every Lush.
      const body = s.slice(1);
      const upToNextTarget = body.split('@')[0];
      const words = upToNextTarget.split(/\s+/).filter(Boolean);
      let taken = 0;
      for (let n = words.length; n >= 1; n--) {
        const candidate = words.slice(0, n).join(' ').replace(/[:,;]+$/, '');
        if (candidate && resolveTargetToken(candidate, toys).length > 0) {
          taken = n;
          break;
        }
      }
      // Nothing resolved: keep the first word as the (unresolvable) target so
      // the directive drives nothing rather than falling back to every toy.
      if (taken === 0) taken = 1;
      const token = words.slice(0, taken).join(' ').replace(/[:,;]+$/, '');
      targets.push(token);
      const consumed = body.indexOf(words[taken - 1]) + words[taken - 1].length;
      s = body.slice(consumed).replace(/^\s*:?\s*/, '');
      continue;
    }
    // Bare `name:` / `name ` forms are only considered before any explicit @
    // target, so an @-form can never accidentally pick up a trailing word.
    if (targets.length > 0) break;
    const colon = s.match(/^([a-z][a-z0-9 _-]*?)\s*:\s*/i);
    if (
      colon &&
      !SYNONYMS[colon[1].trim().toLowerCase()] &&
      resolveTargetToken(colon[1], toys).length > 0
    ) {
      targets.push(colon[1].trim());
      s = s.slice(colon[0].length);
      continue;
    }
    const word = s.match(/^([a-z][a-z0-9_-]*)\s+/i);
    if (
      word &&
      !SYNONYMS[word[1].toLowerCase()] &&
      resolveTargetToken(word[1], toys).length > 0
    ) {
      targets.push(word[1]);
      s = s.slice(word[0].length);
      continue;
    }
    break;
  }
  return { targets: targets.length ? targets : null, rest: s.trim() };
}

/** Parse one inner tag body (already stripped of the surrounding brackets)
 *  into a directive, or null if it names nothing controllable. */
function parseDirectiveBody(body: string, toys: ToyRef[]): LovenseDirective | null {
  const withDuration = parseDurationSuffix(body);
  const durationSec = withDuration.durationSec;
  const inner = withDuration.text.trim();
  if (!inner) return null;

  // Preset / pattern by name, optionally targeted ("@lush pulse").
  const head = splitLeadingTarget(inner, toys);
  const headLower = head.rest.toLowerCase();
  const presetMatch =
    headLower.match(/\b(?:preset|pattern)\s+(pulse|wave|fireworks|earthquake)\b/) ||
    headLower.match(/^\s*(pulse|wave|fireworks|earthquake)\s*$/);
  if (presetMatch) {
    return {
      kind: 'preset',
      name: presetMatch[1] as LovensePreset,
      targets: head.targets,
      durationSec,
    };
  }

  const segments = inner
    .split(/[,;&]|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const groups: TargetedActions[] = [];
  // `pending` collects target-only segments ("@lush and @nora vibrate 10"), so
  // the next segment that carries an action applies to all of them. Once
  // consumed the set becomes `sticky` and keeps applying to later untargeted
  // segments — "@solace thrusting 12, stroke 20-80" drives one toy with both.
  let pending: string[] = [];
  let sticky: string[] | null = null;

  const push = (targets: string[] | null, spec: FunctionActionSpec) => {
    const last = groups[groups.length - 1];
    const same =
      last &&
      ((last.targets === null && targets === null) ||
        (last.targets !== null &&
          targets !== null &&
          last.targets.length === targets.length &&
          last.targets.every((t, i) => t === targets[i])));
    if (same) last.actions.push(spec);
    else groups.push({ targets, actions: [spec] });
  };

  for (const seg of segments) {
    const { targets: tok, rest } = splitLeadingTarget(seg, toys);
    if (tok) pending.push(...tok);
    if (!rest) continue; // target-only segment — just accumulate

    // action optionally followed by =, :, or whitespace, then a value/range
    const m = rest.match(/^([a-z]+)\s*[:=]?\s*(.*)$/i);
    if (!m) continue;
    const word = m[1].toLowerCase();
    const value = m[2].trim();
    const action = SYNONYMS[word];
    if (!action) continue;

    let effective: string[] | null;
    if (pending.length) {
      effective = [...pending];
      sticky = [...pending];
      pending = [];
    } else {
      effective = sticky;
    }

    if (action === 'Stop') {
      push(effective, { action: 'Stop', intensity: 0 });
      continue;
    }

    // Stroke range: "stroke 20-80" (word "stroke" maps to Thrusting by default,
    // but an explicit range promotes it to the Stroke position action).
    const range = value.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (range && word === 'stroke') {
      const { min, max } = normalizeStrokeRange(
        parseInt(range[1], 10),
        parseInt(range[2], 10),
      );
      push(effective, { action: 'Stroke', intensity: 0, min, max });
      continue;
    }

    push(effective, { action, intensity: parseIntensityToken(action, value) });
  }

  if (groups.length === 0) return null;

  // A directive that only stops is its own kind — it bypasses the send throttle
  // and (when untargeted) reaches every pairing.
  if (groups.every((g) => g.actions.every((a) => a.action === 'Stop'))) {
    if (groups.some((g) => g.targets === null)) return { kind: 'stop', targets: null };
    return { kind: 'stop', targets: groups.flatMap((g) => g.targets ?? []) };
  }

  return { kind: 'function', groups, durationSec };
}

/** Extract every `[lovense: ...]` / `[toy: ...]` directive from a message, in
 *  order. Only fully-closed tags match, so a directive still being streamed
 *  (open bracket, no close yet) is safely ignored until complete.
 *
 *  `toys` is what makes bare toy names (`lush vibrate 15`) resolvable; without
 *  it only the explicit `@lush` form is recognized as a target. */
export function parseLovenseDirectives(text: string, toys: ToyRef[] = []): LovenseDirective[] {
  // Case-insensitive guard to match TAG_RE / hasLovenseTag / stripLovenseTags —
  // models routinely title-case bracketed markup (e.g. "[Lovense: ...]").
  if (!text || !/\[(?:lovense|toy)/i.test(text)) return [];
  const out: LovenseDirective[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) {
    const dir = parseDirectiveBody(m[1], toys);
    if (dir) out.push(dir);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Command planning: one directive -> the set of commands that drive every
// applicable toy at once
// ---------------------------------------------------------------------------

/** One command as the backend wants it: which pairing, which toys, what to run.
 *  `pairingId: null` + `toy: null` is the broadcast form (every paired app,
 *  every toy) — one request instead of N when nothing needs per-toy treatment. */
export interface PlannedCommand {
  pairingId: string | null;
  toy: string[] | null;
  actions: FunctionActionSpec[];
}

/** Per-toy user overrides, keyed by toy id. */
export interface ToyPref {
  enabled?: boolean;
  scale?: number;
}

export interface PlanOptions {
  /** Character/global intensity multiplier. */
  scale?: number;
  toyPrefs?: Record<string, ToyPref | undefined>;
  /** Drop actions a *recognized* toy doesn't have (default true) so a combo
   *  directive doesn't get the whole command rejected on a single-function toy. */
  filterByCapability?: boolean;
}

/** Apply an intensity multiplier, clamped to the action's ceiling. Stroke
 *  (a position range) and Stop have no intensity to scale. */
export function scaleActionSpec(spec: FunctionActionSpec, scale: number): FunctionActionSpec {
  if (spec.action === 'Stroke' || spec.action === 'Stop') return { ...spec };
  return { ...spec, intensity: clampToAction(spec.action, spec.intensity * scale) };
}

function sortActions(list: FunctionActionSpec[]): FunctionActionSpec[] {
  return [...list].sort(
    (a, b) => LOVENSE_ACTIONS.indexOf(a.action) - LOVENSE_ACTIONS.indexOf(b.action),
  );
}

/** Stable string for a composed action set — two toys sharing it share a command. */
function signature(list: FunctionActionSpec[]): string {
  return list
    .map((a) =>
      a.action === 'Stroke'
        ? `Stroke:${a.min ?? 0}-${a.max ?? 100}`
        : `${a.action}:${a.intensity}`,
    )
    .join(',');
}

function isEnabled(toy: ToyRef, prefs?: Record<string, ToyPref | undefined>): boolean {
  return prefs?.[toy.id]?.enabled !== false;
}

/** Turn a directive's targeted action groups into the minimum set of commands
 *  that drives every applicable toy simultaneously.
 *
 *  Per toy: later groups override an earlier value for the same function, a
 *  `Stop` wins outright, unsupported functions are dropped, and the per-toy plus
 *  character scales are applied. Toys that end up with an identical action set
 *  (on the same pairing) are then merged into one command. */
export function planFunctionCommands(
  groups: TargetedActions[],
  toys: ToyRef[],
  opts: PlanOptions = {},
): PlannedCommand[] {
  const scale = opts.scale ?? 1;
  const filter = opts.filterByCapability !== false;

  // No toy inventory yet (session not polled) — broadcast the merged union and
  // let the toys sort out what they can do.
  if (toys.length === 0) {
    const merged = new Map<LovenseAction, FunctionActionSpec>();
    for (const g of groups) for (const a of g.actions) merged.set(a.action, scaleActionSpec(a, scale));
    const list = merged.has('Stop') ? [merged.get('Stop')!] : sortActions([...merged.values()]);
    return list.length ? [{ pairingId: null, toy: null, actions: list }] : [];
  }

  const perToy = new Map<string, { toy: ToyRef; actions: Map<LovenseAction, FunctionActionSpec> }>();
  for (const g of groups) {
    for (const toy of resolveTargets(g.targets, toys)) {
      if (!isEnabled(toy, opts.toyPrefs)) continue;
      const cap = capabilitiesForToy(toy.name);
      const key = `${toy.pairingId}:${toy.id}`;
      let entry = perToy.get(key);
      if (!entry) {
        entry = { toy, actions: new Map() };
        perToy.set(key, entry);
      }
      const toyScale = opts.toyPrefs?.[toy.id]?.scale ?? 1;
      for (const a of g.actions) {
        const universal = a.action === 'Stop' || a.action === 'All';
        if (!universal && filter && cap.known && !cap.actions.includes(a.action)) continue;
        entry.actions.set(a.action, scaleActionSpec(a, scale * toyScale));
      }
    }
  }

  const buckets = new Map<string, { pairingId: string; actions: FunctionActionSpec[]; ids: string[] }>();
  for (const { toy, actions } of perToy.values()) {
    const list = actions.has('Stop') ? [actions.get('Stop')!] : sortActions([...actions.values()]);
    if (list.length === 0) continue;
    const sig = `${toy.pairingId}|${signature(list)}`;
    const bucket = buckets.get(sig);
    if (bucket) bucket.ids.push(toy.id);
    else buckets.set(sig, { pairingId: toy.pairingId, actions: list, ids: [toy.id] });
  }

  // Every toy the user has, running the same thing → one broadcast command.
  //
  // Only ever collapse a genuinely UNtargeted request. A broadcast is sent as a
  // comma-joined uid list, which makes Lovense ignore `toy` and drive every toy
  // of every paired app — including toys we don't know about, such as those on
  // a pairing that completed before its app reported a toy list. Collapsing a
  // request that named its targets would therefore drive toys the user never
  // asked for.
  const untargeted = groups.every((g) => g.targets === null || g.targets.length === 0);
  const covered = [...buckets.values()].reduce((n, b) => n + b.ids.length, 0);
  if (
    untargeted &&
    buckets.size === 1 &&
    covered === toys.length &&
    toys.every((t) => isEnabled(t, opts.toyPrefs))
  ) {
    return [{ pairingId: null, toy: null, actions: [...buckets.values()][0].actions }];
  }

  return [...buckets.values()].map((b) => ({ pairingId: b.pairingId, toy: b.ids, actions: b.actions }));
}

/** Which (pairing, toys) a non-Function command (Preset / Stop) should reach.
 *  `ignorePrefs` is set for Stop — a toy the user muted still has to be stoppable. */
export function planTargets(
  targets: string[] | null,
  toys: ToyRef[],
  opts: { toyPrefs?: Record<string, ToyPref | undefined>; ignorePrefs?: boolean } = {},
): { pairingId: string | null; toy: string[] | null }[] {
  if (toys.length === 0) return [{ pairingId: null, toy: null }];
  const hit = resolveTargets(targets, toys).filter(
    (t) => opts.ignorePrefs || isEnabled(t, opts.toyPrefs),
  );
  if (hit.length === 0) return [];
  // As in planFunctionCommands: only an untargeted request may collapse to the
  // broadcast form, which reaches toys beyond the ones we can enumerate.
  const untargeted = !targets || targets.length === 0;
  const all = opts.ignorePrefs ? toys : toys.filter((t) => isEnabled(t, opts.toyPrefs));
  if (untargeted && hit.length === toys.length && all.length === toys.length) {
    return [{ pairingId: null, toy: null }];
  }
  const byPairing = new Map<string, string[]>();
  for (const t of hit) {
    const list = byPairing.get(t.pairingId);
    if (list) list.push(t.id);
    else byPairing.set(t.pairingId, [t.id]);
  }
  return [...byPairing.entries()].map(([pairingId, toy]) => ({ pairingId, toy }));
}

/** True if the text contains at least one control tag (open or closed) — used
 *  to decide whether a character is "trying" to drive the toy. */
export function hasLovenseTag(text: string): boolean {
  return /\[(?:lovense|toy)\s*:/i.test(text);
}

/** Remove control tags from text for display (when tag-hiding is enabled). */
export function stripLovenseTags(text: string): string {
  return text.replace(TAG_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n');
}

/** Mid-scale intensity for an action, used when composing example directives. */
function midIntensity(a: LovenseAction): number {
  return a === 'Pump' || a === 'Depth' ? 3 : 15;
}

/** The functions worth naming for a toy (drop the meta actions). */
function usableActionsFor(toy: ToyRef): LovenseAction[] {
  return capabilitiesForToy(toy.name).actions.filter((a) => a !== 'Stop' && a !== 'All');
}

/** A representative example directive.
 *
 *  With several toys it demonstrates `@handle` targeting — that's the thing
 *  worth teaching, and it shows two toys running at once. With one toy it
 *  demonstrates a multi-function combo where the toy supports one (auto-strokers
 *  move via thrust + depth/stroke together). */
function exampleDirective(toys: ToyRef[], usable: LovenseAction[]): string {
  if (toys.length > 1) {
    const handles = assignToyHandles(toys);
    const parts = toys.slice(0, 2).map((toy, i) => {
      const caps = usableActionsFor(toy).filter((a) => a !== 'Stroke');
      const a = caps[0] ?? 'Vibrate';
      return `@${handles[i]} ${a.toLowerCase()} ${midIntensity(a)}`;
    });
    return `[lovense: ${parts.join(', ')}]`;
  }
  const has = (a: LovenseAction) => usable.includes(a);
  // Stroker-class toys: pair the movement functions.
  if (has('Thrusting') && has('Stroke')) return '[lovense: stroke 20-80, thrusting 12]';
  if (has('Thrusting') && has('Depth')) return '[lovense: thrusting 15, depth 3]';
  // Any two simple functions combine cleanly. (Stroke is excluded here — it
  // needs a range and must pair with Thrusting, handled above.)
  const simple = usable.filter((a) => a !== 'Stroke');
  if (simple.length >= 2) {
    const [a, b] = simple;
    return `[lovense: ${a.toLowerCase()} ${midIntensity(a)}, ${b.toLowerCase()} ${midIntensity(b)}]`;
  }
  const only = simple[0] ?? usable[0] ?? 'Vibrate';
  return `[lovense: ${only.toLowerCase()} ${midIntensity(only)} for 5s]`;
}

/** One line naming every connected toy and what it can do, e.g.
 *  `@lush (Lush): Vibrate. @solace (Solace Pro): Thrusting, Stroke, Depth.` */
export function describeToys(toys: ToyRef[]): string {
  const handles = assignToyHandles(toys);
  return toys
    .map((toy, i) => {
      const label = toy.nickname
        ? `${toy.nickname}, ${toyDisplayName(toy.name)}`
        : toyDisplayName(toy.name);
      const caps = usableActionsFor(toy);
      return `@${handles[i]} (${label}): ${caps.join(', ') || 'Vibrate'}`;
    })
    .join('. ');
}

/** The system instruction injected (opt-in, per character) to teach the model
 *  the directive syntax, which toys are connected, and what each one can do. */
export function buildAiControlInstruction(
  toys: ToyRef[],
  fallbackActions: LovenseAction[],
  defaultDurationSec: number,
  hidden: boolean,
): string {
  const union = toys.length ? unionCapabilities(toys.map((t) => t.name)) : fallbackActions;
  const usable = union.filter((a) => a !== 'Stop' && a !== 'All');
  const list = usable.length ? usable.join(', ') : 'Vibrate';
  const example = exampleDirective(toys, usable);
  const visibility = hidden
    ? 'These directives are removed before the user sees your message.'
    : 'Keep directives short so they read naturally in the scene.';
  const duration = `${Math.max(1, defaultDurationSec)}s`;
  const strokeHint = usable.includes('Stroke')
    ? ` Stroke takes a position range 0–100, must be paired with Thrusting, and the two numbers must be at least ${STROKE_MIN_SPAN} apart — e.g. "[lovense: stroke 20-80, thrusting 12]".`
    : '';
  // Only worth teaching combos when there is more than one function to combine.
  const comboHint =
    usable.filter((a) => a !== 'Stroke').length >= 2 ||
    (usable.includes('Stroke') && usable.includes('Thrusting'))
      ? ' List several functions in one directive, separated by commas, to run them at the same time (e.g. drive an auto-stroker with thrust, depth and stroke at once). A new directive replaces the previous one, so keep everything that should run simultaneously in the same directive.'
      : '';

  if (toys.length > 1) {
    return [
      '[Interactive toy control]',
      `${toys.length} Lovense toys are connected. When it fits the scene, you may drive them by embedding an inline directive such as ${example}.`,
      `Connected toys — ${describeToys(toys)}.`,
      'Prefix a function with a toy handle (@name) to target that toy; the prefix keeps applying to the functions after it until another handle appears. A function with no prefix goes to every toy that supports it, so you can drive different toys with different functions in a single directive.',
      `Intensity is 0–20 (Pump/Depth 0–3).${strokeHint}${comboHint}`,
      'Use "[lovense: stop]" to stop everything, or "[lovense: @name stop]" to stop one toy.',
      `If you omit a duration it runs for ${duration}. Only use each toy's listed functions. ${visibility}`,
    ].join(' ');
  }

  return [
    '[Interactive toy control]',
    `A Lovense toy is connected. When it fits the scene, you may drive it by embedding an inline directive such as ${example}.`,
    `Supported functions on the current toy: ${list} (intensity 0–20; Pump/Depth 0–3).${strokeHint}${comboHint} Use "[lovense: stop]" to stop.`,
    `If you omit a duration it runs for ${duration}. Only use the listed functions. ${visibility}`,
  ].join(' ');
}
