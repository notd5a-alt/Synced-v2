import type { Meta, StoryObj } from '@storybook/react-vite';
import GhostAsciiArt from './GhostAsciiArt';

const meta: Meta<typeof GhostAsciiArt> = {
  title: 'Components/GhostAsciiArt',
  component: GhostAsciiArt,
};

export default meta;
type Story = StoryObj<typeof GhostAsciiArt>;

export const Default: Story = {};
