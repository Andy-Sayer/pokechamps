import React from 'react';
import { describe, test, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { MainMenu } from '../src/ui/MainMenu.js';

const noop = () => {};

describe('MainMenu — screen toggle label', () => {
  test('reflects the live HDMI-capture state', () => {
    const label = (captureState: Parameters<typeof MainMenu>[0]['captureState']) =>
      render(<MainMenu onSelect={noop} captureState={captureState} />).lastFrame() ?? '';

    expect(label('off')).toContain('Turn on screen');
    expect(label('starting')).toContain('starting');
    expect(label('no-signal')).toContain('no signal');
    expect(label('on')).toMatch(/Turn off screen.*live/);
  });

  test('defaults to the off label when no capture state is supplied', () => {
    const { lastFrame } = render(<MainMenu onSelect={noop} />);
    expect(lastFrame()).toContain('Turn on screen');
  });
});
