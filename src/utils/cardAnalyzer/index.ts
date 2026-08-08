// Card analyzer — public surface.
//
// analyzeCard() composes every detector into one AnalysisReport. Everything
// from types.ts / detectFormat.ts / detectors.ts / deterministicFixes.ts is
// re-exported here so a caller only needs one import:
//
//   import { analyzeCard, applyAllDeterministicFixes } from './cardAnalyzer';

import { detectSourceFormat } from './detectFormat';
import {
  detectFormatFinding,
  detectMacroFindings,
  detectExampleFindings,
  detectMissingFieldFindings,
  detectTokenFindings,
  detectLoreEmbeddedFinding,
  detectGreetingIssues,
} from './detectors';
import type { AnalyzableCardData, AnalysisReport, Finding } from './types';

export function analyzeCard(
  card: AnalyzableCardData,
  characterName: string
): AnalysisReport {
  const sourceFormat = detectSourceFormat(card);
  const tokens = detectTokenFindings(card);
  const loreFinding = detectLoreEmbeddedFinding(card);

  const findings: Finding[] = [
    ...detectFormatFinding(card, sourceFormat),
    ...detectMacroFindings(card, characterName),
    ...detectExampleFindings(card),
    ...detectMissingFieldFindings(card),
    ...tokens.findings,
    ...detectGreetingIssues(card),
    ...(loreFinding ? [loreFinding] : []),
  ];

  return {
    sourceFormat,
    findings,
    fieldTokens: tokens.fieldTokens,
    totalPermanentTokens: tokens.totalPermanentTokens,
  };
}

export * from './types';
export * from './detectFormat';
export * from './detectors';
export * from './deterministicFixes';
