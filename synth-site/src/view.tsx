/* @clankImportSource ../vendor/dom.js */
import { For, computed, effect, signal } from "../vendor/dom.js";
import { CLANK_THEME_PRESETS } from "../vendor/ui-theme.js";

export interface SynthBootState {
  frameworkVersion: string;
}

type Track = {
  id: string;
  name: string;
  short: string;
  kind: "drum" | "bass" | "lead";
  color: string;
  description: string;
};

const TRACKS: readonly Track[] = Object.freeze([
  { id: "kick", name: "Kick", short: "KICK", kind: "drum", color: "coral", description: "Sub punch" },
  { id: "snare", name: "Snare", short: "SNAR", kind: "drum", color: "amber", description: "Noise crack" },
  { id: "hat", name: "Hi-hat", short: "HAT", kind: "drum", color: "mint", description: "Bright tick" },
  { id: "clap", name: "Clap", short: "CLAP", kind: "drum", color: "lavender", description: "Wide snap" },
  { id: "bass", name: "Bass", short: "BASS", kind: "bass", color: "blue", description: "Warm square" },
  { id: "lead", name: "Lead", short: "LEAD", kind: "lead", color: "pink", description: "Saw melody" },
]);

const STEPS = Object.freeze(Array.from({ length: 16 }, (_, index) => index));
const STORAGE_KEY = "clank-synth-pattern-v1";

const PRESETS: Readonly<Record<string, { bpm: number; swing: number; pattern: readonly string[] }>> = Object.freeze({
  "Neon Pulse": { bpm: 112, swing: 8, pattern: ["x---x---x---x---", "----x-------x---", "x-x-x-x-x-x-x-x-", "--------x-------", "x--x--x---x--x--", "---x---x---x---x"] },
  "Night Drive": { bpm: 96, swing: 22, pattern: ["x-------x-------", "----x-------x---", "--x---x---x---x-", "--------x-------", "x--x----x--x----", "x---x-x---x---x-"] },
  "Arcade Bloom": { bpm: 128, swing: 4, pattern: ["x--x-x--x--x-x--", "----x-------x---", "xxxxxxxxxxxxxxxx", "--x-----x-----x-", "x-x-x---x-x-x---", "-x--x---x--x--x-"] },
  "Half Time": { bpm: 74, swing: 16, pattern: ["x-------x-------", "--------x-------", "x-x-x-x-x-x-x-x-", "--------x-------", "x-----x-x-----x-", "----x-------x---"] },
});

function patternFromPreset(name: string): number[][] {
  const preset = PRESETS[name] ?? PRESETS["Neon Pulse"];
  return preset.pattern.map((row) => [...row].map((step) => step === "x" ? 1 : 0));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseNumber(value: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, minimum, maximum) : fallback;
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function safeStoredState(): { preset?: string; theme?: string; bpm?: number; swing?: number; master?: number; pattern?: number[][]; volumes?: number[] } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const pattern = Array.isArray(parsed.pattern) && parsed.pattern.length === TRACKS.length
      ? parsed.pattern.map((row) => Array.isArray(row) && row.length === STEPS.length ? row.map((step) => step ? 1 : 0) : null)
      : null;
    if (!pattern || pattern.some((row) => row === null)) return null;
    const parsedPreset = typeof parsed.preset === "string" ? parsed.preset : undefined;
    return {
      preset: parsedPreset === "Custom" || (parsedPreset !== undefined && Boolean(PRESETS[parsedPreset])) ? parsedPreset : undefined,
      theme: typeof parsed.theme === "string" && CLANK_THEME_PRESETS.some((entry) => entry.id === parsed.theme) ? parsed.theme : undefined,
      bpm: typeof parsed.bpm === "number" ? parsed.bpm : undefined,
      swing: typeof parsed.swing === "number" ? parsed.swing : undefined,
      master: typeof parsed.master === "number" ? parsed.master : undefined,
      pattern: pattern as number[][],
      volumes: Array.isArray(parsed.volumes) && parsed.volumes.length === TRACKS.length ? parsed.volumes.map((value) => typeof value === "number" ? clamp(value, 0, 1) : 0.8) : undefined,
    };
  } catch {
    return null;
  }
}

type AudioState = {
  context: AudioContext;
  master: GainNode;
  noise: AudioBuffer;
  timer: number | null;
  nextStep: number;
  nextTime: number;
};

