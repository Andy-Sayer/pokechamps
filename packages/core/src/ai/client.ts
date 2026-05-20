import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-4-7';

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY env var is not set');
    }
    client = new Anthropic();
  }
  return client;
}

export interface AskOpts {
  system?: string;
  // Long static context (team sheets, ruleset) — gets cache_control applied.
  cachedContext?: string;
  user: string;
  maxTokens?: number;
}

export async function ask(opts: AskOpts): Promise<string> {
  const c = getClient();
  const content: Anthropic.Messages.ContentBlockParam[] = [];
  if (opts.cachedContext) {
    content.push({
      type: 'text',
      text: opts.cachedContext,
      cache_control: { type: 'ephemeral' },
    });
  }
  content.push({ type: 'text', text: opts.user });
  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 600,
    system: opts.system,
    messages: [{ role: 'user', content }],
  });
  return resp.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

export function isAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
