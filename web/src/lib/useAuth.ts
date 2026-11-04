import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, type Profile } from './supabase'

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const loadProfile = async (userId: string) => {
    const { data } = await supabase.from('users').select('*').eq('auth_user_id', userId).maybeSingle()
    setProfile(data as Profile | null)
  }

  useEffect(() => {
    if (!session) {
      setProfile(null)
      return
    }
    loadProfile(session.user.id)
  }, [session?.user.id])

  return {
    session,
    profile,
    loading,
    refreshProfile: () => session && loadProfile(session.user.id),
  }
}
