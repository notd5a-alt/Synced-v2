import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VideoGrid from './VideoGrid';
import type { PeerInfo } from '../hooks/useWebRTC';

// Mock ResizeObserver (not available in jsdom)
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any;

// Mock AudioVisualizer (uses Web Audio API)
vi.mock('./AudioVisualizer', () => ({
  default: () => <div data-testid="audio-visualizer" />,
}));

function createMockStream(hasVideo = false, hasAudio = false): MediaStream {
  const tracks: MediaStreamTrack[] = [];
  if (hasVideo) {
    tracks.push({
      kind: 'video',
      readyState: 'live',
      muted: false,
      id: `video-${Math.random()}`,
      enabled: true,
    } as any);
  }
  if (hasAudio) {
    tracks.push({
      kind: 'audio',
      readyState: 'live',
      muted: false,
      id: `audio-${Math.random()}`,
      enabled: true,
    } as any);
  }
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    id: `stream-${Math.random()}`,
  } as any;
}

function createPeer(
  peerId: string,
  opts: { video?: boolean; audio?: boolean; screen?: boolean; state?: RTCPeerConnectionState } = {},
): PeerInfo {
  return {
    peerId,
    pc: new (globalThis as any).RTCPeerConnection() as RTCPeerConnection,
    connectionState: opts.state ?? 'connected',
    chatChannel: null,
    fileChannel: null,
    remoteStream: createMockStream(opts.video, opts.audio),
    remoteScreenStream: createMockStream(opts.screen),
    hmacKey: null,
  };
}

