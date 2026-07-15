import { useState, useEffect } from 'react'
import { signInEmail, signUpEmail, signInWithGoogle } from '../firebase.js'

// Sign-in gate shown whenever no user is authenticated. Email/password is the
// primary path (reliable in Electron); Google uses the desktop system-browser
// OAuth flow when available, Firebase popup in the browser.
export default function AuthView() {
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [notice, setNotice] = useState(null)
  // Browser dev: popup works, show Google. Packaged app: only if a Desktop
  // OAuth client is baked in (else the button would be dead).
  const [showGoogle, setShowGoogle] = useState(!(typeof window !== 'undefined' && window.desktop))
  useEffect(function () {
    if (typeof window !== 'undefined' && window.desktop && window.desktop.getConfig) {
      window.desktop.getConfig()
        .then(function (c) { setShowGoogle(Boolean(c && c.googleConfigured)) })
        .catch(function () { setShowGoogle(false) })
    }
  }, [])

  async function submit(e) {
    e.preventDefault()
    setErr(null); setNotice(null); setBusy(true)
    try {
      if (mode === 'signup') {
        await signUpEmail(email, pw)
        setNotice('Account created. A verification email is on its way.')
      } else {
        await signInEmail(email, pw)
      }
    } catch (ex) {
      setErr(friendly(ex))
    } finally {
      setBusy(false)
    }
  }

  async function google() {
    setErr(null); setNotice(null); setBusy(true)
    try {
      await signInWithGoogle()
    } catch (ex) {
      setErr(friendly(ex))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <img src="./pianoforge.png" alt="PianoForge" className="auth-logo" />
        <h2 className="auth-title">{mode === 'signup' ? 'Create your account' : 'Sign in'}</h2>
        <p className="meta auth-sub">
          {mode === 'signup'
            ? 'Start with 5 free conversions. Enter an activation key any time to unlock unlimited.'
            : 'Welcome back.'}
        </p>

        {showGoogle && (
          <>
            <button className="google-btn" onClick={google} disabled={busy}>
              <span className="google-g">G</span> Continue with Google
            </button>
            <div className="auth-or"><span>or</span></div>
          </>
        )}

        <form onSubmit={submit}>
          <input
            className="url-input auth-input"
            type="email"
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            className="url-input auth-input"
            type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            placeholder="Password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            minLength={6}
            required
          />
          <button className="primary auth-submit" type="submit" disabled={busy}>
            {busy ? 'Working…' : (mode === 'signup' ? 'Create account' : 'Sign in')}
          </button>
        </form>

        {err && <div className="notice warn auth-msg">{err}</div>}
        {notice && <div className="notice auth-msg">{notice}</div>}

        <div className="auth-switch">
          {mode === 'signup' ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button className="linklike" onClick={() => { setErr(null); setNotice(null); setMode(mode === 'signup' ? 'signin' : 'signup') }}>
            {mode === 'signup' ? 'Sign in' : 'Create one'}
          </button>
        </div>
      </div>
    </div>
  )
}

function friendly(ex) {
  const code = (ex && ex.code) || ''
  if (code.includes('invalid-credential') || code.includes('wrong-password') ||
    code.includes('user-not-found')) return 'Wrong email or password.'
  if (code.includes('email-already-in-use')) return 'That email already has an account — sign in instead.'
  if (code.includes('weak-password')) return 'Password must be at least 6 characters.'
  if (code.includes('invalid-email')) return 'That email address looks invalid.'
  if (code.includes('popup-closed') || code.includes('cancelled')) return 'Sign-in was cancelled.'
  if (code.includes('network')) return 'Network error — check your connection.'
  return (ex && ex.message) ? ex.message.replace(/^Firebase:\s*/, '') : 'Sign-in failed.'
}
