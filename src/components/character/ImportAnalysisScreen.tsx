// Review screen for the character-card import analyzer. Purely
// presentational — the parent (CharacterImport.tsx) owns every piece of
// state this reads: which AI findings are toggled on, what's been
// generated/previewed, and what's currently generating. This component's
// only local concerns are grouping/deriving render state from those props.
import { useMemo } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  Info,
  Loader2,
  RotateCw,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import { Button } from '../ui';
import { FieldDiffView } from './FieldDiffView';
import type {
  AnalysisReport,
  CardTextField,
  FieldDiff,
  Finding,
  FindingSeverity,
  LoreExtractResult,
  SourceFormat,
} from '../../utils/cardAnalyzer/types';

export interface ImportAnalysisScreenProps {
  report: AnalysisReport;
  /** Findings currently toggled on for an AI-fix pass, by finding.id. */
  selectedFindingIds: Set<string>;
  onToggleFinding: (findingId: string) => void;
  /** Deterministic fixes are shown as an immediate diff, not a toggle — the
   *  parent already computed them (via applyAllDeterministicFixes) since
   *  they're free/instant; pass the resulting diffs here keyed by field. */
  deterministicDiffs: Record<string, FieldDiff>; // keyed by CardTextField
  /** Set once an AI-fix pass for a given finding.id has been generated and
   *  is awaiting accept/reject — undefined/absent means "not generated yet". */
  aiPreviews: Record<
    string,
    { diffs?: FieldDiff[]; loreExtract?: LoreExtractResult; error?: string }
  >;
  /** Which finding.id is CURRENTLY generating (for a spinner on that row's
   *  button), or null. */
  generatingFindingId: string | null;
  onGeneratePreview: (findingId: string) => void;
  onAcceptPreview: (findingId: string) => void;
  onRejectPreview: (findingId: string) => void;
  onSkipAll: () => void;
  onContinue: () => void;
}

// ---------------------------------------------------------------------------
// Shared display helpers
// ---------------------------------------------------------------------------

const EVIDENCE_MAX_CHARS = 220;

function truncateEvidence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= EVIDENCE_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, EVIDENCE_MAX_CHARS).trimEnd()}…`;
}

const SEVERITY_META: Record<
  FindingSeverity,
  { label: string; icon: typeof AlertCircle; className: string }
> = {
  issue: {
    label: 'Issue',
    icon: AlertCircle,
    className: 'bg-red-500/15 text-red-400 border-red-500/30',
  },
  warning: {
    label: 'Warning',
    icon: AlertTriangle,
    className: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  },
  info: {
    label: 'Info',
    icon: Info,
    className:
      'bg-[var(--color-primary)]/15 text-[var(--color-primary)] border-[var(--color-primary)]/30',
  },
};

function SeverityChip({ severity }: { severity: FindingSeverity }) {
  const meta = SEVERITY_META[severity];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${meta.className}`}
    >
      <Icon size={11} />
      {meta.label}
    </span>
  );
}

function FindingEvidence({ evidence }: { evidence?: string }) {
  if (!evidence) return null;
  return (
    <p className="border-l-2 border-[var(--color-border)] pl-2 text-xs italic text-[var(--color-text-secondary)]">
      &ldquo;{truncateEvidence(evidence)}&rdquo;
    </p>
  );
}

const FIELD_LABELS: Record<CardTextField, string> = {
  description: 'Description',
  personality: 'Personality',
  first_mes: 'First message',
  scenario: 'Scenario',
  mes_example: 'Example messages',
  creator_notes: 'Creator notes',
  system_prompt: 'System prompt',
  post_history_instructions: 'Post-history instructions',
};

const FORMAT_LABELS: Partial<Record<SourceFormat, string>> = {
  wpp: 'W++',
  boostyle: 'Boostyle',
  plist: 'PList',
  json: 'Embedded JSON',
  mixed: 'Mixed formatting (structured + prose)',
};

