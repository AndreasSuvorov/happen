import { useState } from 'react'
import { useAuth } from './lib/useAuth'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Chat from './pages/Chat'
import Settings from './pages/Settings'
import Today from './pages/Today'

export default function App() {
  const { session, profile, loading, refreshProfile } = useAuth()
  const [tab, setTab] = useState<'today' | 'history' | 'chat' | 'settings'>('today')
  const [capture, setCapture] = useState(false)

  if (loading) return <div className="screen centered">Lädt …</div>
  if (!session) return <Login />
  const currentProfile = profile?.auth_user_id === session.user.id ? profile : null
  const activeTab = tab === 'today' || currentProfile ? tab : 'today'
  const openChat = (captureMode: boolean) => {
    setCapture(captureMode)
    setTab('chat')
  }
  const goToday = () => setTab('today')

  return (
    <div className="app today-app">
      <header className="topbar today-topbar">
        <strong>Happen</strong>
        {currentProfile && <button className="today-profile" aria-label="Einstellungen" onClick={() => setTab('settings')}>
          {currentProfile.first_name?.trim().charAt(0).toLocaleUpperCase('de-DE') || '⚙'}
        </button>}
      </header>
      <main className={activeTab === 'chat' ? 'main-flush' : undefined}>
        {activeTab === 'today' && <Today key={session.user.id} authUserId={session.user.id}
          openSettings={() => setTab('settings')} openCapture={() => openChat(true)} />}
        {currentProfile && activeTab === 'history' && <Dashboard profile={currentProfile} />}
        {currentProfile && activeTab === 'chat' && <Chat profile={currentProfile} capture={capture} />}
        {currentProfile && activeTab === 'settings' && <Settings profile={currentProfile} onProfileSaved={refreshProfile} />}
      </main>
      <nav className="tabbar today-tabbar" aria-label="Hauptnavigation">
        <button aria-current={activeTab === 'today' ? 'page' : undefined} onClick={goToday}>Heute</button>
        <button className="today-add" aria-label="Mahlzeit erfassen" onClick={() => openChat(true)} disabled={!currentProfile}>+</button>
        <button aria-current={activeTab === 'chat' ? 'page' : undefined} onClick={() => openChat(false)} disabled={!currentProfile}>Chat</button>
        <button aria-current={activeTab === 'history' ? 'page' : undefined} onClick={() => setTab('history')} disabled={!currentProfile}>Verlauf</button>
      </nav>
    </div>
  )
}
