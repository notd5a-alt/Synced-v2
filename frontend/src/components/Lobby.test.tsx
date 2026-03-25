import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Lobby from './Lobby';

const defaultProps = {
  isHost: true,
  hostAddr: '192.168.1.100:9876',
  connectionState: 'new',
  signalingState: 'open' as const,
  timeoutExpired: false,
  onRetry: vi.fn(),
  onCancel: vi.fn(),
};

describe('Lobby', () => {
  it('shows host address when hosting', () => {
    render(<Lobby {...defaultProps} />);
    expect(screen.getByText('192.168.1.100:9876')).toBeInTheDocument();
    expect(screen.getByText(/HOSTING SESSION/)).toBeInTheDocument();
  });

  it('shows "Waiting for peer..." when signaling is open', () => {
    render(<Lobby {...defaultProps} />);
    expect(screen.getByText('Waiting for peer...')).toBeInTheDocument();
  });

  it('shows "Connecting to host..." for joiner', () => {
    render(<Lobby {...defaultProps} isHost={false} signalingState="connecting" />);
    expect(screen.getByText('Connecting to host...')).toBeInTheDocument();
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

  it('shows copy button for host address', () => {
    render(<Lobby {...defaultProps} />);
    expect(screen.getByText('[ COPY ]')).toBeInTheDocument();
  });
});
