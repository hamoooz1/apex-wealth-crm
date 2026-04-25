import { ArrowRight, ShieldCheck, Users, KanbanSquare, LifeBuoy } from 'lucide-react'
import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import apexLogo from '../assets/apex-wealth-logo.png'

export default function Auth() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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
      <div
        className={['authCard', submitting ? 'authCardSubmitting' : null]
          .filter(Boolean)
          .join(' ')}
      >
        <div className="authLeft">
          <div className="authLeftTop">
            <div className="authLogoPlate">
              <img className="authLogo" src={apexLogo} alt="Apex Wealth CRM" />
            </div>

            <div className="authWelcomeTitle">Welcome back</div>
            <div className="authWelcomeSub">
              Sign in to manage pipeline stages, client AUM, tasks, and team workflows — all in one place.
            </div>

            <div className="authLeftGrid" aria-label="Platform highlights">
              <div className="authFeature">
                <div className="authFeatureIcon">
                  <KanbanSquare size={16} />
                </div>
                <div>
                  <div className="authFeatureTitle">Pipeline</div>
                  <div className="authFeatureSub">Track opportunities by stage</div>
                </div>
              </div>

              <div className="authFeature">
                <div className="authFeatureIcon">
                  <Users size={16} />
                </div>
                <div>
                  <div className="authFeatureTitle">Team</div>
                  <div className="authFeatureSub">Managers and advisor visibility</div>
                </div>
              </div>

              <div className="authFeature">
                <div className="authFeatureIcon">
                  <ShieldCheck size={16} />
                </div>
                <div>
                  <div className="authFeatureTitle">Secure access</div>
                  <div className="authFeatureSub">Role-based permissions and audit</div>
                </div>
              </div>
            </div>
          </div>

          <div className="authLeftBottom">
            <div className="authHelpRow">
              <LifeBuoy size={16} />
              <span>Need an invite? Contact your admin.</span>
            </div>
            <div className="authLegal">© {new Date().getFullYear()} Apex Wealth</div>
          </div>
        </div>

        <div className="authRight">
          <h1 className="authTitle">Sign in</h1>
          <div className="authSubtitle">Use your Apex Wealth email and password.</div>

          <form onSubmit={onSubmit} className="authForm">
            <label className="authLabel">
              Email
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
              Password
              <input
                className="authInput"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
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
            Need access? Contact an admin to send you an invite.
          </div>
        </div>
      </div>
    </div>
  )
}

