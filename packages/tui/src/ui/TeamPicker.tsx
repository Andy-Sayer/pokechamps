import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import type { PokemonSet } from '@pokechamps/core/domain/types.js';
import type { Stores, SavedTeam } from '@pokechamps/core/storage/index.js';
import { formatShowdownTeamSP } from '@pokechamps/core/domain/showdown.js';
// Type-only (erased at runtime); the vision module loads lazily on Ctrl+R.
import type { TeamSummaryResult } from '@pokechamps/vision/teamSummary.js';
import { ExportPanel } from './ExportPanel.js';

// Mirrors saveTeam's filename sanitisation so the picker can predict the saved
// name (collision checks, no-op detection) without a round-trip.
const sanitizeName = (s: string) => s.trim().replace(/[^a-zA-Z0-9_-]/g, '_');

export interface TeamPickerProps {
  stores: Stores;
  onPick: (team: PokemonSet[], name: string) => void;
  onCreateNew: () => void;
  /** Edit an existing team — opens TeamPaste pre-loaded with the team's
   *  Showdown export. Saving with the same name overwrites silently. */
  onEdit: (team: PokemonSet[], name: string) => void;
  /** Clone an existing team — opens TeamPaste pre-loaded with the team's
   *  Showdown export but with a fresh suggested name, so saving creates
   *  a new variant instead of overwriting. Lets the user tweak one small
   *  detail without rebuilding from scratch. */
  onClone: (team: PokemonSet[], suggestedName: string) => void;
  onCancel: () => void;
}

// Picks the smallest "<base>-copy", "<base>-copy2", … that doesn't already
// exist. Keeps clone-of-clone names reasonable.
function suggestCopyName(base: string, existing: string[]): string {
  const taken = new Set(existing);
  const root = base.replace(/-copy\d*$/i, '');
  let candidate = `${root}-copy`;
  let n = 2;
  while (taken.has(candidate)) candidate = `${root}-copy${n++}`;
  return candidate;
}