function ReportHeader({ report }: { report: AnalysisReport }) {
  // 'prose' and 'unknown' aren't worth a headline — there's no structured
  // format to call out, so the block quietly reduces to just the token line.
  const formatLabel = FORMAT_LABELS[report.sourceFormat];
  return (
    <div className="space-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-3">
      {formatLabel && (
        <p className="text-sm font-medium text-[var(--color-text-primary)]">
          Detected format: {formatLabel}
        </p>
      )}
      <p className="text-xs text-[var(--color-text-secondary)]">
        ~{report.totalPermanentTokens} tokens in the permanent prompt (description,
        personality, first message, scenario, and similar always-loaded fields)
      </p>
    </div>
  );
}

function PreviewActions({
  findingId,
  onAccept,
  onReject,
}: {
  findingId: string;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <div className="flex gap-2">
      <Button variant="primary" size="sm" onClick={() => onAccept(findingId)}>
        <Check size={12} className="mr-1" />
        Accept
      </Button>
      <Button variant="ghost" size="sm" onClick={() => onReject(findingId)}>
        <X size={12} className="mr-1" />
        Reject
      </Button>
    </div>
  );
}

function LoreExtractPreview({ extract }: { extract: LoreExtractResult }) {
  return (
    <div className="space-y-2">
      <div>
        <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-secondary)]">
          Revised description
        </p>
        <FieldDiffView
          diff={{ field: 'description', before: extract.originalDescription, after: extract.revisedDescription }}
        />
      </div>
      {extract.entries.length > 0 && (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-secondary)]">
            <BookOpen size={12} />
            Extracted into {extract.entries.length} lore entr
            {extract.entries.length === 1 ? 'y' : 'ies'}
          </p>
          {extract.entries.map((entry, i) => (
            <div
              key={i}
              className="space-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-2"
            >
              <div className="flex flex-wrap gap-1">
                {entry.keys.map((k, ki) => (
                  <span
                    key={ki}
                    className="rounded bg-[var(--color-primary)]/15 px-1.5 py-0.5 text-[10px] text-[var(--color-primary)]"
                  >
                    {k}
                  </span>
                ))}
              </div>
              <p className="text-xs text-[var(--color-text-secondary)]">{entry.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section: deterministic fixes — always-on, no toggle
// ---------------------------------------------------------------------------

function DeterministicSection({
  findings,
  deterministicDiffs,
}: {
  findings: Finding[];
  deterministicDiffs: Record<string, FieldDiff>;
}) {
  if (findings.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--color-text-primary)]">
        <Sparkles size={14} className="text-[var(--color-primary)]" />
        Automatic fixes
      </h3>
      <div className="space-y-2">
        {findings.map((finding) => {
          const diff = finding.field !== 'card' ? deterministicDiffs[finding.field] : undefined;
          return (
            <div
              key={finding.id}
              className="space-y-2 rounded-lg border border-[var(--color-primary)]/40 bg-[var(--color-primary)]/10 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <SeverityChip severity={finding.severity} />
                <p className="text-sm font-medium text-[var(--color-text-primary)]">{finding.title}</p>
              </div>
              <p className="text-xs text-[var(--color-text-secondary)]">{finding.detail}</p>
              <FindingEvidence evidence={finding.evidence} />
              {diff && <FieldDiffView diff={diff} />}
              <p className="flex items-center gap-1.5 text-[11px] text-[var(--color-primary)]">
                <CheckCircle2 size={12} />
                Will be applied automatically
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section: AI-fixable suggestions — toggle + generate + accept/reject
// ---------------------------------------------------------------------------

function AiFindingRow({
  finding,
  selected,
  isGenerating,
  preview,
  onToggleFinding,
  onGeneratePreview,
  onAcceptPreview,
  onRejectPreview,
}: {
  finding: Finding;
  selected: boolean;
  isGenerating: boolean;
  preview: { diffs?: FieldDiff[]; loreExtract?: LoreExtractResult; error?: string } | undefined;
  onToggleFinding: (id: string) => void;
  onGeneratePreview: (id: string) => void;
  onAcceptPreview: (id: string) => void;
  onRejectPreview: (id: string) => void;
}) {
  return (
    <div
      className={`space-y-2 rounded-lg border p-3 transition-colors ${
        selected
          ? 'border-[var(--color-primary)]/50 bg-[var(--color-primary)]/5'
          : 'border-[var(--color-border)] bg-[var(--color-bg-tertiary)]'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleFinding(finding.id)}
          className="mt-0.5 h-4 w-4 flex-shrink-0 accent-[var(--color-primary)]"
          aria-label={`Include "${finding.title}" in the AI fix pass`}
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityChip severity={finding.severity} />
            <p className="text-sm font-medium text-[var(--color-text-primary)]">{finding.title}</p>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)]">{finding.detail}</p>
          <FindingEvidence evidence={finding.evidence} />
        </div>
      </div>

      {isGenerating ? (
        <div className="flex items-center gap-2 pl-6 text-xs text-[var(--color-text-secondary)]">
          <Loader2 size={14} className="animate-spin text-[var(--color-primary)]" />
          Generating suggestion&hellip;
        </div>
      ) : preview?.error ? (
        <div className="ml-6 space-y-2 rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-400">
          <p>{preview.error}</p>
          <Button variant="ghost" size="sm" onClick={() => onGeneratePreview(finding.id)}>
            <RotateCw size={12} className="mr-1" />
            Retry
          </Button>
        </div>
      ) : preview?.diffs ? (
        <div className="ml-6 space-y-2">
          {preview.diffs.map((d) => (
            <div key={d.field} className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-secondary)]">
                {FIELD_LABELS[d.field]}
              </p>
              <FieldDiffView diff={d} />
            </div>
          ))}
          <PreviewActions findingId={finding.id} onAccept={onAcceptPreview} onReject={onRejectPreview} />
        </div>
      ) : preview?.loreExtract ? (
        <div className="ml-6 space-y-2">
          <LoreExtractPreview extract={preview.loreExtract} />
          <PreviewActions findingId={finding.id} onAccept={onAcceptPreview} onReject={onRejectPreview} />
        </div>
      ) : selected ? (
        <div className="pl-6">
          <Button variant="secondary" size="sm" onClick={() => onGeneratePreview(finding.id)}>
            <Sparkles size={12} className="mr-1" />
            Generate preview
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function AiSection({
  findings,
  selectedFindingIds,
  generatingFindingId,
  aiPreviews,
  onToggleFinding,
  onGeneratePreview,
  onAcceptPreview,
  onRejectPreview,
}: {
  findings: Finding[];
  selectedFindingIds: Set<string>;
  generatingFindingId: string | null;
  aiPreviews: ImportAnalysisScreenProps['aiPreviews'];
  onToggleFinding: (id: string) => void;
  onGeneratePreview: (id: string) => void;
  onAcceptPreview: (id: string) => void;
  onRejectPreview: (id: string) => void;
}) {
  if (findings.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--color-text-primary)]">
        <Wand2 size={14} className="text-[var(--color-primary)]" />
        AI-assisted suggestions
      </h3>
      <div className="space-y-2">
        {findings.map((finding) => (
          <AiFindingRow
            key={finding.id}
            finding={finding}
            selected={selectedFindingIds.has(finding.id)}
            isGenerating={generatingFindingId === finding.id}
            preview={aiPreviews[finding.id]}
            onToggleFinding={onToggleFinding}
            onGeneratePreview={onGeneratePreview}
            onAcceptPreview={onAcceptPreview}
            onRejectPreview={onRejectPreview}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section: informational-only findings — nothing to do here
// ---------------------------------------------------------------------------

function InfoSection({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return null;
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-[var(--color-text-secondary)]">
        <Info size={14} />
        For your awareness
      </h3>
      <div className="space-y-2">
        {findings.map((finding) => (
          <div
            key={finding.id}
            className="space-y-1.5 rounded-lg border border-[var(--color-border)]/60 bg-[var(--color-bg-tertiary)]/50 p-3 opacity-80"
          >
            <div className="flex flex-wrap items-center gap-2">
              <SeverityChip severity={finding.severity} />
              <p className="text-sm font-medium text-[var(--color-text-secondary)]">{finding.title}</p>
            </div>
            <p className="text-xs text-[var(--color-text-secondary)]">{finding.detail}</p>
            <FindingEvidence evidence={finding.evidence} />
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function ImportAnalysisScreen({
  report,
  selectedFindingIds,
  onToggleFinding,
  deterministicDiffs,
  aiPreviews,
  generatingFindingId,
  onGeneratePreview,
  onAcceptPreview,
  onRejectPreview,
  onSkipAll,
  onContinue,
}: ImportAnalysisScreenProps) {
  const deterministicFindings = useMemo(
    () => report.findings.filter((f) => f.fix === 'deterministic'),
    [report.findings]
  );
  const aiFindings = useMemo(
    () => report.findings.filter((f) => f.fix === 'ai'),
    [report.findings]
  );
  const infoFindings = useMemo(
    () => report.findings.filter((f) => f.fix === 'none'),
    [report.findings]
  );
  const hasActionable = deterministicFindings.length > 0 || aiFindings.length > 0;

  // "How many fixes are about to be applied" for the footer label. There's
  // no explicit "accepted" flag in the props contract (aiPreviews only
  // tracks pending previews), so this is the best signal available from
  // props alone: every deterministic diff (always-on) plus every currently
  // toggled-on AI finding that has a successfully generated preview. It's
  // an approximation of "ready to apply", not a strict accept-tracking
  // count — see the report back to the integrator for the full rationale.
  const deterministicCount = Object.keys(deterministicDiffs).length;
  const aiReadyCount = useMemo(() => {
    let n = 0;
    selectedFindingIds.forEach((id) => {
      const p = aiPreviews[id];
      if (p && !p.error && ((p.diffs && p.diffs.length > 0) || p.loreExtract)) n++;
    });
    return n;
  }, [selectedFindingIds, aiPreviews]);
  const totalToApply = deterministicCount + aiReadyCount;
  const continueLabel =
    totalToApply > 0 ? `Apply ${totalToApply} fix${totalToApply === 1 ? '' : 'es'} & continue` : 'Continue';

  return (
    <div className="space-y-4">
      <ReportHeader report={report} />

      {!hasActionable ? (
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <CheckCircle2 size={32} className="text-green-400" />
          <p className="text-sm font-medium text-[var(--color-text-primary)]">
            Nothing to fix &mdash; looks good
          </p>
          <p className="text-xs text-[var(--color-text-secondary)]">
            No structural issues detected in this card.
          </p>
        </div>
      ) : (
        <>
          <DeterministicSection findings={deterministicFindings} deterministicDiffs={deterministicDiffs} />
          <AiSection
            findings={aiFindings}
            selectedFindingIds={selectedFindingIds}
            generatingFindingId={generatingFindingId}
            aiPreviews={aiPreviews}
            onToggleFinding={onToggleFinding}
            onGeneratePreview={onGeneratePreview}
            onAcceptPreview={onAcceptPreview}
            onRejectPreview={onRejectPreview}
          />
        </>
      )}

      <InfoSection findings={infoFindings} />

      <div className="sticky bottom-0 -mx-6 -mb-6 mt-4 flex gap-3 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-6 py-3">
        {hasActionable && (
          <Button variant="secondary" onClick={onSkipAll} className="flex-1">
            Skip suggestions &mdash; continue
          </Button>
        )}
        <Button variant="primary" onClick={onContinue} className="flex-1">
          {continueLabel}
        </Button>
      </div>
    </div>
  );
}
