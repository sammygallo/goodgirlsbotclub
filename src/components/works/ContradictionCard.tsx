import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { useStoryStore } from '../../stores/storyStore';
import { isFactTombstone } from '../../types/storyBible';
import type {
  ChatMessageSourceRef,
  Contradiction,
  ContradictionResolution,
  ContradictionType,
  SourceRef,
} from '../../types/storyBible';
import type { StoryLogEntry } from '../../api/client';
import { capturedAt, describeRef } from '../../utils/storyBible/sourceRefs';
import { checkMsgDrift, type DriftMessage } from '../../utils/storyBible/msgDrift';
import { Button, ConfirmDialog, Input, Modal, TextArea } from '../ui';

/**
 * One contradiction, reviewable (story-state phase 10, plan §6.1/§6.2).
 *
 * Collapsed it is a flag — type, description, where it stands. Expanded
 * it is the evidence: the competing facts and, for each, the passage it
 * came from. Evidence resolution is deliberately lazy and deliberately
 * failure-tolerant: the snapshot captured at ingestion is ALWAYS a
 * sufficient fallback, so nothing here may hard-depend on a fetch
 * landing. A card whose chat is gone still shows the user what the
 * quarrel was about — that is the whole point of snapshotting.
 */

/** The slice of a raw chat message this card reads.
 *
 *  Structural on purpose. `api.getChatMessages` returns a shape whose
 *  interface isn't exported, and the ingest walk's normalized message is
 *  a third, different type; the lead's cache can hold either as long as
 *  it carries these three fields. */
export interface EvidenceMessage {
  mes: string;
  swipes?: string[];
  extra?: { ggbc_id?: unknown } | null;
}

/** Quoted evidence clamp. Long enough to recognise the moment, short
 *  enough that ten expanded cards are still a page rather than a chat. */
const QUOTE_MAX = 300;

/** `FACT_MAX_BYTES` is 8 KiB on the whole normalized row, and the row a
 *  Write-my-own builds also carries an id, a category, a source ref and
 *  one `contradicts` uuid per competing fact. Cap the text well below
 *  the row cap so the envelope can never be what pushes a 413 — a
 *  rejection after the user typed their correction is the worst possible
 *  place to discover a limit. */
const WRITE_OWN_TEXT_MAX_BYTES = 6000;

/** One line, folded into Keep / Write-my-own. Not a place for an essay:
 *  the rationale rides in the continuity section, which has its own cap. */
const RATIONALE_MAX = 200;

/** Mirrors StoryTab's helper of the same name. Replicated rather than
 *  imported because the tab is the composer here, not a utility module —
 *  a component importing back out of its own parent is the shape that
 *  turns into a cycle the first time the tab imports something else. */
function humanizeContradictionType(type: ContradictionType): string {
  return type.replace(/_/g, ' ');
}

const STATUS_CHIP: Record<
  ContradictionResolution['status'],
  { label: string; className: string }
> = {
  // Warning, not error: an unresolved contradiction is a decision waiting
  // to be made, not something that went wrong.
  unresolved: {
    label: 'needs a decision',
    className: 'text-[var(--color-warning)]',
  },
  user_chose: { label: 'resolved', className: 'text-[var(--color-success)]' },
  agent_resolved: {
    label: 'resolved while building',
    className: 'text-[var(--color-success)]',
  },
  deferred: {
    label: 'deferred',
    className: 'text-[var(--color-text-secondary)]',
  },
};

const EVIDENCE_BADGE: Record<'live' | 'drifted' | 'dangling', string> = {
  live: 'text-[var(--color-success)]',
  drifted: 'text-[var(--color-warning)]',
  dangling: 'text-[var(--color-error)]',
};

interface Evidence {
  /** The passage to show. Empty when nothing was ever captured. */
  quote: string;
  /** How the quote stands against live state; null when there is no live
   *  referent to stand against (a card field, a user annotation). */
  badge: 'live' | 'drifted' | 'dangling' | null;
  note: string;
}

const NO_EVIDENCE: Evidence = { quote: '', badge: null, note: '' };

/** What the card renders for one cited fact id. Coerced defensively:
 *  `data` is `Record<string, unknown>` on the wire and a malformed row
 *  must degrade to blank text, never throw mid-render. */
