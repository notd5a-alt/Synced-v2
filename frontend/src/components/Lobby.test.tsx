import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Lobby from './Lobby';

const defaultProps = {
  isHost: true,
  roomCode: 'X7KM3P',
  connectionState: 'new',
  signalingState: 'open' as const,
  signalingUrl: 'ws://localhost:9876/ws/X7KM3P?role=host',
  debugLog: [] as string[],
  timeoutExpired: false,
  onRetry: vi.fn(),
  onCancel: vi.fn(),
};

describe('Lobby', () => {
  it('shows room code when hosting', () => {
    render(<Lobby {...defaultProps} />);
    expect(screen.getByText('X 7 K M 3 P')).toBeInTheDocument();
    expect(screen.getByText(/HOSTING SESSION/)).toBeInTheDocument();
  });

  it('shows "Waiting for peer..." when signaling is open', () => {
    render(<Lobby {...defaultProps} />);
    expect(screen.getByText('Waiting for peer...')).toBeInTheDocument();
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
});
