import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

/** Structural shape of a vision TurnProposal (no @pokechamps/vision dep — the panel
 *  only needs the lines + meta). */
export interface ProposalLike {
  lines: string[];
  confidence?: number;
  notes?: string[];
  partial?: boolean;   // in-progress turn (live preview) — shown as "reading…", not yet final
}

export interface VisionProposalPanelProps {
  proposal: ProposalLike;
  /** 1-based turn number for the header, if known. */
  turnNumber?: number;
  /** Line → plain-English "parsed-as" echo (wire to previewTurnLine(line, ctx)). The
   *  verification surface: if it returns null the line didn't parse → flagged. */
  gloss?: (line: string) => string | null;
  /** Ratified lines → submit to the engine (same path as typed turn input). */
  onAccept: (lines: string[]) => void;
  /** Discard the proposal (vision got it wrong / user will type it). */
  onReject: () => void;
}

const forDisplay = (line: string) => line.replace(/ > /g, ' › ');

/** "Vision proposes, you ratify" — review a vision-built turn before it touches the
 *  engine. ↑↓ pick a line, `e` edit it inline (with live gloss), Enter accept all,
 *  `r` reject. Mirrors the self-verifying typed-input flow (the ⮑ gloss line). */
export function VisionProposalPanel({ proposal, turnNumber, gloss, onAccept, onReject }: VisionProposalPanelProps) {
  const [lines, setLines] = useState<string[]>(proposal.lines);
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);

  // RE-SYNC on prop change: the panel stays mounted across proposal updates (live
  // partials growing, a final replacing the preview, the ratify queue advancing), and
  // useState only reads the FIRST proposal — the panel froze on it while every later
  // update streamed by invisibly (the live "stuck panel"). Never clobber an in-flight
  // manual edit; a fresh proposal lands after it's submitted.
  useEffect(() => {
    if (editing) return;
    setLines(proposal.lines);
    setCursor(c => Math.min(c, Math.max(0, proposal.lines.length - 1)));
  }, [proposal.lines, editing]);

  useInput((input, key) => {
    if (editing) return;                                  // TextInput owns the keys; onSubmit exits
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    else if (key.downArrow) setCursor(c => Math.min(lines.length - 1, c + 1));
    else if (input === 'e') setEditing(true);
    else if (input === 'r') onReject();
    else if (key.return) onAccept(lines.map(l => l.trim()).filter(Boolean));
  });

  const conf = Math.round((proposal.confidence ?? 0) * 100);
  const confColor = conf >= 80 ? 'green' : conf >= 50 ? 'yellow' : 'red';
  const partial = !!proposal.partial;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={partial ? 'yellow' : 'cyan'} paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={partial ? 'yellow' : 'cyan'}>{partial ? '⏳ Reading turn… (live — don\'t type)' : '⌁ Vision proposal'}{turnNumber != null ? ` — turn ${turnNumber}` : ''}</Text>
        <Text color={confColor}>conf {conf}%</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, i) => {
          const sel = i === cursor;
          const g = gloss ? gloss(line) : undefined;
          return (
            <Box key={i} flexDirection="column">
              <Box>
                <Text color={sel ? 'cyanBright' : undefined}>{sel ? '▸ ' : '  '}</Text>
                {editing && sel ? (
                  <TextInput
                    value={lines[i] ?? ''}
                    onChange={v => setLines(ls => ls.map((x, j) => (j === i ? v : x)))}
                    onSubmit={() => setEditing(false)}
                  />
                ) : (
                  <Text color={sel ? 'white' : 'gray'}>
                    {forDisplay(line)}
                    {/* a damaging move's target resolves at finalize — mid-turn its line reads "self", which is not a claim */}
                    {partial && / > self$/.test(line) ? <Text dimColor italic>  (target resolves at finalize)</Text> : null}
                  </Text>
                )}
              </Box>
              {!editing && (
                g === null ? <Text color="red">{'     ⚠ does not parse'}</Text>
                  : g ? <Text dimColor>{`     ⮑ ${g}`}</Text> : null
              )}
            </Box>
          );
        })}
      </Box>

      {proposal.notes && proposal.notes.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {proposal.notes.map((n, i) => <Text key={i} color="yellow">{`⚠ ${n}`}</Text>)}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>{editing ? 'enter done · type to edit the line'
          : partial ? 'reading… the turn will finalize when it completes — no need to type · enter accepts as-is · r reject'
          : '↑↓ line · enter accept · e edit · r reject'}</Text>
      </Box>
    </Box>
  );
}
