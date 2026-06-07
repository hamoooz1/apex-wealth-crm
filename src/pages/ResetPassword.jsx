import { ArrowRight, Lock } from 'lucide-react'
import { useMemo, useState } from 'react'
import { updatePassword } from '../lib/auth.js'
import { useAuth } from '../contexts/AuthContext.jsx'
import apexLogo from '../assets/apex-wealth-logo.png'

export default function ResetPassword() {
  const { clearPasswordRecovery } = useAuth()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  const canSubmit = useMemo(() => {
    return password.length >= 8 && confirm.length >= 8 && !loading
  }, [password, confirm, loading])

  async function onSubmit(e) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    try {
      await updatePassword(password)
      clearPasswordRecovery()
      setDone(true)
    } catch (err) {
      setError(err?.message || 'Could not update password.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="authWrap">
      <div className="authGlow" aria-hidden="true" />
      <div className="authGrid" aria-hidden="true" />

      <div className="authCard">
        <div className="authHead">
          <div className="authLogoPlate">
            <img className="authLogo" src={apexLogo} alt="Apex Wealth" />
          </div>
          <h1 className="authTitle">{done ? 'Password updated' : 'Set new password'}</h1>
          <div className="authSubtitle">
            {done
              ? 'You are signed in. Redirecting to your dashboard…'
              : 'Choose a new password for your Apex Wealth account.'}
          </div>
        </div>

        {done ? (
          <div className="authSuccess">Your password has been saved.</div>
        ) : (
          <form onSubmit={onSubmit} className="authFields">
            <label className="authLabel">
              <span className="authLabelText">New password</span>
              <input
                className="authInput"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </label>

            <label className="authLabel">
              <span className="authLabelText">Confirm password</span>
              <input
                className="authInput"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat password"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </label>

            {error ? <div className="authError">{error}</div> : null}

            <button className="authBtn" type="submit" disabled={!canSubmit}>
              <span className="authBtnInner">
                {loading ? (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    Saving…
                  </>
                ) : (
                  <>
                    Save password
                    <ArrowRight size={16} />
                  </>
                )}
              </span>
            </button>
          </form>
        )}

        <div className="authFooter">
          <span className="authSecure">
            <Lock size={13} />
            Secure password reset
          </span>
        </div>
      </div>
    </div>
  )
}
