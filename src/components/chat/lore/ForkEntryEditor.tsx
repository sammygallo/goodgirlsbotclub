import { useState } from 'react';
import {
  useWorldInfoStore,
  type WorldInfoEntry,
  type WorldInfoPosition,
  type SelectiveLogic,
} from '../../../stores/worldInfoStore';
import { useChatLoreConfigStore } from '../../../stores/chatLoreConfigStore';
import { useAuthStore } from '../../../stores/authStore';
import { hashContent } from '../../../utils/worldInfoComposition';
import { diffLines } from '../../../utils/textDiff';
import { Button, Input, TextArea, ConfirmDialog } from '../../ui';

export interface ForkEntryEditorProps {
  chatFile: string;
  bookId: string;
  entryId: string;
  onClose: () => void;
}

// Stable fallback so the zustand selector never returns a fresh array
// reference (fresh `[]` per call destabilizes useSyncExternalStore — React #185).
const EMPTY_ENTRIES: WorldInfoEntry[] = [];

const POSITION_OPTIONS: { value: WorldInfoPosition; label: string }[] = [
  { value: 'before_char', label: 'Before Character' },
  { value: 'after_char', label: 'After Character' },
  { value: 'before_an', label: "Before Author's Note" },
  { value: 'after_an', label: "After Author's Note" },
  { value: 'at_depth', label: '@ Depth' },
];

const LOGIC_OPTIONS: { value: SelectiveLogic; label: string }[] = [
  { value: 'AND_ANY', label: 'AND ANY' },
  { value: 'AND_ALL', label: 'AND ALL' },
  { value: 'NOT_ANY', label: 'NOT ANY' },
  { value: 'NOT_ALL', label: 'NOT ALL' },
];

function parseCsv(s: string): string[] {
  return s
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

// Every field this editor can put in a fork's patch — id/createdAt/source/
// revisions are deliberately excluded (they're forced back to the base
// entry's own values when the overlay is applied, or aren't user-editable
// concepts for a fork at all). updatedAt is owned by upsertOverlay itself.
const OVERRIDABLE_FIELDS: (keyof WorldInfoEntry)[] = [
  'content',
  'comment',
  'keys',
  'enabled',
  'constant',
  'caseSensitive',
  'position',
  'depth',
  'order',
  'keysSecondary',
  'selective',
  'selectiveLogic',
  'scanDepth',
  'probability',
  'useProbability',
  'group',
  'groupOverride',
  'groupWeight',
  'preventRecursion',
  'excludeRecursion',
  'sticky',
  'cooldown',
  'delay',
  'critical',
  'category',
  'relatedIds',
];

function fieldDiffers(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a) !== JSON.stringify(b);
  }
  return a !== b;
}

/**
 * Only the fields whose value differs from `base` right now. This is
 * load-bearing: a patch that included unchanged fields would permanently
 * shadow any future edit to the base entry for those fields, even though
 * the author never meant to override them.
 *
 * `draft` comes out of buildDraft() with content/comment/keys/keysSecondary/
 * group already trimmed/re-parsed (parseCsv) — normalize base's copies of
 * those same fields the identical way before diffing, or an untouched field
 * that merely has incidental whitespace in the library (common on imported
 * entries) would look "changed" from normalization alone and get silently
 * baked into the patch, freezing that field against future base edits even
 * though the author never touched it.
 */
function buildPatch(
  draft: WorldInfoEntry,
  base: WorldInfoEntry
): Partial<WorldInfoEntry> {
  const normalizedBase: WorldInfoEntry = {
    ...base,
    content: base.content.trim(),
    comment: (base.comment ?? '').trim(),
    keys: parseCsv((base.keys ?? []).join(', ')),
    keysSecondary: parseCsv((base.keysSecondary ?? []).join(', ')),
    group: (base.group ?? '').trim(),
  };
  const patch: Partial<WorldInfoEntry> = {};
  for (const key of OVERRIDABLE_FIELDS) {
    if (fieldDiffers(draft[key], normalizedBase[key])) {
      (patch as Record<string, unknown>)[key] = draft[key];
    }
  }
  return patch;
}

/**
 * Per-chat fork editor for a single base entry. Reads the live base entry
 * and any existing overlay directly from the stores (rather than trusting
 * copies handed down by the parent) so a concurrent edit to the base entry
 * elsewhere is always reflected here — in the read-only base panel above the
 * form, and in the drift banner. The caller is expected to key this
 * component on `${bookId}:${entryId}` so switching targets remounts it
 * (fresh initial form state) instead of trying to reconcile in place.
 */
