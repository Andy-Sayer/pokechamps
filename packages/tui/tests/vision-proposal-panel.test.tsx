import React from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { VisionProposalPanel } from '../src/ui/VisionProposalPanel.js';

const LINES = ['o1+mega > Fake Out > m1 > 82', 'm2 > Light Screen > self', 'o1 ko'];
const proposal = { lines: LINES, confidence: 0.9, notes: ['o2 species unresolved (nickname)'] };
const GLOSS: Record<string, string> = {
  'o1+mega > Fake Out > m1 > 82': 'Mega Raichu Fake Out → Staraptor, 82% left',
  'm2 > Light Screen > self': 'Grimmsnarl set Light Screen',
  'o1 ko': 'Raichu fainted',
};
const gloss = (l: string) => GLOSS[l] ?? null;
const noop = () => {};
const tick = () => new Promise(r => setTimeout(r, 20));

describe('VisionProposalPanel', () => {
  test('renders the lines, glosses, confidence, notes, and the accept hint', () => {
    const { lastFrame } = render(
      <VisionProposalPanel proposal={proposal} turnNumber={3} gloss={gloss} onAccept={noop} onReject={noop} />,
    );
    const f = lastFrame()!;
    expect(f).toContain('Vision proposal');
    expect(f).toContain('turn 3');
    expect(f).toContain('conf 90%');
    expect(f).toContain('Fake Out');
    expect(f).toContain('Mega Raichu Fake Out → Staraptor');   // injected gloss
    expect(f).toContain('o2 species unresolved');              // note
    expect(f).toContain('accept');
  });

  test('Enter accepts the trimmed lines', () => {
    const onAccept = vi.fn();
    const { stdin } = render(<VisionProposalPanel proposal={proposal} gloss={gloss} onAccept={onAccept} onReject={noop} />);
    stdin.write('\r');
    expect(onAccept).toHaveBeenCalledWith(LINES);
  });

  test('r rejects', () => {
    const onReject = vi.fn();
    const { stdin } = render(<VisionProposalPanel proposal={proposal} gloss={gloss} onAccept={noop} onReject={onReject} />);
    stdin.write('r');
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  test('e enters edit mode (hint changes)', async () => {
    const { stdin, lastFrame } = render(<VisionProposalPanel proposal={proposal} gloss={gloss} onAccept={noop} onReject={noop} />);
    expect(lastFrame()).toContain('e edit');
    stdin.write('e');
    await tick();
    expect(lastFrame()).toContain('enter done');
  });

  test('a line that does not parse is flagged', () => {
    const { lastFrame } = render(
      <VisionProposalPanel proposal={{ lines: ['garblednonsense'] }} gloss={() => null} onAccept={noop} onReject={noop} />,
    );
    expect(lastFrame()).toContain('does not parse');
  });
});