export function TeamPicker({ stores, onPick, onCreateNew, onEdit, onClone, onCancel }: TeamPickerProps) {
  // null = still loading. Once loaded, an empty list short-circuits to the
  // create-new flow (preserves the prior synchronous behaviour).
  const [teams, setTeams] = useState<SavedTeam[] | null>(null);
  // ink-select-input fires onHighlight with the focused item — we track that
  // separately to drive the right-hand preview panel.
  const [preview, setPreview] = useState<string | null>(null);
  // When set: render an ExportPanel overlay for the named team instead of
  // the picker. Esc clears.
  const [exportFor, setExportFor] = useState<{ name: string; text: string } | null>(null);
  // Overlay mode for the destructive/edit-name actions; `error` surfaces a
  // collision message under the rename field.
  const [mode, setMode] = useState<'rename' | 'delete' | 'import' | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Import-from-screen flow: capture the two summary pages with Ctrl+R, OCR + verify,
  // then name + save. Paths live in a ref (no re-render needed); `importBusy` stops a
  // held Ctrl+R double-firing a capture or overlapping the OCR pass.
  const [importStep, setImportStep] = useState<'moves' | 'stats' | 'reading' | 'name'>('moves');
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<TeamSummaryResult | null>(null);
  const [importName, setImportName] = useState('imported');
  const importPaths = useRef<{ moves?: string }>({});
  const importBusy = useRef(false);
  const importGen = useRef(0);   // bumped on close/cancel — an in-flight OCR pass from a cancelled import must not resurrect the panel

  const closeImport = () => {
    importGen.current++;
    setMode(null); setError(null); setImportMsg(null); setImportResult(null);
    setImportStep('moves'); importPaths.current = {};
  };

  const captureImportPage = async () => {
    if (importBusy.current) return;
    importBusy.current = true;
    const gen = importGen.current;
    try {
      const step = importStep as 'moves' | 'stats';
      const vis = await import('@pokechamps/vision/teamSummary.js');
      const { loadFrame } = await import('@pokechamps/vision/decode.js');
      const path = vis.snapshotSummaryPage(step);
      const page = vis.detectSummaryPage(await loadFrame(path));
      if (gen !== importGen.current) return;   // import was cancelled while loading
      if (page !== step) {
        setImportMsg(page
          ? `that's the ${page === 'moves' ? 'Moves & More' : 'Stats'} page — show the ${step === 'moves' ? 'Moves & More' : 'Stats'} page, then Ctrl+R`
          : 'no team summary detected — open the team summary in-game, then Ctrl+R');
        return;
      }
      if (step === 'moves') {
        importPaths.current.moves = path;
        setImportStep('stats');
        setImportMsg(null);
        return;
      }
      setImportStep('reading');
      setImportMsg(null);
      const res = await vis.importTeamFromFrames(importPaths.current.moves!, path);
      if (gen !== importGen.current) return;   // cancelled mid-OCR — drop the result
      setImportResult(res);
      setImportName('imported');
      setImportStep('name');
    } catch (e) {
      if (gen !== importGen.current) return;
      setImportMsg(`capture failed: ${(e as Error).message}`);
      setImportStep(s => (s === 'reading' ? 'stats' : s));   // a failed OCR pass returns to re-capture Stats
    } finally {
      importBusy.current = false;
    }
  };

  const submitImport = async (raw: string) => {
    if (!importResult) return;
    const safe = sanitizeName(raw);
    if (!safe) { setError('name is empty'); return; }
    if (teams!.some(x => x.name === safe)) { setError(`"${safe}" already exists — pick another name`); return; }
    await stores.teams.save(safe, importResult.team);
    closeImport();
    reload(safe);
  };

  // Reload the list after a mutation; optionally focus a specific team.
  const reload = (selectName?: string) => {
    stores.teams.list().then(list => {
      setTeams(list);
      setPreview(selectName ?? list[0]?.name ?? null);
      if (list.length === 0) onCreateNew();
    });
  };

  useEffect(() => {
    let cancelled = false;
    stores.teams.list().then(list => {
      if (cancelled) return;
      setTeams(list);
      setPreview(list[0]?.name ?? null);
      if (list.length === 0) onCreateNew();
    });
    return () => { cancelled = true; };
  }, [stores]);

  const current = (): SavedTeam | undefined => teams?.find(t => t.name === preview);

  const submitRename = async (raw: string) => {
    const t = current();
    if (!t) { setMode(null); return; }
    const safe = sanitizeName(raw);
    if (!safe || safe === t.name) { setMode(null); setError(null); return; } // no change
    if (teams!.some(x => x.name === safe)) { setError(`"${safe}" already exists`); return; }
    await stores.teams.save(safe, t.team);  // write under the new name…
    await stores.teams.delete(t.name);      // …then drop the old file
    setMode(null); setError(null);
    reload(safe);
  };

  const confirmDelete = async () => {
    const t = current();
    if (!t) { setMode(null); return; }
    await stores.teams.delete(t.name);
    setMode(null);
    reload();
  };

  // `e` edit, `k` clone (k for kopy — c is taken by /custom-bring style
  // commands), `x` show Showdown export, `r` rename, `d` delete, `i` import
  // from the live screen (Ctrl+R captures each summary page).
  useInput((input, key) => {
    if (key.escape) {
      if (exportFor) setExportFor(null);
      else if (mode === 'import') closeImport();
      else if (mode) { setMode(null); setError(null); }
      return;
    }
    if (mode === 'delete') {
      if (input === 'y' || key.return) void confirmDelete();
      else if (input === 'n') setMode(null);
      return;
    }
    if (mode === 'import') {
      // moves/stats steps: Ctrl+R captures the page. name step: TextInput owns input.
      if ((importStep === 'moves' || importStep === 'stats') && key.ctrl && (input === 'r' || input === 'R')) void captureImportPage();
      return;
    }
    if (exportFor || mode) return; // rename: TextInput owns input; export: read-only
    if (!preview || !teams) return;
    const t = teams.find(t => t.name === preview);
    if (!t) return;
    if (input === 'e') onEdit(t.team, t.name);
    else if (input === 'k') onClone(t.team, suggestCopyName(t.name, teams.map(x => x.name)));
    else if (input === 'x') setExportFor({ name: t.name, text: formatShowdownTeamSP(t.team) });
    else if (input === 'r') { setRenameValue(t.name); setError(null); setMode('rename'); }
    else if (input === 'd') { setError(null); setMode('delete'); }
    else if (input === 'i') { setError(null); closeImport(); setMode('import'); }
  });

  if (teams === null) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">Pick your team</Text>
        <Text dimColor>(loading…)</Text>
      </Box>
    );
  }
  if (teams.length === 0) {
    // onCreateNew already invoked from the effect; render nothing while the
    // route transitions.
    return null;
  }

  const items = [
    ...teams.map(t => ({ label: t.name, value: t.name })),
    { label: 'cancel', value: '__cancel__' },
  ];

  const previewTeam = preview ? teams.find(t => t.name === preview)?.team ?? [] : [];

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Pick your team</Text>
      <Text dimColor>Enter to pick · <Text color="white">e</Text> edit · <Text color="white">k</Text> clone · <Text color="white">r</Text> rename · <Text color="white">d</Text> delete · <Text color="white">x</Text> export · <Text color="white">i</Text> import from screen · ESC to cancel</Text>
      <Box marginTop={1} flexDirection="row">
        <Box width={30} marginRight={2} flexDirection="column">
          <SelectInput
            items={items}
            isFocused={!exportFor && !mode}
            onHighlight={item => {
              const v = item.value as string;
              if (v.startsWith('__')) setPreview(null);
              else setPreview(v);
            }}
            onSelect={item => {
              if (item.value === '__cancel__') onCancel();
              else {
                const t = teams.find(t => t.name === item.value)!;
                onPick(t.team, t.name);
              }
            }}
          />
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="round" paddingX={1}>
          {preview ? (
            <>
              <Text bold>{preview}</Text>
              {previewTeam.length === 0 ? (
                <Text dimColor>(empty team)</Text>
              ) : previewTeam.map((m, i) => (
                <Text key={i}>
                  {i + 1}. {m.species}
                  {m.item ? <Text dimColor> @ {m.item}</Text> : null}
                </Text>
              ))}
            </>
          ) : (
            <Text dimColor>Highlight a team to preview its mons.</Text>
          )}
        </Box>
      </Box>
      {mode === 'rename' && preview && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text>Rename <Text bold>{preview}</Text> to: <TextInput value={renameValue} onChange={setRenameValue} onSubmit={submitRename} /></Text>
          {error ? <Text color="red">{error}</Text> : <Text dimColor>Enter to confirm · Esc to cancel</Text>}
        </Box>
      )}
      {mode === 'delete' && preview && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
          <Text>Delete team <Text bold color="red">{preview}</Text>? <Text dimColor>(y / n)</Text></Text>
        </Box>
      )}
      {mode === 'import' && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text bold color="magenta">Import team from screen</Text>
          <Text>
            <Text color={importStep === 'moves' ? 'yellow' : 'green'}>{importStep === 'moves' ? '▸' : '✓'} Moves &amp; More page</Text>
            {'   '}
            <Text color={importStep === 'stats' ? 'yellow' : importStep === 'moves' ? 'gray' : 'green'}>{importStep === 'moves' ? '· ' : importStep === 'stats' ? '▸' : '✓'} Stats page</Text>
          </Text>
          {(importStep === 'moves' || importStep === 'stats') && (
            <Text dimColor>Open the team summary in-game on the <Text color="white">{importStep === 'moves' ? 'Moves & More' : 'Stats'}</Text> page, then <Text bold>Ctrl+R</Text> to capture · Esc cancels</Text>
          )}
          {importStep === 'reading' && <Text color="yellow">reading both pages… (~20s, OCR + verification)</Text>}
          {importStep === 'name' && importResult && (
            <>
              {importResult.team.map((m, i) => (
                <Text key={i}>
                  {i + 1}. {m.species} <Text dimColor>{m.item ? `@ ${m.item} ` : ''}· {m.nature} · {m.moves.join(', ')}</Text>
                </Text>
              ))}
              {importResult.warnings.length > 0 && (
                <Text color="yellow">⚠ {importResult.warnings.length} warning{importResult.warnings.length > 1 ? 's' : ''}: {importResult.warnings.slice(0, 3).join(' · ')}{importResult.warnings.length > 3 ? ' · …' : ''}</Text>
              )}
              <Text>Save as: <TextInput value={importName} onChange={setImportName} onSubmit={v => void submitImport(v)} /></Text>
            </>
          )}
          {importMsg && <Text color="red">{importMsg}</Text>}
          {error && importStep === 'name' && <Text color="red">{error}</Text>}
        </Box>
      )}
      {exportFor && (
        <ExportPanel
          title={`Showdown export — ${exportFor.name}`}
          body={exportFor.text}
          hint="Select with your terminal + copy · paste into play.pokemonshowdown.com → Teambuilder · Esc closes"
        />
      )}
    </Box>
  );
}
