import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { OpponentEntry, PokemonSet } from '@pokechamps/core/domain/types.js';
import { speciesTypes } from '@pokechamps/core/domain/typechart.js';
import { toId } from '@pokechamps/core/domain/data.js';
import { defaultOpponentSet } from '@pokechamps/core/domain/bring.js';
import { predictOppBack } from '@pokechamps/core/domain/oppBringPredict.js';
import type { Stores } from '@pokechamps/core/storage/index.js';
import { onProposal as onWatchProposal } from './watcher.js';

export interface OpponentLeadPickerProps {
  stores: Stores;
  opponent: OpponentEntry[];
  /** Our team — used to predict the opponent's BACK TWO once their leads are
   *  chosen (their bring is the 4 best for them vs us; filter to those with both
   *  leads). */
  myTeam: PokemonSet[];
  onConfirm: (indices: [number, number]) => void;
  onCancel: () => void;
  /** Step back one screen (to BringPicker) so the user can change their
   *  bring choice. Triggered by Esc or Left-arrow. If omitted, falls
   *  back to onCancel (which typically routes all the way to the menu). */
  onBack?: () => void;
}

const LEAD_SIZE = 2;

// In VGC team preview the opponent commits to 4 brings but you only see
// the 2 leads up front; the back two reveal themselves via switches or
// forced send-ins after a faint. This picker captures just the leads —
// the BattleScreen grows the "brought" set as more opp mons appear on field.
/** Order the two chosen leads into [o1, o2] using the SCREEN's plate order when vision
 *  has told us who stands where; otherwise fall back to team-list order. Only a plate
 *  order that actually covers the chosen pair is trusted — a stale or half-read one must
 *  not silently mirror the board. Exported for test. */
export function orderLeads(
  chosen: ReadonlySet<number>,
  plate: readonly [number | null, number | null],
): [number, number] {
  const byIndex = [...chosen].sort((a, b) => a - b) as [number, number];
  const [a, b] = plate;
  if (a == null || b == null || a === b) return byIndex;
  if (!chosen.has(a) || !chosen.has(b)) return byIndex;
  return [a, b];
}

