import { useEffect, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from './lib/useAuth'
import type { Profile } from './lib/supabase'
import Login from './pages/Login'
import TabBar from './components/TabBar'
import Heute from './pages/heute/Heute'
import Warum from './pages/heute/Warum'
import Tageslinie from './pages/heute/Tageslinie'
import Training from './pages/training/Training'
import Laufanalyse from './pages/training/Laufanalyse'
import Essen from './pages/essen/Essen'
import Erfassen from './pages/essen/Erfassen'
import ChatCoach from './pages/chat/ChatCoach'
import Verlauf from './pages/verlauf/Verlauf'
import Rueckblick from './pages/rueckblick/Rueckblick'
import Onboarding from './pages/onboarding/Onboarding'
import Einstellungen from './pages/einstellungen/Einstellungen'
import { checkOnboardingRemote, needsOnboarding } from './pages/onboarding/state'

/** Bildschirme mit Tab-Leiste unten. */
function WithTabs() {
  return (
    <div className="coach shell">
      <main className="shell-main">
        <Outlet />
      </main>
      <TabBar />
    </div>
  )
}

/** Unterseiten und Abläufe ohne Tab-Leiste. */
function Plain({ children }: { children?: ReactNode }) {
  return <div className="coach shell">{children ?? <Outlet />}</div>
}

/** Neue Nutzer einmal ins Onboarding schicken (Ziel noch nicht gesetzt, weder lokal noch in coach_settings). */
function useOnboardingGate(profile: Profile) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  useEffect(() => {
    if (!needsOnboarding(profile) || pathname.startsWith('/onboarding') || pathname.startsWith('/einstellungen')) return
    let active = true
    checkOnboardingRemote(profile).then((needed) => {
      if (active && needed) navigate('/onboarding/1', { replace: true })
    })
    return () => {
      active = false
    }
    // Nur beim Start prüfen, nicht bei jedem Seitenwechsel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id])
}

function CoachRoutes({ profile, refreshProfile }: { profile: Profile; refreshProfile: () => void }) {
  useOnboardingGate(profile)
  return (
    <Routes>
      <Route element={<WithTabs />}>
        <Route path="/heute" element={<Heute profile={profile} />} />
        <Route path="/tageslinie/:date?" element={<Tageslinie profile={profile} />} />
        <Route path="/training" element={<Training profile={profile} />} />
        <Route path="/essen" element={<Essen profile={profile} />} />
        <Route path="/chat" element={<ChatCoach profile={profile} />} />
        <Route path="/verlauf/:ansicht?" element={<Verlauf profile={profile} />} />
      </Route>
      <Route element={<Plain />}>
        <Route path="/essen/erfassen" element={<Erfassen profile={profile} />} />
        <Route path="/warum" element={<Warum profile={profile} />} />
        <Route path="/lauf/:id" element={<Laufanalyse profile={profile} />} />
        <Route path="/rueckblick/:karte?" element={<Rueckblick profile={profile} />} />
        <Route path="/onboarding/:schritt?" element={<Onboarding profile={profile} />} />
        <Route
          path="/einstellungen"
          element={<Einstellungen profile={profile} onProfileSaved={refreshProfile} />}
        />
      </Route>
      <Route path="*" element={<Navigate to="/heute" replace />} />
    </Routes>
  )
}

export default function App() {
  const { session, profile, loading, refreshProfile } = useAuth()

  if (loading) return <div className="coach empty" style={{ minHeight: '100dvh' }}>Lädt …</div>
  if (!session)
    return (
      <div className="legacy">
        <Login />
      </div>
    )
  if (!profile) return <div className="coach empty" style={{ minHeight: '100dvh' }}>Profil wird angelegt …</div>

  return (
    <BrowserRouter>
      <CoachRoutes profile={profile} refreshProfile={() => void refreshProfile()} />
    </BrowserRouter>
  )
}
