import { ArrowRight, Eye, EyeOff, Lock } from 'lucide-react'
import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import apexLogo from '../assets/apex-wealth-logo.png'

export default function Auth() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = useMemo(() => {
    return email.trim().length > 0 && password.length > 0 && !loading && !submitting
  }, [email, password, loading, submitting])

  async function onSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    setSubmitting(true)
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      if (signInError) throw signInError
    } catch (err) {
      setError(err?.message || 'Authentication failed')
      setSubmitting(false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="authWrap">
      <div className="authGlow" aria-hidden="true" />
      <div className="authGrid" aria-hidden="true" />

      <div
        className={['authCard', submitting ? 'authCardSubmitting' : null]
          .filter(Boolean)
          .join(' ')}
      >
        <div className="authHead">
          <div className="authLogoPlate">
            <img className="authLogo" src={apexLogo} alt="Apex Wealth" />
          </div>
          <h1 className="authTitle">Sign in</h1>
          <div className="authSubtitle">
            Welcome back. Use your Apex Wealth credentials to continue.
          </div>
        </div>

        <form onSubmit={onSubmit} className="authFields">
          <label className="authLabel">
            <span className="authLabelText">Email</span>
            <input
              className="authInput"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@apexwealth.com"
              autoComplete="email"
              required
            />
          </label>

          <label className="authLabel">
            <span className="authLabelText">Password</span>
            <div className="authInputWrap">
              <input
                className="authInput"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="authReveal"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>

          {error ? <div className="authError">{error}</div> : null}

          <button className="authBtn" type="submit" disabled={!canSubmit}>
            <span className="authBtnInner">
              {loading ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRight size={16} />
                </>
              )}
            </span>
          </button>
        </form>

        <div className="authFooter">
          <span className="authSecure">
            <Lock size={13} />
            Encrypted, role-based access
          </span>
          <span className="authLegal">© {new Date().getFullYear()} Apex Wealth</span>
        </div>
      </div>
    </div>
  )
}
