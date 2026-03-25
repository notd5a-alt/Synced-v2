import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import VideoCall from './VideoCall';
import type { ConnectionStats } from '../types';

const noopAsync = fn() as unknown as () => Promise<void>;

const meta: Meta<typeof VideoCall> = {
  title: 'Components/VideoCall',
  component: VideoCall,
  args: {
    localStream: null,
    remoteStream: null,
    screenStream: null,
    onStartCall: fn() as unknown as (withVideo?: boolean) => Promise<void>,
    onEndCall: fn(),
    onToggleAudio: fn(),
    onToggleVideo: noopAsync,
    onShareScreen: noopAsync,
    onStopScreenShare: noopAsync,
    callError: null,
    connectionQuality: null,
    connectionType: null,
    isRecovering: false,
    recoveryFailed: false,
    signalingState: 'open',
    audioProcessing: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
    onToggleAudioProcessing: fn() as unknown as (key: 'noiseSuppression' | 'echoCancellation' | 'autoGainControl') => Promise<void>,
    stats: null,
    localSpeaking: false,
    remoteSpeaking: false,
  },
};

export default meta;
type Story = StoryObj<typeof VideoCall>;

// Helper: create a fake MediaStream with an audio track
function fakeStream(): MediaStream {
  return new MediaStream([
    { kind: 'audio', enabled: true, readyState: 'live', muted: false } as unknown as MediaStreamTrack,
  ]);
}

const sampleStats: ConnectionStats = {
  rtt: 45,
  packetLoss: 0.2,
  bitrate: 256000,
  codec: 'opus',
  resolution: null,
  fps: null,
};

export const Idle: Story = {};

export const VoiceCall: Story = {
  args: {
    localStream: fakeStream(),
    remoteStream: fakeStream(),
    connectionQuality: 'excellent',
    connectionType: 'direct',
  },
};

export const Error: Story = {
  args: {
    callError: 'No microphone found. Please check your device settings.',
  },
};

export const Recovering: Story = {
  args: {
    localStream: fakeStream(),
    remoteStream: fakeStream(),
    isRecovering: true,
    connectionQuality: 'poor',
  },
};

export const RecoveryFailed: Story = {
  args: {
    localStream: fakeStream(),
    recoveryFailed: true,
  },
};

export const QualityExcellent: Story = {
  args: {
    localStream: fakeStream(),
    remoteStream: fakeStream(),
    connectionQuality: 'excellent',
    connectionType: 'direct',
    stats: { ...sampleStats, rtt: 25, packetLoss: 0.1 },
  },
};

export const QualityGood: Story = {
  args: {
    localStream: fakeStream(),
    remoteStream: fakeStream(),
    connectionQuality: 'good',
    connectionType: 'direct',
    stats: { ...sampleStats, rtt: 120, packetLoss: 1.5 },
  },
};

export const QualityPoor: Story = {
  args: {
    localStream: fakeStream(),
    remoteStream: fakeStream(),
    connectionQuality: 'poor',
    connectionType: 'relay',
    stats: { ...sampleStats, rtt: 300, packetLoss: 5 },
  },
};

export const QualityCritical: Story = {
  args: {
    localStream: fakeStream(),
    remoteStream: fakeStream(),
    connectionQuality: 'critical',
    connectionType: 'relay',
    stats: { ...sampleStats, rtt: 600, packetLoss: 15, bitrate: 32000 },
  },
};
