import { useState, useRef, useEffect } from 'react';
import { Upload, FileImage, FileJson, X, BookOpen, AlertTriangle, Sparkles } from 'lucide-react';
import { useCharacterStore } from '../../stores/characterStore';
import { useWorldInfoStore } from '../../stores/worldInfoStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { Modal, Button, Input, TextArea, ImageUpload, TagInput } from '../ui';
import { showToastGlobal } from '../ui/Toast';
import { AlternateGreetingsEditor } from './AlternateGreetingsEditor';
import { ImportAnalysisScreen } from './ImportAnalysisScreen';
import {
  analyzeCard,
  applyAllDeterministicFixes,
  type AnalysisReport,
  type CardTextField,
  type FieldDiff,
  type Finding,
  type LoreExtractResult,
} from '../../utils/cardAnalyzer';
import { runAiFix } from '../../utils/cardAnalyzer/aiFixes';
import { CARD_FIX_PROMPT_VERSION } from '../../utils/cardAnalyzer/prompts';
import type { CharacterInfo } from '../../api/client';
import type {
  CharacterBookV2,
  CharacterBookEntryV2,
  CharacterBookMeta,
  CharacterCardV2,
  CharacterExportData,
} from '../../utils/characterCard';

type Phase = 'pick' | 'report' | 'form';

/** Card-analyzer field → this form's own field key, for merging an accepted
 *  fix's diff back into the form. `system_prompt`/`post_history_instructions`
 *  aren't editable in this form (they pass through from the imported card
 *  untouched in handleSubmit) and no current detector targets them, so
 *  they're intentionally absent here. */
const CARD_FIELD_TO_FORM_KEY: Partial<Record<CardTextField, string>> = {
  description: 'description',
  personality: 'personality',
  first_mes: 'firstMessage',
  scenario: 'scenario',
  mes_example: 'exampleMessages',
  creator_notes: 'creatorNotes',
};

interface CharacterImportProps {
  isOpen: boolean;
  onClose: () => void;
  onImported?: (avatarUrl: string) => void;
}

