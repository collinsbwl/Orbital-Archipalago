import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_URL, resolveMode, toWsUrl } from './mode';

describe('toWsUrl', () => {
  it('keeps absolute ws/wss URLs as they are', () => {
    expect(toWsUrl('ws://localhost:8787/ws', 'https://sim.example/')).toBe('ws://localhost:8787/ws');
    expect(toWsUrl('wss://engine.example/ws', 'http://localhost:5173/')).toBe('wss://engine.example/ws');
  });

  it('resolves a path against the page origin, matching its security', () => {
    expect(toWsUrl('/ws', 'https://sim.example/some/page?live=1')).toBe('wss://sim.example/ws');
    expect(toWsUrl('/ws', 'http://localhost:8080/')).toBe('ws://localhost:8080/ws');
  });

  it('maps http(s) URLs to ws(s)', () => {
    expect(toWsUrl('https://engine.example/ws', 'http://localhost/')).toBe('wss://engine.example/ws');
  });
});

describe('resolveMode', () => {
  it('uses fixtures by default and the local engine for ?live=1', () => {
    expect(resolveMode('', undefined)).toEqual({ mode: 'fixture', wsUrl: DEFAULT_LIVE_URL });
    expect(resolveMode('?live=1', undefined)).toEqual({ mode: 'live', wsUrl: DEFAULT_LIVE_URL });
  });

  it('goes live on a configured URL unless ?fixtures=1, resolving a same-origin path', () => {
    expect(resolveMode('', '/ws', 'https://sim.example/')).toEqual({ mode: 'live', wsUrl: 'wss://sim.example/ws' });
    expect(resolveMode('?fixtures=1', '/ws', 'https://sim.example/')).toEqual({ mode: 'fixture', wsUrl: 'wss://sim.example/ws' });
  });
});
