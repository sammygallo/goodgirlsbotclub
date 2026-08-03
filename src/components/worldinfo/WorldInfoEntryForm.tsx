import { useEffect, useMemo, useState } from 'react';
import {
  useWorldInfoStore,
  WI_CATEGORIES,
  humanizeCategory,
  type WorldInfoEntry,
  type WorldInfoPosition,
  type SelectiveLogic,
} from '../../stores/worldInfoStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { profileForProvider } from '../../utils/tokenizer';
import { lintDraftInBook, type LintSeverity } from '../../utils/lorebookLint';
import { Button, Input, TextArea } from '../ui';

interface WorldInfoEntryFormProps {
  bookId: string;
  entry: WorldInfoEntry | null; // null = creating new
  onClose: () => void;
}

const POSITION_OPTIONS: { value: WorldInfoPosition; label: string; hint: string }[] = [
  { value: 'before_char', label: 'Before Character', hint: 'Injected before character description' },
  { value: 'after_char', label: 'After Character', hint: "Injected after character description" },
  { value: 'before_an', label: "Before Author's Note", hint: 'Injected before auxiliary prompt' },
  { value: 'after_an', label: "After Author's Note", hint: 'Injected after post-history instructions' },
  { value: 'at_depth', label: '@ Depth', hint: 'Injected at a specific depth in the chat' },
];

const LOGIC_OPTIONS: { value: SelectiveLogic; label: string; hint: string }[] = [
  { value: 'AND_ANY', label: 'AND ANY', hint: 'Primary matches AND at least one secondary matches' },
  { value: 'AND_ALL', label: 'AND ALL', hint: 'Primary matches AND every secondary matches' },
  { value: 'NOT_ANY', label: 'NOT ANY', hint: 'Primary matches AND no secondary matches' },
  { value: 'NOT_ALL', label: 'NOT ALL', hint: 'Primary matches AND at least one secondary is missing' },
];

// Stable fallback so the zustand selector never returns a fresh array
// reference (fresh `[]` per call destabilizes useSyncExternalStore — React #185).
const EMPTY_ENTRIES: WorldInfoEntry[] = [];

// Lint findings are advisory — they never block saving, so severity only
// drives colour. Errors mean the entry can never fire.
const LINT_SEVERITY_STYLES: Record<LintSeverity, { text: string; dot: string; label: string }> = {
  error: { text: 'text-red-400', dot: 'bg-red-400', label: 'Never fires' },
  warning: { text: 'text-amber-400', dot: 'bg-amber-400', label: 'Check' },
  info: {
    text: 'text-[var(--color-text-secondary)]',
    dot: 'bg-[var(--color-text-secondary)]',
    label: 'Note',
  },
};

