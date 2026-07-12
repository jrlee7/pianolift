import { useState } from 'react'
import { activateKey, currentUser, FREE_LIMIT } from '../firebase.js'

// Shown when a customer hits the free-conversion limit (or opens it from the
// account bar). Claims a single-use key, then unlocks unlimited conversions.
export default function ActivationModal({ reason, onActivated, onClose }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setErr(null); setBusy(true)
    try {
      await activateKey(currentUser(), key)
      onActivated()
    } catch (ex) {
      setErr((ex && ex.message) || 'Activation failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Activate PianoForge</h2>
        <p className="meta">
          {reason === 'limit'
            ? 'You\'ve used all ' + FREE_LIMIT + ' free conversions. Enter your activation key to unlock unlimited.'
            : 'Enter your activation key to unlock unlimited conversions.'}
        </p>
        <form onSubmit={submit}>
          <input
            className="url-input activation-input"
            placeholder="PIANO-XXXXX-XXXXX-XXXXX"
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            autoFocus
            spellCheck={false}
          />
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={busy}>Later</button>
            <button type="submit" className="primary" disabled={busy || !key.trim()}>
              {busy ? 'Activating…' : 'Activate'}
            </button>
          </div>
        </form>
        {err && <div className="notice warn auth-msg">{err}</div>}
      </div>
    </div>
  )
}