describe('VideoGrid', () => {
  const defaultProps = {
    localStream: null as MediaStream | null,
    localSpeaking: false,
    localHasVideo: false,
    peers: new Map<string, PeerInfo>(),
    peerSpeaking: new Map<string, boolean>(),
    streamRevision: 0,
  };

  it('renders local tile only when no peers', () => {
    render(<VideoGrid {...defaultProps} />);
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('YOU')).toBeInTheDocument(); // placeholder
  });

  it('renders tiles inside a video-canvas container', () => {
    const { container } = render(<VideoGrid {...defaultProps} />);
    expect(container.querySelector('.video-canvas')).toBeTruthy();
  });

  it('renders tiles with absolute positioning via canvas-tile wrapper', () => {
    const peers = new Map([
      ['peer-aaaa', createPeer('peer-aaaa', { audio: true })],
    ]);
    const { container } = render(<VideoGrid {...defaultProps} peers={peers} />);
    const wrappers = container.querySelectorAll('.canvas-tile');
    expect(wrappers.length).toBe(2); // local + 1 peer
    // Each wrapper should have position styles
    for (const w of wrappers) {
      const el = w as HTMLElement;
      expect(el.style.left).toBeTruthy();
      expect(el.style.top).toBeTruthy();
      expect(el.style.width).toBeTruthy();
      // aspect-ratio is set but jsdom may not expose it; just verify width exists
      expect(el.style.width).toBeTruthy();
    }
  });

  it('auto-positions new tiles with default layout', () => {
    const peers = new Map([
      ['peer-aaaa', createPeer('peer-aaaa')],
      ['peer-bbbb', createPeer('peer-bbbb')],
    ]);
    const { container } = render(<VideoGrid {...defaultProps} peers={peers} />);
    const wrappers = container.querySelectorAll('.canvas-tile');
    expect(wrappers.length).toBe(3); // local + 2 peers
    // Each tile should have non-zero position
    const positions = Array.from(wrappers).map((w) => ({
      left: (w as HTMLElement).style.left,
      top: (w as HTMLElement).style.top,
    }));
    // All should have percentage-based positions
    for (const p of positions) {
      expect(p.left).toMatch(/%$/);
      expect(p.top).toMatch(/%$/);
    }
  });

  it('shows peer labels (truncated to 8 chars)', () => {
    const peers = new Map([
      ['peer-abcdefgh1234', createPeer('peer-abcdefgh1234')],
    ]);
    render(<VideoGrid {...defaultProps} peers={peers} />);
    expect(screen.getByText('peer-abc')).toBeInTheDocument();
  });

  it('applies speaking class to speaking peer tile', () => {
    const peers = new Map([
      ['peer-aaaa', createPeer('peer-aaaa', { audio: true })],
    ]);
    const peerSpeaking = new Map([['peer-aaaa', true]]);
    const { container } = render(
      <VideoGrid {...defaultProps} peers={peers} peerSpeaking={peerSpeaking} />
    );
    const tiles = container.querySelectorAll('.video-tile.speaking');
    expect(tiles.length).toBe(1);
  });

  it('applies speaking class to local tile when localSpeaking', () => {
    const { container } = render(
      <VideoGrid {...defaultProps} localSpeaking={true} />
    );
    const tiles = container.querySelectorAll('.video-tile.speaking');
    expect(tiles.length).toBe(1);
  });

  it('shows disconnected class for failed peer', () => {
    const peers = new Map([
      ['peer-aaaa', createPeer('peer-aaaa', { state: 'failed' })],
    ]);
    const { container } = render(<VideoGrid {...defaultProps} peers={peers} />);
    expect(container.querySelector('.video-tile.disconnected')).toBeTruthy();
  });

  it('renders screen share tile with expand hint', () => {
    const peers = new Map([
      ['peer-aaaa', createPeer('peer-aaaa', { video: true, screen: true })],
    ]);
    render(<VideoGrid {...defaultProps} peers={peers} />);
    expect(screen.getByText('Double-click to expand')).toBeInTheDocument();
  });

  it('expands screen share tile on double-click', () => {
    const peers = new Map([
      ['peer-aaaa', createPeer('peer-aaaa', { video: true, screen: true })],
    ]);
    const { container } = render(<VideoGrid {...defaultProps} peers={peers} />);

    // Double-click the canvas-tile wrapper containing the screen share
    const screenLabel = screen.getByLabelText(/Expand screen share/);
    const wrapper = screenLabel.closest('.canvas-tile') as HTMLElement;
    fireEvent.doubleClick(wrapper);

    expect(container.querySelector('.grid-expanded')).toBeTruthy();
    expect(screen.getByText('Double-click to return')).toBeInTheDocument();
  });

  it('collapses back to canvas on second double-click', () => {
    const peers = new Map([
      ['peer-aaaa', createPeer('peer-aaaa', { video: true, screen: true })],
    ]);
    const { container } = render(<VideoGrid {...defaultProps} peers={peers} />);

    // Double-click to expand
    const screenLabel = screen.getByLabelText(/Expand screen share/);
    const wrapper = screenLabel.closest('.canvas-tile') as HTMLElement;
    fireEvent.doubleClick(wrapper);
    expect(container.querySelector('.grid-expanded')).toBeTruthy();

    // Double-click the expanded container to collapse
    const expandedContainer = container.querySelector('.grid-expanded') as HTMLElement;
    fireEvent.doubleClick(expandedContainer);
    expect(container.querySelector('.grid-expanded')).toBeNull();
    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('shows CONNECTING placeholder for new peer', () => {
    const peers = new Map([
      ['peer-aaaa', createPeer('peer-aaaa', { state: 'new' })],
    ]);
    render(<VideoGrid {...defaultProps} peers={peers} />);
    expect(screen.getByText('CONNECTING...')).toBeInTheDocument();
  });

  it('shows RECONNECTING placeholder for disconnected peer with no tracks', () => {
    const peers = new Map([
      ['peer-aaaa', createPeer('peer-aaaa', { state: 'disconnected' })],
    ]);
    render(<VideoGrid {...defaultProps} peers={peers} />);
    expect(screen.getByText('RECONNECTING...')).toBeInTheDocument();
  });

  it('shows CANNOT CONNECT message for failed peer', () => {
    const peers = new Map([
      ['peer-aaaa', createPeer('peer-aaaa', { state: 'failed' })],
    ]);
    render(<VideoGrid {...defaultProps} peers={peers} />);
    expect(screen.getByText('CANNOT CONNECT TO peer-aaa')).toBeInTheDocument();
  });

  it('renders audio visualizer for audio-only peer', () => {
    const peers = new Map([
      ['peer-aaaa', createPeer('peer-aaaa', { audio: true })],
    ]);
    render(<VideoGrid {...defaultProps} peers={peers} />);
    expect(screen.getByTestId('audio-visualizer')).toBeInTheDocument();
  });

  it('does not start drag on right-click', () => {
    const peers = new Map([
      ['peer-aaaa', createPeer('peer-aaaa', { audio: true })],
    ]);
    const { container } = render(<VideoGrid {...defaultProps} peers={peers} />);
    const wrapper = container.querySelectorAll('.canvas-tile')[1] as HTMLElement;
    const initialLeft = wrapper.style.left;

    // Right-click (button 2)
    fireEvent.pointerDown(wrapper, { button: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(wrapper, { clientX: 200, clientY: 200 });
    fireEvent.pointerUp(wrapper, { button: 2 });

    expect(wrapper.style.left).toBe(initialLeft);
  });
});
