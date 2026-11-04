import { useState } from 'react'
import { useAuth } from './lib/useAuth'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Settings from './pages/Settings'

export default function App() {
  const { session, profile, loading, refreshProfile } = useAuth()
  const [tab, setTab] = useState<'dashboard' | 'settings'>('dashboard')

  if (loading) return <div className="screen centered">Lädt …</div>
  if (!session) return <Login />
  if (!profile) return <div className="screen centered">Profil wird angelegt …</div>

  return (
    <div className="app">
      <header className="topbar">
        <strong>Happen</strong>
      </header>
      <main>
        {tab === 'dashboard' ? (
          <Dashboard profile={profile} />
        ) : (
          <Settings profile={profile} onProfileSaved={refreshProfile} />
        )}
      </main>
      <nav className="tabbar">
        <button className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}>
          Übersicht
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          Einstellungen
        </button>
      </nav>
    </div>
  )
}
