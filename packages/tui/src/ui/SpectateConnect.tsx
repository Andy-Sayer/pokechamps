// Paste-a-share-link screen. The friend pastes the spectator URL the host
// sent them (https://host/spectate/<token>); we parse it into a ShareTarget
// and hand it to the parent, which routes to the live SpectatorScreen.
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { parseShareInput, type ShareTarget } from '../spectate.js';

export interface SpectateConnectProps {
  /** Configured server URL, used as the origin when the user pastes a bare token. */
  fallbackBaseUrl?: string;
  onConnect: (target: ShareTarget) => void;
  onCancel: () => void;
}

export function SpectateConnect({ fallbackBaseUrl, onConnect, onCancel }: SpectateConnectProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  useInput((_ch, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Spectate a shared match</Text>
      <Text dimColor>Paste the live-share link your friend sent you, then Enter.</Text>
      <Box marginTop={1}>
        <Text>{'> '}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={v => {
            const target = parseShareInput(v, fallbackBaseUrl);
            if (!target) {
              setError('That doesn\'t look like a share link. Expected https://host/spectate/<token>.');
              return;
            }
            onConnect(target);
          }}
        />
      </Box>
      {error && <Text color="red">{error}</Text>}
      <Text dimColor>Esc to go back.</Text>
    </Box>
  );
}
