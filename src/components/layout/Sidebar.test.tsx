/**
 * @vitest-environment jsdom
 *
 * The Sidebar's local group-select mode against a selection made from outside
 * it. The hero (E6-S2) can select a character while the sidebar is mid-way
 * through picking group members, and selecting must end that mode the way the
 * cancel button and startGroupChat do — otherwise "Switch character" later opens
 * the list still in group-select, where a row click toggles membership instead
 * of choosing a character.
 *
 * The sidebar is rendered with its store actions stubbed and `fetch` refused,
 * so nothing here reaches a network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CharacterInfo } from '../../api/client';
import { useCharacterStore } from '../../stores/characterStore';
import { Sidebar } from './Sidebar';

const initial = useCharacterStore.getState();

const ivy = { name: 'Ivy', avatar: 'ivy.png' } as CharacterInfo;
const rose = { name: 'Rose', avatar: 'rose.png' } as CharacterInfo;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
  useCharacterStore.setState({
    characters: [ivy, rose],
    charactersLoaded: true,
    isLoading: false,
    selectedCharacter: null,
    groupChatCharacters: [],
    isGroupChatMode: false,
    fetchCharacters: vi.fn(async () => {}),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useCharacterStore.setState(initial, true);
});

describe('group selection and an outside selection', () => {
  it('ends group-select when a character is selected, so Switch character opens the normal list', () => {
    render(<Sidebar isOpen onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start group chat' }));
    expect(screen.getByRole('heading', { name: 'Group Chat (0)' })).toBeTruthy();

    // What the hero's Chat button does: select one character, clearing the picks.
    act(() => {
      useCharacterStore.setState({ selectedCharacter: ivy, groupChatCharacters: [] });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Switch character' }));

    expect(screen.queryByText(/^Group Chat \(/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Characters' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel group selection' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Start group chat' })).toBeTruthy();
  });

  it('chooses the character on a row click once the list is back, rather than toggling group membership', () => {
    const selectCharacter = vi.fn(async () => {});
    useCharacterStore.setState({ selectCharacter });
    render(<Sidebar isOpen onClose={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start group chat' }));
    act(() => {
      useCharacterStore.setState({ selectedCharacter: ivy, groupChatCharacters: [] });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Switch character' }));
    fireEvent.click(screen.getByText('Rose'));

    expect(selectCharacter).toHaveBeenCalledWith('rose.png');
    expect(useCharacterStore.getState().groupChatCharacters).toEqual([]);
  });
});
