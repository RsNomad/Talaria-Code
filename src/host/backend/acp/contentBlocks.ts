import type { ToolDiff } from '../../../shared/protocol';
import { buildDiffHunks } from './diffHunks';
import type { AcpContentBlock, AcpToolCallContent } from './types';

/** Extract the text of a single ACP `ContentBlock` (message/thought chunk content). */
export function extractSingleBlockText(block: AcpContentBlock | null | undefined): string {
  if (!block) return '';
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  return '';
}

/**
 * Join the text content blocks of a `ToolCallContent[]` array (tool_call /
 * tool_call_update `.content`) into one string, ignoring `diff` and
 * `terminal` entries (handled separately — see {@link extractDiffs}).
 */
export function extractToolCallOutputText(content: AcpToolCallContent[] | null | undefined): string {
  if (!content) return '';
  const parts: string[] = [];
  for (const item of content) {
    if ('content' in item) {
      const text = extractSingleBlockText(item.content);
      if (text) parts.push(text);
    }
  }
  return parts.join('\n');
}

/** Pull every `diff` entry out of a `ToolCallContent[]` array and turn it into a {@link ToolDiff}. */
export function extractDiffs(content: AcpToolCallContent[] | null | undefined): ToolDiff[] {
  if (!content) return [];
  const diffs: ToolDiff[] = [];
  for (const item of content) {
    if ('type' in item && item.type === 'diff') {
      diffs.push({ path: item.path, hunks: buildDiffHunks(item.oldText, item.newText) });
    }
  }
  return diffs;
}

/**
 * Best-effort one-line preview of a tool's `rawInput` object for
 * `tool.start.rawInput` (protocol wants a `string`, ACP gives an object).
 */
export function previewRawInput(rawInput: Record<string, unknown> | null | undefined): string | undefined {
  if (!rawInput) return undefined;
  for (const key of ['command', 'path', 'pattern', 'query', 'goal', 'url']) {
    const value = rawInput[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  try {
    const json = JSON.stringify(rawInput);
    if (!json || json === '{}') return undefined;
    return json.length > 200 ? `${json.slice(0, 197)}...` : json;
  } catch {
    return undefined;
  }
}
