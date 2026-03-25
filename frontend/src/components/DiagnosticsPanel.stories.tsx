import type { Meta, StoryObj } from '@storybook/react-vite';
import DiagnosticsPanel from './DiagnosticsPanel';
import type { ConnectionStats } from '../types';

const meta: Meta<typeof DiagnosticsPanel> = {
  title: 'Components/DiagnosticsPanel',
  component: DiagnosticsPanel,
  args: {
    stats: null,
    connectionQuality: null,
    connectionType: null,
  },
};

export default meta;
type Story = StoryObj<typeof DiagnosticsPanel>;

export const NoData: Story = {};

export const Excellent: Story = {
  args: {
    stats: {
      rtt: 25,
      packetLoss: 0.1,
      bitrate: 512000,
      codec: 'opus',
      resolution: '1280x720',
      fps: 30,
    } as ConnectionStats,
    connectionQuality: 'excellent',
    connectionType: 'direct',
  },
};

export const Good: Story = {
  args: {
    stats: {
      rtt: 120,
      packetLoss: 1.5,
      bitrate: 256000,
      codec: 'opus',
      resolution: '640x480',
      fps: 24,
    } as ConnectionStats,
    connectionQuality: 'good',
    connectionType: 'direct',
  },
};

export const Poor: Story = {
  args: {
    stats: {
      rtt: 350,
      packetLoss: 8,
      bitrate: 64000,
      codec: 'opus',
      resolution: '320x240',
      fps: 15,
    } as ConnectionStats,
    connectionQuality: 'poor',
    connectionType: 'relay',
  },
};

export const Critical: Story = {
  args: {
    stats: {
      rtt: 800,
      packetLoss: 20,
      bitrate: 16000,
      codec: 'opus',
      resolution: null,
      fps: null,
    } as ConnectionStats,
    connectionQuality: 'critical',
    connectionType: 'relay',
  },
};
