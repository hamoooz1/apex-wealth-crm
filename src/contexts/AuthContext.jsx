import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'

const AuthContext = createContext(null)

async function fetchMyProfile(userId) {
  if (!userId) return null
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error
  return data || null
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState(null)

  useEffect(() => {
    let mounted = true

    async function init() {
      setLoading(true)
      const { data, error } = await supabase.auth.getSession()
      if (!mounted) return
      if (error) {
        // eslint-disable-next-line no-console
        console.error(error)
      }
      const nextSession = data?.session ?? null
      setSession(nextSession)
      setUser(nextSession?.user ?? null)
      setLoading(false)
    }

    init()

    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setUser(nextSession?.user ?? null)
    })

    return () => {
      mounted = false
      sub?.subscription?.unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    let mounted = true

    async function loadProfile() {
      if (!user?.id) {
        setProfile(null)
        setProfileError(null)
        return
      }
      setProfileLoading(true)
      setProfileError(null)
      try {
        const p = await fetchMyProfile(user.id)
        if (!mounted) return
        setProfile(p)
      } catch (e) {
        if (!mounted) return
        setProfile(null)
        setProfileError(e)
      } finally {
        if (mounted) setProfileLoading(false)
      }
    }

    loadProfile()
    return () => {
      mounted = false
    }
  }, [user?.id])

  const value = useMemo(() => {
    return {
      session,
      user,
      profile,
      loading,
      profileLoading,
      profileError,
      signOut: () => supabase.auth.signOut(),
      refreshProfile: async () => {
        if (!user?.id) return null
        const p = await fetchMyProfile(user.id)
        setProfile(p)
        return p
      },
    }
  }, [session, user, profile, loading, profileLoading, profileError])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