function createAudioState(): AudioState | null {
  if (typeof window === "undefined") return null;
  const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return null;
  const context = new AudioContextCtor();
  const master = context.createGain();
  master.gain.value = 0.78;
  master.connect(context.destination);
  const noise = context.createBuffer(1, context.sampleRate * 0.5, context.sampleRate);
  const data = noise.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  return { context, master, noise, timer: null, nextStep: 0, nextTime: 0 };
}

function gainEnvelope(context: AudioContext, output: GainNode, time: number, peak: number, duration: number): void {
  output.gain.setValueAtTime(0.0001, time);
  output.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), time + 0.004);
  output.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  output.gain.setValueAtTime(0.0001, time + duration + 0.01);
  void context;
}

function kick(state: AudioState, time: number, volume: number): void {
  const oscillator = state.context.createOscillator();
  const output = state.context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(150, time);
  oscillator.frequency.exponentialRampToValueAtTime(46, time + 0.16);
  gainEnvelope(state.context, output, time, 0.9 * volume, 0.27);
  oscillator.connect(output).connect(state.master);
  oscillator.start(time);
  oscillator.stop(time + 0.3);
}

function noiseHit(state: AudioState, time: number, volume: number, highpass: number, duration: number): void {
  const source = state.context.createBufferSource();
  const filter = state.context.createBiquadFilter();
  const output = state.context.createGain();
  source.buffer = state.noise;
  filter.type = "highpass";
  filter.frequency.value = highpass;
  gainEnvelope(state.context, output, time, 0.5 * volume, duration);
  source.connect(filter).connect(output).connect(state.master);
  source.start(time);
  source.stop(time + duration + 0.02);
}

function tone(state: AudioState, time: number, volume: number, frequency: number, type: OscillatorType, duration: number, filterFrequency: number): void {
  const oscillator = state.context.createOscillator();
  const filter = state.context.createBiquadFilter();
  const output = state.context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, time);
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(filterFrequency, time);
  gainEnvelope(state.context, output, time, 0.35 * volume, duration);
  oscillator.connect(filter).connect(output).connect(state.master);
  oscillator.start(time);
  oscillator.stop(time + duration + 0.03);
}

