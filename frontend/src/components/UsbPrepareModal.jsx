import { useEffect, useRef, useState } from 'react'
import {
  getDrives, checkUsbPrepare, startUsbPrepare, getUsbPrepareStatus,
  cancelUsbPrepare
} from '../api.js'

// A brand-new USB stick is just empty FAT32 — plug it into the Gotek and the
// piano sees no disk at all. This turns one into an emulator stick: the HxC
// firmware config plus a blank 720K Disklavier floppy per slot, after which
// every Write-disk action in the app can fill it.
//
// Writing 1000 slots is ~2GB, so the backend runs it on a thread and this
// polls for progress.

const SLOT_CHOICES = [100, 250, 500, 1000]
const SLOT_BYTES = 2008064

function gb(bytes) {
  return (bytes / 1e9).toFixed(1) + ' GB'
}

export default function UsbPrepareModal({ onClose, onDone }) {
  const [drives, setDrives] = useState(null)
  const [drive, setDrive] = useState('')
  const [slots, setSlots] = useState(1000)
  const [check, setCheck] = useState(null)
  const [checking, setChecking] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  // Where the ETA clock started: { at, done }. `done` is non-zero when the
  // modal reattaches to a prepare that was already part-way through, so the
  // rate is measured over what we actually watched.
  const startedAt = useRef(null)
  const notified = useRef(false)
  const doneCb = useRef(onDone)
  doneCb.current = onDone

  const running = Boolean(status && status.running)

  // Removable drives, and whichever prepare may already be running (the modal
  // can be reopened mid-run).
  useEffect(function () {
    let live = true
    Promise.all([getDrives(), getUsbPrepareStatus()]).then(function (r) {
      if (!live) return
      const list = r[0].removable || []
      setDrives(list)
      const gotek = (r[0].gotekRoot || '').toUpperCase()
      // Default to a stick that isn't already the Gotek library.
      const fresh = list.filter(function (d) {
        return d.root.toUpperCase() !== gotek
      })
      const pick = (fresh[0] || list[0] || {}).root || ''
      setDrive(pick)
      if (r[1].running) {
        startedAt.current = { at: Date.now(), done: r[1].done }
        setStatus(r[1])
      }
    }).catch(function (e) { if (live) setError(e.message) })
    return function () { live = false }
  }, [])

  // Dry-run the target whenever the choice changes.
  useEffect(function () {
    if (!drive || running) return
    let live = true
    setChecking(true)
    setConfirmed(false)
    checkUsbPrepare(drive, slots).then(function (c) {
      if (live) { setCheck(c); setError(null) }
    }).catch(function (e) {
      if (live) { setCheck(null); setError(e.message) }
    }).finally(function () { if (live) setChecking(false) })
    return function () { live = false }
  }, [drive, slots, running])

  // Poll while a prepare runs. The stick's contents changed underneath the
  // Disk tab, so tell the parent to rescan — once, when the run ends.
  useEffect(function () {
    if (!running) return
    const t = setInterval(function () {
      getUsbPrepareStatus().then(function (s) {
        setStatus(s)
        if (!s.running && !notified.current) {
          notified.current = true
          if (doneCb.current) doneCb.current()
        }
      }).catch(function () { /* keep polling; a blip isn't fatal */ })
    }, 1000)
    return function () { clearInterval(t) }
  }, [running])

  function retarget(fn) {
    // Changing the target invalidates the last run's result panel.
    setStatus(null)
    notified.current = false
    fn()
  }

  async function begin() {
    setError(null)
    notified.current = false
    try {
      startedAt.current = { at: Date.now(), done: 0 }
      // force only when the user ticked the erase box: the backend re-checks
      // the stick at start time, so a swapped drive still gets caught.
      setStatus(await startUsbPrepare(drive, slots, needsForce && confirmed))
    } catch (e) {
      setError(e.message)
    }
  }

  async function stop() {
    try {
      setStatus(await cancelUsbPrepare())
    } catch (e) {
      setError(e.message)
    }
  }

  const blocked = Boolean(check && check.blockers && check.blockers.length)
  const needsForce = Boolean(check && check.needsForce)
  const canStart = Boolean(drive) && !checking && !blocked && !running
    && (!needsForce || confirmed)

  // Rough remaining time from the rate achieved so far.
  let eta = null
  if (running && startedAt.current) {
    const written = status.done - startedAt.current.done
    if (written > 0) {
      const per = (Date.now() - startedAt.current.at) / written
      const left = Math.round(per * (status.slots - status.done) / 1000)
      eta = left > 90
        ? Math.round(left / 60) + ' min left'
        : Math.max(1, left) + ' sec left'
    }
  }

  const finishedOk = status && status.finished && !status.running
    && !status.error && !status.cancelled

  return (
    <div className="modal-backdrop"
      onClick={function (e) {
        if (e.target === e.currentTarget && !running) onClose()
      }}>
      <div className="modal-box" style={{ maxWidth: 560 }}>
        <h3 style={{ marginTop: 0 }}>Prepare a blank USB stick</h3>
        <p className="meta">
          Writes the Gotek/Nalbantov layout onto an empty FAT32 stick: the
          firmware config plus one blank 1995-Disklavier floppy per slot. After
          this, “Write disk” can save songs to it and the piano will read them.
        </p>

        {drives && drives.length === 0 && (
          <div className="notice warn">
            No removable drive found. Plug the USB stick in and reopen this.
          </div>
        )}

        {drives && drives.length > 0 && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '14px 0 6px' }}>
            <label style={{ margin: 0 }}>Stick</label>
            <select value={drive} disabled={running} style={{ flex: 1 }}
              onChange={function (e) {
                const v = e.target.value
                retarget(function () { setDrive(v) })
              }}>
              {drives.map(function (d) {
                return (
                  <option key={d.root} value={d.root}>
                    {d.root} {d.label} — {gb(d.totalBytes || 0)} {d.fileSystem}
                    {d.isGotek ? ' — already a Gotek stick' : ''}
                  </option>
                )
              })}
            </select>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '6px 0' }}>
          <label style={{ margin: 0 }}>Slots</label>
          <select value={slots} disabled={running} style={{ width: 120 }}
            onChange={function (e) {
              const v = parseInt(e.target.value, 10)
              retarget(function () { setSlots(v) })
            }}>
            {SLOT_CHOICES.map(function (n) {
              return <option key={n} value={n}>{n}</option>
            })}
          </select>
          <span className="meta">
            {gb(slots * SLOT_BYTES)} — each slot is one floppy and holds up to
            76 songs. A factory stick has 1000.
          </span>
        </div>

        {checking && !status && <div className="notice">Checking the stick…</div>}

        {check && !status && check.blockers.map(function (b, i) {
          return <div key={i} className="notice warn">{b}</div>
        })}

        {check && !status && !blocked && check.warnings.map(function (w, i) {
          return <div key={i} className="notice warn">{w}</div>
        })}

        {check && !status && !blocked && needsForce && !running && (
          <label className="meta" style={{
            display: 'flex', alignItems: 'center', gap: 6, marginTop: 10
          }}>
            <input type="checkbox" checked={confirmed}
              onChange={function (e) { setConfirmed(e.target.checked) }} />
            I understand this erases everything already on {check.drive}.
          </label>
        )}

        {check && !blocked && !needsForce && !running && !status && (
          <div className="notice">
            {check.drive} looks empty and ready — {gb(check.freeBytes || 0)} free,
            {' '}{gb(check.neededBytes)} needed.
          </div>
        )}

        {status && (status.running || status.finished) && (
          <div style={{ marginTop: 14 }}>
            <div className="meta">
              {status.error
                ? 'Failed: ' + status.error
                : status.cancelled
                  ? 'Stopped after ' + status.done + ' slots — those slots work, '
                    + 'the rest were never written.'
                  : status.running
                    ? status.stage + '… slot ' + status.done + ' / ' + status.slots
                      + (eta ? ' — ' + eta : '')
                    : 'Done — ' + status.slots + ' blank disks on ' + status.drive
                      + '. Safe to unplug.'}
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{
                width: (status.slots
                  ? Math.round(100 * status.done / status.slots)
                  : 0) + '%'
              }} />
            </div>
          </div>
        )}

        {error && <div className="notice warn" style={{ marginTop: 10 }}>{error}</div>}

        <div style={{
          display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14
        }}>
          {running
            ? <button onClick={stop}>Stop</button>
            : <button onClick={onClose}>{finishedOk ? 'Close' : 'Cancel'}</button>}
          {!finishedOk && (
            <button className="primary" disabled={!canStart} onClick={begin}>
              {running ? 'Writing…' : '🖫 Prepare stick'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
