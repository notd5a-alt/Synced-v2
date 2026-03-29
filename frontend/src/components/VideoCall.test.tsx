import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VideoCall from './VideoCall';
import type { PeerInfo } from '../hooks/useWebRTC';

// Polyfill ResizeObserver for test environment
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
}

// Mock AudioVisualizer (uses Web Audio API)
vi.mock('./AudioVisualizer', () => ({
  default: () => <div data-testid="audio-visualizer" />,
}));

const defaultProps = {
  localStream: null as MediaStream | null,
  screenStream: null as MediaStream | null,
  streamRevision: 0,
  peers: new Map<string, PeerInfo>(),
  peerSpeaking: new Map<string, boolean>(),
  onStartCall: vi.fn(),
  onEndCall: vi.fn(),
  onToggleAudio: vi.fn(),
  onToggleVideo: vi.fn(),
  onShareScreen: vi.fn(),
  onStopScreenShare: vi.fn(),
  callError: null as string | null,
  connectionQuality: null as any,
  connectionType: null as any,
  isRecovering: false,
  recoveryFailed: false,
  signalingState: 'open',
  audioProcessing: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
  onToggleAudioProcessing: vi.fn(),
  aiNsEnabled: false,
  onToggleAiNs: vi.fn(),
  stats: null as any,
  localSpeaking: false,
  audioDevices: { inputDevices: [], outputDevices: [], selectedInput: '', selectedOutput: '', setInputDevice: vi.fn(), setOutputDevice: vi.fn() } as any,
  micLevel: 0,
  deafened: false,
  onToggleDeafen: vi.fn(),
  peersAudioState: new Map(),
  mutedForPeers: new Set<string>(),
  onToggleMuteForPeer: vi.fn(),
  peersMutedForMe: new Map(),
  locallyMutedPeers: new Set<string>(),
  onToggleLocalMutePeer: vi.fn(),
  peerNames: new Map<string, string>(),
};

describe('VideoCall', () => {
  it('shows CALL button when not in a call', () => {
    render(<VideoCall {...defaultProps} />);
    expect(screen.getByText('[ CALL ]')).toBeInTheDocument();
  });

  it('shows call controls when in a call', () => {
    const localStream = new MediaStream([
      { kind: 'audio', enabled: true, readyState: 'live', muted: false } as any,
    ]);
    render(<VideoCall {...defaultProps} localStream={localStream} />);

    expect(screen.getByText('[ MIC ON ]')).toBeInTheDocument();
    expect(screen.getByText('[ DEAFEN ]')).toBeInTheDocument();
    expect(screen.getByText('[ CAM OFF ]')).toBeInTheDocument();
    expect(screen.getByText('[ END CALL ]')).toBeInTheDocument();
  });

  it('calls onStartCall when CALL button is clicked', async () => {
    const onStartCall = vi.fn();
    render(<VideoCall {...defaultProps} onStartCall={onStartCall} />);
    await userEvent.click(screen.getByText('[ CALL ]'));
    expect(onStartCall).toHaveBeenCalledWith(false);
  });

  it('shows error message when callError is set', () => {
    render(<VideoCall {...defaultProps} callError="No microphone found" />);
    expect(screen.getByText('No microphone found')).toBeInTheDocument();
  });

  it('shows reconnecting message when isRecovering', () => {
    const localStream = new MediaStream([
      { kind: 'audio', enabled: true, readyState: 'live', muted: false } as any,
    ]);
    render(<VideoCall {...defaultProps} localStream={localStream} isRecovering={true} />);
    expect(screen.getByText('Reconnecting...')).toBeInTheDocument();
  });

  it('shows recovery failed message', () => {
    const localStream = new MediaStream([
      { kind: 'audio', enabled: true, readyState: 'live', muted: false } as any,
    ]);
    render(<VideoCall {...defaultProps} localStream={localStream} recoveryFailed={true} />);
    expect(screen.getByText('Connection lost. Please end and restart the call.')).toBeInTheDocument();
  });

  it('shows DIAG button that toggles diagnostics panel', async () => {
    const localStream = new MediaStream([
      { kind: 'audio', enabled: true, readyState: 'live', muted: false } as any,
    ]);
    render(<VideoCall {...defaultProps} localStream={localStream} />);
    const diagBtn = screen.getByText('[ DIAG ]');
    expect(diagBtn).toBeInTheDocument();

    // Click DIAG — since stats is null, panel renders but with "No data yet"
    await userEvent.click(diagBtn);
    expect(screen.getByText(/CONNECTION DIAGNOSTICS/)).toBeInTheDocument();
  });
});
