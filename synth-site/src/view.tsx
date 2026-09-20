/* @clankImportSource ../vendor/dom.js */
import { For, Show, computed, effect, onCleanup, signal } from "../vendor/dom.js";
import { batch } from "../vendor/core.js";
import { CLANK_THEME_PRESETS } from "../vendor/ui-theme.js";
import { createSynthAudio } from "./synth-audio.js";
import { TRACKS, STEPS, PRESETS, STORAGE_KEY, MAX_PATTERN_BYTES, DEFAULT_MASTER, DEFAULT_LEVEL, patternFromPreset, readStoredState, importPattern, createPatternHistory, createTapTempo, editTrack, isTransportShortcut, stepDestination, type PatternDocument } from "./synth-data.js";

export interface SynthBootState { frameworkVersion: string; }
function parseNumber(value: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}
function formatTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}
function safeStoredState() {
  if (typeof window === "undefined") return null;
  try { return readStoredState(window.localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}

export function SynthView(_props: SynthBootState) {
  const stored = safeStoredState();
  const selectedPreset = signal(stored?.preset ?? "Neon Pulse");
  const selectedTheme = signal(stored?.theme ?? "clank");
  const bpm = signal(stored?.bpm ?? PRESETS["Neon Pulse"].bpm);
  const swing = signal(stored?.swing ?? PRESETS["Neon Pulse"].swing);
  const masterVolume = signal(stored?.master ?? DEFAULT_MASTER);
  const pattern = signal<number[][]>(stored?.pattern ?? patternFromPreset("Neon Pulse"));
  const volumes = signal<number[]>(stored?.volumes ?? TRACKS.map(() => DEFAULT_LEVEL));
  const muted = signal<boolean[]>(TRACKS.map(() => false));
  const soloed = signal<boolean[]>(TRACKS.map(() => false));
  const playing = signal(false);
  const currentStep = signal(-1);
  const elapsed = signal(0);
  const status = signal("Ready to play");
  const audioReady = signal(false);
  const focusedStep = signal(0);
  const importError = signal("");
  const activeCount = computed(() => pattern.value.flat().filter(Boolean).length);
  const history = createPatternHistory();
  const historyVersion = signal(0);
  const canUndo = computed(() => { historyVersion.value; return history.canUndo; });
  const canRedo = computed(() => { historyVersion.value; return history.canRedo; });
  const tap = createTapTempo();
  let disposed = false;
  let editVersion = 0;
  let importRequest = 0;
  const audio = createSynthAudio({
    host: () => typeof window === "undefined" ? null : window,
    mix: () => ({ bpm: bpm.value, swing: swing.value, master: masterVolume.value, pattern: pattern.value, volumes: volumes.value, muted: muted.value, soloed: soloed.value }),
    onPlaying: (value) => { playing.value = value; },
    onStep: (value) => { currentStep.value = value; },
    onElapsed: (value) => { elapsed.value = value; },
    onReady: (value) => { audioReady.value = value; },
    onStatus: (value) => { status.value = value; },
  });
  const unlockAudio = audio.unlock;
  const start = audio.start;
  const stop = audio.stop;
  function snapshot(): PatternDocument {
    return { version: 1, name: selectedPreset.value, bpm: bpm.value, swing: swing.value, master: masterVolume.value, pattern: pattern.value, volumes: volumes.value };
  }
  function apply(value: PatternDocument): void {
    selectedPreset.value = value.name;
    bpm.value = value.bpm;
    swing.value = value.swing;
    masterVolume.value = value.master;
    pattern.value = value.pattern;
    volumes.value = value.volumes;
  }
  function commit(value: PatternDocument, message: string): void {
    if (!history.record(snapshot(), value)) return;
    batch(() => {
      apply(value);
      editVersion += 1;
      historyVersion.value += 1;
      status.value = message;
    });
  }
  function toggleStep(track: number, step: number): void {
    commit({ ...snapshot(), name: "Custom", pattern: pattern.value.map((row, index) => index === track ? row.map((value, cell) => cell === step ? value ? 0 : 1 : value) : row) }, "Pattern edited");
  }
  function changeTrack(track: number, action: "clear" | "left" | "right"): void {
    commit({ ...snapshot(), name: "Custom", pattern: editTrack(pattern.value, track, action) }, `${TRACKS[track].name} ${action === "clear" ? "cleared" : `rotated ${action}`}`);
  }
  function updateVolume(track: number, value: string): void {
    const next = parseNumber(value, volumes.peek()[track], 0, 1);
    if (next === volumes.peek()[track]) return;
    editVersion += 1;
    volumes.value = volumes.value.map((level, index) => index === track ? next : level);
  }
  function updateNumber(state: { value: number }, next: number): void {
    if (state.value === next) return;
    editVersion += 1;
    state.value = next;
  }
  function toggleFlag(track: number, kind: "mute" | "solo"): void {
    editVersion += 1;
    const target = kind === "mute" ? muted : soloed;
    target.value = target.value.map((value, index) => index === track ? !value : value);
  }
  function applyPreset(name: string): void {
    if (!Object.hasOwn(PRESETS, name)) return;
    commit({ ...snapshot(), name, bpm: PRESETS[name].bpm, swing: PRESETS[name].swing, pattern: patternFromPreset(name) }, `${name} loaded`);
  }
  function clearPattern(): void {
    commit({ ...snapshot(), name: "Custom", pattern: TRACKS.map(() => STEPS.map(() => 0)) }, "Pattern cleared");
  }
  function randomize(): void {
    const chances = [0.22, 0.16, 0.68, 0.12, 0.25, 0.18];
    commit({ ...snapshot(), name: "Custom", pattern: TRACKS.map((_track, index) => STEPS.map((step) => index < 4 && step % 4 === 0 || Math.random() < chances[index] ? 1 : 0)) }, "New pattern generated");
  }
  function travel(direction: "undo" | "redo"): void {
    const next = history[direction](snapshot());
    if (!next) return;
    stop();
    batch(() => { apply(next); editVersion += 1; historyVersion.value += 1; status.value = direction === "undo" ? "Pattern edit undone" : "Pattern edit redone"; });
  }
  function resetMix(): void {
    editVersion += 1;
    batch(() => {
      volumes.value = TRACKS.map(() => DEFAULT_LEVEL);
      muted.value = TRACKS.map(() => false);
      soloed.value = TRACKS.map(() => false);
      masterVolume.value = DEFAULT_MASTER;
      status.value = "Mix reset · Pattern and tempo preserved";
    });
  }
  function tapTempo(): void {
    const next = tap(performance.now());
    if (next === null) { status.value = "Tap again to set the tempo"; return; }
    updateNumber(bpm, next);
    status.value = `Tempo set to ${next} BPM`;
  }
  function stepKey(event: KeyboardEvent, track: number, step: number): void {
    if (event.isComposing || event.altKey || event.metaKey || event.shiftKey) return;
    if ((event.key === " " || event.key === "Enter") && !event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleStep(track, step);
      return;
    }
    if (event.ctrlKey && event.key !== "Home" && event.key !== "End") return;
    const next = stepDestination(event.key, track, step, event.ctrlKey);
    if (!next) return;
    event.preventDefault();
    const button = (event.currentTarget as HTMLElement).closest(".step-grid")?.querySelector<HTMLElement>(`[data-step-index="${next.track * 16 + next.step}"]`);
    if (button) {
      focusedStep.value = next.track * 16 + next.step;
      button.focus({ preventScroll: true });
      button.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  function handlePlayClick(): void {
    if (playing.value) stop(); else void start();
  }
  function exportPattern(): void {
    const payload = JSON.stringify(snapshot(), null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `clank-synth-${selectedPreset.value.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
    status.value = "Pattern exported";
  }
  function copyPattern(): void {
    if (typeof navigator === "undefined" || !navigator.clipboard) { status.value = "Clipboard unavailable · Use Export instead"; return; }
    void navigator.clipboard.writeText(JSON.stringify(snapshot())).then(() => { if (!disposed) status.value = "Pattern copied"; }, () => { if (!disposed) status.value = "Clipboard denied · Use Export instead"; });
  }
  async function loadPattern(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const request = ++importRequest;
    const revision = editVersion;
    importError.value = "";
    try {
      if (file.size > MAX_PATTERN_BYTES) throw new Error("Pattern files must be 16 KB or smaller.");
      const next = importPattern(await file.text());
      if (disposed || request !== importRequest) return;
      if (revision !== editVersion) throw new Error("The pattern changed while loading. Import the file again to replace it.");
      stop();
      commit(next, "Pattern imported · Press Play when ready");
      status.value = "Pattern imported · Press Play when ready";
    } catch (error) {
      if (!disposed && request === importRequest) importError.value = error instanceof Error ? error.message : "This file could not be read. Choose a JSON pattern export.";
    }
  }
  if (typeof window !== "undefined") {
    effect(() => {
      const value = JSON.stringify({ theme: selectedTheme.value, preset: selectedPreset.value, bpm: bpm.value, swing: swing.value, master: masterVolume.value, pattern: pattern.value, volumes: volumes.value });
      try { window.localStorage.setItem(STORAGE_KEY, value); } catch { /* Browser storage is optional. */ }
    });
    effect(() => { audio.setVolume(masterVolume.value); });
    effect(() => { document.documentElement.setAttribute("data-clank-theme", selectedTheme.value); });
    const keydown = (event: KeyboardEvent) => {
      if (!isTransportShortcut(event)) return;
      event.preventDefault();
      if (playing.value) stop(); else void start();
    };
    window.addEventListener("keydown", keydown);
    onCleanup(() => {
      disposed = true;
      importRequest += 1;
      window.removeEventListener("keydown", keydown);
      audio.dispose();
    });
  }

  return (
    <div class="synth-app">
      <header class="topbar">
        <a class="wordmark" href="/" aria-label="Clank Synth home"><span class="mark">✦</span><strong>Clank</strong><span class="wordmark-product">Synth</span></a>
        <div class="topbar-tools"><div class="topbar-meta" aria-live="polite"><span class="live-dot" classList={{ playing: playing.value }} /> <span>{status.value}</span><span class="topbar-divider" /><span class="mono">{_props.frameworkVersion}</span></div><label class="theme-control"><span>Theme</span><select value={selectedTheme.value} onChange={(event: Event) => { const value = (event.currentTarget as HTMLSelectElement).value; if (CLANK_THEME_PRESETS.some((theme) => theme.id === value)) selectedTheme.value = value; }} aria-label="Select a Clank design system theme"><For each={CLANK_THEME_PRESETS} by="id">{(theme) => <option value={theme.id}>{theme.name}</option>}</For></select></label></div>
      </header>

      <main class="synth-shell">
        <section class="hero">
          <div class="hero-copy"><span class="eyebrow">CLANK AUDIO LAB · 001</span><h1>Program your own <em>pulse.</em></h1><p>A tiny, playable groovebox built with Clank signals, server rendering, and the Web Audio API. Shape a loop, press play, and hear every change immediately.</p><div class="hero-tags"><span>16 steps</span><span>6 instruments</span><span>zero dependencies</span></div></div>
          <div class="hero-meter"><div class="meter-orbit"><span class="meter-core" classList={{ active: playing.value }} /><i /><i /><i /><i /></div><div><span class="meter-label">SESSION TIME</span><strong>{formatTime(elapsed.value)}</strong></div><div class="hero-meter-footer"><span>{activeCount.value} active steps</span><span class="mono">SPACE TO PLAY</span></div></div>
        </section>

        <Show when={!audioReady.value}>
          <aside class="audio-gate panel" aria-label="Enable audio playback">
            <span class="audio-gate-icon">♫</span>
            <div><strong>Audio is off</strong><small>Mobile browsers require a tap before sound can play.</small></div>
            <button class="audio-gate-button" type="button" onPointerDown={() => void unlockAudio()} onClick={() => void unlockAudio()} agentId="audio-enable" agentLabel="Enable audio playback">Enable audio</button>
          </aside>
        </Show>

        <section class="transport panel" aria-label="Transport controls">
          <div class="transport-main"><button class="play-button" type="button" onClick={handlePlayClick} agentId="transport-play" agentLabel={playing.value ? "Stop the synth" : audioReady.value ? "Play the synth" : "Enable audio and play the synth"}><span>{playing.value ? "■" : "▶"}</span>{playing.value ? "Stop" : "Play"}</button><button class="secondary-button" type="button" onClick={clearPattern} agentId="pattern-clear" agentLabel="Clear all sequencer steps">Clear</button><button class="secondary-button" type="button" onClick={randomize} agentId="pattern-randomize" agentLabel="Generate a random beat">Randomize <span>⌘</span></button><button class="secondary-button" type="button" onClick={tapTempo} aria-label="Tap tempo">Tap tempo</button></div>
          <div class="transport-sliders"><label><span>Tempo <strong>{bpm.value} BPM</strong></span><input type="range" min="60" max="180" step="1" value={bpm.value} onInput={(event: InputEvent) => { updateNumber(bpm, parseNumber((event.currentTarget as HTMLInputElement).value, bpm.value, 60, 180)); }} aria-label="Tempo in beats per minute" /></label><label><span>Swing <strong>{swing.value}%</strong></span><input type="range" min="0" max="40" step="1" value={swing.value} onInput={(event: InputEvent) => { updateNumber(swing, parseNumber((event.currentTarget as HTMLInputElement).value, swing.value, 0, 40)); }} aria-label="Swing percentage" /></label><label><span>Master <strong>{Math.round(masterVolume.value * 100)}%</strong></span><input type="range" min="0" max="1" step="0.01" value={masterVolume.value} onInput={(event: InputEvent) => { updateNumber(masterVolume, parseNumber((event.currentTarget as HTMLInputElement).value, masterVolume.value, 0, 1)); }} aria-label="Master volume" /></label></div>
        </section>

        <section class="sequencer panel" aria-labelledby="sequencer-title">
          <header class="panel-header"><div><span class="eyebrow">STEP PROGRAMMER</span><h2 id="sequencer-title">Build a loop</h2></div><div class="header-actions"><label class="select-control"><span>Pattern</span><select value={selectedPreset.value} onChange={(event: Event) => applyPreset((event.currentTarget as HTMLSelectElement).value)} aria-label="Select a pattern preset"><option value="Custom">Custom</option><For each={Object.keys(PRESETS)}>{(name) => <option value={name}>{name}</option>}</For></select></label><button class="icon-button" type="button" onClick={copyPattern} aria-label="Copy pattern JSON" title="Copy pattern JSON">↗</button><button class="icon-button" type="button" onClick={exportPattern} aria-label="Export pattern JSON" title="Export pattern JSON">↓</button></div></header>
          <div class="pattern-tools"><div class="history-actions" role="group" aria-label="Pattern history"><button class="secondary-button" type="button" onClick={() => travel("undo")} disabled={!canUndo.value} aria-label="Undo pattern edit">Undo</button><button class="secondary-button" type="button" onClick={() => travel("redo")} disabled={!canRedo.value} aria-label="Redo pattern edit">Redo</button></div><label class="secondary-button import-button">Import JSON<input type="file" accept=".json,application/json" aria-label="Import pattern JSON" onChange={(event: Event) => void loadPattern(event)} /></label><span id="sequencer-keyboard-help">Arrow keys move · Enter or Space toggles</span></div>
          <Show when={Boolean(importError.value)}><p class="import-error" role="alert">{importError.value}</p></Show>
          <div class="sequencer-scroll"><div class="step-grid" role="group" aria-label="16-step sequencer" aria-describedby="sequencer-keyboard-help"><div class="track-spacer" /><div class="step-numbers"><For each={STEPS}>{(step) => <span classList={{ current: currentStep.value === step }}>{String(step + 1).padStart(2, "0")}</span>}</For></div><For each={TRACKS} by="id">{(track, trackIndex) => <div class="track-row"><div class={`track-label ${track.color}`}><span class="track-icon">{track.id === "kick" ? "◉" : track.id === "snare" ? "◌" : track.id === "hat" ? "⌁" : track.id === "clap" ? "✺" : track.id === "bass" ? "∿" : "✦"}</span><span><strong>{track.name}</strong><small>{track.description}</small></span></div><div class="step-cells"><For each={STEPS}>{(step) => <button type="button" class="step-cell" data-step-index={trackIndex() * 16 + step} tabIndex={focusedStep.value === trackIndex() * 16 + step ? 0 : -1} onFocus={() => { focusedStep.value = trackIndex() * 16 + step; }} onKeyDown={(event: KeyboardEvent) => stepKey(event, trackIndex(), step)} classList={{ active: Boolean(pattern.value[trackIndex()].at(step)), current: currentStep.value === step }} onClick={() => toggleStep(trackIndex(), step)} aria-label={`${track.name}, step ${step + 1}`} aria-pressed={pattern.value[trackIndex()].at(step) ? "true" : "false"} agentId={`step-${track.id}-${step + 1}`} agentLabel={`Toggle ${track.name} step ${step + 1}`}><span /></button>}</For></div><div class="track-controls"><button classList={{ enabled: muted.value[trackIndex()] }} type="button" onClick={() => toggleFlag(trackIndex(), "mute")} aria-pressed={muted.value[trackIndex()] ? "true" : "false"} aria-label={`${muted.value[trackIndex()] ? "Unmute" : "Mute"} ${track.name}`}>M</button><button classList={{ enabled: soloed.value[trackIndex()] }} type="button" onClick={() => toggleFlag(trackIndex(), "solo")} aria-pressed={soloed.value[trackIndex()] ? "true" : "false"} aria-label={`${soloed.value[trackIndex()] ? "Unsolo" : "Solo"} ${track.name}`}>S</button><input type="range" min="0" max="1" step="0.01" value={volumes.value[trackIndex()]} onInput={(event: InputEvent) => updateVolume(trackIndex(), (event.currentTarget as HTMLInputElement).value)} aria-label={`${track.name} volume`} /></div></div>}</For></div></div>
          <footer class="sequencer-footer"><span><i class="legend-dot active" /> active step</span><span><i class="legend-dot current" /> playhead</span><span class="sequencer-count">{activeCount.value} / 96 steps active</span></footer>
        </section>

        <section class="lower-grid"><article class="panel info-panel"><header class="panel-header compact"><div><span class="eyebrow">INSTRUMENT RACK</span><h2>Six voices, one mix</h2></div><button class="secondary-button" type="button" onClick={resetMix} aria-label="Reset all mix levels, mutes, and solos">Reset mix</button></header><div class="instrument-list"><For each={TRACKS} by="id">{(track, index) => <div class="instrument-row"><span class={`instrument-swatch ${track.color}`} /><div><strong>{track.name}</strong><small>{track.kind === "drum" ? "Percussion voice" : track.kind === "bass" ? "Low oscillator" : "Melodic oscillator"}</small></div><span class="instrument-level">{Math.round((volumes.value[index()] ?? 0) * 100)}%</span><div class="track-edit-actions" role="group" aria-label={`${track.name} pattern tools`}><button type="button" onClick={() => changeTrack(index(), "left")} aria-label={`Rotate ${track.name} left one step`} title="Rotate left">←</button><button type="button" onClick={() => changeTrack(index(), "right")} aria-label={`Rotate ${track.name} right one step`} title="Rotate right">→</button><button type="button" onClick={() => changeTrack(index(), "clear")} aria-label={`Clear ${track.name} steps`}>Clear</button></div></div>}</For></div></article><article class="panel info-panel"><header class="panel-header compact"><div><span class="eyebrow">HOW IT WORKS</span><h2>A reactive instrument</h2></div><span class="badge green">LIVE</span></header><div class="notes"><p><span>01</span><strong>Signal-first UI</strong><small>Every cell, control, and meter is a reactive Clank signal.</small></p><p><span>02</span><strong>Look-ahead scheduler</strong><small>Native oscillators are queued 120ms ahead for a steady groove.</small></p><p><span>03</span><strong>Private by default</strong><small>Your pattern is saved to this browser, never uploaded to a server.</small></p></div></article></section>
      </main>
      <footer class="site-footer"><span>CLANK SYNTH / AUDIO LAB 001</span><span>Built with <a href="https://clank.run">Clank</a> · <a href="https://docs.clank.run">Read the docs</a></span></footer>
    </div>
  );
}
