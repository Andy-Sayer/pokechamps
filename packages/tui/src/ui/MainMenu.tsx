import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import type { CaptureState } from './capture.js';

export interface MainMenuProps {
  onSelect: (key: 'new-match' | 'spectate' | 'team-management' | 'history' | 'server' | 'toggle-capture' | 'quit') => void;
  /** Optional one-line connection badge shown above the menu. */
  connectionBadge?: { text: string; color: 'green' | 'yellow' | 'red' };
  /** Live HDMI-capture state — drives the "Turn on/off screen" toggle label. */
  captureState?: CaptureState;
}

export function MainMenu({ onSelect, connectionBadge, captureState = 'off' }: MainMenuProps) {
  const screenLabel = captureState === 'off' ? 'Turn on screen (HDMI capture)'
    : captureState === 'starting' ? 'Turn off screen — starting…'
    : captureState === 'no-signal' ? 'Turn off screen — no signal'
    : 'Turn off screen — live';
  const items = [
    { label: 'Start a new match', value: 'new-match' as const },
    { label: screenLabel, value: 'toggle-capture' as const },
    { label: 'Spectate a shared match', value: 'spectate' as const },
    { label: 'Team management', value: 'team-management' as const },
    { label: 'Match history', value: 'history' as const },
    { label: 'Server settings', value: 'server' as const },
    { label: 'Quit', value: 'quit' as const },
  ];
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">PokeChamps — Pokemon Champions battle assistant</Text>
      {connectionBadge && (
        <Text color={connectionBadge.color}>{connectionBadge.text}</Text>
      )}
      <Text dimColor>Choose an action</Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={item => onSelect(item.value)} />
      </Box>
    </Box>
  );
}
