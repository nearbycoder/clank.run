# Clank Synth

Clank Synth is the framework's small, playable audio lab. It is a server-rendered, hydrated
TypeScript app with a dependency-free Web Audio engine and a 16-step pattern editor.

## Run it

```sh
cd synth-site
npm run dev
```

Open `http://127.0.0.1:4600` and press **Play**. Audio is created only after that user gesture, so
the demo remains safe for browsers that block autoplay.

## Program a beat

- Click a cell to toggle a step for Kick, Snare, Hat, Clap, Bass, or Lead.
- Change the preset, tempo, swing, master level, and individual track levels.
- Use **Randomize**, **Clear**, and the JSON copy/export controls to explore ideas. Your current
  pattern is saved automatically in the browser and can be downloaded with **Export JSON**.
- Mute or solo tracks while the sequencer is running. The active step is announced to assistive
  technology and highlighted in the grid.

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