export function WorldInfoEntryForm({ bookId, entry, onClose }: WorldInfoEntryFormProps) {
  const { createEntry, updateEntry } = useWorldInfoStore();
  const bookEntries = useWorldInfoStore(
    (s) => s.books.find((b) => b.id === bookId)?.entries ?? EMPTY_ENTRIES
  );

  const [keys, setKeys] = useState('');
  const [content, setContent] = useState('');
  const [comment, setComment] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [constant, setConstant] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [position, setPosition] = useState<WorldInfoPosition>('before_char');
  const [depth, setDepth] = useState(4);
  const [order, setOrder] = useState(100);

  // Secondary keys + selective logic
  const [selective, setSelective] = useState(false);
  const [keysSecondary, setKeysSecondary] = useState('');
  const [selectiveLogic, setSelectiveLogic] = useState<SelectiveLogic>('AND_ANY');

  // Scan depth override
  const [useScanDepthOverride, setUseScanDepthOverride] = useState(false);
  const [scanDepthOverride, setScanDepthOverride] = useState(4);

  // Probability
  const [useProbability, setUseProbability] = useState(false);
  const [probability, setProbability] = useState(100);

  // Grouping
  const [group, setGroup] = useState('');
  const [groupOverride, setGroupOverride] = useState(false);
  const [groupWeight, setGroupWeight] = useState(100);

  // Recursion
  const [preventRecursion, setPreventRecursion] = useState(false);
  const [excludeRecursion, setExcludeRecursion] = useState(false);

  // Timed effects
  const [sticky, setSticky] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const [delay, setDelay] = useState(0);

  // Continuity & linking
  const [critical, setCritical] = useState(false);
  const [category, setCategory] = useState('');
  const [relatedIds, setRelatedIds] = useState<string[]>([]);

  useEffect(() => {
    if (entry) {
      setKeys(entry.keys.join(', '));
      setContent(entry.content);
      setComment(entry.comment);
      setEnabled(entry.enabled);
      setConstant(entry.constant);
      setCaseSensitive(entry.caseSensitive);
      setPosition(entry.position);
      setDepth(entry.depth);
      setOrder(entry.order);
      setSelective(entry.selective);
      setKeysSecondary(entry.keysSecondary.join(', '));
      setSelectiveLogic(entry.selectiveLogic);
      setUseScanDepthOverride(entry.scanDepth !== null);
      setScanDepthOverride(entry.scanDepth ?? 4);
      setUseProbability(entry.useProbability);
      setProbability(entry.probability);
      setGroup(entry.group);
      setGroupOverride(entry.groupOverride);
      setGroupWeight(entry.groupWeight);
      setPreventRecursion(entry.preventRecursion);
      setExcludeRecursion(entry.excludeRecursion);
      setSticky(entry.sticky);
      setCooldown(entry.cooldown);
      setDelay(entry.delay);
      setCritical(entry.critical);
      setCategory(entry.category);
      setRelatedIds(entry.relatedIds);
    } else {
      setKeys('');
      setContent('');
      setComment('');
      setEnabled(true);
      setConstant(false);
      setCaseSensitive(false);
      setPosition('before_char');
      setDepth(4);
      setOrder(100);
      setSelective(false);
      setKeysSecondary('');
      setSelectiveLogic('AND_ANY');
      setUseScanDepthOverride(false);
      setScanDepthOverride(4);
      setUseProbability(false);
      setProbability(100);
      setGroup('');
      setGroupOverride(false);
      setGroupWeight(100);
      setPreventRecursion(false);
      setExcludeRecursion(false);
      setSticky(0);
      setCooldown(0);
      setDelay(0);
      setCritical(false);
      setCategory('');
      setRelatedIds([]);
    }
  }, [entry]);

  const parsedKeys = keys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  // Single source of truth for "what would be saved". The submit path writes
  // this straight to the store, and the Entry check panel lints it, so the
  // advice always describes the entry the author is about to save.
  // Keyed on the raw comma strings, not the parsed arrays — the parsed arrays
  // are fresh every render and would defeat the memo.
  const draftEntry = useMemo<WorldInfoEntry>(
    () => ({
      id: entry?.id ?? 'draft',
      keys: keys
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
      content: content.trim(),
      comment: comment.trim(),
      enabled,
      constant,
      caseSensitive,
      position,
      depth,
      order,
      keysSecondary: keysSecondary
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
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
      // Timestamps are owned by the store; they exist here only so the draft
      // is a complete WorldInfoEntry for the linter, and are stripped on save.
      createdAt: entry?.createdAt ?? 0,
      updatedAt: entry?.updatedAt ?? 0,
    }),
    [
      entry?.id,
      entry?.createdAt,
      entry?.updatedAt,
      keys,
      content,
      comment,
      enabled,
      constant,
      caseSensitive,
      position,
      depth,
      order,
      keysSecondary,
      selective,
      selectiveLogic,
      useScanDepthOverride,
      scanDepthOverride,
      probability,
      useProbability,
      group,
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
    ]
  );

  const activeProvider = useSettingsStore((s) => s.activeProvider);
  // Linted against the whole book, not in isolation — the cross-entry rules
  // (near-duplicate bodies, related links that no longer resolve) are exactly
  // the ones the list badges and the health panel report, and a panel that
  // said "No issues found" for a row badged CHECK sent authors looking for a
  // problem the editor refused to name.
  const findings = useMemo(
    () =>
      lintDraftInBook(
        draftEntry,
        bookEntries,
        profileForProvider(activeProvider || '')
      ),
    [draftEntry, bookEntries, activeProvider]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Stop propagation so the submit event doesn't bubble through the React portal
    // tree to CharacterEdit's outer form, which would save + close the character editor.
    e.stopPropagation();
    if (!content.trim()) return;
    if (!constant && parsedKeys.length === 0) return;

    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...data } = draftEntry;

    if (entry) {
      updateEntry(bookId, entry.id, data);
    } else {
      createEntry(bookId, data);
    }
    onClose();
  };

  const canSubmit = content.trim().length > 0 && (constant || parsedKeys.length > 0);

  // Category stays free-form so imports never lose data — surface any
  // nonstandard value (from the saved entry or current state) as an option.
  const extraCategories = Array.from(
    new Set(
      [entry?.category ?? '', category].filter(
        (c) => c && !(WI_CATEGORIES as readonly string[]).includes(c)
      )
    )
  );

  // Candidates for explicit related-entry links: every OTHER entry in this book.
  const otherEntries = bookEntries.filter((e) => e.id !== entry?.id);

  const toggleRelated = (id: string) => {
    setRelatedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Input
        label="Keywords (comma-separated)"
        placeholder="e.g. dragon, wyrm, drake"
        value={keys}
        onChange={(e) => setKeys(e.target.value)}
        disabled={constant}
        autoFocus={!entry}
      />
      <p className="-mt-3 text-xs text-[var(--color-text-secondary)]">
        {constant
          ? 'Constant entries activate on every generation; keywords are ignored.'
          : 'Activates when ANY keyword appears. Wrap a key in /slashes/flags to use regex.'}
      </p>

      <TextArea
        label="Content *"
        placeholder="Lore content to inject into the prompt when triggered. Supports {{char}}, {{user}}, etc."
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={6}
        required
      />

      <Input
        label="Comment (optional)"
        placeholder="Displayed in the UI only"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />

      <div>
        <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
          Category
        </label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
        >
          <option value="">No category</option>
          {WI_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {humanizeCategory(cat)}
            </option>
          ))}
          {extraCategories.map((cat) => (
            <option key={cat} value={cat}>
              {humanizeCategory(cat)}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
          Authoring tag for organizing lore. Does not affect matching.
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1.5">
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
        <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
          {POSITION_OPTIONS.find((o) => o.value === position)?.hint}
        </p>
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
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
            Lower order is injected first and survives token-budget trimming.
            Constant and Critical entries are never trimmed at all.
          </p>
        </div>
      </div>

      <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
        <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="w-4 h-4 accent-[var(--color-primary)]"
          />
          Enabled
        </label>
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
        <p className="-mt-1 pl-6 text-xs text-[var(--color-text-secondary)]">
          Hard continuity fact — never evicted by the token budget, and only
          real chat text can trigger it (other entries&apos; text can&apos;t).
        </p>
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
      </div>

      {/* Secondary keys */}
      {!constant && (
        <div className="space-y-2 pt-3 border-t border-[var(--color-border)]">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
            Secondary Keys
          </h3>
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
                placeholder="e.g. fire, ice"
                value={keysSecondary}
                onChange={(e) => setKeysSecondary(e.target.value)}
              />
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                  Logic
                </label>
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
                <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                  {LOGIC_OPTIONS.find((o) => o.value === selectiveLogic)?.hint}
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* Scan depth override */}
      {!constant && (
        <div className="space-y-2 pt-3 border-t border-[var(--color-border)]">
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
            <div>
              <input
                type="number"
                min={1}
                max={50}
                value={scanDepthOverride}
                onChange={(e) => setScanDepthOverride(Number(e.target.value) || 1)}
                className="w-full px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
              />
              <p className="mt-1 text-xs text-[var(--color-text-secondary)]">
                Scan this many trailing messages instead of the global default.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Probability */}
      <div className="space-y-2 pt-3 border-t border-[var(--color-border)]">
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
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-[var(--color-text-secondary)]">
                Probability
              </label>
              <span className="text-xs tabular-nums text-[var(--color-text-secondary)]">
                {probability}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={probability}
              onChange={(e) => setProbability(Number(e.target.value))}
              className="w-full accent-[var(--color-primary)]"
            />
          </div>
        )}
      </div>

      {/* Grouping */}
      <div className="space-y-2 pt-3 border-t border-[var(--color-border)]">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          Inclusion Group
        </h3>
        <Input
          label="Group name (optional)"
          placeholder="Entries in the same group compete"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        />
        {group.trim().length > 0 && (
          <>
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
            <p className="text-xs text-[var(--color-text-secondary)]">
              Equal weights pick a deterministic winner (lowest Order, then most
              matched keys). Set different weights only when you want a random
              draw.
            </p>
          </>
        )}
      </div>

      {/* Related entries */}
      <div className="space-y-2 pt-3 border-t border-[var(--color-border)]">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          Related entries
        </h3>
        <p className="text-xs text-[var(--color-text-secondary)]">
          Always inject these entries whenever this one fires — an explicit
          link that bypasses their own keywords and group competition.
        </p>
        {otherEntries.length === 0 ? (
          <p className="text-xs text-[var(--color-text-secondary)] italic">
            No other entries in this book yet.
          </p>
        ) : (
          <div className="max-h-48 overflow-y-auto space-y-1 rounded-lg border border-[var(--color-border)] p-2">
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
                <span className="min-w-0 truncate">
                  {e.comment || e.keys[0] || e.id}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Recursion */}
      <div className="space-y-2 pt-3 border-t border-[var(--color-border)]">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          Recursion
        </h3>
        <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
          <input
            type="checkbox"
            checked={preventRecursion}
            onChange={(e) => setPreventRecursion(e.target.checked)}
            className="w-4 h-4 accent-[var(--color-primary)]"
          />
          Prevent recursion (content won't trigger other entries)
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)] cursor-pointer">
          <input
            type="checkbox"
            checked={excludeRecursion}
            onChange={(e) => setExcludeRecursion(e.target.checked)}
            className="w-4 h-4 accent-[var(--color-primary)]"
          />
          Exclude from recursion (other entries can't trigger this one)
        </label>
        <p className="text-xs text-[var(--color-text-secondary)]">
          Critical entries are always excluded from being triggered by
          recursion — only real chat text can activate them.
        </p>
      </div>

      {/* Timed Effects */}
      <div className="space-y-3 pt-3 border-t border-[var(--color-border)]">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          Timed Effects
        </h3>
        <div className="grid grid-cols-3 gap-3">
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
        <p className="text-xs text-[var(--color-text-secondary)]">
          <span className="font-medium">Sticky:</span> turns to stay active after trigger.{' '}
          <span className="font-medium">Cooldown:</span> turns to wait before re-triggering.{' '}
          <span className="font-medium">Delay:</span> turns to wait before first activation. 0 = off.
        </p>
      </div>

      {/* Entry check — advisory only, never blocks saving */}
      <div className="space-y-2 pt-3 border-t border-[var(--color-border)]">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          Entry check
        </h3>
        {findings.length === 0 ? (
          <p className="text-xs text-[var(--color-text-secondary)]">
            No issues found.
          </p>
        ) : (
          <ul className="space-y-1">
            {findings.map((f, i) => {
              const style = LINT_SEVERITY_STYLES[f.severity];
              return (
                <li
                  key={`${f.code}-${i}`}
                  className={`flex items-start gap-2 text-xs ${style.text}`}
                >
                  <span
                    className={`mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0 ${style.dot}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{style.label}:</span> {f.message}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex gap-3 pt-4 border-t border-[var(--color-border)]">
        <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!canSubmit}
          className="flex-1"
        >
          {entry ? 'Save Changes' : 'Create Entry'}
        </Button>
      </div>
    </form>
  );
}
