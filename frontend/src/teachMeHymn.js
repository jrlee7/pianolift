// "Teach Me to Walk in the Light" (Clara W. McMaster) — a short, recognizable
// melody + simple bass used by the Play tab's Visual Sync Test: it plays on a
// drawn keyboard on the TV while the real notes fire on the Disklavier, so any
// residual timing offset is obvious to the eye+ear and can be nudged to zero.
//
// This is an APPROXIMATE, editable transcription — the sync test only needs
// clear, well-spaced onsets across the piano's range (low bass + high treble
// exercise different solenoids), not a perfect score. Adjust freely: each note
// is { pitch (MIDI), start (sec), dur (sec), velocity (0-127) }. Times are on a
// simple 100 BPM grid (beat = 0.6 s); onsets are deliberately spaced so a
// human can match each TV key-light to its piano strike.
//
// Pitch reference: C4 = 60 (middle C). The melody sits in C major.

const BEAT = 0.6 // seconds per quarter note (~100 BPM)
const b = function (n) { return n * BEAT } // beats -> seconds helper

// Melody line (right hand) — "Teach me to walk in the light of his love /
// teach me to pray to my Father above". Stepwise and gentle on purpose.
const MELODY = [
  // phrase 1
  { p: 67, on: 0,  d: 1 },   // G4  "Teach"
  { p: 72, on: 1,  d: 1 },   // C5  "me"
  { p: 72, on: 2,  d: 1 },   // C5  "to"
  { p: 74, on: 3,  d: 1 },   // D5  "walk"
  { p: 72, on: 4,  d: 1 },   // C5  "in"
  { p: 71, on: 5,  d: 1 },   // B4  "the"
  { p: 69, on: 6,  d: 2 },   // A4  "light"
  { p: 67, on: 8,  d: 1 },   // G4  "of"
  { p: 69, on: 9,  d: 1 },   // A4  "his"
  { p: 71, on: 10, d: 2 },   // B4  "love"
  // phrase 2
  { p: 67, on: 12, d: 1 },   // G4  "Teach"
  { p: 72, on: 13, d: 1 },   // C5  "me"
  { p: 74, on: 14, d: 1 },   // D5  "to"
  { p: 76, on: 15, d: 1 },   // E5  "pray"
  { p: 74, on: 16, d: 1 },   // D5  "to"
  { p: 72, on: 17, d: 1 },   // C5  "my"
  { p: 71, on: 18, d: 2 },   // B4  "Father"
  { p: 74, on: 20, d: 1 },   // D5  "a-"
  { p: 72, on: 21, d: 1 },   // C5  "-bove"
  { p: 72, on: 22, d: 2 }    // C5  (rest/hold)
]

// Bass line (left hand) — root notes on the strong beats, an octave-plus below,
// so the test also drives the low end of the keyboard.
const BASS = [
  { p: 48, on: 0,  d: 2 },   // C3
  { p: 55, on: 2,  d: 2 },   // G3
  { p: 53, on: 4,  d: 2 },   // F3
  { p: 55, on: 6,  d: 2 },   // G3
  { p: 48, on: 8,  d: 2 },   // C3
  { p: 50, on: 10, d: 2 },   // D3
  { p: 48, on: 12, d: 2 },   // C3
  { p: 55, on: 14, d: 2 },   // G3
  { p: 53, on: 16, d: 2 },   // F3
  { p: 55, on: 18, d: 2 },   // G3
  { p: 43, on: 20, d: 2 },   // G2
  { p: 48, on: 22, d: 2 }    // C3
]

function build() {
  const notes = []
  const add = function (list, vel) {
    for (let i = 0; i < list.length; i++) {
      const n = list[i]
      notes.push({
        onset: b(n.on),
        offset: b(n.on + n.d) - 0.03, // tiny gap so repeated pitches re-strike
        pitch: n.p,
        velocity: n.velocity != null ? n.velocity : vel
      })
    }
  }
  add(MELODY, 92)  // melody a touch louder
  add(BASS, 70)
  notes.sort(function (a, c) { return a.onset - c.onset })
  return notes
}

// { notes: [...], pedals: [], duration } in the same shape prepareEvents wants.
export const TEACH_ME_HYMN = {
  title: 'Teach Me to Walk in the Light',
  events: { notes: build(), pedals: [] },
  duration: b(24)
}
