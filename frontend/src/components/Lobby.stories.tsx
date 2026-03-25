import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import Lobby from './Lobby';

const meta: Meta<typeof Lobby> = {
  title: 'Components/Lobby',
  component: Lobby,
  args: {
    isHost: true,
    hostAddr: '192.168.1.100:9876',
    connectionState: 'new',
    signalingState: 'open',
    timeoutExpired: false,
    onRetry: fn(),
    onCancel: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof Lobby>;

export const HostWaiting: Story = {};

export const JoinerConnecting: Story = {
  args: {
    isHost: false,
    signalingState: 'connecting',
  },
};

export const SignalingReconnecting: Story = {
  args: {
    signalingState: 'reconnecting',
  },
};

export const TimeoutExpired: Story = {
  args: {
    timeoutExpired: true,
  },
};
