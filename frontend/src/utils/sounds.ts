// Terminal-aesthetic sound effects via Web Audio API oscillators
// No audio files needed — all sounds generated programmatically

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  return ctx;
}

function beep(freq: number, duration: number, type: OscillatorType = "sine", volume: number = 0.15): void {
  try {
    const c = getCtx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, c.currentTime);
    gain.gain.setValueAtTime(volume, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(c.currentTime);
    osc.stop(c.currentTime + duration);
  } catch {
    // AudioContext not available
  }
}

// Message sent — soft ascending click
export function playMessageSent(): void {
  beep(800, 0.06, "sine", 0.08);
  setTimeout(() => beep(1200, 0.04, "sine", 0.06), 50);
}

// Message received — two-tone descending
export function playMessageReceived(): void {
  beep(1000, 0.08, "sine", 0.1);
  setTimeout(() => beep(700, 0.06, "sine", 0.08), 70);
}

// Peer connected — ascending triad
export function playPeerConnected(): void {
  beep(523, 0.12, "triangle", 0.12); // C5
  setTimeout(() => beep(659, 0.12, "triangle", 0.1), 120); // E5
  setTimeout(() => beep(784, 0.15, "triangle", 0.08), 240); // G5
}

// Peer disconnected — descending minor
export function playPeerDisconnected(): void {
  beep(784, 0.12, "triangle", 0.12); // G5
  setTimeout(() => beep(622, 0.12, "triangle", 0.1), 120); // Eb5
  setTimeout(() => beep(523, 0.18, "triangle", 0.08), 240); // C5
}

// Call ended — low double beep
export function playCallEnded(): void {
  beep(440, 0.1, "square", 0.08);
  setTimeout(() => beep(330, 0.15, "square", 0.06), 150);
}

// File transfer complete — cheerful ascending
export function playFileComplete(): void {
  beep(660, 0.08, "sine", 0.1);
  setTimeout(() => beep(880, 0.08, "sine", 0.08), 80);
  setTimeout(() => beep(1100, 0.12, "sine", 0.06), 160);
}

// Error — low buzz
export function playError(): void {
  beep(200, 0.15, "sawtooth", 0.08);
  setTimeout(() => beep(180, 0.2, "sawtooth", 0.06), 100);
}
