import { describe, expect, it } from 'vitest'
import { findUnresolvedMacros, processMacros, type MacroContext } from './macros'

describe('processMacros', () => {
  it('substitutes identity macros from context', () => {
    const ctx: MacroContext = { charName: 'Mina', userName: 'Sammy' }
    expect(processMacros('{{char}} greets {{user}}', ctx)).toBe('Mina greets Sammy')
  })

  it('falls back to persona name, then "User", for {{user}}', () => {
    expect(processMacros('{{user}}', { personaName: 'Bailey' })).toBe('Bailey')
    expect(processMacros('{{user}}', {})).toBe('User')
  })

  it('leaves unknown macros intact for debugging', () => {
    expect(processMacros('{{notamacro}}', {})).toBe('{{notamacro}}')
  })

  describe('{{calc}}', () => {
    it('evaluates arithmetic with precedence and parens', () => {
      expect(processMacros('{{calc::2+3*4}}', {})).toBe('14')
      expect(processMacros('{{calc::(2+3)*4}}', {})).toBe('20')
      expect(processMacros('{{calc::-3+1}}', {})).toBe('-2')
    })

    it('returns empty string for division by zero and invalid input', () => {
      expect(processMacros('{{calc::1/0}}', {})).toBe('0')
      expect(processMacros('{{calc::1+alert(1)}}', {})).toBe('')
      expect(processMacros('{{calc::}}', {})).toBe('')
    })
  })

  describe('{{if}} blocks', () => {
    it('takes the then-branch when the condition holds', () => {
      expect(processMacros('{{if::1==1}}yes{{else}}no{{/if}}', {})).toBe('yes')
      expect(processMacros('{{if::abc contains b}}yes{{/if}}', {})).toBe('yes')
    })

    it('takes the else-branch (or empty) when it does not', () => {
      expect(processMacros('{{if::1==2}}yes{{else}}no{{/if}}', {})).toBe('no')
      expect(processMacros('{{if::1==2}}yes{{/if}}', {})).toBe('')
    })

    it('resolves macros inside the condition', () => {
      const ctx: MacroContext = { variables: { mood: 'happy' } }
      expect(processMacros('{{if::{{getvar::mood}}==happy}}:){{else}}:({{/if}}', ctx)).toBe(':)')
    })
  })

  describe('variables', () => {
    it('setvar mutates ctx.variables and getvar reads it back', () => {
      const ctx: MacroContext = { variables: {} }
      expect(processMacros('{{setvar::x::5}}got {{getvar::x}}', ctx)).toBe('got 5')
      expect(ctx.variables).toEqual({ x: '5' })
    })

    it('addvar/incvar/decvar treat missing values as 0', () => {
      const ctx: MacroContext = { variables: {} }
      processMacros('{{addvar::a::3}}', ctx)
      expect(ctx.variables!.a).toBe('3')
      expect(processMacros('{{incvar::b}}/{{decvar::c}}', ctx)).toBe('1/-1')
    })

    it('resolves nested macros inside-out, e.g. calc over getvar', () => {
      const ctx: MacroContext = { variables: { x: '6' } }
      expect(processMacros('{{calc::{{getvar::x}}*2}}', ctx)).toBe('12')
    })
  })
})

describe('findUnresolvedMacros', () => {
  it('lists remaining {{...}} patterns after processing', () => {
    expect(findUnresolvedMacros('a {{foo}} b {{bar::1}}')).toEqual(['foo', 'bar::1'])
    expect(findUnresolvedMacros('clean text')).toEqual([])
  })
})
