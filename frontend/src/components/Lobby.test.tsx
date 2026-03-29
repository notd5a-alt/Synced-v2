import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Lobby from './Lobby';

const defaultProps = {
  isHost: true,
  roomCode: 'X7KM3P',
  connectionState: 'new',
  signalingState: 'open' as const,
  signalingUrl: 'ws://localhost:9876/ws/X7KM3P?token=test',
  debugLog: [] as string[],
  timeoutExpired: false,
  reconnectAttempt: 0,
  maxReconnectAttempts: 5,
  peerCount: 0,
  roomPeers: [] as string[],
  localPeerId: 'aaaa-bbbb-cccc',
  onRetry: vi.fn(),
  onCancel: vi.fn(),
};

describe('Lobby', () => {
  it('shows room code when hosting', () => {
    render(<Lobby {...defaultProps} />);
    expect(screen.getByText('X 7 K M 3 P')).toBeInTheDocument();
    expect(screen.getByText(/HOSTING SESSION/)).toBeInTheDocument();
  });

  it('shows "Waiting for peers..." when signaling is open and no peers', () => {
    render(<Lobby {...defaultProps} />);
    expect(screen.getByText('Waiting for peers...')).toBeInTheDocument();
  });

  it('shows peer count when peers are connected', () => {
    render(<Lobby {...defaultProps} peerCount={2} roomPeers={['peer-1111', 'peer-2222']} />);
    expect(screen.getByText('3 peers in room')).toBeInTheDocument();
  });

  it('shows "Connecting to server..." for joiner', () => {
    render(<Lobby {...defaultProps} isHost={false} signalingState="connecting" />);
    expect(screen.getByText('Connecting to server...')).toBeInTheDocument();
  });

  it('shows timeout state with retry/cancel buttons', () => {
    render(<Lobby {...defaultProps} timeoutExpired={true} />);
    expect(screen.getByText('Connection timed out.')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
    expect(screen.getByText('[ CANCEL ]')).toBeInTheDocument();
  });

  it('calls onRetry when retry is clicked', async () => {
    const onRetry = vi.fn();
    render(<Lobby {...defaultProps} timeoutExpired={true} onRetry={onRetry} />);
    await userEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows copy button for room code', () => {
    render(<Lobby {...defaultProps} />);
    expect(screen.getByText('[ COPY ]')).toBeInTheDocument();
  });

  it('shows peer list with local peer highlighted', () => {
    render(<Lobby {...defaultProps} localPeerId="aaaa-bbbb-cccc" roomPeers={['peer-1111']} peerCount={1} />);
    expect(screen.getByText('aaaa-bbb (you)')).toBeInTheDocument();
    expect(screen.getByText('peer-111')).toBeInTheDocument();
  });

  it('shows N/8 peers in header', () => {
    render(<Lobby {...defaultProps} peerCount={3} roomPeers={['a', 'b', 'c']} />);
    expect(screen.getByText('4 / 8 peers')).toBeInTheDocument();
  });

  it('does not show peer list when signaling is not open', () => {
    render(<Lobby {...defaultProps} signalingState="connecting" />);
    expect(screen.queryByText(/peers/)).toBeNull();
  });
});