export function SynthView(_props: SynthBootState) {
  const stored = safeStoredState();
  const selectedPreset = signal(stored?.preset ?? "Neon Pulse");
  const selectedTheme = signal(stored?.theme ?? "clank");
  const bpm = signal(stored?.bpm ? clamp(stored.bpm, 60, 180) : PRESETS["Neon Pulse"].bpm);
  const swing = signal(stored?.swing ? clamp(stored.swing, 0, 40) : PRESETS["Neon Pulse"].swing);
  const masterVolume = signal(stored?.master === undefined ? 0.78 : clamp(stored.master, 0, 1));
  const pattern = signal<number[][]>(stored?.pattern ?? patternFromPreset("Neon Pulse"));
  const volumes = signal<number[]>(stored?.volumes ?? TRACKS.map(() => 0.82));
  const muted = signal<boolean[]>(TRACKS.map(() => false));
  const soloed = signal<boolean[]>(TRACKS.map(() => false));
  const playing = signal(false);
  const currentStep = signal(-1);
  const elapsed = signal(0);
  const status = signal("Ready to play");
  const activeCount = computed(() => pattern.value.flat().filter(Boolean).length);
  const audio = { current: null as AudioState | null };
  let startedAt = 0;
  let elapsedTimer: number | null = null;
  let starting = false;

  function setStatus(message: string): void {
    status.value = message;
  }

  function toggleStep(trackIndex: number, step: number): void {
    pattern.update((rows) => rows.map((row, index) => index === trackIndex ? row.map((value, position) => position === step ? (value ? 0 : 1) : value) : row));
    selectedPreset.value = "Custom";
    setStatus("Pattern edited");
  }

  function updateVolume(index: number, value: string): void {
    const next = parseNumber(value, volumes.value[index] ?? 0.8, 0, 1);
    volumes.update((values) => values.map((current, position) => position === index ? next : current));
  }

  function toggleFlag(index: number, flag: "mute" | "solo"): void {
    const target = flag === "mute" ? muted : soloed;
    target.update((values) => values.map((value, position) => position === index ? !value : value));
  }

  function applyPreset(name: string): void {
    const preset = PRESETS[name];
    if (!preset) return;
    selectedPreset.value = name;
    bpm.value = preset.bpm;
    swing.value = preset.swing;
    pattern.value = patternFromPreset(name);
    setStatus(`${name} loaded`);
  }

  function clearPattern(): void {
    pattern.value = TRACKS.map(() => STEPS.map(() => 0));
    selectedPreset.value = "Custom";
    setStatus("Pattern cleared");
  }

  function randomize(): void {
    pattern.value = TRACKS.map((_track, trackIndex) => STEPS.map((_step, step) => {
      const density = trackIndex === 0 ? 0.22 : trackIndex === 1 ? 0.16 : trackIndex === 2 ? 0.68 : trackIndex === 3 ? 0.12 : trackIndex === 4 ? 0.25 : 0.18;
      const anchor = trackIndex < 4 && (step === 0 || step === 4 || step === 8 || step === 12);
      return anchor || Math.random() < density ? 1 : 0;
    }));
    selectedPreset.value = "Custom";
    setStatus("A new pattern is ready");
  }

  function scheduleTrack(state: AudioState, trackIndex: number, time: number): void {
    const track = TRACKS[trackIndex];
    const level = volumes.value[trackIndex] ?? 0.8;
    const anySolo = soloed.value.some(Boolean);
    if (!pattern.value[trackIndex]?.[state.nextStep] || muted.value[trackIndex] || (anySolo && !soloed.value[trackIndex])) return;
    if (track.id === "kick") kick(state, time, level);
    else if (track.id === "snare") noiseHit(state, time, level, 1400, 0.18);
    else if (track.id === "hat") noiseHit(state, time, level * 0.65, 6200, 0.055);
    else if (track.id === "clap") noiseHit(state, time, level * 0.8, 2100, 0.12);
    else if (track.id === "bass") tone(state, time, level, [55, 55, 65.4, 73.4, 82.4, 73.4, 65.4, 55][state.nextStep % 8], "square", 0.19, 850);
    else tone(state, time, level, [220, 261.6, 293.7, 329.6, 392, 329.6, 293.7, 261.6][state.nextStep % 8], "sawtooth", 0.16, 1900);
  }

  function schedule(): void {
    const state = audio.current;
    if (!state || !playing.value) return;
    const stepDuration = 60 / bpm.value / 4;
    const swingFactor = (swing.value / 100) * 0.34;
    while (state.nextTime < state.context.currentTime + 0.12) {
      const step = state.nextStep;
      for (let trackIndex = 0; trackIndex < TRACKS.length; trackIndex += 1) scheduleTrack(state, trackIndex, state.nextTime);
      const delay = stepDuration * (step % 2 === 0 ? 1 + swingFactor : 1 - swingFactor);
      const visualDelay = Math.max(0, (state.nextTime - state.context.currentTime) * 1000);
      window.setTimeout(() => { if (playing.value) currentStep.value = step; }, visualDelay);
      state.nextTime += delay;
      state.nextStep = (step + 1) % STEPS.length;
    }
    state.timer = window.setTimeout(schedule, 25);
  }

  async function start(): Promise<void> {
    if (playing.value || starting) return;
    starting = true;
    try {
      if (!audio.current) audio.current = createAudioState();
      const state = audio.current;
      if (!state) { setStatus("Web Audio is unavailable in this browser"); return; }
      await state.context.resume();
      playing.value = true;
      state.nextStep = 0;
      state.nextTime = state.context.currentTime + 0.05;
      startedAt = Date.now();
      elapsed.value = 0;
      setStatus("Playing live");
      if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
      elapsedTimer = window.setInterval(() => { if (playing.value) elapsed.value = (Date.now() - startedAt) / 1000; }, 250);
      schedule();
    } finally {
      starting = false;
    }
  }

  function stop(): void {
    playing.value = false;
    currentStep.value = -1;
    if (audio.current?.timer !== null && audio.current?.timer !== undefined) window.clearTimeout(audio.current.timer);
    if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
    elapsedTimer = null;
    setStatus("Ready to play");
  }

  function exportPattern(): void {
    if (typeof window === "undefined") return;
    const payload = JSON.stringify({ version: 1, name: selectedPreset.value, bpm: bpm.value, swing: swing.value, master: masterVolume.value, pattern: pattern.value, volumes: volumes.value }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selectedPreset.value.toLowerCase().replace(/[^a-z0-9]+/gu, "-") || "clank-pattern"}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setStatus("Pattern exported");
  }

  function copyPattern(): void {
    if (typeof navigator === "undefined" || !navigator.clipboard) { setStatus("Clipboard is unavailable"); return; }
    navigator.clipboard.writeText(JSON.stringify({ bpm: bpm.value, swing: swing.value, pattern: pattern.value })).then(() => setStatus("Pattern JSON copied"), () => setStatus("Clipboard permission was denied"));
  }

  if (typeof window !== "undefined") {
    effect(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: selectedTheme.value, preset: selectedPreset.value, bpm: bpm.value, swing: swing.value, master: masterVolume.value, pattern: pattern.value, volumes: volumes.value }));
      } catch { /* Storage can be disabled without breaking the synth. */ }
    });
    effect(() => {
      if (audio.current) audio.current.master.gain.setTargetAtTime(masterVolume.value, audio.current.context.currentTime, 0.015);
    });
    effect(() => {
      document.documentElement.setAttribute("data-clank-theme", selectedTheme.value);
    });
    window.addEventListener("keydown", (event) => {
      if (event.code === "Space" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)) {
        event.preventDefault();
        if (playing.value) stop(); else void start();
      }
    });
  }

  return (
    <div class="synth-app">
      <header class="topbar">
        <a class="wordmark" href="/" aria-label="Clank Synth home"><span class="mark">✦</span><strong>Clank</strong><span class="wordmark-product">Synth</span></a>
        <div class="topbar-tools"><div class="topbar-meta"><span class="live-dot" classList={{ playing: playing.value }} /> <span>{status.value}</span><span class="topbar-divider" /><span class="mono">{_props.frameworkVersion}</span></div><label class="theme-control"><span>Theme</span><select value={selectedTheme.value} onChange={(event: Event) => { selectedTheme.value = (event.currentTarget as HTMLSelectElement).value; }} aria-label="Select a Clank design system theme"><For each={CLANK_THEME_PRESETS} by="id">{(theme) => <option value={theme.id}>{theme.name}</option>}</For></select></label></div>
      </header>

      <main class="synth-shell">
        <section class="hero">
          <div class="hero-copy"><span class="eyebrow">CLANK AUDIO LAB · 001</span><h1>Program your own <em>pulse.</em></h1><p>A tiny, playable groovebox built with Clank signals, server rendering, and the Web Audio API. Shape a loop, press play, and hear every change immediately.</p><div class="hero-tags"><span>16 steps</span><span>6 instruments</span><span>zero dependencies</span></div></div>
          <div class="hero-meter"><div class="meter-orbit"><span class="meter-core" classList={{ active: playing.value }} /><i /><i /><i /><i /></div><div><span class="meter-label">SESSION TIME</span><strong>{formatTime(elapsed.value)}</strong></div><div class="hero-meter-footer"><span>{activeCount.value} active steps</span><span class="mono">SPACE TO PLAY</span></div></div>
        </section>

        <section class="transport panel" aria-label="Transport controls">
          <div class="transport-main"><button class="play-button" type="button" onClick={() => playing.value ? stop() : void start()} agentId="transport-play" agentLabel={playing.value ? "Stop the synth" : "Play the synth"}><span>{playing.value ? "■" : "▶"}</span>{playing.value ? "Stop" : "Play"}</button><button class="secondary-button" type="button" onClick={clearPattern} agentId="pattern-clear" agentLabel="Clear all sequencer steps">Clear</button><button class="secondary-button" type="button" onClick={randomize} agentId="pattern-randomize" agentLabel="Generate a random beat">Randomize <span>⌘</span></button></div>
          <div class="transport-sliders"><label><span>Tempo <strong>{bpm.value} BPM</strong></span><input type="range" min="60" max="180" step="1" value={bpm.value} onInput={(event: InputEvent) => { bpm.value = parseNumber((event.currentTarget as HTMLInputElement).value, bpm.value, 60, 180); }} aria-label="Tempo in beats per minute" /></label><label><span>Swing <strong>{swing.value}%</strong></span><input type="range" min="0" max="40" step="1" value={swing.value} onInput={(event: InputEvent) => { swing.value = parseNumber((event.currentTarget as HTMLInputElement).value, swing.value, 0, 40); }} aria-label="Swing percentage" /></label><label><span>Master <strong>{Math.round(masterVolume.value * 100)}%</strong></span><input type="range" min="0" max="1" step="0.01" value={masterVolume.value} onInput={(event: InputEvent) => { masterVolume.value = parseNumber((event.currentTarget as HTMLInputElement).value, masterVolume.value, 0, 1); }} aria-label="Master volume" /></label></div>
        </section>

        <section class="sequencer panel" aria-labelledby="sequencer-title">
          <header class="panel-header"><div><span class="eyebrow">STEP PROGRAMMER</span><h2 id="sequencer-title">Build a loop</h2></div><div class="header-actions"><label class="select-control"><span>Pattern</span><select value={selectedPreset.value} onChange={(event: Event) => applyPreset((event.currentTarget as HTMLSelectElement).value)} aria-label="Select a pattern preset"><option value="Custom">Custom</option><For each={Object.keys(PRESETS)}>{(name) => <option value={name}>{name}</option>}</For></select></label><button class="icon-button" type="button" onClick={copyPattern} aria-label="Copy pattern JSON" title="Copy pattern JSON">↗</button><button class="icon-button" type="button" onClick={exportPattern} aria-label="Export pattern JSON" title="Export pattern JSON">↓</button></div></header>
          <div class="sequencer-scroll"><div class="step-grid"><div class="track-spacer" /><div class="step-numbers"><For each={STEPS}>{(step) => <span classList={{ current: currentStep.value === step }}>{String(step + 1).padStart(2, "0")}</span>}</For></div><For each={TRACKS} by="id">{(track, trackIndex) => <div class="track-row"><div class={`track-label ${track.color}`}><span class="track-icon">{track.id === "kick" ? "◉" : track.id === "snare" ? "◌" : track.id === "hat" ? "⌁" : track.id === "clap" ? "✺" : track.id === "bass" ? "∿" : "✦"}</span><span><strong>{track.name}</strong><small>{track.description}</small></span></div><div class="step-cells"><For each={STEPS}>{(step) => <button type="button" class="step-cell" classList={{ active: Boolean(pattern.value[trackIndex()].at(step)), current: currentStep.value === step }} onClick={() => toggleStep(trackIndex(), step)} aria-label={`${track.name}, step ${step + 1}`} aria-pressed={pattern.value[trackIndex()].at(step) ? "true" : "false"} agentId={`step-${track.id}-${step + 1}`} agentLabel={`Toggle ${track.name} step ${step + 1}`}><span /></button>}</For></div><div class="track-controls"><button classList={{ enabled: muted.value[trackIndex()] }} type="button" onClick={() => toggleFlag(trackIndex(), "mute")} aria-label={`${muted.value[trackIndex()] ? "Unmute" : "Mute"} ${track.name}`}>M</button><button classList={{ enabled: soloed.value[trackIndex()] }} type="button" onClick={() => toggleFlag(trackIndex(), "solo")} aria-label={`${soloed.value[trackIndex()] ? "Unsolo" : "Solo"} ${track.name}`}>S</button><input type="range" min="0" max="1" step="0.01" value={volumes.value[trackIndex()]} onInput={(event: InputEvent) => updateVolume(trackIndex(), (event.currentTarget as HTMLInputElement).value)} aria-label={`${track.name} volume`} /></div></div>}</For></div></div>
          <footer class="sequencer-footer"><span><i class="legend-dot active" /> active step</span><span><i class="legend-dot current" /> playhead</span><span class="sequencer-count">{activeCount.value} / 96 steps active</span></footer>
        </section>

        <section class="lower-grid"><article class="panel info-panel"><header class="panel-header compact"><div><span class="eyebrow">INSTRUMENT RACK</span><h2>Six voices, one mix</h2></div><span class="badge">WEB AUDIO</span></header><div class="instrument-list"><For each={TRACKS} by="id">{(track, index) => <div class="instrument-row"><span class={`instrument-swatch ${track.color}`} /><div><strong>{track.name}</strong><small>{track.kind === "drum" ? "Percussion voice" : track.kind === "bass" ? "Low oscillator" : "Melodic oscillator"}</small></div><span class="instrument-level">{Math.round((volumes.value[index()] ?? 0) * 100)}%</span></div>}</For></div></article><article class="panel info-panel"><header class="panel-header compact"><div><span class="eyebrow">HOW IT WORKS</span><h2>A reactive instrument</h2></div><span class="badge green">LIVE</span></header><div class="notes"><p><span>01</span><strong>Signal-first UI</strong><small>Every cell, control, and meter is a reactive Clank signal.</small></p><p><span>02</span><strong>Look-ahead scheduler</strong><small>Native oscillators are queued 120ms ahead for a steady groove.</small></p><p><span>03</span><strong>Private by default</strong><small>Your pattern is saved to this browser, never uploaded to a server.</small></p></div></article></section>
      </main>
      <footer class="site-footer"><span>CLANK SYNTH / AUDIO LAB 001</span><span>Built with <a href="https://clank.run">Clank</a> · <a href="https://docs.clank.run">Read the docs</a></span></footer>
    </div>
  );
}
