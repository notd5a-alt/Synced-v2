import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import Home from './Home';

const meta: Meta<typeof Home> = {
  title: 'Components/Home',
  component: Home,
  args: {
    onHost: fn(),
    onJoin: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof Home>;

export const Default: Story = {};
