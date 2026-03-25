import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Home from './Home';

describe('Home', () => {
  it('renders host and join options', () => {
    render(<Home onHost={vi.fn()} onJoin={vi.fn()} />);
    expect(screen.getByText('Host a Session')).toBeInTheDocument();
    expect(screen.getByText('[ JOIN ]')).toBeInTheDocument();
  });

  it('calls onHost when host button is clicked', async () => {
    const onHost = vi.fn();
    render(<Home onHost={onHost} onJoin={vi.fn()} />);
    await userEvent.click(screen.getByText('Host a Session'));
    expect(onHost).toHaveBeenCalledTimes(1);
  });

  it('calls onJoin with address when form is submitted', async () => {
    const onJoin = vi.fn();
    render(<Home onHost={vi.fn()} onJoin={onJoin} />);

    const input = screen.getByPlaceholderText('Enter host address (ip:port)');
    await userEvent.type(input, '192.168.1.1:9876');
    await userEvent.click(screen.getByText('[ JOIN ]'));

    expect(onJoin).toHaveBeenCalledWith('192.168.1.1:9876');
  });

  it('disables join button when address is empty', () => {
    render(<Home onHost={vi.fn()} onJoin={vi.fn()} />);
    const joinBtn = screen.getByText('[ JOIN ]');
    expect(joinBtn).toBeDisabled();
  });
});