export function OpponentLeadPicker({ stores, opponent, myTeam, onConfirm, onCancel, onBack }: OpponentLeadPickerProps) {
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  // Resolve the species-only preview entries to default sets so we can score the
  // opponent's brings vs our team (same technique as our own bring decision).
  const oppSets = useMemo(() => opponent.map(e => defaultOpponentSet(e, 50)), [opponent]);

  // VISION PRE-FILL: while this screen asks "which 2 did they send out?", the live
  // watcher is READING the send-out banner that answers it. When a proposal's opp
  // switch lines resolve to exactly two of the six, pre-select them — the user just
  // confirms with Enter (never auto-confirmed, and a manual toggle wins from then on).
  const [visionMsg, setVisionMsg] = useState<string | null>(null);
  const manualTouch = useRef(false);
  const lastAutoKey = useRef('');
  // PLATE ORDER. Which lead is o1 and which is o2 is decided by the SCREEN, not by our
  // team-list order — the nameplates are ground truth. Confirming by team index instead
  // produced an engine board mirrored against reality, and the occupancy reconciler then
  // reported it as "the opponents swapped", which is nonsense from the player's side and
  // cost a turn to acknowledge (live, 2026-07-28). Holds opponent indices in slot order.
  const plateOrder = useRef<[number | null, number | null]>([null, null]);
  useEffect(() => onWatchProposal(p => {
    if (manualTouch.current) return;
    const seen: number[] = [];
    let unrecognized = 0;
    const noteSlot = (slot: 1 | 2, species: string) => {
      const i = opponent.findIndex(o => toId(o.species) === toId(species));
      if (i >= 0) plateOrder.current[slot - 1] = i;
    };
    // The settled plate assertions are the most direct statement of who is where.
    if (p.occupancy?.o1) noteSlot(1, p.occupancy.o1);
    if (p.occupancy?.o2) noteSlot(2, p.occupancy.o2);
    for (const l of p.lines) {
      const m = l.match(/^o([12]) > switch > (.+)$/);
      if (!m) continue;
      const idx = opponent.findIndex(o => toId(o.species) === toId(m[2]!));
      if (idx >= 0) {
        if (!seen.includes(idx)) seen.push(idx);
        noteSlot(Number(m[1]) as 1 | 2, m[2]!);       // the send-out line names the slot
      } else unrecognized++;
    }
    // Pre-fill whatever resolved — a NICKNAMED lead ("sent out Courtois and
    // Camerupt!") leaves only one recognizable, and one pre-selected beats none.
    if (seen.length === 0 || seen.length > 2) return;
    const key = [...seen].sort((a, b) => a - b).join(',');
    if (lastAutoKey.current === key) return;
    lastAutoKey.current = key;
    setChosen(new Set(seen));
    const names = seen.map(i => opponent[i]!.species).join(' + ');
    setVisionMsg(seen.length === 2
      ? `⌁ vision saw ${names} sent out — Enter to confirm`
      : `⌁ vision saw ${names} + ${unrecognized ? 'an unrecognized name (nicknamed?)' : 'one it could not read'} — toggle their other lead, then Enter`);
  }), [opponent]);

  useInput((input, key) => {
    // Esc + Left-arrow both go back one step (to BringPicker) so the user
    // can fix the bring if they realise they messed it up. When no
    // onBack handler is supplied we fall through to onCancel which
    // typically routes all the way to the main menu.
    if (key.escape || key.leftArrow) { (onBack ?? onCancel)(); return; }
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(opponent.length - 1, c + 1));
    if (input === ' ') {
      manualTouch.current = true;   // the user's hand wins over vision pre-fill from here on
      const next = new Set(chosen);
      if (next.has(cursor)) next.delete(cursor);
      else if (next.size < LEAD_SIZE) next.add(cursor);
      setChosen(next);
    }
    if (key.return && chosen.size === LEAD_SIZE) {
      onConfirm(orderLeads(chosen, plateOrder.current));
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Opponent's leads — which 2 did they send out at preview?</Text>
      <Text dimColor>↑/↓ to move · space to toggle · Enter when 2 selected · ←/ESC to go back to bring</Text>
      <Text dimColor>The other 2 of their bring will reveal as they switch in or come in on a faint.</Text>
      {visionMsg && <Text color="green">{visionMsg}</Text>}
      <Box flexDirection="column" marginTop={1}>
        {opponent.map((o, i) => {
          const pik = stores.pikalytics.get(o.species);
          const item = pik?.items[0];
          const ability = pik?.abilities[0];
          const selected = chosen.has(i);
          return (
            <Box key={i} flexDirection="column">
              <Text color={i === cursor ? 'yellow' : undefined}>
                {i === cursor ? '>' : ' '} [{selected ? 'x' : ' '}] {i + 1}. {o.species} <Text dimColor>[{speciesTypes(o.species).join('/') || '?'}]</Text>
              </Text>
              {pik && (
                <Text dimColor>
                  {'      '}
                  {item ? `item: ${item.name} ${item.pct.toFixed(0)}%` : ''}
                  {item && ability ? ' · ' : ''}
                  {ability ? `${ability.name} ${ability.pct.toFixed(0)}%` : ''}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
      {/* Once both leads are chosen, predict the back two: keep only the brings
          that are best for them vs us AND contain both leads. */}
      {chosen.size === LEAD_SIZE && (() => {
        const leadSp = [...chosen].sort((a, b) => a - b).map(i => opponent[i]!.species);
        const back = predictOppBack(oppSets, myTeam, leadSp, 3);
        return (
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="magenta" paddingX={1}>
            <Text><Text color="magenta" bold>⌁ likely back two</Text> <Text dimColor>given {leadSp.join(' + ')}</Text></Text>
            {back.length
              ? back.map((g, i) => <Text key={i}>  {i === 0 ? '→' : ' '} <Text bold={i === 0}>{g.back.map(m => m.species).join(' + ')}</Text></Text>)
              : <Text dimColor>  (no likely bring pairs with both leads)</Text>}
          </Box>
        );
      })()}
      <Box marginTop={1}>
        <Text dimColor>
          Selected {chosen.size}/{LEAD_SIZE}
          {chosen.size === LEAD_SIZE ? ' — press Enter to confirm' : ''}
        </Text>
      </Box>
    </Box>
  );
}