export function CharacterImport({ isOpen, onClose, onImported }: CharacterImportProps) {
  const {
    importCharacter,
    createCharacter,
    registerEmbeddedBookFromCard,
    isImporting,
    isCreating,
    error,
    clearError,
    getAllTags,
    lorebookDetected,
    clearLorebookDetected,
  } = useCharacterStore();
  const { importBookJson } = useWorldInfoStore();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importedData, setImportedData] = useState<Partial<CharacterInfo> | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [importedBook, setImportedBook] = useState<CharacterBookV2 | null>(null);
  const [standardizeFormatting, setStandardizeFormatting] = useState(false);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [importChanges, setImportChanges] = useState<string[]>([]);
  const [importIgnoredFiles, setImportIgnoredFiles] = useState<string[]>([]);
  // Lorebook-only file detection lives on the store now (`lorebookDetected`)
  // so this reflects the parser's own LorebookDetectedError instead of a
  // second, independently-maintained heuristic in this component.
  const [lorebookImported, setLorebookImported] = useState(false);
  const [formData, setFormData] = useState<{
    name: string;
    description: string;
    personality: string;
    firstMessage: string;
    scenario: string;
    exampleMessages: string;
    creatorNotes: string;
    creator: string;
    tags: string[];
  }>({
    name: '',
    description: '',
    personality: '',
    firstMessage: '',
    scenario: '',
    exampleMessages: '',
    creatorNotes: '',
    creator: '',
    tags: [],
  });
  const [alternateGreetings, setAlternateGreetings] = useState<string[]>([]);

  // Card-analyzer report state. `analysisReport`/`rawCard`/`bookMeta` are
  // computed once per import (right after parsing); the rest track the
  // user's in-progress review of AI-fixable findings.
  const [phase, setPhase] = useState<Phase>('pick');
  const [analysisReport, setAnalysisReport] = useState<AnalysisReport | null>(null);
  const [rawCard, setRawCard] = useState<CharacterCardV2 | CharacterExportData | null>(null);
  const [bookMeta, setBookMeta] = useState<CharacterBookMeta | undefined>(undefined);
  const [deterministicDiffs, setDeterministicDiffs] = useState<Record<string, FieldDiff>>({});
  const [appliedDeterministicFindingIds, setAppliedDeterministicFindingIds] = useState<string[]>([]);
  const [selectedFindingIds, setSelectedFindingIds] = useState<Set<string>>(new Set());
  const [acceptedFindingIds, setAcceptedFindingIds] = useState<Set<string>>(new Set());
  const [aiPreviews, setAiPreviews] = useState<
    Record<string, { diffs?: FieldDiff[]; loreExtract?: LoreExtractResult; error?: string }>
  >({});
  const [generatingFindingId, setGeneratingFindingId] = useState<string | null>(null);
  // One AbortController per in-flight finding — generations for different
  // findings can run concurrently (nothing serializes "Generate preview"
  // across rows), so a single shared ref would let a later generation's
  // controller silently replace an earlier one still in flight, making the
  // earlier one uncancelable (e.g. by closing the modal).
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const abortAllGenerations = () => {
    for (const controller of abortControllersRef.current.values()) controller.abort();
    abortControllersRef.current.clear();
  };

  // Cancel any in-flight AI-fix generation if the modal unmounts.
  useEffect(() => {
    return () => abortAllGenerations();
  }, []);

  const resetAnalysisState = () => {
    setPhase('pick');
    setAnalysisReport(null);
    setRawCard(null);
    setBookMeta(undefined);
    setDeterministicDiffs({});
    setAppliedDeterministicFindingIds([]);
    setSelectedFindingIds(new Set());
    setAcceptedFindingIds(new Set());
    setAiPreviews({});
    setGeneratingFindingId(null);
    abortAllGenerations();
  };

  const processFiles = async (files: File[], opts?: { standardizeFormatting: boolean }) => {
    const result = await importCharacter(files, {
      standardizeFormatting: opts?.standardizeFormatting ?? standardizeFormatting,
    });

    if (result) {
      setImportedData(result.data);
      setImportedBook(result.characterBook || null);
      setImportWarnings(result.warnings || []);
      setImportChanges(result.changes || []);
      setImportIgnoredFiles(result.ignoredFiles || []);
      if (result.avatarFile) {
        setAvatarFile(result.avatarFile);
        const previewUrl = URL.createObjectURL(result.avatarFile);
        setAvatarPreview(previewUrl);
      }
      setFormData({
        name: result.data.name || '',
        description: result.data.description || result.data.data?.description || '',
        personality: result.data.personality || result.data.data?.personality || '',
        firstMessage: result.data.first_mes || result.data.data?.first_mes || '',
        scenario: result.data.scenario || result.data.data?.scenario || '',
        exampleMessages: result.data.mes_example || '',
        creatorNotes: result.data.data?.creator_notes || '',
        creator: result.data.data?.creator || '',
        tags: result.data.tags || result.data.data?.tags || [],
      });
      setAlternateGreetings(
        result.data.alternate_greetings ||
          result.data.data?.alternate_greetings ||
          []
      );

      // Analyze the freshly-normalized card. Deterministic fixes are
      // computed immediately (they're free); AI-fixable findings wait for
      // the user to toggle them on. A card that comes back clean (no
      // findings at all) skips the report screen entirely — the "opt-in
      // fixes" design must not add friction to an import that has nothing
      // to say.
      const characterName = result.data.name || '';
      const cardForAnalysis = {
        name: characterName,
        description: result.data.description || result.data.data?.description || '',
        personality: result.data.personality || result.data.data?.personality || '',
        first_mes: result.data.first_mes || result.data.data?.first_mes || '',
        scenario: result.data.scenario || result.data.data?.scenario || '',
        mes_example: result.data.mes_example || result.data.data?.mes_example || '',
        creator_notes: result.data.data?.creator_notes || '',
        system_prompt: result.data.system_prompt || result.data.data?.system_prompt || '',
        post_history_instructions:
          result.data.post_history_instructions ||
          result.data.data?.post_history_instructions ||
          '',
      };
      const report = analyzeCard(cardForAnalysis, characterName);
      const { diffs, appliedFindingIds } = applyAllDeterministicFixes(
        report.findings,
        cardForAnalysis,
        characterName
      );
      setAnalysisReport(report);
      setRawCard(result.rawCard);
      setBookMeta(result.bookMeta);
      setDeterministicDiffs(
        Object.fromEntries(diffs.map((d) => [d.field, d]))
      );
      setAppliedDeterministicFindingIds(appliedFindingIds);
      setPhase(report.findings.length > 0 ? 'report' : 'form');
    }
    // If nothing was found and it's because a dropped JSON was a lorebook in
    // disguise, the store has already set `lorebookDetected` — no local
    // re-parse needed; the render below reads it straight off the store.
  };

  /** The card an AI fix pass should read from: the already-normalized
   *  imported text, with any deterministic fix's result substituted in for
   *  fields it touched. Without this, a field with BOTH a deterministic
   *  finding (e.g. a legacy `<BOT>` placeholder, applied automatically)
   *  and an AI-fixable finding (e.g. W++ formatting) would have its AI
   *  pass run against the pre-fix text — the model never sees the
   *  placeholder fix, so the rewritten prose could still contain `<BOT>`
   *  even though the report told the user it was handled. Feeding the
   *  deterministic result in as the baseline means the AI diff's `after`
   *  already incorporates it, so applying both fixes to the same field
   *  composes correctly instead of the later one silently discarding the
   *  earlier one's work. */
  const currentCardForFixes = () => {
    const base = (field: CardTextField, fallback: string) =>
      deterministicDiffs[field]?.after ?? fallback;
    return {
      name: formData.name,
      description: base('description', formData.description),
      personality: base('personality', formData.personality),
      first_mes: base('first_mes', formData.firstMessage),
      scenario: base('scenario', formData.scenario),
      mes_example: base('mes_example', formData.exampleMessages),
      creator_notes: base('creator_notes', formData.creatorNotes),
      system_prompt: importedData?.system_prompt || importedData?.data?.system_prompt || '',
      post_history_instructions:
        importedData?.post_history_instructions ||
        importedData?.data?.post_history_instructions ||
        '',
    };
  };

  const handleToggleFinding = (findingId: string) => {
    setSelectedFindingIds((prev) => {
      const next = new Set(prev);
      if (next.has(findingId)) next.delete(findingId);
      else next.add(findingId);
      return next;
    });
  };

  const handleGeneratePreview = async (findingId: string) => {
    const finding = analysisReport?.findings.find((f) => f.id === findingId);
    if (!finding || finding.fix !== 'ai') return;

    const controller = new AbortController();
    abortControllersRef.current.get(findingId)?.abort();
    abortControllersRef.current.set(findingId, controller);
    setGeneratingFindingId(findingId);
    setAiPreviews((prev) => {
      const next = { ...prev };
      delete next[findingId];
      return next;
    });

    try {
      const { activeProvider, activeModel } = useSettingsStore.getState();
      const result = await runAiFix(
        finding as Finding,
        currentCardForFixes(),
        formData.name.trim() || 'Character',
        { provider: activeProvider, model: activeModel, signal: controller.signal }
      );
      setAiPreviews((prev) => ({
        ...prev,
        [findingId]:
          result.kind === 'fieldDiffs'
            ? { diffs: result.diffs }
            : { loreExtract: result.result },
      }));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setAiPreviews((prev) => ({
        ...prev,
        [findingId]: { error: err instanceof Error ? err.message : 'Generation failed.' },
      }));
    } finally {
      // Only touch shared state if OUR OWN controller is still the current
      // one for this finding — a newer generation for the same finding
      // (started after this one but not yet resolved) would have already
      // replaced it in the map. Without this guard, an aborted/superseded
      // request's finally would still unconditionally null
      // generatingFindingId once it settles, making the spinner disappear
      // while the newer request is still actually running.
      if (abortControllersRef.current.get(findingId) === controller) {
        abortControllersRef.current.delete(findingId);
        setGeneratingFindingId((current) => (current === findingId ? null : current));
      }
    }
  };

  const handleAcceptPreview = (findingId: string) => {
    setAcceptedFindingIds((prev) => new Set(prev).add(findingId));
  };

  const handleRejectPreview = (findingId: string) => {
    setSelectedFindingIds((prev) => {
      const next = new Set(prev);
      next.delete(findingId);
      return next;
    });
    setAcceptedFindingIds((prev) => {
      const next = new Set(prev);
      next.delete(findingId);
      return next;
    });
    setAiPreviews((prev) => {
      const next = { ...prev };
      delete next[findingId];
      return next;
    });
  };

  /** Merge every deterministic diff plus every ACCEPTED AI-fix diff into
   *  the form, stage any extracted lore entries into the embedded book,
   *  and move to the editable form. Rejected/unreviewed AI suggestions are
   *  simply left as the user's original imported text — nothing here is
   *  destructive, everything still passes through the normal edit form
   *  before it's saved. */
  const applyReviewedFixesAndContinue = () => {
    abortAllGenerations();
    const patch: Record<string, string> = {};
    const applyDiff = (diff: FieldDiff) => {
      const key = CARD_FIELD_TO_FORM_KEY[diff.field];
      if (key) patch[key] = diff.after;
    };

    for (const diff of Object.values(deterministicDiffs)) applyDiff(diff);

    // Two independently-generated ACCEPTED AI fixes can target the same
    // field — e.g. a W++ rewrite and a lore-extraction both touching
    // `description` on a long, heavily-structured card. Unlike
    // deterministic fixes (composed sequentially on purpose, see
    // applyAllDeterministicFixes), each AI pass here was generated
    // independently against the same pre-AI baseline, so there's no
    // principled way to merge two conflicting rewrites — applying both
    // would silently let whichever was accepted last win with no trace.
    // Track collisions and surface them instead of hiding the loss.
    const claimedByFieldKey: Record<string, string> = {};
    const conflictedFields: string[] = [];
    const newLoreEntries: CharacterBookEntryV2[] = [];
    for (const findingId of acceptedFindingIds) {
      // Accepted-but-then-unchecked findings don't apply — unchecking the
      // box after Accept is how a user abandons a fix they previewed and
      // decided against, without having to hit Reject (which also throws
      // the preview away entirely).
      if (!selectedFindingIds.has(findingId)) continue;
      const preview = aiPreviews[findingId];
      if (!preview) continue;

      const noteClaim = (field: CardTextField) => {
        const key = CARD_FIELD_TO_FORM_KEY[field];
        if (!key) return;
        if (claimedByFieldKey[key] && claimedByFieldKey[key] !== findingId) {
          conflictedFields.push(field);
        }
        claimedByFieldKey[key] = findingId;
      };

      preview.diffs?.forEach((d) => {
        noteClaim(d.field);
        applyDiff(d);
      });
      if (preview.loreExtract) {
        noteClaim('description');
        patch.description = preview.loreExtract.revisedDescription;
        for (const entry of preview.loreExtract.entries) {
          newLoreEntries.push({ keys: entry.keys, content: entry.content });
        }
      }
    }

    if (conflictedFields.length > 0) {
      const unique = Array.from(new Set(conflictedFields));
      showToastGlobal(
        `Two accepted fixes both rewrote ${unique.join(', ')} — only the last one applied. Double-check before saving.`,
        'warning'
      );
    }

    if (Object.keys(patch).length > 0) {
      setFormData((prev) => ({ ...prev, ...patch }));
    }
    if (newLoreEntries.length > 0) {
      setImportedBook((prev) =>
        prev
          ? { ...prev, entries: [...prev.entries, ...newLoreEntries] }
          : { name: `${formData.name.trim() || 'Character'} Lorebook`, entries: newLoreEntries }
      );
    }
    setPhase('form');
  };

  const handleSkipSuggestions = () => {
    abortAllGenerations();
    setPhase('form');
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    clearError();
    clearLorebookDetected();
    setLorebookImported(false);

    await processFiles(files);

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleChange = (field: string) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    setFormData((prev) => ({ ...prev, [field]: e.target.value }));
    if (error) clearError();
  };

  const handleAvatarChange = (file: File | null) => {
    setAvatarFile(file);
    if (file) {
      const previewUrl = URL.createObjectURL(file);
      setAvatarPreview(previewUrl);
    } else {
      setAvatarPreview(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name.trim()) {
      return;
    }

    const altGreetings = alternateGreetings.filter(
      (g) => typeof g === 'string' && g.trim()
    );
    const depthPrompt = importedData?.data?.extensions?.depth_prompt;
    // Coerced to a string upstream in cardToCharacterInfo (SillyTavern
    // writes this as a number) — the typeof check here is just narrowing
    // for the string-typed field, not a data-loss guard anymore.
    const talkativenessRaw = importedData?.data?.extensions?.talkativeness;
    // Everything the parser preserved that this form doesn't have its own
    // field for — V3-only card keys and third-party extension namespaces —
    // so a round trip through the wizard doesn't drop them. `extensions` is
    // pulled out separately since buildCardData layers it before
    // depth_prompt/talkativeness rather than through data_overrides.
    // `alternate_greetings` is ALSO pulled out: it's edited below via
    // `alternateGreetings` state and sent as its own explicit field, but
    // buildCardData only overwrites that field when truthy — clearing every
    // greeting sends `undefined`, so leaving the original imported array in
    // `dataOverrides` would silently resurrect greetings the user just
    // deleted (buildCardData spreads data_overrides first; a skipped
    // explicit assignment leaves whatever the spread put there in place).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { extensions: importedExtensions, alternate_greetings: _dropped, ...dataOverrides } =
      importedData?.data || {};

    // Import provenance: what format the card was detected as, which fixes
    // (deterministic — always applied — and AI, only the ones the user
    // accepted) actually landed, and the original parsed card so a future
    // "restore original import" action in the edit screen has something to
    // restore from. Capped well under the row's JSONB comfort zone; a huge
    // original card is dropped rather than bloating every future read of
    // this character.
    const ORIGINAL_CARD_MAX_BYTES = 400_000;
    const originalCardJson = rawCard ? JSON.stringify(rawCard) : null;
    // Real UTF-8 byte length, not JS string .length (UTF-16 code units) —
    // a card with substantial non-ASCII text (CJK, accents, emoji) can run
    // up to ~3x its .length in actual bytes, which would let content well
    // over the intended cap slip through a length-only check.
    const originalCardBytes = originalCardJson
      ? new TextEncoder().encode(originalCardJson).length
      : 0;
    const fixesApplied = [
      ...appliedDeterministicFindingIds.map((id) => {
        const finding = analysisReport?.findings.find((f) => f.id === id);
        return { finding: id, pass: 'deterministic', field: finding?.field ?? '' };
      }),
      ...Array.from(acceptedFindingIds).map((id) => {
        const finding = analysisReport?.findings.find((f) => f.id === id);
        return { finding: id, pass: finding?.aiPass ?? 'unknown', field: finding?.field ?? '' };
      }),
    ];
    const importProvenance = {
      version: 1,
      imported_at: new Date().toISOString(),
      source_format: analysisReport?.sourceFormat ?? 'unknown',
      prompt_version: CARD_FIX_PROMPT_VERSION,
      original_card: originalCardBytes > 0 && originalCardBytes <= ORIGINAL_CARD_MAX_BYTES ? rawCard : null,
      original_omitted: originalCardBytes > ORIGINAL_CARD_MAX_BYTES,
      ...(bookMeta ? { character_book_meta: bookMeta } : {}),
      fixes_applied: fixesApplied,
    };
    const mergedExtensions = {
      ...(importedExtensions || {}),
      ggbc: {
        ...((importedExtensions?.ggbc as Record<string, unknown> | undefined) || {}),
        import: importProvenance,
      },
    };

    const avatarUrl = await createCharacter(
      {
        ch_name: formData.name.trim(),
        description: formData.description.trim(),
        personality: formData.personality.trim(),
        first_mes: formData.firstMessage.trim(),
        scenario: formData.scenario.trim(),
        mes_example: formData.exampleMessages.trim(),
        creator_notes: formData.creatorNotes.trim(),
        creator: formData.creator.trim(),
        tags: formData.tags.join(', '),
        alternate_greetings: altGreetings.length > 0 ? altGreetings : undefined,
        system_prompt:
          importedData?.system_prompt || importedData?.data?.system_prompt || undefined,
        post_history_instructions:
          importedData?.post_history_instructions ||
          importedData?.data?.post_history_instructions ||
          undefined,
        character_version:
          importedData?.character_version ||
          importedData?.data?.character_version ||
          undefined,
        depth_prompt_prompt: depthPrompt?.prompt?.trim() || undefined,
        depth_prompt_depth: depthPrompt?.prompt?.trim() ? depthPrompt.depth ?? 4 : undefined,
        depth_prompt_role: depthPrompt?.prompt?.trim()
          ? (depthPrompt.role as string | undefined) || 'system'
          : undefined,
        talkativeness: typeof talkativenessRaw === 'string' ? talkativenessRaw : undefined,
        data_overrides: dataOverrides,
        extensions: mergedExtensions,
      },
      avatarFile || undefined
    );

    if (avatarUrl) {
      // Persist the character's embedded lorebook after the server assigns
      // the final avatar filename.
      if (importedBook) {
        registerEmbeddedBookFromCard(
          avatarUrl,
          importedBook,
          `${formData.name.trim() || 'Character'} Lorebook`
        );
        watchForLorebookSyncFailure();
      }
      handleClose();
      onImported?.(avatarUrl);
    }
  };

  /**
   * registerEmbeddedBookFromCard's server sync is fire-and-forget (see
   * worldInfoStore's own comment on syncNewBookWithEntries/
   * syncCharacterBookReplace — making it awaitable is out of scope there)
   * and only ever surfaces failure by setting worldInfoStore's `error`
   * field, which nothing downstream of an import was reading. Watch for it
   * briefly so a sync failure doesn't silently vanish — the character row
   * itself always saves fine either way, so this is a heads-up, not a
   * blocker.
   *
   * `error` is a single field shared by every worldInfoStore mutator (and
   * also rendered as its own banner on the World Info page), so this is a
   * best-effort heuristic, not a precise "this import's sync" signal:
   * ignore whatever the error already was before this call started (so a
   * stale, already-displayed error can't get misattributed to this
   * import), and never write to the field — clearing someone else's
   * still-relevant error out from under them would be worse than an
   * occasional missed/misattributed toast in this narrow window.
   */
  const watchForLorebookSyncFailure = () => {
    const errorBeforeThisImport = useWorldInfoStore.getState().error;
    const unsub = useWorldInfoStore.subscribe((state) => {
      if (!state.error || state.error === errorBeforeThisImport) return;
      showToastGlobal(
        `Character saved, but the lorebook didn't sync: ${state.error} — retry from the character's Lorebook section.`,
        'warning'
      );
      unsub();
    });
    setTimeout(unsub, 5000);
  };

  const handleImportAsLorebook = () => {
    if (!lorebookDetected) return;
    const book = importBookJson(lorebookDetected.text, lorebookDetected.name);
    if (book) {
      setLorebookImported(true);
    }
  };

  const handleClose = () => {
    // Clean up preview URL
    if (avatarPreview) {
      URL.revokeObjectURL(avatarPreview);
    }
    setImportedData(null);
    setImportedBook(null);
    setAvatarFile(null);
    setAvatarPreview(null);
    clearLorebookDetected();
    setLorebookImported(false);
    setImportWarnings([]);
    setImportChanges([]);
    setImportIgnoredFiles([]);
    resetAnalysisState();
    setFormData({
      name: '',
      description: '',
      personality: '',
      firstMessage: '',
      scenario: '',
      exampleMessages: '',
      creatorNotes: '',
      creator: '',
      tags: [],
    });
    setAlternateGreetings([]);
    clearError();
    onClose();
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const files = Array.from(e.dataTransfer.files).filter((f) => {
      const isPNG = f.type === 'image/png' || f.name.toLowerCase().endsWith('.png');
      const isJSON = f.type === 'application/json' || f.name.toLowerCase().endsWith('.json');
      return isPNG || isJSON;
    });
    if (files.length === 0) return;

    clearError();
    clearLorebookDetected();
    setLorebookImported(false);

    await processFiles(files);
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Import Character" size="lg">
      {phase === 'report' && analysisReport ? (
        <ImportAnalysisScreen
          report={analysisReport}
          selectedFindingIds={selectedFindingIds}
          onToggleFinding={handleToggleFinding}
          deterministicDiffs={deterministicDiffs}
          aiPreviews={aiPreviews}
          generatingFindingId={generatingFindingId}
          onGeneratePreview={handleGeneratePreview}
          onAcceptPreview={handleAcceptPreview}
          onRejectPreview={handleRejectPreview}
          onSkipAll={handleSkipSuggestions}
          onContinue={applyReviewedFixesAndContinue}
        />
      ) : phase === 'pick' ? (
        /* File Selection View */
        <div className="space-y-4">
          {/* Normalization toggle */}
          <label className="flex items-start gap-2.5 p-3 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-lg cursor-pointer hover:border-[var(--color-primary)]/50 transition-colors">
            <input
              type="checkbox"
              checked={standardizeFormatting}
              onChange={(e) => setStandardizeFormatting(e.target.checked)}
              className="mt-0.5 accent-[var(--color-primary)]"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--color-text-primary)]">
                <Sparkles size={14} className="text-[var(--color-primary)]" />
                Standardize formatting
              </div>
              <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                Convert curly quotes to straight, <code>_italics_</code> to <code>*italics*</code>, and normalize dashes.
                Junk whitespace and duplicate tags are always cleaned up.
              </p>
            </div>
          </label>

          {/* Drop Zone */}
          <div
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            className="border-2 border-dashed border-[var(--color-border)] rounded-xl p-8 text-center hover:border-[var(--color-primary)] transition-colors cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={48} className="mx-auto text-[var(--color-text-secondary)] mb-4" />
            <p className="text-[var(--color-text-primary)] font-medium mb-2">
              Drop character file(s) here
            </p>
            <p className="text-sm text-[var(--color-text-secondary)] mb-4">
              or click to browse &mdash; you can drop a PNG and lorebook JSON together
            </p>
            <div className="flex justify-center gap-4 text-xs text-[var(--color-text-secondary)]">
              <span className="flex items-center gap-1">
                <FileImage size={14} />
                PNG (Character Card)
              </span>
              <span className="flex items-center gap-1">
                <FileJson size={14} />
                JSON (character or lorebook)
              </span>
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".png,.json,image/png,application/json"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />

          {/* Loading State */}
          {isImporting && (
            <div className="flex items-center justify-center py-4">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--color-primary)]" />
              <span className="ml-2 text-[var(--color-text-secondary)]">
                Reading character file...
              </span>
            </div>
          )}

          {/* Lorebook Detection */}
          {lorebookDetected && !lorebookImported && (
            <div className="p-4 bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/40 rounded-lg space-y-3">
              <div className="flex items-start gap-2.5 text-sm text-[var(--color-text-primary)]">
                <BookOpen size={18} className="text-[var(--color-primary)] shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">This is a lorebook / world-info file</p>
                  <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                    Contains {lorebookDetected.entryCount} entr{lorebookDetected.entryCount === 1 ? 'y' : 'ies'} — not a character card.
                    You can import it as a lorebook and link it to a character later.
                  </p>
                </div>
              </div>
              <Button variant="primary" onClick={handleImportAsLorebook} className="w-full">
                <BookOpen size={16} />
                Import as Lorebook
              </Button>
            </div>
          )}

          {/* Lorebook Imported Success */}
          {lorebookImported && (
            <div className="p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm">
              Lorebook imported successfully! You can find it in Settings &rarr; World Info / Lorebook.
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Cancel Button */}
          <div className="flex justify-end pt-4 border-t border-[var(--color-border)]">
            <Button variant="secondary" onClick={handleClose}>
              {lorebookImported ? 'Done' : 'Cancel'}
            </Button>
          </div>
        </div>
      ) : (
        /* Character Edit Form */
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Cleanup summary */}
          {importChanges.length > 0 && (
            <div className="p-3 bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/40 rounded-lg text-sm">
              <div className="flex items-center gap-1.5 text-[var(--color-primary)] font-medium mb-1">
                <Sparkles size={14} />
                Cleaned up on import
              </div>
              <ul className="text-xs text-[var(--color-text-secondary)] list-disc list-inside space-y-0.5">
                {importChanges.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Warnings */}
          {importWarnings.length > 0 && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/40 rounded-lg text-sm">
              <div className="flex items-center gap-1.5 text-amber-400 font-medium mb-1">
                <AlertTriangle size={14} />
                Heads up
              </div>
              <ul className="text-xs text-[var(--color-text-secondary)] list-disc list-inside space-y-0.5">
                {importWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Ignored extra files */}
          {importIgnoredFiles.length > 0 && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/40 rounded-lg text-sm">
              <div className="flex items-center gap-1.5 text-amber-400 font-medium mb-1">
                <AlertTriangle size={14} />
                Only the first file of each type was imported
              </div>
              <ul className="text-xs text-[var(--color-text-secondary)] list-disc list-inside space-y-0.5">
                {importIgnoredFiles.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Success Message */}
          <div className="p-3 bg-green-500/20 border border-green-500/50 rounded-lg text-green-400 text-sm flex items-center justify-between">
            <span>Character data loaded successfully!</span>
            <button
              type="button"
              onClick={() => {
                setImportedData(null);
                setImportedBook(null);
                setAvatarFile(null);
                if (avatarPreview) {
                  URL.revokeObjectURL(avatarPreview);
                }
                setAvatarPreview(null);
                setAlternateGreetings([]);
                resetAnalysisState();
              }}
              className="p-1 hover:bg-green-500/20 rounded"
            >
              <X size={16} />
            </button>
          </div>

          {/* Embedded Lorebook Notice */}
          {importedBook && (
            <div className="p-3 bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/40 rounded-lg flex items-center gap-2.5 text-sm text-[var(--color-text-primary)]">
              <BookOpen size={16} className="text-[var(--color-primary)] shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium">Embedded lorebook detected</p>
                <p className="text-xs text-[var(--color-text-secondary)] truncate">
                  {importedBook.name || 'Character Lorebook'} ·{' '}
                  {importedBook.entries?.length ?? 0} entr
                  {(importedBook.entries?.length ?? 0) === 1 ? 'y' : 'ies'} — will
                  auto-activate when this character is selected.
                </p>
              </div>
            </div>
          )}

          {/* Avatar */}
          <ImageUpload
            currentImage={avatarPreview || undefined}
            onImageSelect={handleAvatarChange}
            label="Avatar"
          />

          {/* Name - Required */}
          <Input
            label="Name *"
            placeholder="Character's name"
            value={formData.name}
            onChange={handleChange('name')}
            required
            autoFocus
          />

          {/* Description */}
          <TextArea
            label="Description"
            placeholder="Describe the character's appearance, background, and other details..."
            value={formData.description}
            onChange={handleChange('description')}
            rows={3}
          />

          {/* Personality */}
          <TextArea
            label="Personality"
            placeholder="Character's personality traits, mannerisms, speech patterns..."
            value={formData.personality}
            onChange={handleChange('personality')}
            rows={3}
          />

          {/* First Message */}
          <TextArea
            label="First Message"
            placeholder="The character's opening message when starting a new chat..."
            value={formData.firstMessage}
            onChange={handleChange('firstMessage')}
            rows={4}
          />

          {/* Alternate Greetings — additional opening messages the user can
              swipe between. Pre-populated from the imported card. */}
          <AlternateGreetingsEditor
            greetings={alternateGreetings}
            onChange={setAlternateGreetings}
          />

          {/* Scenario */}
          <TextArea
            label="Scenario"
            placeholder="The setting or context for conversations..."
            value={formData.scenario}
            onChange={handleChange('scenario')}
            rows={2}
          />

          {/* Collapsible Advanced Section */}
          <details className="group">
            <summary className="cursor-pointer text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] py-2">
              Advanced Options
            </summary>

            <div className="space-y-4 mt-2 pl-2 border-l-2 border-[var(--color-border)]">
              {/* Example Messages */}
              <TextArea
                label="Example Messages"
                placeholder="Example dialogue to help the AI understand the character's voice..."
                value={formData.exampleMessages}
                onChange={handleChange('exampleMessages')}
                rows={4}
              />

              {/* Creator Notes */}
              <TextArea
                label="Creator Notes"
                placeholder="Notes about the character for other users..."
                value={formData.creatorNotes}
                onChange={handleChange('creatorNotes')}
                rows={2}
              />

              {/* Creator */}
              <Input
                label="Creator"
                placeholder="Your name or handle"
                value={formData.creator}
                onChange={handleChange('creator')}
              />

              {/* Tags */}
              <TagInput
                label="Tags"
                value={formData.tags}
                onChange={(tags) => setFormData((prev) => ({ ...prev, tags }))}
                suggestions={getAllTags()}
              />
            </div>
          </details>

          {/* Error Message */}
          {error && (
            <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-4 border-t border-[var(--color-border)]">
            <Button
              type="button"
              variant="secondary"
              onClick={handleClose}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              isLoading={isCreating}
              disabled={!formData.name.trim()}
              className="flex-1"
            >
              Import Character
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
