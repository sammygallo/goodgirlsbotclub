// ---------------------------------------------------------------------------
// Lovense domain logic — pure, dependency-free helpers shared by the store,
// the settings panel, the in-chat quick control, and the /lovense command.
//
// Covers: the Standard-API Function action vocabulary + ranges, a per-toy
// capability table (so the UI only offers functions a toy actually has), and
// the parser/instruction for AI-driven control (characters embedding
// `[lovense: ...]` directives in their replies).
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
// AI-driven control: parse `[lovense: ...]` directives out of a message
// ---------------------------------------------------------------------------

export interface FunctionActionSpec {
  action: LovenseAction;
  intensity: number;
  /** Stroke range (0–100). Only set when action === 'Stroke'. */
  min?: number;
  max?: number;
}

export type LovenseDirective =
  | { kind: 'function'; actions: FunctionActionSpec[]; durationSec?: number }
  | { kind: 'preset'; name: LovensePreset; durationSec?: number }
  | { kind: 'stop' };

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

/** Parse one inner tag body (already stripped of the surrounding brackets)
 *  into a directive, or null if it names nothing controllable. */
function parseDirectiveBody(body: string): LovenseDirective | null {
  const withDuration = parseDurationSuffix(body);
  const durationSec = withDuration.durationSec;
  const inner = withDuration.text.trim();
  if (!inner) return null;

  const lower = inner.toLowerCase();

  // Preset / pattern by name.
  const presetMatch = lower.match(/\b(?:preset|pattern)\s+(pulse|wave|fireworks|earthquake)\b/)
    || lower.match(/^\s*(pulse|wave|fireworks|earthquake)\s*$/);
  if (presetMatch) {
    return { kind: 'preset', name: presetMatch[1] as LovensePreset, durationSec };
  }

  const segments = inner
    .split(/[,;&]|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const actions: FunctionActionSpec[] = [];
  let sawStop = false;

  for (const seg of segments) {
    // action optionally followed by =, :, or whitespace, then a value/range
    const m = seg.match(/^([a-z]+)\s*[:=]?\s*(.*)$/i);
    if (!m) continue;
    const word = m[1].toLowerCase();
    const rest = m[2].trim();
    const action = SYNONYMS[word];
    if (!action) continue;

    if (action === 'Stop') {
      sawStop = true;
      continue;
    }

    // Stroke range: "stroke 20-80" (word "stroke" maps to Thrusting by default,
    // but an explicit range promotes it to the Stroke position action).
    const range = rest.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (range && (word === 'stroke')) {
      let lo = clampToAction('Stroke', parseInt(range[1], 10));
      let hi = clampToAction('Stroke', parseInt(range[2], 10));
      if (lo > hi) [lo, hi] = [hi, lo];
      actions.push({ action: 'Stroke', intensity: 0, min: lo, max: hi });
      continue;
    }

    actions.push({ action, intensity: parseIntensityToken(action, rest) });
  }

  if (sawStop && actions.length === 0) return { kind: 'stop' };
  if (actions.length === 0) return null;
  return { kind: 'function', actions, durationSec };
}

/** Extract every `[lovense: ...]` / `[toy: ...]` directive from a message, in
 *  order. Only fully-closed tags match, so a directive still being streamed
 *  (open bracket, no close yet) is safely ignored until complete. */
export function parseLovenseDirectives(text: string): LovenseDirective[] {
  // Case-insensitive guard to match TAG_RE / hasLovenseTag / stripLovenseTags —
  // models routinely title-case bracketed markup (e.g. "[Lovense: ...]").
  if (!text || !/\[(?:lovense|toy)/i.test(text)) return [];
  const out: LovenseDirective[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) {
    const dir = parseDirectiveBody(m[1]);
    if (dir) out.push(dir);
  }
  return out;
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

/** The system instruction injected (opt-in, per character) to teach the model
 *  the directive syntax and which functions the connected toy supports. */
export function buildAiControlInstruction(
  actions: LovenseAction[],
  defaultDurationSec: number,
  hidden: boolean,
): string {
  const usable = actions.filter((a) => a !== 'Stop' && a !== 'All');
  const list = usable.length ? usable.join(', ') : 'Vibrate';
  const example = usable.includes('Vibrate')
    ? '[lovense: vibrate 15 for 5s]'
    : `[lovense: ${usable[0]?.toLowerCase() ?? 'vibrate'} 15 for 5s]`;
  const visibility = hidden
    ? 'These directives are removed before the user sees your message.'
    : 'Keep directives short so they read naturally in the scene.';
  const duration = `${Math.max(1, defaultDurationSec)}s`;
  const strokeHint = usable.includes('Stroke')
    ? ' Stroke takes a position range 0–100, e.g. "[lovense: stroke 20-80]".'
    : '';
  return [
    '[Interactive toy control]',
    `A Lovense toy is connected. When it fits the scene, you may drive it by embedding an inline directive such as ${example}.`,
    `Supported functions on the current toy: ${list} (intensity 0–20; Pump/Depth 0–3).${strokeHint} Use "[lovense: stop]" to stop.`,
    `If you omit a duration it runs for ${duration}. Only use the listed functions. ${visibility}`,
  ].join(' ');
}
