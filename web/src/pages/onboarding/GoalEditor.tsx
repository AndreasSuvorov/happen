import { useState } from 'react'
import { Icon } from '../../components/ui'
import './onboarding.css'
import { GOAL_OPTIONS, type GoalDraft, type GoalId } from './goal'

export default function GoalEditor({ draft, onChange }: { draft: GoalDraft; onChange: (d: GoalDraft) => void }) {
  const [uid] = useState(() => Math.random().toString(36).slice(2, 7))
  const toggle = (id: GoalId) =>
    onChange({ ...draft, goals: draft.goals.includes(id) ? draft.goals.filter((g) => g !== id) : [...draft.goals, id] })

  return (
    <>
      <div className="ob-goals">
        {GOAL_OPTIONS.map(([id, label]) => {
          const on = draft.goals.includes(id)
          return (
            <button key={id} type="button" className="ob-goal" aria-pressed={on} onClick={() => toggle(id)}>
              {label}
              <span className="ob-goal-box" aria-hidden="true">
                {on && <Icon name="check" size={14} strokeWidth={3} />}
              </span>
            </button>
          )
        })}
      </div>
      {draft.goals.includes('lauf') && (
        <div className="ob-race pop-in">
          <span className="ob-race-title">Dein Lauf</span>
          <div className="ob-field">
            <label htmlFor={`race-${uid}`}>Welcher Lauf?</label>
            <input
              id={`race-${uid}`}
              className="ob-input"
              type="text"
              placeholder="z. B. Halbmarathon Barcelona"
              value={draft.raceName}
              onChange={(e) => onChange({ ...draft, raceName: e.target.value })}
            />
          </div>
          <div className="ob-race-grid">
            <div className="ob-field">
              <label htmlFor={`date-${uid}`}>Datum</label>
              <input
                id={`date-${uid}`}
                className="ob-input"
                type="text"
                inputMode="numeric"
                placeholder="TT.MM.JJJJ"
                value={draft.raceDate}
                onChange={(e) => onChange({ ...draft, raceDate: e.target.value })}
              />
            </div>
            <div className="ob-field">
              <label htmlFor={`target-${uid}`}>Wunschzeit (optional)</label>
              <input
                id={`target-${uid}`}
                className="ob-input"
                type="text"
                inputMode="numeric"
                placeholder="h:mm:ss"
                value={draft.raceTarget}
                onChange={(e) => onChange({ ...draft, raceTarget: e.target.value })}
              />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
