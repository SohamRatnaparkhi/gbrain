/**
 * chunkText stays linear with spans on (large pages, Wave A).
 *
 * Span tracking carries offset segments through merge and overlap; copying a
 * run's segments on every merge made the merge quadratic in pieces per chunk.
 * Doubling the input must roughly double the time with spans on, for chat-log
 * text and for a page of one-word paragraphs (the most pieces per chunk). The
 * bound is generous (linear is 2x, quadratic 4x) and each size takes its best
 * of three runs, so a busy machine does not fail it. Each run is timed in
 * process CPU time, which measures the work rather than how long the
 * scheduler made it wait.
 */
import { describe, test, expect } from 'bun:test';
import { chunkText } from '../src/core/chunkers/recursive.ts';
import { cpuMs } from './helpers/cpu-time.ts';

function chatLog(chars: number): string {
  let a = 0x9e3779b9;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const who = ['alice-example', 'bob-example', 'carol-example'];
  const words = ['ok', 'lol', 'see you at', 'the acme-example demo', 'running late', 'did you get', 'the doc', 'sounds good', '😂', 'can you send the link', 'https://example.com/x'];
  const parts: string[] = [];
  let len = 0;
  let day = 0;
  while (len < chars) {
    const line = r() < 0.02
      ? `\n## 2026-03-${String((day++ % 28) + 1).padStart(2, '0')}\n\n`
      : `[10:${String(Math.floor(r() * 60)).padStart(2, '0')}] ${who[Math.floor(r() * 3)]}: ${Array.from({ length: 1 + Math.floor(r() * 12) }, () => words[Math.floor(r() * words.length)]).join(' ')}\n`;
    parts.push(line);
    len += line.length;
  }
  return parts.join('');
}

function bestMs(text: string): number {
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    let chunks: ReturnType<typeof chunkText> = [];
    best = Math.min(best, cpuMs(() => { chunks = chunkText(text, { spans: true }); }));
    expect(chunks.every(c => c.byte_start !== undefined)).toBe(true);
  }
  return best;
}

const MB = 1024 * 1024;

describe('chunkText(spans: true) scales linearly', () => {
  for (const [name, make] of [
    ['chat log', chatLog],
    ['one-word paragraphs', (chars: number) => 'x\n\n'.repeat(Math.floor(chars / 3))],
  ] as const) {
    test(`${name}: 4 MB takes under 3x the time of 2 MB`, () => {
      const small = bestMs(make(2 * MB));
      const large = bestMs(make(4 * MB));
      expect(large / small).toBeLessThan(3);
    }, 120_000);
  }
});