export function ForkEntryEditor({ chatFile, bookId, entryId, onClose }: ForkEntryEditorProps) {
  const base = useWorldInfoStore((s) =>
    s.books.find((b) => b.id === bookId)?.entries.find((e) => e.id === entryId)
  );
  const bookEntries = useWorldInfoStore(
    (s) => s.books.find((b) => b.id === bookId)?.entries ?? EMPTY_ENTRIES
  );
  const overlay = useChatLoreConfigStore((s) => s.configs[chatFile]?.overlays[entryId]);
  const upsertOverlay = useChatLoreConfigStore((s) => s.upsertOverlay);
  const removeOverlay = useChatLoreConfigStore((s) => s.removeOverlay);
  const currentHandle = useAuthStore((s) => s.currentUser?.handle) ?? '';

  // Seed initial form values ONCE (base + overlay.patch on top) — never
  // re-seeded on every base change, or an in-progress edit would get
  // clobbered the instant something else touched the base entry. The base
  // panel above and the drift banner stay live via the selectors above;
  // only the editable fields below are frozen at open time.
  const seed = { ...(base ?? ({} as WorldInfoEntry)), ...(overlay?.patch ?? {}) };

  const [content, setContent] = useState(seed.content ?? '');
  const [comment, setComment] = useState(seed.comment ?? '');
  const [keys, setKeys] = useState((seed.keys ?? []).join(', '));
  const [enabled, setEnabled] = useState(seed.enabled ?? true);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [constant, setConstant] = useState(seed.constant ?? false);
  const [caseSensitive, setCaseSensitive] = useState(seed.caseSensitive ?? false);
  const [critical, setCritical] = useState(seed.critical ?? false);
  const [position, setPosition] = useState<WorldInfoPosition>(seed.position ?? 'before_char');
  const [depth, setDepth] = useState(seed.depth ?? 4);
  const [order, setOrder] = useState(seed.order ?? 100);
  const [category, setCategory] = useState(seed.category ?? '');

  const [selective, setSelective] = useState(seed.selective ?? false);
  const [keysSecondary, setKeysSecondary] = useState((seed.keysSecondary ?? []).join(', '));
  const [selectiveLogic, setSelectiveLogic] = useState<SelectiveLogic>(
    seed.selectiveLogic ?? 'AND_ANY'
  );

  const [useScanDepthOverride, setUseScanDepthOverride] = useState(
    (seed.scanDepth ?? null) !== null
  );
  const [scanDepthOverride, setScanDepthOverride] = useState(seed.scanDepth ?? 4);

  const [useProbability, setUseProbability] = useState(seed.useProbability ?? false);
  const [probability, setProbability] = useState(seed.probability ?? 100);

  const [group, setGroup] = useState(seed.group ?? '');
  const [groupOverride, setGroupOverride] = useState(seed.groupOverride ?? false);
  const [groupWeight, setGroupWeight] = useState(seed.groupWeight ?? 100);

  const [preventRecursion, setPreventRecursion] = useState(seed.preventRecursion ?? false);
  const [excludeRecursion, setExcludeRecursion] = useState(seed.excludeRecursion ?? false);

  const [sticky, setSticky] = useState(seed.sticky ?? 0);
  const [cooldown, setCooldown] = useState(seed.cooldown ?? 0);
  const [delay, setDelay] = useState(seed.delay ?? 0);

  const [relatedIds, setRelatedIds] = useState<string[]>(seed.relatedIds ?? []);

  const [showDiff, setShowDiff] = useState(false);
  const [confirmAutoDiscard, setConfirmAutoDiscard] = useState(false);

  if (!base) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          This entry no longer exists in its source lorebook.
        </p>
        <Button variant="secondary" onClick={onClose} className="w-full">
          Back
        </Button>
      </div>
    );
  }

  const drifted = !!overlay && overlay.baseContentHash !== hashContent(base.content);
  // "This chat's current effective content" — base with the STORED overlay
  // patch applied, not the in-progress edits below.
  const effectiveContentForChat = overlay?.patch.content ?? base.content;

  const buildDraft = (): WorldInfoEntry => ({
    ...base,
    content: content.trim(),
    comment: comment.trim(),
    keys: parseCsv(keys),
    enabled,
    constant,
    caseSensitive,
    position,
    depth,
    order,
    keysSecondary: parseCsv(keysSecondary),
    selective,
    selectiveLogic,
    scanDepth: useScanDepthOverride ? scanDepthOverride : null,
    probability,
    useProbability,
    group: group.trim(),
    groupOverride,
    groupWeight,
    preventRecursion,
    excludeRecursion,
    sticky,
    cooldown,
    delay,
    critical,
    category,
    relatedIds,
  });

  const doDiscard = () => {
    removeOverlay(chatFile, entryId);
    onClose();
  };

  const handleSave = () => {
    const draft = buildDraft();
    const patch = buildPatch(draft, base);

    if (Object.keys(patch).length === 0) {
      if (overlay) {
        // Every field now matches the base again — equivalent to discarding
        // the fork outright. Confirm rather than silently deleting it.
        setConfirmAutoDiscard(true);
      } else {
        onClose();
      }
      return;
    }

    upsertOverlay(chatFile, {
      baseEntryId: entryId,
      baseBookId: bookId,
      patch,
      baseContentHash: hashContent(base.content),
      createdBy: currentHandle,
      createdAt: overlay?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      note: overlay?.note,
    });
    onClose();
  };

  const handleRebase = () => {
    if (!overlay) return;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { content: _droppedContent, ...rest } = overlay.patch;
    if (Object.keys(rest).length === 0) {
      // Content was the only thing overridden — nothing left to keep.
      removeOverlay(chatFile, entryId);
      onClose();
      return;
    }
    upsertOverlay(chatFile, {
      ...overlay,
      patch: rest,
      baseContentHash: hashContent(base.content),
      updatedAt: Date.now(),
    });
    // Reflect the adopted base content in the open form immediately.
    setContent(base.content);
  };

  const handleKeepMine = () => {
    if (!overlay) return;
    upsertOverlay(chatFile, {
      ...overlay,
      baseContentHash: hashContent(base.content),
      updatedAt: Date.now(),
    });
  };

  const otherEntries = bookEntries.filter((e) => e.id !== entryId);
  const toggleRelated = (id: string) => {
    setRelatedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const parsedKeys = parseCsv(keys);
  const canSave = content.trim().length > 0 && (constant || parsedKeys.length > 0);

  return (
    <div className="space-y-4">
      {/* Read-only base entry, always live */}
      <div className="p-3 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          Base entry (library — read only)
        </p>
        <p className="text-sm font-medium text-[var(--color-text-primary)] truncate">
          {base.comment || base.keys[0] || base.id}
        </p>
        <p className="text-xs text-[var(--color-text-secondary)] line-clamp-3">{base.content}</p>
      </div>

      {drifted && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 space-y-2">
          <p className="text-xs text-amber-400">
            The base entry changed since you forked it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowDiff((v) => !v)}>
              {showDiff ? 'Hide diff' : 'View diff'}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleRebase}>
              Rebase
            </Button>
            <Button variant="ghost" size="sm" onClick={handleKeepMine}>
              Keep mine
            </Button>
          </div>
          {showDiff && (
            <div className="max-h-48 space-y-0.5 overflow-y-auto overflow-x-auto rounded bg-[var(--color-bg-tertiary)] p-2 font-mono text-xs">
              {diffLines(base.content, effectiveContentForChat).map((line, i) => (
                <div
                  key={i}
                  className={
                    line.type === 'add'
                      ? 'text-green-400'
                      : line.type === 'del'
                        ? 'text-red-400 line-through'
                        : 'text-[var(--color-text-secondary)]'
                  }
                >
                  <span className="select-none">
                    {line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  '}
                  </span>
                  {line.text || ' '}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Primary fields */}
      <Input
        label="Keywords (comma-separated)"
        value={keys}
        onChange={(e) => setKeys(e.target.value)}
        disabled={constant}
      />
      <TextArea
        label="Content *"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={6}
        required
      />
      <Input
        label="Comment (optional)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="w-4 h-4 accent-[var(--color-primary)]"
        />
        Enabled
      </label>

      {/* Advanced disclosure — every other overridable WorldInfoEntry field */}
      <details
        className="pt-2 border-t border-[var(--color-border)]"
        open={showAdvanced}
        onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
          Advanced
        </summary>

        <div className="mt-3 space-y-3">
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
            <input
              type="checkbox"
              checked={constant}
              onChange={(e) => setConstant(e.target.checked)}
              className="w-4 h-4 accent-[var(--color-primary)]"
            />
            Constant (always inject, ignore keywords)
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
            <input
              type="checkbox"
              checked={critical}
              onChange={(e) => setCritical(e.target.checked)}
              className="w-4 h-4 accent-[var(--color-primary)]"
            />
            Critical
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
              disabled={constant}
              className="w-4 h-4 accent-[var(--color-primary)]"
            />
            Case-sensitive matching
          </label>

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              Category
            </label>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
              Position
            </label>
            <select
              value={position}
              onChange={(e) => setPosition(e.target.value as WorldInfoPosition)}
              className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            >
              {POSITION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {position === 'at_depth' && (
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                  Depth
                </label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={depth}
                  onChange={(e) => setDepth(Number(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                />
              </div>
            )}
            <div className={position === 'at_depth' ? '' : 'col-span-2'}>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Order
              </label>
              <input
                type="number"
                min={0}
                max={10000}
                value={order}
                onChange={(e) => setOrder(Number(e.target.value) || 0)}
                className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              />
            </div>
          </div>

          {!constant && (
            <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
              <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={selective}
                  onChange={(e) => setSelective(e.target.checked)}
                  className="w-4 h-4 accent-[var(--color-primary)]"
                />
                Use secondary keys
              </label>
              {selective && (
                <>
                  <Input
                    label="Secondary keys (comma-separated)"
                    value={keysSecondary}
                    onChange={(e) => setKeysSecondary(e.target.value)}
                  />
                  <select
                    value={selectiveLogic}
                    onChange={(e) => setSelectiveLogic(e.target.value as SelectiveLogic)}
                    className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                  >
                    {LOGIC_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          )}

          {!constant && (
            <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
              <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={useScanDepthOverride}
                  onChange={(e) => setUseScanDepthOverride(e.target.checked)}
                  className="w-4 h-4 accent-[var(--color-primary)]"
                />
                Override scan depth
              </label>
              {useScanDepthOverride && (
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={scanDepthOverride}
                  onChange={(e) => setScanDepthOverride(Number(e.target.value) || 1)}
                  className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                />
              )}
            </div>
          )}

          <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
            <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
              <input
                type="checkbox"
                checked={useProbability}
                onChange={(e) => setUseProbability(e.target.checked)}
                className="w-4 h-4 accent-[var(--color-primary)]"
              />
              Use probability
            </label>
            {useProbability && (
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={probability}
                  onChange={(e) => setProbability(Number(e.target.value))}
                  className="flex-1 accent-[var(--color-primary)]"
                />
                <span className="text-xs tabular-nums text-[var(--color-text-secondary)]">
                  {probability}%
                </span>
              </div>
            )}
          </div>

          <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
            <Input
              label="Group name (optional)"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            />
            {group.trim().length > 0 && (
              <div className="grid grid-cols-2 gap-3 items-end">
                <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={groupOverride}
                    onChange={(e) => setGroupOverride(e.target.checked)}
                    className="w-4 h-4 accent-[var(--color-primary)]"
                  />
                  Override
                </label>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                    Weight
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={groupWeight}
                    onChange={(e) => setGroupWeight(Number(e.target.value) || 1)}
                    className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
            <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
              <input
                type="checkbox"
                checked={preventRecursion}
                onChange={(e) => setPreventRecursion(e.target.checked)}
                className="w-4 h-4 accent-[var(--color-primary)]"
              />
              Prevent recursion
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
              <input
                type="checkbox"
                checked={excludeRecursion}
                onChange={(e) => setExcludeRecursion(e.target.checked)}
                className="w-4 h-4 accent-[var(--color-primary)]"
              />
              Exclude from recursion
            </label>
          </div>

          <div className="grid grid-cols-3 gap-3 pt-2 border-t border-[var(--color-border)]">
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Sticky
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={sticky}
                onChange={(e) => setSticky(Math.max(0, Number(e.target.value) || 0))}
                className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Cooldown
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={cooldown}
                onChange={(e) => setCooldown(Math.max(0, Number(e.target.value) || 0))}
                className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                Delay
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={delay}
                onChange={(e) => setDelay(Math.max(0, Number(e.target.value) || 0))}
                className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              />
            </div>
          </div>

          <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
              Related entries
            </h3>
            {otherEntries.length === 0 ? (
              <p className="text-xs text-[var(--color-text-secondary)] italic">
                No other entries in this book.
              </p>
            ) : (
              <div className="max-h-40 overflow-y-auto space-y-1 rounded-lg border border-[var(--color-border)] p-2">
                {otherEntries.map((e) => (
                  <label
                    key={e.id}
                    className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={relatedIds.includes(e.id)}
                      onChange={() => toggleRelated(e.id)}
                      className="w-4 h-4 flex-shrink-0 accent-[var(--color-primary)]"
                    />
                    <span className="min-w-0 truncate">{e.comment || e.keys[0] || e.id}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </details>

      <div className="flex gap-3 pt-4 border-t border-[var(--color-border)]">
        <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!canSave}
          onClick={handleSave}
          className="flex-1"
        >
          Save fork
        </Button>
      </div>

      <ConfirmDialog
        isOpen={confirmAutoDiscard}
        onClose={() => setConfirmAutoDiscard(false)}
        onConfirm={doDiscard}
        title="Discard this fork?"
        message="Every field now matches the base entry again, so there's nothing left to fork — saving will discard this chat's fork entirely."
        confirmLabel="Discard fork"
        danger
      />
    </div>
  );
}
