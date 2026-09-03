/**
 * Card sounds, synthesised rather than sampled -- no assets to load, and a
 * shaped noise burst is a convincing card slide.
 *
 * Presence is cheap here and worth a lot: a table where cards make no sound
 * feels like a spreadsheet.
 */

let context: AudioContext | null = null;
let enabled = true;

function ctx(): AudioContext | null {
  if (!enabled) return null;
  // Browsers require a gesture before audio starts; every caller here is one.
  context ??= new AudioContext();
  if (context.state === 'suspended') void context.resume();
  return context;
}

export function setSoundEnabled(value: boolean): void {
  enabled = value;
}

export function isSoundEnabled(): boolean {
  return enabled;
}

/** Filtered white noise: the body of every card sound. */
function burst(duration: number, frequency: number, gain: number, when = 0): void {
  const audio = ctx();
  if (!audio) return;

  const frames = Math.max(1, Math.floor(audio.sampleRate * duration));
  const buffer = audio.createBuffer(1, frames, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    // Decaying noise, so it reads as a brush rather than a hiss.
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
  }

  const source = audio.createBufferSource();
  source.buffer = buffer;

  const filter = audio.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = frequency;
  filter.Q.value = 0.8;

  const volume = audio.createGain();
  volume.gain.value = gain;

  source.connect(filter).connect(volume).connect(audio.destination);
  source.start(audio.currentTime + when);
}

export const sounds = {
  slide: () => burst(0.13, 2100, 0.16),
  flip: () => burst(0.07, 3400, 0.22),
  deal: () => burst(0.09, 2600, 0.14),
  /** A riffle is just a run of small slides with tightening gaps. */
  shuffle: () => {
    for (let i = 0; i < 9; i++) burst(0.05, 1800 + i * 90, 0.09, i * 0.035);
  },
  pickup: () => burst(0.05, 2800, 0.1),
};
