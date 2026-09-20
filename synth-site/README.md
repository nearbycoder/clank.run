# Clank Synth

Clank Synth is the framework's small, playable audio lab. It is a server-rendered, hydrated
TypeScript app with a dependency-free Web Audio engine and a 16-step pattern editor.

## Run it

```sh
cd synth-site
npm run dev
```

Open `http://127.0.0.1:4600` and tap **Enable audio** (or **Play**) once. Mobile browsers require
that explicit user gesture before Web Audio can produce sound; the synth unlocks a silent source
first, then starts the loop without autoplaying on page load.

## Program a beat

- Click a cell to toggle a step for Kick, Snare, Hat, Clap, Bass, or Lead.
- Change the preset, tempo, swing, master level, and individual track levels.
- Use **Randomize**, **Clear**, and the JSON copy/export controls to explore ideas. Your current
  pattern is saved automatically in the browser and can be downloaded with **Export JSON**.
- Mute or solo tracks while the sequencer is running. The active step is announced to assistive
  technology and highlighted in the grid.
- Import a saved version-1 JSON pattern file. Imports are validated as a
  complete pattern, limited to 16 KiB, and stop playback without starting audio automatically.
- Undo and redo retain up to 40 edits, including imported patterns and their tempo and levels.
  Transport ticks do not consume history; undo and redo stop playback before restoring an edit.
- Clear or rotate each instrument's steps from the track rack. **Reset mix** restores track and
  master levels and clears mute/solo choices while keeping the pattern, tempo, and swing.
- Use **Tap tempo** to average recent taps, bounded to 60–180 BPM. A pause longer than two seconds
  begins a new sequence.

The sequencer has one keyboard tab stop. Arrow keys move between cells, Home/End move within a
track, Ctrl+Home/End move to the first/last cell, and Enter or Space toggles the focused step.
Space outside inputs and controls toggles transport. Composition, repeated keys, and modifier
shortcuts do not start playback. Stopping clears scheduled voices and timing indicators; removing
the synth also releases its keyboard listener and audio context. Saved zero swing and zero volume
remain zero when restored.

The synth uses the browser's native `AudioContext`: oscillators and filtered noise are scheduled
slightly ahead of time so the loop stays tight without a dependency or a server-side audio service.
The framework's signals keep the grid, transport, and meters reactive, while `renderDocument` and
`hydrate` preserve the first server-rendered view.

## Deploy

```sh
node ../scripts/clank.mjs login
npm run doctor
npm run deploy:check
npm run deploy
node ../scripts/clank.mjs domain add synth.clank.run
```

The app stores patterns locally in the browser; it does not send microphone, audio, or pattern data
to Clank. The deployment has a `/healthz` check and serves the framework runtime from its checked-in
artifact, so it can be rolled out without installing packages on the host.
