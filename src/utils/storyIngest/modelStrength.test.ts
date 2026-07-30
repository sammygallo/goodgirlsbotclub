import { describe, it, expect } from 'vitest';
import { isWeakModel } from './modelStrength';

describe('isWeakModel', () => {
  it('flags common budget/small-tier naming across providers', () => {
    expect(isWeakModel('gpt-4o-mini')).toBe(true);
    expect(isWeakModel('gpt-4.1-nano')).toBe(true);
    expect(isWeakModel('claude-haiku-4-5-20251001')).toBe(true);
    expect(isWeakModel('gemini-2.0-flash-lite')).toBe(true);
    expect(isWeakModel('gemini-nano')).toBe(true);
    expect(isWeakModel('mistral-small-latest')).toBe(true);
    expect(isWeakModel('gpt-3.5-turbo-instant')).toBe(true);
  });

  it('flags single-digit open-weight parameter counts', () => {
    expect(isWeakModel('llama-3.1-8b-instruct')).toBe(true);
    expect(isWeakModel('llama-3.2-3b')).toBe(true);
    expect(isWeakModel('llama-3.2-1b')).toBe(true);
    expect(isWeakModel('qwen2.5-7b-instruct')).toBe(true);
    expect(isWeakModel('ministral-8b-latest')).toBe(true);
    expect(isWeakModel('phi-3.5-mini')).toBe(true);
  });

  it('does not flag frontier/large models', () => {
    expect(isWeakModel('gpt-4o')).toBe(false);
    expect(isWeakModel('gpt-4.1')).toBe(false);
    expect(isWeakModel('claude-opus-5')).toBe(false);
    expect(isWeakModel('claude-sonnet-5')).toBe(false);
    expect(isWeakModel('gemini-2.0-pro')).toBe(false);
    expect(isWeakModel('llama-3.1-70b-instruct')).toBe(false);
    expect(isWeakModel('llama-3.1-405b-instruct')).toBe(false);
    expect(isWeakModel('mixtral-8x7b')).toBe(false);
    expect(isWeakModel('qwen2.5-32b-instruct')).toBe(false);
  });

  it('does not false-positive on substrings that merely contain a pattern', () => {
    // "gemini" contains "mini" as a substring but is not word-bounded.
    expect(isWeakModel('gemini-2.0-flash')).toBe(false);
    expect(isWeakModel('gemini-1.5-pro')).toBe(false);
  });

  it('does not false-positive on two-digit-plus parameter counts', () => {
    expect(isWeakModel('llama-2-13b-chat')).toBe(false);
    expect(isWeakModel('command-r-plus-104b')).toBe(false);
  });

  it('is false for an empty or missing model id', () => {
    expect(isWeakModel(null)).toBe(false);
    expect(isWeakModel(undefined)).toBe(false);
    expect(isWeakModel('')).toBe(false);
  });
});
