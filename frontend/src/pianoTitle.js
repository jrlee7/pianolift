// Title rules the floppy-era Disklaviers actually enforce, mirrored on the
// client so the editor shows exactly what the piano will display.
//
// The E-SEQ header stores a 32-byte, space-padded title (see eseq_writer.py,
// offset 0x57) and the writer keeps only bytes 0x20..0x7E — printable ASCII.
// Anything else (accented letters, smart quotes, emoji, control chars) the
// piano can't render, so we strip it here rather than let it become blanks on
// the LCD.
export const MAX_PIANO_TITLE = 32

// Keep only printable ASCII, collapse runs of whitespace to single spaces, and
// cap at 32 characters. Does NOT trim the ends while typing (so a trailing
// space you're mid-word on survives); callers trim on confirm.
export function sanitizePianoTitle(s) {
  let out = ''
  let prevSpace = false
  for (const ch of (s || '')) {
    const code = ch.charCodeAt(0)
    if (code < 32 || code > 126) continue // non-printable / non-ASCII: drop
    const isSpace = ch === ' '
    if (isSpace && prevSpace) continue     // collapse double spaces
    out += ch
    prevSpace = isSpace
    if (out.length >= MAX_PIANO_TITLE) break
  }
  return out
}

// Final form for building the disk: sanitized + trimmed, with a fallback so an
// all-illegal title never renders blank.
export function finalizePianoTitle(s, fallback) {
  const clean = sanitizePianoTitle(s).trim()
  return clean || sanitizePianoTitle(fallback || '').trim() || 'Song'
}
