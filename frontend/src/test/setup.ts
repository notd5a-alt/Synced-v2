import '@testing-library/jest-dom';

// Mock Web Crypto API (jsdom has no SubtleCrypto)
const mockSign = vi.fn().mockResolvedValue(new ArrayBuffer(32));
const mockVerify = vi.fn().mockResolvedValue(true);

Object.defineProperty(globalThis, 'crypto', {
  value: {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2),
    subtle: {
      importKey: vi.fn().mockResolvedValue({ type: 'secret' }),
      deriveKey: vi.fn().mockResolvedValue({ type: 'secret', algorithm: { name: 'HMAC' } }),
      sign: mockSign,
      verify: mockVerify,
    },
    getRandomValues: <T extends ArrayBufferView>(arr: T): T => {
      const uint8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      for (let i = 0; i < uint8.length; i++) uint8[i] = Math.floor(Math.random() * 256);
      return arr;
    },
  },
});

// Mock AudioContext (jsdom has none)
class MockOscillator {
  type = '';
  frequency = { setValueAtTime: vi.fn() };
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class MockGainNode {
  gain = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  connect = vi.fn();
}

class MockAnalyserNode {
  fftSize = 0;
  smoothingTimeConstant = 0;
  frequencyBinCount = 128;
  getByteFrequencyData = vi.fn();
  connect = vi.fn();
}

class MockAudioContext {
  createOscillator() { return new MockOscillator(); }
  createGain() { return new MockGainNode(); }
  createAnalyser() { return new MockAnalyserNode(); }
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
  createMediaStreamDestination() { return { stream: new MockMediaStream() }; }
  get destination() { return {}; }
  get currentTime() { return 0; }
  close() { return Promise.resolve(); }
}
(globalThis as any).AudioContext = MockAudioContext;
(globalThis as any).webkitAudioContext = MockAudioContext;

// Stub RTCPeerConnection
class MockRTCPeerConnection {
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  connectionState = 'new';
  signalingState = 'stable';
  onicecandidate: ((e: any) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((e: any) => void) | null = null;
  ondatachannel: ((e: any) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;

  createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'v=0\r\na=rtpmap:111 opus/48000\r\n' });
  createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0\r\na=rtpmap:111 opus/48000\r\n' });
  setLocalDescription = vi.fn().mockImplementation(function (this: MockRTCPeerConnection, desc: any) {
    this.localDescription = desc;
    return Promise.resolve();
  });
  setRemoteDescription = vi.fn().mockImplementation(function (this: MockRTCPeerConnection, desc: any) {
    this.remoteDescription = desc;
    return Promise.resolve();
  });
  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  addTrack = vi.fn().mockReturnValue({
    track: null,
    replaceTrack: vi.fn(),
    getParameters: vi.fn().mockReturnValue({ encodings: [{}] }),
    setParameters: vi.fn(),
  });
  removeTrack = vi.fn();
  getSenders = vi.fn().mockReturnValue([]);
  getReceivers = vi.fn().mockReturnValue([]);
  getTransceivers = vi.fn().mockReturnValue([]);
  getStats = vi.fn().mockResolvedValue(new Map());
  restartIce = vi.fn();
  close = vi.fn();
  createDataChannel = vi.fn().mockReturnValue({
    label: 'test',
    readyState: 'open',
    send: vi.fn(),
    onopen: null,
    onclose: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    binaryType: 'arraybuffer',
  });
}
(globalThis as any).RTCPeerConnection = MockRTCPeerConnection;
(globalThis as any).RTCRtpTransceiver = { prototype: {} };
(globalThis as any).RTCRtpReceiver = { getCapabilities: vi.fn().mockReturnValue({ codecs: [] }) };

// Mock MediaStream
class MockMediaStream {
  private _tracks: any[] = [];
  constructor(tracks?: any[]) { this._tracks = tracks || []; }
  getTracks() { return [...this._tracks]; }
  getAudioTracks() { return this._tracks.filter((t: any) => t.kind === 'audio'); }
  getVideoTracks() { return this._tracks.filter((t: any) => t.kind === 'video'); }
  addTrack(t: any) { this._tracks.push(t); }
  removeTrack(t: any) { this._tracks = this._tracks.filter((x: any) => x !== t); }
}
(globalThis as any).MediaStream = MockMediaStream;

// Mock navigator.mediaDevices
Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: {
    getUserMedia: vi.fn().mockResolvedValue(new MockMediaStream([
      { kind: 'audio', enabled: true, readyState: 'live', muted: false, stop: vi.fn(), getSettings: () => ({ deviceId: 'default' }), applyConstraints: vi.fn(), onended: null, onmute: null, onunmute: null },
    ])),
    getDisplayMedia: vi.fn().mockResolvedValue(new MockMediaStream([
      { kind: 'video', enabled: true, readyState: 'live', muted: false, stop: vi.fn(), contentHint: '', onended: null, onmute: null, onunmute: null },
    ])),
    enumerateDevices: vi.fn().mockResolvedValue([
      { kind: 'audioinput', deviceId: 'default', label: 'Default Mic' },
    ]),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
  configurable: true,
});

// Mock clipboard
Object.defineProperty(globalThis.navigator, 'clipboard', {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  configurable: true,
});
