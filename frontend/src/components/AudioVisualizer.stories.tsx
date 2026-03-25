import type { Meta, StoryObj } from '@storybook/react-vite';
import AudioVisualizer from './AudioVisualizer';

const meta: Meta<typeof AudioVisualizer> = {
  title: 'Components/AudioVisualizer',
  component: AudioVisualizer,
  args: {
    stream: null,
  },
};

export default meta;
type Story = StoryObj<typeof AudioVisualizer>;

export const NoStream: Story = {};

export const WithStream: Story = {
  args: {
    stream: new MediaStream([
      { kind: 'audio', enabled: true, readyState: 'live', muted: false } as unknown as MediaStreamTrack,
    ]),
  },
};
