// Gathering the inputs an ingestion run needs (story-state phase 6).
//
// Lives in the components layer on purpose: this is the one place that
// reaches across chatStore/characterStore/personaStore/worldInfoStore to
// assemble a plain snapshot. Keeping it here means `storyIngestStore`
// and the passes stay free of those imports — and specifically free of
// the static `chatStore` edge that would re-enter the lovenseStore
// module-init cycle and TDZ-crash the app.

import { api, type ProjectChatRef } from '../../api/client';
import type { CharacterInfo } from '../../api/client';
import type { Persona } from '../../stores/personaStore';
import type { WorldInfoBook } from '../../stores/worldInfoStore';
import type { ReplayEntry } from '../../utils/storyIngest/wiReplay';
import type {
  ColdStartSources,
  IngestMessage,
} from '../../utils/storyIngest/types';

/** Resolve a card field that may live top-level or under `data`. A local
 *  copy of chatStore's helper — importing it would drag that store (and
 *  its init cycle) into the ingestion path. */
function cardField(character: CharacterInfo | null, field: string): string {
  if (!character) return '';
  const top = (character as unknown as Record<string, unknown>)[field];
  if (typeof top === 'string' && top.trim()) return top;
  const data = character.data as Record<string, unknown> | undefined;
  const nested = data?.[field];
  if (typeof nested === 'string' && nested.trim()) return nested;
  return '';
}

export function gatherColdStartSources(
  character: CharacterInfo | null,
  avatar: string,
  persona: Persona | null,
  books: WorldInfoBook[]
): ColdStartSources {
  return {
    characterName: character?.name || avatar.replace(/\.(png|webp|jpe?g)$/i, ''),
    characterAvatar: avatar,
    description: cardField(character, 'description'),
    personality: cardField(character, 'personality'),
    scenario: cardField(character, 'scenario'),
    mesExample: cardField(character, 'mes_example'),
    firstMessage: cardField(character, 'first_mes'),
    persona: persona
      ? { name: persona.name, description: persona.description }
      : null,
    lorebooks: books.map((book) => ({
      bookId: book.id,
      bookName: book.name,
      entries: book.entries.map((e) => ({
        id: e.id,
        keys: e.keys,
        content: e.content,
        constant: e.constant,
        enabled: e.enabled,
      })),
    })),
  };
}

export function replayEntriesFrom(books: WorldInfoBook[]): ReplayEntry[] {
  return books.flatMap((book) =>
    book.entries.map((e) => ({
      id: e.id,
      bookId: book.id,
      keys: e.keys,
      secondaryKeys: (e as unknown as { secondaryKeys?: string[] }).secondaryKeys,
      content: e.content,
      enabled: e.enabled,
      constant: e.constant,
      caseSensitive: e.caseSensitive,
      scanDepth: (e as unknown as { scanDepth?: number | null }).scanDepth ?? null,
    }))
  );
}

export interface GatheredIngestInputs {
  messages: IngestMessage[];
  capturedWiFired: unknown;
}

/**
 * Read the source chat straight from the server rather than whatever is
 * loaded in the UI: the bible's source chat is frequently NOT the chat
 * the user currently has open, and the header — which carries the phase-0
 * `wi_fired` telemetry — is stripped by the ordinary message fetch.
 */
export async function gatherIngestInputs(
  chat: ProjectChatRef
): Promise<GatheredIngestInputs> {
  const { header, messages } = await api.getChatWithHeader(
    chat.character_avatar,
    chat.file_name
  );

  const out: IngestMessage[] = [];
  for (const raw of messages) {
    const m = raw as unknown as {
      name?: string;
      is_user?: boolean;
      is_system?: boolean;
      mes?: string;
      send_date?: number;
      swipe_id?: number;
      swipes?: string[];
      extra?: { ggbc_id?: unknown };
    };
    const id = typeof m.extra?.ggbc_id === 'string' ? m.extra.ggbc_id : '';
    // A message with no permanent id predates phases 1–2 and can't be
    // referenced by the bible; the server heals ids on every save, so
    // this only shows up for a chat that hasn't been written since.
    if (!id) continue;
    const swipeIdx = typeof m.swipe_id === 'number' ? m.swipe_id : 0;
    const content =
      Array.isArray(m.swipes) && m.swipes[swipeIdx] !== undefined
        ? m.swipes[swipeIdx]
        : (m.mes ?? '');
    out.push({
      id,
      name: m.name ?? '',
      isUser: !!m.is_user,
      isSystem: !!m.is_system,
      content: content ?? '',
      timestamp: typeof m.send_date === 'number' ? m.send_date : 0,
      swipeIdx,
    });
  }

  return {
    messages: out,
    capturedWiFired: (header as Record<string, unknown> | null)?.wi_fired,
  };
}
