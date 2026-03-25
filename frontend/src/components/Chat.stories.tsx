import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import Chat from './Chat';
import type { ChatMessage } from '../types';

const sampleMessages: ChatMessage[] = [
  { type: 'text', id: 'msg-1', content: 'Hey, are you there?', timestamp: 1700000000000, from: 'you', reactions: {} },
  { type: 'text', id: 'msg-2', content: 'Yeah! Just joined.', timestamp: 1700000001000, from: 'peer', reactions: {} },
  { type: 'text', id: 'msg-3', content: 'Cool, let me share a file.', timestamp: 1700000002000, from: 'you', reactions: {} },
];

const messagesWithReactions: ChatMessage[] = [
  { type: 'text', id: 'msg-1', content: 'Check this out!', timestamp: 1700000000000, from: 'you', reactions: { '👍': ['peer'], '🔥': ['peer'] } },
  { type: 'text', id: 'msg-2', content: 'That is awesome!', timestamp: 1700000001000, from: 'peer', reactions: { '❤️': ['you'] } },
];

const meta: Meta<typeof Chat> = {
  title: 'Components/Chat',
  component: Chat,
  args: {
    messages: [],
    onSend: fn(),
    onCommand: fn(),
    cmdOutput: null,
    onReaction: fn(),
    onMarkRead: fn(),
    onTyping: fn(),
    peerReadUpTo: null,
    peerTyping: false,
  },
};

export default meta;
type Story = StoryObj<typeof Chat>;

export const Empty: Story = {};

export const Messages: Story = {
  args: {
    messages: sampleMessages,
  },
};

export const Reactions: Story = {
  args: {
    messages: messagesWithReactions,
  },
};

export const PeerTyping: Story = {
  args: {
    messages: sampleMessages,
    peerTyping: true,
  },
};

export const ReadReceipts: Story = {
  args: {
    messages: sampleMessages,
    peerReadUpTo: 'msg-3',
  },
};

export const CommandOutput: Story = {
  args: {
    messages: sampleMessages,
    cmdOutput: 'Messages cleared.',
  },
};
