// Second-level submenu picked from TeamManagement → Add a new team.
// Routes to either the interactive TeamBuilder or the Showdown-paste flow.
import React from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';

export type AddTeamChoice = 'interactive' | 'import' | 'back';

export interface AddTeamPickerProps {
  onSelect: (choice: AddTeamChoice) => void;
}

export function AddTeamPicker({ onSelect }: AddTeamPickerProps) {
  useInput((_input, key) => {
    if (key.escape) onSelect('back');
  });
  const items = [
    { label: 'Build interactively',            value: 'interactive' as const },
    { label: 'Import from Showdown export',    value: 'import' as const },
    { label: 'Back',                           value: 'back' as const },
  ];
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Add a new team</Text>
      <Text dimColor>↑/↓ pick · Enter select · ESC back</Text>
      <Box marginTop={1}>
        <SelectInput items={items} onSelect={item => onSelect(item.value)} />
      </Box>
    </Box>
  );
}