interface SourceFactView {
  id: string;
  /** False for a tombstoned row AND for one the index has never heard of
   *  — both render as "(deleted fact)". */
  present: boolean;
  text: string;
  confidence: string;
  category: string;
  source: SourceRef | null;
}

function readSourceFact(
  index: Map<string, StoryLogEntry> | null,
  id: string
): SourceFactView {
  const row = index?.get(id);
  if (!row || isFactTombstone(row.data)) {
    return { id, present: false, text: '', confidence: '', category: '', source: null };
  }
  const source = row.data.source;
  return {
    id,
    present: true,
    text: String(row.data.text ?? ''),
    confidence: String(row.data.confidence ?? ''),
    category: String(row.data.category ?? ''),
    source: source && typeof source === 'object' ? (source as SourceRef) : null,
  };
}

function clampQuote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= QUOTE_MAX) return trimmed;
  return `${trimmed.slice(0, QUOTE_MAX).trimEnd()}…`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The evidence message in the shared comparator's shape.
 *
 *  `swipe_idx` IS the chosen swipe (sourceRefs' v1.1 amendment). Passing
 *  `swipes` through lets the comparator resolve the exact swipe the ref
 *  names rather than only the active one.
 *
 *  A message with no `swipes` array has exactly one text, `mes`, which is
 *  swipe 0 — modelled here as a ONE-ELEMENT array rather than as "swipes
 *  unavailable". The distinction matters: `swipes: null` means "we can't
 *  see that swipe" and yields `unverifiable`, whereas a single-element
 *  array means "there is exactly one swipe and it isn't the one you
 *  asked for" — genuine drift. Getting this wrong would downgrade a real
 *  "the message changed" into a hedged "couldn't be re-checked". */
function asDriftMessage(msg: EvidenceMessage, id: string): DriftMessage {
  const swipes = Array.isArray(msg.swipes) ? msg.swipes : [msg.mes];
  return {
    id,
    content: swipes[0] ?? msg.mes,
    swipeIdx: 0,
    timestamp: 0,
    swipes,
  };
}

async function resolveChatMessageEvidence(
  ref: ChatMessageSourceRef,
  messages: EvidenceMessage[] | null
): Promise<Evidence> {
  const snapshot = clampQuote(String(ref.snapshot?.excerpt ?? ''));
  const dangling: Evidence = {
    quote: snapshot,
    badge: 'dangling',
    note: 'as captured during ingestion',
  };

  // No transcript in hand — chat missing, fetch failed, or the lead had
  // nothing to give us. The snapshot carries the card on its own.
  if (!messages) return dangling;

  const { msg } = ref.ref;
  const found = messages.find((m) => m.extra?.ggbc_id === msg.msg_id);
  if (!found) return dangling;

  // One drift ladder for the whole app (phase 11). This used to be a
  // private copy here, and "check the fingerprint, not just the id" is
  // exactly the kind of rule that rots when it has two implementations.
  const verdict = await checkMsgDrift(msg, asDriftMessage(found, msg.msg_id));
  switch (verdict) {
    case 'dangling':
      return dangling;
    case 'drifted':
      return {
        quote: snapshot,
        badge: 'drifted',
        note: 'the message changed since ingestion',
      };
    case 'unverifiable':
      // A cross-algorithm comparison says nothing about whether the text
      // changed. The badge still reads `drifted` because this surface has
      // only three states and "unchecked" is closer to "don't trust the
      // quote" than to "verified" — the note carries the nuance. The
      // banner in StoryTab, which has a fourth state, stays silent
      // instead.
      return {
        quote: snapshot,
        badge: 'drifted',
        note: "couldn't be re-checked here — showing what was captured",
      };
    default: {
      const live = Array.isArray(found.swipes)
        ? found.swipes[msg.swipe_idx]
        : found.mes;
      return { quote: clampQuote(live ?? ''), badge: 'live', note: '' };
    }
  }
}

async function resolveEvidence(
  source: SourceRef | null,
  messages: EvidenceMessage[] | null
): Promise<Evidence> {
  if (!source) return NO_EVIDENCE;
  switch (source.kind) {
    case 'chat_message':
      return resolveChatMessageEvidence(source, messages);
    case 'card_field':
      // The card is right there in the app — its snapshot is the evidence
      // and there is no transcript to consult. Never fetch a chat here.
      return {
        quote: clampQuote(String(source.snapshot?.excerpt ?? '')),
        badge: null,
        note: 'from the character card',
      };
    case 'user_annotation':
      return { quote: '', badge: null, note: 'you wrote this' };
    case 'agent_inference':
      return { quote: '', badge: null, note: 'inferred while building' };
    default: {
      const excerpt = String(source.snapshot?.excerpt ?? '');
      if (!excerpt) return NO_EVIDENCE;
      return {
        quote: clampQuote(excerpt),
        badge: null,
        note: `from ${describeRef(source)}`,
      };
    }
  }
}

/** Apply a resolution change to one entry, purely.
 *
 *  Returns null — an explicit no-op for `patchContinuity` — when the entry
 *  is no longer there to change. On a 409 this same function re-runs
 *  against the winner's entries, so "the entry vanished under me" has to
 *  mean "write nothing", not "invent it back".
 */
function patchResolution(
  entryId: string,
  next: (entry: Contradiction) => ContradictionResolution | null
) {
  return (entries: Contradiction[]): Contradiction[] | null => {
    const idx = entries.findIndex((e) => e.id === entryId);
    if (idx < 0) return null;
    const resolution = next(entries[idx]);
    if (!resolution) return null;
    const out = entries.slice();
    out[idx] = { ...entries[idx], resolution };
    return out;
  };
}

interface WriteOwnModalProps {
  onSubmit: (text: string) => void;
  onClose: () => void;
  busy: boolean;
}

function WriteOwnModal({ onSubmit, onClose, busy }: WriteOwnModalProps) {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  const tooLong = byteLength(trimmed) > WRITE_OWN_TEXT_MAX_BYTES;

  return (
    <Modal isOpen onClose={onClose} title="Write my own">
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-text-secondary)]">
          If neither version is right, say what actually is. It's recorded
          as your own fact and becomes the answer to this contradiction —
          the versions it replaces stay in the story's history.
        </p>
        <TextArea
          label="What's actually true?"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          autoFocus
          disabled={busy}
          placeholder="She's had the scar since the fire, not the duel."
          error={
            tooLong
              ? 'Too long to store as a single fact — trim it down.'
              : undefined
          }
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => onSubmit(trimmed)}
            disabled={busy || !trimmed || tooLong}
          >
            {busy ? 'Saving…' : 'Save as the answer'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ContradictionCard({
  contradiction,
  loadChatMessages,
  onWriteOwn,
  canManage,
  disabled,
  deleteDisabled,
}: {
  contradiction: Contradiction;
  /** The source chat's messages, fetched ONCE per visit by the lead and
   *  shared across every card. Called only when an expanded card actually
   *  cites a chat message. Null means "couldn't" — never a hard failure. */
  loadChatMessages: () => Promise<EvidenceMessage[] | null>;
  /** Appends the user's fact and then patches this entry's resolution to
   *  cite it (plan §6.2 — append first, so the resolution never points at
   *  an id that doesn't exist yet). Resolves false if either half failed. */
  onWriteOwn: (text: string, rationale: string) => Promise<boolean>;
  canManage: boolean;
  /** Canon locked. Gates every mutating control (Keep, Defer, Reopen,
   *  Write my own, Delete fact). A build in flight does NOT set this,
   *  because reconcile's merge is resolution-safe by design and
   *  disabling would push the user to Change/Reset instead (plan §3.3). */
  disabled: boolean;
  /** A build in flight or resumable. Disables the per-fact Delete
   *  action only — a fact a walk chunk might re-cite is a race the
   *  plan carves out. Resolutions stay live either way. */
  deleteDisabled?: boolean;
}) {
  const factIndex = useStoryStore((s) => s.factIndex);
  const loadAllFactsById = useStoryStore((s) => s.loadAllFactsById);
  const patchContinuity = useStoryStore((s) => s.patchContinuity);
  const deleteFact = useStoryStore((s) => s.deleteFact);
  const isSaving = useStoryStore((s) => s.isSaving);

  const [expanded, setExpanded] = useState(false);
  const [evidence, setEvidence] = useState<Record<string, Evidence>>({});
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [rationale, setRationale] = useState('');
  const [writeOwnOpen, setWriteOwnOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  /** Which control is mid-flight, so exactly one button wears the label. */
  const [pending, setPending] = useState<string | null>(null);

  // Held in a ref so an unmemoized prop from the parent can't retrigger
  // the evidence effect on every render — the fetch is once per visit.
  const loadChatMessagesRef = useRef(loadChatMessages);
  loadChatMessagesRef.current = loadChatMessages;

  const { id: entryId, sources, resolution } = contradiction;
  const status = resolution.status;
  const chosen = resolution.canonical_choice ?? null;

  // Lazy: nothing below runs until the card is opened, and the fact index
  // is the store's single per-visit cache shared by every card.
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoadingEvidence(true);
    void (async () => {
      const index = factIndex ?? (await loadAllFactsById());
      if (cancelled) return;
      if (!index) {
        setLoadingEvidence(false);
        return;
      }
      const refs = sources.map((id) => readSourceFact(index, id).source);
      // Only pull the transcript when something here actually cites one.
      // A card built entirely from character-card fields must never cost
      // the user a chat fetch.
      const needsChat = refs.some((s) => s?.kind === 'chat_message');
      const messages = needsChat ? await loadChatMessagesRef.current() : null;
      if (cancelled) return;
      const next: Record<string, Evidence> = {};
      for (let i = 0; i < sources.length; i++) {
        next[sources[i]] = await resolveEvidence(refs[i], messages);
      }
      if (cancelled) return;
      setEvidence((prev) => ({ ...prev, ...next }));
      setLoadingEvidence(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, factIndex, sources, loadAllFactsById]);

  const blocked = !canManage || disabled || isSaving || pending !== null;

  const run = async (key: string, action: () => Promise<boolean>) => {
    setPending(key);
    try {
      await action();
    } finally {
      setPending(null);
    }
  };

  const keep = (factId: string) =>
    run(`keep:${factId}`, () =>
      patchContinuity(
        patchResolution(entryId, (entry) =>
          // The winner may have dropped this source (a concurrent delete
          // ran its cleanup). Choosing a fact the entry no longer cites
          // would write a resolution nothing can honour — no-op instead.
          entry.sources.includes(factId)
            ? {
                status: 'user_chose',
                canonical_choice: factId,
                rationale: rationale.trim(),
                resolved_at: capturedAt(),
              }
            : null
        ),
        {
          target: { type: 'contradiction', id: entryId },
          classification: 'contradiction',
          diff: `resolution: user_chose ${factId}`,
        }
      )
    );

  const defer = () =>
    run('defer', () =>
      patchContinuity(
        patchResolution(entryId, () => ({
          status: 'deferred',
          canonical_choice: null,
          rationale: rationale.trim(),
          resolved_at: capturedAt(),
        })),
        {
          target: { type: 'contradiction', id: entryId },
          classification: 'contradiction',
          diff: 'resolution: deferred',
        }
      )
    );

  const reopen = () =>
    run('reopen', () =>
      patchContinuity(
        patchResolution(entryId, () => ({
          status: 'unresolved',
          canonical_choice: null,
          rationale: '',
          resolved_at: null,
        })),
        {
          target: { type: 'contradiction', id: entryId },
          classification: 'contradiction',
          diff: 'resolution: reopened',
        }
      )
    );

  const factViews = sources.map((id) => readSourceFact(factIndex, id));
  const indexPending = factIndex === null;

  return (
    <div className="rounded-lg bg-[var(--color-bg-secondary)] p-3 space-y-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-start gap-2 text-left"
      >
        {expanded ? (
          <ChevronDown
            size={16}
            className="mt-0.5 shrink-0 text-[var(--color-text-secondary)]"
          />
        ) : (
          <ChevronRight
            size={16}
            className="mt-0.5 shrink-0 text-[var(--color-text-secondary)]"
          />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
              {humanizeContradictionType(contradiction.type)}
            </span>
            <span className={`text-xs ${STATUS_CHIP[status].className}`}>
              {STATUS_CHIP[status].label}
            </span>
            {contradiction.detected_by === 'user' && (
              <span className="text-xs text-[var(--color-text-secondary)]">
                · you flagged this
              </span>
            )}
          </div>
          <p className="text-sm text-[var(--color-text-primary)]">
            {contradiction.description}
          </p>
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 pl-6">
          {resolution.rationale && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              Your note: {resolution.rationale}
            </p>
          )}

          {/* Without the failure branch a failed index load leaves an
              expanded card completely blank — the store toasts the error,
              but the card must still say why it has nothing to show. */}
          {indexPending && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              {loadingEvidence
                ? 'Loading the facts…'
                : "The facts couldn't be loaded — collapse and open this again to retry."}
            </p>
          )}

          {!indexPending &&
            factViews.map((fact) => {
              const ev = evidence[fact.id] ?? NO_EVIDENCE;
              return (
                <div
                  key={fact.id}
                  className="rounded-lg bg-[var(--color-bg-tertiary)] p-3 space-y-2"
                >
                  {fact.present ? (
                    <>
                      <div className="flex flex-wrap items-start gap-2">
                        <p className="min-w-0 flex-1 text-sm text-[var(--color-text-primary)]">
                          {fact.text}
                        </p>
                        {chosen === fact.id && (
                          <span className="text-xs text-[var(--color-success)] shrink-0">
                            chosen
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-[var(--color-text-secondary)]">
                        {[fact.confidence, fact.category]
                          .filter(Boolean)
                          .map((v) => v.replace(/_/g, ' '))
                          .join(' · ')}
                      </p>
                    </>
                  ) : (
                    // Visible on purpose. A contradiction still citing a
                    // fact that no longer exists is reviewable
                    // information, and hiding the row would leave the
                    // user staring at a one-sided argument.
                    <p className="text-sm italic text-[var(--color-text-secondary)]">
                      (deleted fact)
                    </p>
                  )}

                  {(ev.quote || ev.note) && (
                    <div className="border-l-2 border-[var(--color-border)] pl-2 space-y-1">
                      {ev.quote ? (
                        <p className="text-xs text-[var(--color-text-quote)] whitespace-pre-wrap">
                          {ev.quote}
                        </p>
                      ) : (
                        ev.badge && (
                          <p className="text-xs italic text-[var(--color-text-secondary)]">
                            nothing was captured from the source
                          </p>
                        )
                      )}
                      <p className="text-xs text-[var(--color-text-secondary)]">
                        {ev.badge && (
                          <span className={EVIDENCE_BADGE[ev.badge]}>
                            {ev.badge}
                          </span>
                        )}
                        {ev.badge && ev.note ? ' — ' : ''}
                        {ev.note}
                      </p>
                    </div>
                  )}

                  {canManage && fact.present && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void keep(fact.id)}
                        disabled={blocked}
                      >
                        {pending === `keep:${fact.id}`
                          ? 'Saving…'
                          : 'Keep this'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDeleteId(fact.id)}
                        disabled={blocked || deleteDisabled}
                      >
                        <Trash2 size={14} className="mr-1.5" />
                        {pending === `delete:${fact.id}`
                          ? 'Deleting…'
                          : 'Delete fact'}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}

          {canManage && (
            <div className="space-y-2">
              <Input
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="Why? (optional)"
                aria-label="Why (optional)"
                maxLength={RATIONALE_MAX}
                disabled={blocked}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setWriteOwnOpen(true)}
                  disabled={blocked}
                >
                  Write my own
                </Button>
                {status !== 'deferred' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void defer()}
                    disabled={blocked}
                  >
                    {pending === 'defer' ? 'Saving…' : 'Defer'}
                  </Button>
                )}
                {status !== 'unresolved' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void reopen()}
                    disabled={blocked}
                  >
                    {pending === 'reopen' ? 'Saving…' : 'Reopen'}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {writeOwnOpen && (
        <WriteOwnModal
          busy={pending === 'write-own'}
          onClose={() => setWriteOwnOpen(false)}
          onSubmit={(text) => {
            void run('write-own', async () => {
              const ok = await onWriteOwn(text, rationale.trim());
              if (ok) setWriteOwnOpen(false);
              return ok;
            });
          }}
        />
      )}

      <ConfirmDialog
        isOpen={confirmDeleteId !== null}
        title="Delete this fact?"
        message="It's removed from the story everywhere, including any contradiction that cites it. Snapshots taken before now still contain it."
        confirmLabel="Delete fact"
        danger
        busy={blocked}
        onConfirm={() => {
          // ConfirmDialog calls onClose immediately after onConfirm, which
          // clears confirmDeleteId — capturing the id here is what makes
          // the delete survive its own dialog.
          const id = confirmDeleteId;
          if (id) void run(`delete:${id}`, () => deleteFact(id));
        }}
        onClose={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}
