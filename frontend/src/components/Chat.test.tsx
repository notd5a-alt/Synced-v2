import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Chat from './Chat';
import type { ChatMessage } from '../types';

const defaultProps = {
  messages: [] as ChatMessage[],
  onSend: vi.fn(),
  onCommand: vi.fn(),
  cmdOutput: null,
  onReaction: vi.fn(),
  onMarkRead: vi.fn(),
  onTyping: vi.fn(),
  peerReadUpTo: null,
  peerTyping: false,
};

const sampleMessages: ChatMessage[] = [
  { type: 'text', id: 'msg-1', content: 'Hello!', timestamp: 1700000000000, from: 'you', reactions: {} },
  { type: 'text', id: 'msg-2', content: 'Hi there!', timestamp: 1700000001000, from: 'peer-abc1', reactions: {} },
];

describe('Chat', () => {
  it('shows empty state when no messages', () => {
    render(<Chat {...defaultProps} />);
    expect(screen.getByText('No messages yet. Say something!')).toBeInTheDocument();
  });

  it('renders messages with correct sender labels', () => {
    render(<Chat {...defaultProps} messages={sampleMessages} />);
    expect(screen.getByText('> You')).toBeInTheDocument();
    expect(screen.getByText('< peer-abc')).toBeInTheDocument();
    expect(screen.getByText('Hello!')).toBeInTheDocument();
    expect(screen.getByText('Hi there!')).toBeInTheDocument();
  });

  it('calls onSend when form is submitted', async () => {
    const onSend = vi.fn();
    render(<Chat {...defaultProps} onSend={onSend} />);

    const input = screen.getByPlaceholderText('Type a message...');
    await userEvent.type(input, 'test message');
    await userEvent.click(screen.getByText('[ SEND ]'));

    expect(onSend).toHaveBeenCalledWith('test message');
  });

  it('calls onCommand for slash commands instead of onSend', async () => {
    const onSend = vi.fn();
    const onCommand = vi.fn();
    render(<Chat {...defaultProps} onSend={onSend} onCommand={onCommand} />);

    const input = screen.getByPlaceholderText('Type a message...');
    await userEvent.type(input, '/help');
    await userEvent.click(screen.getByText('[ SEND ]'));

    expect(onCommand).toHaveBeenCalledWith('/help');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows typing indicator when peer is typing', () => {
    render(<Chat {...defaultProps} peerTyping={true} />);
    expect(screen.getByText('Peer is typing')).toBeInTheDocument();
  });

  it('shows command output when present', () => {
    render(<Chat {...defaultProps} cmdOutput="Messages cleared." />);
    expect(screen.getByText('Messages cleared.')).toBeInTheDocument();
  });

  it('shows SEEN badge on read message', () => {
    render(<Chat {...defaultProps} messages={sampleMessages} peerReadUpTo="msg-1" />);
    expect(screen.getByText('SEEN')).toBeInTheDocument();
  });

  it('disables send button when input is empty', () => {
    render(<Chat {...defaultProps} />);
    expect(screen.getByText('[ SEND ]')).toBeDisabled();
  });
});
