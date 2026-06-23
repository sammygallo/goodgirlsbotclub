// STscript executor — runs parsed pipelines with scope stack,
// pipe threading, macro expansion, and control flow.

import type {
  ParsedPipeline,
  ParsedArg,
  ExecutionContext,
  Scope,
} from './types';
import { parsePipeline } from './parser';
import { getCommand } from './registry';
import { processMacros, type MacroContext } from '../macros';
import { getUICallbacks } from './uiCallbacks';
import { useChatStore } from '../../stores/chatStore';
import { getSettingsBlob, patchServerKey, markSectionDirty, recordServerTs, shouldReuploadSection } from '../serverSettings';

const MAX_LOOP_ITERATIONS = 100;
const MAX_RECURSION_DEPTH = 10;
const GLOBAL_VARS_KEY = 'stm:global-vars';
// Cross-device sync of STscript global variables via `stm_stscript_globals`.
const GLOBALS_SERVER_KEY = 'stm_stscript_globals';
const GLOBALS_LOCAL_TS_KEY = 'stm:stscript-globals-local-ts';

// ───── Global variable persistence ─────

function loadGlobalVars(): Record<string, string> {
  try {
    const stored = localStorage.getItem(GLOBAL_VARS_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch { return {}; }
}

function writeGlobalVarsLocal(vars: Record<string, string>): void {
  try {
    localStorage.setItem(GLOBAL_VARS_KEY, JSON.stringify(vars));
  } catch { /* ignore quota */ }
}

function saveGlobalVars(vars: Record<string, string>): void {
  writeGlobalVarsLocal(vars);
  markSectionDirty(GLOBALS_LOCAL_TS_KEY);
  patchServerKey(GLOBALS_SERVER_KEY, { vars }, GLOBALS_LOCAL_TS_KEY).catch(() => {});
}

/**
 * Reconcile STscript global variables with the server after login. Mirrors the
 * synced-store fetchPrefs pattern: re-upload pending local edits, otherwise
 * adopt the server's copy into localStorage. Called from authStore.
 */
export async function syncGlobalVarsFromServer(): Promise<void> {
  try {
    const settings = await getSettingsBlob();
    const section = settings[GLOBALS_SERVER_KEY] as
      | { vars?: Record<string, string>; _ts?: number }
      | undefined;
    const serverTs = Number(section?._ts || 0);
    if (shouldReuploadSection(GLOBALS_LOCAL_TS_KEY, serverTs)) {
      patchServerKey(GLOBALS_SERVER_KEY, { vars: loadGlobalVars() }, GLOBALS_LOCAL_TS_KEY).catch(() => {});
      return;
    }
    if (section && section.vars && typeof section.vars === 'object') {
      writeGlobalVarsLocal(section.vars);
      try { recordServerTs(GLOBALS_LOCAL_TS_KEY, serverTs); } catch { /* ignore */ }
    }
  } catch { /* non-fatal — localStorage values remain active */ }
}

// ───── Scope helpers ─────

export function createScope(parent: Scope | null = null): Scope {
  return { locals: {}, parent };
}

/** Walk scope chain upward to find a variable. */
export function resolveVariable(name: string, scope: Scope): string | undefined {
  let s: Scope | null = scope;
  while (s) {
    if (name in s.locals) return s.locals[name];
    s = s.parent;
  }
  return undefined;
}

/** Collect all scope variables (for {{var::name}} macro expansion). */
function collectScopeVars(scope: Scope): Record<string, string> {
  const result: Record<string, string> = {};
  const chain: Scope[] = [];
  let s: Scope | null = scope;
  while (s) { chain.push(s); s = s.parent; }
  // Walk from root to leaf so closer scopes shadow ancestors
  for (let i = chain.length - 1; i >= 0; i--) {
    Object.assign(result, chain[i].locals);
  }
  return result;
}

// ───── Macro expansion for STscript ─────

function buildMacroContext(ctx: ExecutionContext): MacroContext {
  let lastMessage = '';
  let lastMessageId = '';
  try {
    const messages = useChatStore.getState().messages;
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      lastMessage = last.content || '';
      lastMessageId = String(messages.length - 1);
    }
  } catch { /* not available */ }

  return {
    variables: ctx.chatVariables,
    extra: {
      pipe: ctx.pipe,
      timesIndex: String(ctx.timesIndex),
      input: ctx.originalInput,
      lastMessageId,
      lastMessage,
      __scopeVars: JSON.stringify(collectScopeVars(ctx.scope)),
    },
  };
}

function expandMacros(text: string, ctx: ExecutionContext): string {
  if (!text) return text;
  return processMacros(text, buildMacroContext(ctx));
}

// ───── Closure helpers ─────

/** Check if a value is a closure literal {: ... :} */
export function isClosure(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{:') && trimmed.endsWith(':}');
}

/** Strip {: :} delimiters from a closure literal. */
export function unwrapClosure(value: string): string {
  const trimmed = value.trim();
  return trimmed.slice(2, -2).trim();
}

/** Execute a closure string in a child scope. */
export async function executeClosure(
  source: string,
  ctx: ExecutionContext,
): Promise<string> {
  if (ctx.recursionDepth >= MAX_RECURSION_DEPTH) {
    ctx.showToast('Max recursion depth exceeded', 'error');
    ctx.abortSignal = { type: 'error', message: 'Max recursion depth exceeded' };
    return '';
  }

  const childScope = createScope(ctx.scope);
  const childCtx: ExecutionContext = {
    ...ctx,
    scope: childScope,
    recursionDepth: ctx.recursionDepth + 1,
    abortSignal: null,
  };

  const pipeline = parsePipeline(source);
  const result = await executePipeline(pipeline, childCtx);

  // Propagate abort/return signals up (but not break — break stops at the loop level)
  if (childCtx.abortSignal) {
    if (childCtx.abortSignal.type === 'abort' || childCtx.abortSignal.type === 'error') {
      ctx.abortSignal = childCtx.abortSignal;
    } else if (childCtx.abortSignal.type === 'return') {
      return childCtx.abortSignal.value;
    } else if (childCtx.abortSignal.type === 'break') {
      ctx.abortSignal = childCtx.abortSignal;
      return childCtx.abortSignal.value;
    }
  }

  // Sync variables back
  ctx.chatVariables = childCtx.chatVariables;
  ctx.globalVariables = childCtx.globalVariables;

  return result;
}

// ───── Pipeline execution ─────

export async function executePipeline(
  pipeline: ParsedPipeline,
  ctx: ExecutionContext,
): Promise<string> {
  let pipeValue = ctx.pipe;

  for (let i = 0; i < pipeline.commands.length; i++) {
    if (ctx.abortSignal) break;

    const cmd = pipeline.commands[i];

    // Expand macros in all arg values and rawArgs
    const expandedArgs: ParsedArg[] = cmd.args.map(a => ({
      key: a.key,
      value: isClosure(a.value) ? a.value : expandMacros(a.value, ctx),
    }));
    const expandedRawArgs = expandMacros(cmd.rawArgs, ctx);

    // Auto-pipe injection: if not breakPipe and not first command,
    // prepend pipe value to unnamed args (unless rawArgs references {{pipe}})
    if (i > 0 && !cmd.breakPipe) {
      const hasPipeRef = cmd.rawArgs.toLowerCase().includes('{{pipe}}');
      if (!hasPipeRef && pipeValue) {
        expandedArgs.unshift({ value: pipeValue });
      }
    }

    // Look up command handler
    const def = getCommand(cmd.name);
    if (!def) {
      ctx.showToast(`Unknown command: /${cmd.name}`, 'error');
      pipeValue = '';
      ctx.pipe = pipeValue;
      continue;
    }

    // Execute handler
    try {
      const result = await def.handler(expandedArgs, expandedRawArgs, ctx);
      pipeValue = result;
      ctx.pipe = pipeValue;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.showToast(`Error in /${cmd.name}: ${msg}`, 'error');
      ctx.abortSignal = { type: 'error', message: msg };
      break;
    }
  }

  return pipeValue;
}

// ───── Top-level entry point ─────

export async function executeSlashCommand(
  input: string,
  ctx: ExecutionContext,
): Promise<string> {
  const pipeline = parsePipeline(input);
  if (pipeline.commands.length === 0) return '';

  const result = await executePipeline(pipeline, ctx);

  // Persist variables
  try {
    const state = useChatStore.getState();
    const chatFile = state.currentChatFile;
    if (chatFile) {
      state.setChatVariables(chatFile, ctx.chatVariables);
    }
  } catch { /* not available */ }
  saveGlobalVars(ctx.globalVariables);

  return result;
}

// ───── Context factory ─────

export function buildExecutionContext(
  overrides?: Partial<ExecutionContext>,
): ExecutionContext {
  const cbs = getUICallbacks();

  // Load current chat variables
  let chatVariables: Record<string, string> = {};
  try {
    const state = useChatStore.getState();
    const chatFile = state.currentChatFile;
    if (chatFile) {
      chatVariables = { ...state.getChatVariables(chatFile) };
    }
  } catch { /* not available */ }

  return {
    pipe: '',
    scope: createScope(),
    chatVariables,
    globalVariables: loadGlobalVars(),
    timesIndex: -1,
    originalInput: '',
    abortSignal: null,
    recursionDepth: 0,
    showToast: cbs.showToast,
    setInputText: cbs.setInputText,
    showPopup: cbs.showPopup,
    showInputPrompt: cbs.showInputPrompt,
    navigate: cbs.navigate,
    ...overrides,
  };
}

// Re-export for loop use in commands
export { MAX_LOOP_ITERATIONS, MAX_RECURSION_DEPTH };
