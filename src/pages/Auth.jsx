import { ArrowLeft, ArrowRight, Eye, EyeOff, Lock } from 'lucide-react'
import { useMemo, useState } from 'react'
import { requestPasswordReset } from '../lib/auth.js'
import { supabase } from '../lib/supabaseClient.js'
import apexLogo from '../assets/apex-wealth-logo.png'

export default function Auth() {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [success, setSuccess] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = useMemo(() => {
    if (mode === 'forgot') return email.trim().length > 0 && !loading
    return email.trim().length > 0 && password.length > 0 && !loading && !submitting
  }, [email, password, loading, submitting, mode])

  async function onSubmit(e) {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    setLoading(true)

    if (mode === 'forgot') {
      try {
        await requestPasswordReset(email)
        setSuccess(`If an account exists for ${email.trim()}, a reset link is on its way.`)
      } catch (err) {
        setError(err?.message || 'Could not send reset email.')
      } finally {
        setLoading(false)
      }
      return
    }

    setSubmitting(true)
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      if (signInError) throw signInError
    } catch (err) {
      const raw = String(err?.message || '')
      let message = raw || 'Authentication failed'
      if (/invalid login credentials/i.test(raw)) {
        message =
          'Wrong email or password. Use Forgot password below, or open your invite email to set a password first.'
      } else if (/email not confirmed/i.test(raw)) {
        message = 'Confirm your email before signing in, or use the invite link from your inbox.'
      }
      setError(message)
      setSubmitting(false)
    } finally {
      setLoading(false)
    }
  }

  function switchMode(next) {
    setMode(next)
    setError(null)
    setSuccess(null)
    setPassword('')
    setSubmitting(false)
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
          <h1 className="authTitle">{mode === 'forgot' ? 'Reset password' : 'Sign in'}</h1>
          <div className="authSubtitle">
            {mode === 'forgot'
              ? 'Enter your email and we will send a link to choose a new password.'
              : 'Welcome back. Use your Apex Wealth credentials to continue.'}
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

          {mode === 'signin' ? (
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
          ) : null}

          {error ? <div className="authError">{error}</div> : null}
          {success ? <div className="authSuccess">{success}</div> : null}

          <button className="authBtn" type="submit" disabled={!canSubmit}>
            <span className="authBtnInner">
              {loading ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  {mode === 'forgot' ? 'Sending…' : 'Signing in…'}
                </>
              ) : (
                <>
                  {mode === 'forgot' ? 'Send reset link' : 'Sign in'}
                  <ArrowRight size={16} />
                </>
              )}
            </span>
          </button>

          {mode === 'signin' ? (
            <button className="authLinkBtn" type="button" onClick={() => switchMode('forgot')}>
              Forgot password?
            </button>
          ) : (
            <button className="authLinkBtn" type="button" onClick={() => switchMode('signin')}>
              <ArrowLeft size={14} />
              Back to sign in
            </button>
          )}
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
