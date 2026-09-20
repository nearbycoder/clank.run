import { bounded, DEFAULT_MASTER, TRACKS } from "./synth-data.js";

type Mix = { bpm: number; swing: number; master: number; pattern: number[][]; volumes: number[]; muted: boolean[]; soloed: boolean[] };
type Voice = { source: AudioScheduledSourceNode; nodes: AudioNode[]; release: () => void };
type AudioState = { context: AudioContext; master: GainNode; noise: AudioBuffer; voices: Set<Voice> };
type AudioHost = Pick<Window, "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval"> & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };

// Private, lazy audio owner. Timers and sources share a transport generation so
// a stopped run cannot move the playhead or resume after a later user action.
export function createSynthAudio(options: {
  host: () => AudioHost | null;
  mix: () => Mix;
  onPlaying: (playing: boolean) => void;
  onStep: (step: number) => void;
  onElapsed: (seconds: number) => void;
  onReady: (ready: boolean) => void;
  onStatus: (message: string) => void;
}) {
  let state: AudioState | null = null;
  let host: AudioHost | null = null;
  let disposed = false;
  let playing = false;
  let generation = 0;
  let lifecycle = 0;
  let nextStep = 0;
  let nextTime = 0;
  let timer: number | null = null;
  let elapsedTimer: number | null = null;
  const visualTimers = new Set<number>();
  let starting: Promise<void> | null = null;
  let unlocking: Promise<AudioState | null> | null = null;
  let volume = options.mix().master;

  function setVolume(value: number): void {
    volume = bounded(value, 0, 1) ? value : DEFAULT_MASTER;
    if (state && !disposed) state.master.gain.setTargetAtTime(volume, state.context.currentTime, 0.015);
  }
  function source(audio: AudioState, node: AudioScheduledSourceNode, nodes: AudioNode[], time: number, end: number): void {
    const voice: Voice = { source: node, nodes, release() {
      node.onended = null;
      for (const output of nodes) output.disconnect();
      audio.voices.delete(voice);
    } };
    node.onended = voice.release;
    audio.voices.add(voice);
    try { node.start(time); node.stop(end); } catch (error) { voice.release(); throw error; }
  }
  function envelope(output: GainNode, time: number, peak: number, duration: number): void {
    output.gain.setValueAtTime(0.0001, time);
    output.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), time + 0.004);
    output.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    output.gain.setValueAtTime(0.0001, time + duration + 0.01);
  }
  function voice(audio: AudioState, index: number, step: number, time: number, level: number): void {
    const context = audio.context;
    const output = context.createGain();
    if (index === 0) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(150, time);
      oscillator.frequency.exponentialRampToValueAtTime(46, time + 0.16);
      envelope(output, time, 0.9 * level, 0.27);
      oscillator.connect(output).connect(audio.master);
      source(audio, oscillator, [oscillator, output], time, time + 0.3);
    } else if (index < 4) {
      const noise = context.createBufferSource();
      const filter = context.createBiquadFilter();
      const duration = index === 1 ? 0.18 : index === 2 ? 0.055 : 0.12;
      noise.buffer = audio.noise;
      filter.type = "highpass";
      filter.frequency.value = index === 1 ? 1400 : index === 2 ? 6200 : 2100;
      envelope(output, time, 0.5 * level * (index === 2 ? 0.65 : index === 3 ? 0.8 : 1), duration);
      noise.connect(filter).connect(output).connect(audio.master);
      source(audio, noise, [noise, filter, output], time, time + duration + 0.02);
    } else {
      const oscillator = context.createOscillator();
      const filter = context.createBiquadFilter();
      const bass = index === 4;
      const duration = bass ? 0.19 : 0.16;
      oscillator.type = bass ? "square" : "sawtooth";
      oscillator.frequency.setValueAtTime((bass ? [55, 55, 65.4, 73.4, 82.4, 73.4, 65.4, 55] : [220, 261.6, 293.7, 329.6, 392, 329.6, 293.7, 261.6])[step % 8], time);
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(bass ? 850 : 1900, time);
      envelope(output, time, 0.35 * level, duration);
      oscillator.connect(filter).connect(output).connect(audio.master);
      source(audio, oscillator, [oscillator, filter, output], time, time + duration + 0.03);
    }
  }
  async function enable(): Promise<AudioState | null> {
    const token = lifecycle;
    try {
      host = options.host();
      if (!host || disposed) return null;
      if (!state) {
        const Constructor = host.AudioContext || host.webkitAudioContext;
        if (!Constructor) { options.onStatus("Web Audio is unavailable in this browser"); return null; }
        const context = new Constructor();
        const master = context.createGain();
        master.gain.value = volume;
        master.connect(context.destination);
        const noise = context.createBuffer(1, context.sampleRate * 0.5, context.sampleRate);
        const data = noise.getChannelData(0);
        for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
        state = { context, master, noise, voices: new Set() };
      }
      const audio = state;
      if (audio.context.state !== "running") await audio.context.resume();
      if (disposed || audio !== state || token !== lifecycle) return null;
      if (audio.context.state !== "running") { options.onReady(false); options.onStatus("Tap Enable audio to allow playback"); return null; }
      // A silent source completes the mobile unlock handshake and is owned by
      // the same cleanup path as every audible voice.
      const warmup = audio.context.createOscillator();
      const silent = audio.context.createGain();
      silent.gain.setValueAtTime(0, audio.context.currentTime);
      warmup.connect(silent).connect(audio.context.destination);
      source(audio, warmup, [warmup, silent], audio.context.currentTime, audio.context.currentTime + 0.02);
      options.onReady(true);
      if (!playing) options.onStatus("Audio enabled · Ready to play");
      return audio;
    } catch {
      if (!disposed && token === lifecycle) { options.onReady(false); options.onStatus("Tap Enable audio to allow playback"); }
      return null;
    }
  }
  function unlock(): Promise<AudioState | null> {
    if (disposed) return Promise.resolve(null);
    if (unlocking) return unlocking;
    const pending = enable().finally(() => { if (unlocking === pending) unlocking = null; });
    unlocking = pending;
    return pending;
  }
  function stop(): void {
    generation += 1;
    lifecycle += 1;
    starting = null;
    unlocking = null;
    playing = false;
    if (timer !== null) host?.clearTimeout(timer);
    if (elapsedTimer !== null) host?.clearInterval(elapsedTimer);
    for (const visual of visualTimers) host?.clearTimeout(visual);
    visualTimers.clear();
    timer = null;
    elapsedTimer = null;
    if (state) for (const entry of [...state.voices]) {
      try { entry.source.stop(state.context.currentTime); } catch { /* Already ended. */ }
      entry.release();
    }
    options.onPlaying(false);
    options.onStep(-1);
    if (!disposed) options.onStatus("Ready to play");
  }
  function schedule(token: number): void {
    if (!state || !host || disposed || !playing || token !== generation) return;
    const audio = state;
    // Background throttling must not enqueue minutes of missed notes at once.
    if (nextTime < audio.context.currentTime - 0.12) nextTime = audio.context.currentTime + 0.02;
    const mix = options.mix();
    const duration = 60 / mix.bpm / 4;
    const swing = mix.swing / 100 * 0.34;
    const anySolo = mix.soloed.some(Boolean);
    while (nextTime < audio.context.currentTime + 0.12) {
      const step = nextStep;
      TRACKS.forEach((_track, index) => {
        const level = mix.volumes[index];
        if (level > 0 && mix.pattern[index][step] && !mix.muted[index] && (!anySolo || mix.soloed[index])) voice(audio, index, step, nextTime, level);
      });
      const visual = host.setTimeout(() => {
        visualTimers.delete(visual);
        if (!disposed && playing && token === generation) options.onStep(step);
      }, Math.max(0, (nextTime - audio.context.currentTime) * 1000));
      visualTimers.add(visual);
      nextTime += duration * (step % 2 === 0 ? 1 + swing : 1 - swing);
      nextStep = (step + 1) % 16;
    }
    timer = host.setTimeout(() => schedule(token), 25);
  }
  function start(): Promise<void> {
    if (disposed || playing) return Promise.resolve();
    if (starting) return starting;
    const token = ++generation;
    starting = (async () => {
      const audio = await unlock();
      if (!audio || !host || disposed || token !== generation) return;
      playing = true;
      nextStep = 0;
      nextTime = audio.context.currentTime + 0.05;
      const startedAt = audio.context.currentTime;
      options.onPlaying(true);
      options.onElapsed(0);
      options.onStatus("Playing your loop");
      elapsedTimer = host.setInterval(() => {
        if (!disposed && playing && token === generation) options.onElapsed(Math.floor(audio.context.currentTime - startedAt));
      }, 250);
      schedule(token);
    })().finally(() => { if (token === generation) starting = null; });
    return starting;
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stop();
    const audio = state;
    state = null;
    audio?.master.disconnect();
    if (audio && audio.context.state !== "closed") void audio.context.close().catch(() => {});
  }
  return { unlock, start, stop, setVolume, dispose };
}
