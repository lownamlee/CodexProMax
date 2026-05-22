import type { SkillRecord } from '../types'

export type SlashSkillRange = {
  start: number
  end: number
  query: string
}

export type SlashSkillInsertion = {
  value: string
  caretIndex: number
  skill: SkillRecord
}

export function cycleSuggestionIndex(
  currentIndex: number,
  optionCount: number,
  direction: 'next' | 'previous',
): number {
  if (optionCount <= 0) return 0
  const delta = direction === 'next' ? 1 : -1
  return (currentIndex + delta + optionCount) % optionCount
}

export function findSlashSkillRange(value: string, caretIndex: number): SlashSkillRange | null {
  const prefix = value.slice(0, caretIndex)
  const match = /(^|\s)\/([^\s/]*)$/.exec(prefix)
  if (!match) return null
  const query = match[2] ?? ''
  return {
    start: caretIndex - query.length - 1,
    end: caretIndex,
    query,
  }
}

export function replaceExactSlashSkill(
  value: string,
  caretIndex: number,
  skills: SkillRecord[],
): SlashSkillInsertion | null {
  const range = findSlashSkillRange(value, caretIndex)
  if (!range?.query) return null
  const skill = skills.find((candidate) => candidate.name.toLowerCase() === range.query.toLowerCase())
  if (!skill) return null

  const replacement = replaceSlashSkillRange(value, range, skill.content)
  return {
    ...replacement,
    skill,
  }
}

export function replaceSlashSkillRange(
  value: string,
  range: SlashSkillRange,
  content: string,
): Omit<SlashSkillInsertion, 'skill'> {
  const tail = value.slice(range.end)
  const separator = tail && !/\s/.test(tail[0] ?? '') && !/\s$/.test(content) ? ' ' : ''
  const inserted = `${content}${separator}`
  return {
    value: `${value.slice(0, range.start)}${inserted}${tail}`,
    caretIndex: range.start + inserted.length,
  }
}
