import { describe, expect, it } from 'vitest'
import type { SkillRecord } from '../src/types'
import { cycleSuggestionIndex, findSlashSkillRange, replaceExactSlashSkill } from '../src/ui/skillInsertion'

const PLAN_SKILL: SkillRecord = {
  id: 'plan-first',
  name: 'plan-first',
  content: 'Plan and implement it properly.',
  origin: 'system',
  createdAt: '2026-05-22T00:00:00.000Z',
  updatedAt: '2026-05-22T00:00:00.000Z',
}

describe('slash skill insertion', () => {
  it('replaces an exact slash skill token at the caret', () => {
    const input = 'Context\n\n/plan-first'
    const replacement = replaceExactSlashSkill(input, input.length, [PLAN_SKILL])

    expect(replacement).toMatchObject({
      value: 'Context\n\nPlan and implement it properly.',
      caretIndex: 'Context\n\nPlan and implement it properly.'.length,
      skill: PLAN_SKILL,
    })
  })

  it('detects partial slash tokens only at token boundaries', () => {
    expect(findSlashSkillRange('Use /plan', 'Use /plan'.length)).toMatchObject({
      start: 4,
      query: 'plan',
    })
    expect(findSlashSkillRange('https://codex/plan', 'https://codex/plan'.length)).toBeNull()
    expect(replaceExactSlashSkill('Use /plan', 'Use /plan'.length, [PLAN_SKILL])).toBeNull()
  })

  it('cycles keyboard suggestion selection in both directions', () => {
    expect(cycleSuggestionIndex(0, 3, 'next')).toBe(1)
    expect(cycleSuggestionIndex(2, 3, 'next')).toBe(0)
    expect(cycleSuggestionIndex(0, 3, 'previous')).toBe(2)
    expect(cycleSuggestionIndex(4, 0, 'previous')).toBe(0)
  })
})
