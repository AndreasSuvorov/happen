export type Briefing = {
  headline: string
  why: string
  today: { text: string }
  food: string
  question: { text: string } | null
  weigh: boolean
}

export type BriefingRow = { date: string; payload: Briefing }
const cacheKey = (userId: string) => `happen-morning:${userId}`

export function readCachedBriefing(userId: string): BriefingRow | null {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(userId)) ?? 'null') as BriefingRow | null
  } catch {
    return null
  }
}

export function cacheBriefing(userId: string, briefing: BriefingRow | null) {
  try {
    if (briefing) localStorage.setItem(cacheKey(userId), JSON.stringify(briefing))
    else localStorage.removeItem(cacheKey(userId))
  } catch {
    // The online briefing works even when storage is unavailable.
  }
}
