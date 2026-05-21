// Server Settings screen. Lets the user connect the TUI to a remote
// @pokechamps/server, log in / register / log out, or disconnect back to
// local-file mode.
//
// The TUI's overall flow is unchanged in remote mode — every screen still
// receives a Stores instance. Only the source-of-truth swaps.
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import type { PokechampsConfig } from '../config.js';

export interface ServerSettingsProps {
  config: PokechampsConfig;
  onConfigChange: (next: PokechampsConfig) => void;
  onExit: () => void;
}

type Mode =
  | { kind: 'menu' }
  | { kind: 'connect' }
  | { kind: 'login' | 'register'; step: 'email' | 'password' | 'submitting'; email: string; password: string }
  | { kind: 'result'; ok: boolean; message: string };

interface AuthResponse {
  token: string;
  user: { id: string; email: string };
}

async function postAuth(
  serverUrl: string,
  path: '/auth/login' | '/auth/register',
  email: string,
  password: string,
): Promise<AuthResponse> {
  const res = await fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path}: ${res.status} ${text || res.statusText}`);
  }
  return (await res.json()) as AuthResponse;
}

export function ServerSettings({ config, onConfigChange, onExit }: ServerSettingsProps) {
  const [mode, setMode] = useState<Mode>({ kind: 'menu' });

  useInput((_input, key) => {
    if (key.escape) {
      if (mode.kind === 'menu') onExit();
      else setMode({ kind: 'menu' });
    }
  });

  // ---------- Result screen ----------
  if (mode.kind === 'result') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={mode.ok ? 'green' : 'red'}>
          {mode.ok ? '✓ ' : '✗ '}{mode.message}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Press any key or Esc to go back…</Text>
        </Box>
        <ContinueOnAnyKey onContinue={() => setMode({ kind: 'menu' })} />
      </Box>
    );
  }

  // ---------- Connect to server (set URL) ----------
  if (mode.kind === 'connect') {
    return <ConnectForm
      initial={config.serverUrl ?? 'http://localhost:3000'}
      onCancel={() => setMode({ kind: 'menu' })}
      onSubmit={(serverUrl) => {
        onConfigChange({ ...config, serverUrl });
        setMode({ kind: 'result', ok: true, message: `Connected to ${serverUrl}` });
      }}
    />;
  }

  // ---------- Login / Register ----------
  if (mode.kind === 'login' || mode.kind === 'register') {
    const verb = mode.kind === 'login' ? 'Login' : 'Register';
    if (mode.step === 'email') {
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold color="cyan">{verb} — email</Text>
          <Box marginTop={1}>
            <Text>Email: </Text>
            <TextInput
              value={mode.email}
              onChange={v => setMode({ ...mode, email: v })}
              onSubmit={() => setMode({ ...mode, step: 'password' })}
            />
          </Box>
          <Text dimColor>Esc to cancel</Text>
        </Box>
      );
    }
    if (mode.step === 'password') {
      return (
        <Box flexDirection="column" padding={1}>
          <Text bold color="cyan">{verb} — password</Text>
          <Box marginTop={1}>
            <Text>Password: </Text>
            <TextInput
              value={mode.password}
              mask="*"
              onChange={v => setMode({ ...mode, password: v })}
              onSubmit={() => {
                if (!config.serverUrl) {
                  setMode({ kind: 'result', ok: false, message: 'No server URL set — connect first.' });
                  return;
                }
                setMode({ ...mode, step: 'submitting' });
                postAuth(
                  config.serverUrl,
                  mode.kind === 'login' ? '/auth/login' : '/auth/register',
                  mode.email,
                  mode.password,
                )
                  .then(res => {
                    onConfigChange({ ...config, token: res.token, email: res.user.email });
                    setMode({ kind: 'result', ok: true, message: `${verb} successful — signed in as ${res.user.email}` });
                  })
                  .catch(err => {
                    setMode({ kind: 'result', ok: false, message: String(err.message ?? err) });
                  });
              }}
            />
          </Box>
          <Text dimColor>Esc to cancel</Text>
        </Box>
      );
    }
    return (
      <Box padding={1}>
        <Text>Submitting…</Text>
      </Box>
    );
  }

  // ---------- Menu ----------
  const connected = Boolean(config.serverUrl);
  const loggedIn = Boolean(config.token);
  const items: Array<{ label: string; value: string }> = [];
  if (!connected) {
    items.push({ label: 'Connect to server (set URL)', value: 'connect' });
  } else {
    items.push({ label: `Reconfigure server URL (current: ${config.serverUrl})`, value: 'connect' });
    if (!loggedIn) {
      items.push({ label: 'Log in', value: 'login' });
      items.push({ label: 'Register new account', value: 'register' });
    } else {
      items.push({ label: 'Log out (clear stored token)', value: 'logout' });
    }
    items.push({ label: 'Disconnect (back to local-file mode)', value: 'disconnect' });
  }
  items.push({ label: 'Back', value: 'back' });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Server Settings</Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Text>
          Mode: {connected
            ? <Text color="green">remote ({config.serverUrl})</Text>
            : <Text color="yellow">local file</Text>}
        </Text>
        {connected && (
          <Text>
            Auth: {loggedIn
              ? <Text color="green">signed in{config.email ? ` as ${config.email}` : ''}</Text>
              : <Text color="red">not signed in</Text>}
          </Text>
        )}
      </Box>
      <SelectInput
        items={items}
        onSelect={item => {
          if (item.value === 'connect') setMode({ kind: 'connect' });
          else if (item.value === 'login') setMode({ kind: 'login', step: 'email', email: config.email ?? '', password: '' });
          else if (item.value === 'register') setMode({ kind: 'register', step: 'email', email: '', password: '' });
          else if (item.value === 'logout') {
            const next = { ...config };
            delete next.token;
            delete next.email;
            onConfigChange(next);
            setMode({ kind: 'result', ok: true, message: 'Signed out.' });
          } else if (item.value === 'disconnect') {
            onConfigChange({});
            setMode({ kind: 'result', ok: true, message: 'Disconnected — back to local-file mode.' });
          } else if (item.value === 'back') {
            onExit();
          }
        }}
      />
    </Box>
  );
}

function ContinueOnAnyKey({ onContinue }: { onContinue: () => void }) {
  useInput(() => onContinue());
  return null;
}

interface ConnectFormProps {
  initial: string;
  onSubmit: (url: string) => void;
  onCancel: () => void;
}

function ConnectForm({ initial, onSubmit, onCancel }: ConnectFormProps) {
  const [url, setUrl] = useState(initial);
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Connect to PokeChamps server</Text>
      <Box marginTop={1}>
        <Text>URL: </Text>
        <TextInput
          value={url}
          onChange={setUrl}
          onSubmit={() => {
            const cleaned = url.trim().replace(/\/$/, '');
            if (!cleaned) { onCancel(); return; }
            onSubmit(cleaned);
          }}
        />
      </Box>
      <Text dimColor>Esc to cancel</Text>
    </Box>
  );
}
