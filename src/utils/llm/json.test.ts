import { describe, it, expect } from 'vitest';
import { extractJsonObjects, firstJsonObject, asString, asStringList } from './json';

describe('extractJsonObjects', () => {
  it('extracts a single clean object', () => {
    const result = extractJsonObjects('{"a": 1}');
    expect(result).toEqual(['{"a": 1}']);
  });

  it('extracts two top-level objects separated by prose, in order', () => {
    const result = extractJsonObjects('Sure! {"a":1} and also {"b":2} done.');
    expect(result).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('extracts an object wrapped in a markdown fence', () => {
    const result = extractJsonObjects('```json\n{"a":1}\n```');
    expect(result).toEqual(['{"a":1}']);
  });

  it('returns the whole outer object for nested objects, not the inner ones separately', () => {
    const result = extractJsonObjects('{"a": {"b": {"c": 1}}}');
    expect(result).toEqual(['{"a": {"b": {"c": 1}}}']);
  });

  it('does not let a brace inside a string value confuse the depth counter', () => {
    const input = '{"a": "text with { and } inside"}';
    const result = extractJsonObjects(input);
    expect(result).toEqual([input]);
    expect(() => JSON.parse(result[0])).not.toThrow();
    expect(JSON.parse(result[0])).toEqual({ a: 'text with { and } inside' });
  });

  it('does not let an escaped quote prematurely end the in-string state', () => {
    const input = '{"a": "she said \\"hi\\""}';
    const result = extractJsonObjects(input);
    expect(result).toEqual([input]);
    expect(() => JSON.parse(result[0])).not.toThrow();
    expect(JSON.parse(result[0])).toEqual({ a: 'she said "hi"' });
  });

  it('contributes nothing for output truncated mid-object with no closing brace', () => {
    const result = extractJsonObjects('{"a": 1, "b": 2');
    expect(result).toEqual([]);
  });

  it('keeps a complete first object when a second object is truncated', () => {
    const result = extractJsonObjects('{"a":1} {"b": incomplete');
    expect(result).toEqual(['{"a":1}']);
  });

  it('returns an empty array when there are no braces at all', () => {
    const result = extractJsonObjects('just some plain prose, no json here');
    expect(result).toEqual([]);
  });

  it('does not throw on an unbalanced closing brace and recovers the valid trailing object', () => {
    const result = extractJsonObjects('oops } {"a":1}');
    expect(result).toEqual(['{"a":1}']);
  });
});

describe('firstJsonObject', () => {
  it('returns the parsed object (not the raw string) for clean input', () => {
    const result = firstJsonObject('{"a": 1}');
    expect(result).toEqual({ a: 1 });
  });

  it('returns the first object when multiple are present', () => {
    const result = firstJsonObject('{"a":1} {"b":2}');
    expect(result).toEqual({ a: 1 });
  });

  it('skips a brace-balanced but malformed chunk and returns the next valid object', () => {
    const result = firstJsonObject('{a: 1} {"b": 2}');
    expect(result).toEqual({ b: 2 });
  });

  it('returns null for a top-level JSON array, since the scanner only tracks curly braces', () => {
    const result = firstJsonObject('[1,2,3]');
    expect(result).toBeNull();
  });

  it('returns null for an empty string', () => {
    const result = firstJsonObject('');
    expect(result).toBeNull();
  });

  it('returns null when no parseable object exists anywhere', () => {
    const result = firstJsonObject('{a: 1} {b: 2} not json at all');
    expect(result).toBeNull();
  });
});

describe('asString', () => {
  it('returns a normal short string trimmed as-is', () => {
    expect(asString('hello')).toBe('hello');
  });

  it('trims leading and trailing whitespace', () => {
    expect(asString('  hello  ')).toBe('hello');
  });

  it('truncates a string longer than the default max (200) to exactly 200 chars', () => {
    const long = 'x'.repeat(250);
    const result = asString(long);
    expect(result).toHaveLength(200);
    expect(result).toBe('x'.repeat(200));
  });

  it('respects a custom max parameter', () => {
    expect(asString('abcdefghij', 5)).toBe('abcde');
  });

  it('returns an empty string for non-string inputs', () => {
    expect(asString(42)).toBe('');
    expect(asString(null)).toBe('');
    expect(asString(undefined)).toBe('');
    expect(asString({ a: 1 })).toBe('');
  });
});

describe('asStringList', () => {
  it('returns an array of strings, trimmed, each capped at 120 chars by default', () => {
    const long = 'y'.repeat(150);
    const result = asStringList(['  hello  ', long]);
    expect(result[0]).toBe('hello');
    expect(result[1]).toHaveLength(120);
    expect(result[1]).toBe('y'.repeat(120));
  });

  it('filters out empty and whitespace-only strings', () => {
    const result = asStringList(['a', '', '   ', 'b']);
    expect(result).toEqual(['a', 'b']);
  });

  it('filters out non-string elements mixed into the array', () => {
    const result = asStringList(['a', 42, null, undefined, { x: 1 }, 'b', ['nested']]);
    expect(result).toEqual(['a', 'b']);
  });

  it('truncates a longer array to exactly 12 items by default', () => {
    const input = Array.from({ length: 20 }, (_, i) => `item${i}`);
    const result = asStringList(input);
    expect(result).toHaveLength(12);
    expect(result).toEqual(input.slice(0, 12));
  });

  it('respects a custom max count parameter', () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    const result = asStringList(input, 2);
    expect(result).toEqual(['a', 'b']);
  });

  it('returns an empty array for non-array input', () => {
    expect(asStringList('not an array')).toEqual([]);
    expect(asStringList({ a: 1 })).toEqual([]);
    expect(asStringList(null)).toEqual([]);
    expect(asStringList(undefined)).toEqual([]);
  });
});
