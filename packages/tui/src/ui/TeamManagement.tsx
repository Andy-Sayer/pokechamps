// First-level Team Management submenu — picked from MainMenu. Routes to
// the existing TeamPicker for browse/edit/export and to AddTeamPicker for
// the two add flows (interactive vs. Showdown import).
import React from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';

export type TeamManagementChoice = 'view' | 'add' | 'back';

export interface TeamManagementProps {
  onSelect: (choice: TeamManagementChoice) => void;
}

export function TeamManagement({ onSelect }: TeamManagementProps) {
  useInput((_input, key) => {
    if (key.escape) onSelect('back');
  });
  const items = [
    { label: 'View / modify existing teams', value: 'view' as const },
    { label: 'Add a new team',                value: 'add' as const },
    { label: 'Back',                          value: 'back' as const },
  ];
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Team management</Text>
      <Text dimColor>↑/↓ pick · Enter select · ESC back</Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={item => onSelect(item.value)} />
      </Box>
    </Box>
  );
}
