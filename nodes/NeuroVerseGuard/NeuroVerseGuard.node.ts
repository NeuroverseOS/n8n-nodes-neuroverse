import {
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  NodeConnectionTypes,
} from 'n8n-workflow';

import {
  loadWorld,
  evaluateGuard,
  evaluateGuardWithAI,
  extractContentFields,
  adaptationFromVerdict,
  detectBehavioralPatterns,
  generateAdaptationNarrative,
} from '@neuroverseos/governance';
import type { GuardVerdict, Adaptation } from '@neuroverseos/governance';
import { writeFileSync, mkdtempSync, statSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

// ─── Bundled Worlds ──────────────────────────────────────────────────────────

const BUNDLED_WORLDS_DIR = resolve(__dirname, '..', '..', '..', 'worlds');

function getBundledWorldChoices(): Array<{ name: string; value: string }> {
  try {
    return readdirSync(BUNDLED_WORLDS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({
        name: d.name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        value: d.name,
      }));
  } catch {
    return [];
  }
}

function scanDirectoryForWorlds(dirPath: string): Array<{ name: string; value: string }> {
  try {
    return readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({
        name: d.name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        value: d.name,
      }));
  } catch {
    return [];
  }
}

// ─── Field Name Normalization (Fix 3) ─────────────────────────────────────────
// extractContentFields recognizes specific key names. Real-world workflows use
// many synonyms.  Normalize before passing to the governance function.

const DRAFT_REPLY_ALIASES = new Set([
  'draft_reply', 'reply', 'reply_text', 'reply_body',
  'response', 'response_text', 'response_body',
  'answer', 'answer_text',
  'draft', 'draft_text', 'draft_body',
  'output', 'ai_output', 'ai_response', 'generated_reply',
]);

const CUSTOMER_INPUT_ALIASES = new Set([
  'customer_input', 'customer_message', 'customer_text',
  'user_input', 'user_message', 'user_text',
  'email_body', 'email_text', 'email_content',
  'message', 'message_text', 'message_body',
  'msg', 'inquiry', 'question', 'request',
  'incoming', 'incoming_message', 'original_message',
  'ticket_body', 'ticket_text',
]);

const CONTEXT_ALIASES = new Set([
  'context', 'metadata', 'subject', 'topic',
  'email_subject', 'subject_line', 'category',
  'channel', 'source', 'tags',
]);

function normalizeFieldNames(args: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  let hasDraftReply = false;
  let hasCustomerInput = false;
  let hasContext = false;

  for (const [key, value] of Object.entries(args)) {
    const lowerKey = key.toLowerCase();

    if (!hasDraftReply && DRAFT_REPLY_ALIASES.has(lowerKey)) {
      normalized['draft_reply'] = value;
      hasDraftReply = true;
    } else if (!hasCustomerInput && CUSTOMER_INPUT_ALIASES.has(lowerKey)) {
      normalized['customer_input'] = value;
      hasCustomerInput = true;
    } else if (!hasContext && CONTEXT_ALIASES.has(lowerKey)) {
      normalized['context'] = value;
      hasContext = true;
    } else {
      normalized[key] = value;
    }
  }

  return normalized;
}

// ─── Vocabulary Resolution ────────────────────────────────────────────────────
// The guard engine's pattern matching can over-trigger on action verbs in raw
// text.  If the intent matches a safe (non-blocking) vocabulary pattern, resolve
// it to the vocabulary key.  This gives the engine a clean semantic label to
// evaluate instead of raw text that might partially match blocking patterns.

function resolveToVocabularyKey(intent: string, world: any): string {
  try {
    const vocabulary: Record<string, { pattern: string }> = world?.guards?.intent_vocabulary ?? {};
    const guards: any[] = world?.guards?.guards ?? [];

    // Build a set of vocabulary keys that are referenced by blocking guards —
    // we never want to resolve TO a blocking intent.
    const blockingKeys = new Set<string>();
    for (const guard of guards) {
      if (guard.enforcement === 'block' || guard.enforcement === 'pause') {
        for (const key of guard.intent_patterns ?? []) {
          blockingKeys.add(key);
        }
      }
    }

    // Try to match intent against vocabulary patterns.  Return the first
    // non-blocking key that matches.
    for (const [key, entry] of Object.entries(vocabulary)) {
      if (blockingKeys.has(key)) continue; // don't resolve to blocking intents
      if (!entry.pattern) continue;
      try {
        const regex = new RegExp(entry.pattern, 'i');
        if (regex.test(intent)) {
          return key; // e.g. "reply_to_inquiry", "send_information"
        }
      } catch { /* invalid regex */ }
    }
  } catch { /* world structure may vary */ }

  return intent; // no match — keep original
}

// ─── World Cache ──────────────────────────────────────────────────────────────

interface CachedWorld {
  world: Awaited<ReturnType<typeof loadWorld>>;
  mtime: number;
}
const worldCache = new Map<string, CachedWorld>();

function getDirectoryMtime(dirPath: string): number {
  try {
    let latest = statSync(dirPath).mtimeMs;
    for (const file of ['guards.json', 'world.json', 'invariants.json', 'kernel.json']) {
      try {
        const mt = statSync(join(dirPath, file)).mtimeMs;
        if (mt > latest) latest = mt;
      } catch { /* file may not exist */ }
    }
    return latest;
  } catch {
    return 0;
  }
}

// ─── Tool Surface Validation (Fix 1) ─────────────────────────────────────────
// If the tool doesn't match any guard's appliesTo, also evaluate WITHOUT the
// tool so guards with appliesTo still fire.  Attacker can't bypass by using
// an unknown tool name.

function getKnownToolSurfaces(world: any): Set<string> {
  const surfaces = new Set<string>();
  try {
    const toolSurfaces = world?.guards?.tool_surfaces ?? [];
    for (const s of toolSurfaces) {
      if (typeof s === 'string') surfaces.add(s.toLowerCase());
    }
    const guards = world?.guards?.guards ?? [];
    for (const g of guards) {
      if (Array.isArray(g.appliesTo)) {
        for (const t of g.appliesTo) {
          if (typeof t === 'string') surfaces.add(t.toLowerCase());
        }
      }
    }
  } catch { /* world structure may vary */ }
  return surfaces;
}

function takeStrictestVerdict(a: GuardVerdict, b: GuardVerdict): GuardVerdict {
  const severity: Record<string, number> = { BLOCK: 3, PAUSE: 2, WARN: 1, ALLOW: 0 };
  const aScore = severity[a.status] ?? 0;
  const bScore = severity[b.status] ?? 0;
  return bScore > aScore ? b : a;
}

// ─── Content Safety Scan (Fix 4) ──────────────────────────────────────────────
// After intent evaluation, scan the actual content (draft replies, email bodies)
// against immutable guard patterns.  Intent classification correctly separates
// "what you're doing" from "what the content says" — but content itself can
// still violate policy (e.g. an ALLOW'd "customer_reply" that contains a
// password in the body).

// Direct content patterns catch raw sensitive data in message bodies regardless
// of whether the world's intent patterns (which are verb+noun combos) match.
// These detect the DATA ITSELF, not the intent to share it.
const SENSITIVE_CONTENT_PATTERNS: Array<{ id: string; pattern: RegExp; label: string }> = [
  // Actual credential-like values in text
  { id: 'raw-password',     pattern: /password\s*[:=]\s*\S+/i,                              label: 'Password value in content' },
  { id: 'raw-api-key',      pattern: /api[_-]?key\s*[:=]\s*\S+/i,                           label: 'API key value in content' },
  { id: 'raw-token',        pattern: /(access[_-]?token|bearer|secret[_-]?key)\s*[:=]\s*\S+/i, label: 'Token/secret value in content' },
  { id: 'raw-ssn',          pattern: /\b\d{3}-\d{2}-\d{4}\b/,                               label: 'SSN pattern in content' },
  { id: 'raw-credit-card',  pattern: /\b(?:\d[ -]*?){13,19}\b/,                             label: 'Credit card number pattern in content' },
  { id: 'raw-private-key',  pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,            label: 'Private key in content' },
];

function scanContentAgainstImmutableGuards(
  contentText: string,
  world: any,
): { violated: boolean; guardId?: string; reason?: string } {
  if (!contentText || contentText.length === 0) {
    return { violated: false };
  }

  // Layer 1: World's intent vocabulary patterns (verb+noun combos)
  try {
    const guards: any[] = world?.guards?.guards ?? [];
    const vocabulary: Record<string, { pattern: string }> = world?.guards?.intent_vocabulary ?? {};

    for (const guard of guards) {
      if (!guard.immutable) continue;
      if (guard.enforcement !== 'block') continue;

      for (const patternKey of guard.intent_patterns ?? []) {
        const vocabEntry = vocabulary[patternKey];
        if (!vocabEntry?.pattern) continue;

        try {
          const regex = new RegExp(vocabEntry.pattern, 'i');
          if (regex.test(contentText)) {
            return {
              violated: true,
              guardId: guard.id,
              reason: `Content violates ${guard.label}: matched pattern "${patternKey}" in reply/message body. The agent's intent was allowed, but the content itself contains a policy violation.`,
            };
          }
        } catch { /* invalid regex — skip */ }
      }
    }
  } catch { /* world structure may vary */ }

  // Layer 2: Direct sensitive data detection — catches raw values
  // (password=X, SSN, credit card numbers, private keys) even when
  // no action verb precedes them.
  for (const check of SENSITIVE_CONTENT_PATTERNS) {
    if (check.pattern.test(contentText)) {
      return {
        violated: true,
        guardId: `content-scan-${check.id}`,
        reason: `${check.label} detected in reply/message body. The agent's intent was allowed, but the content contains sensitive data that must not be sent.`,
      };
    }
  }

  return { violated: false };
}

// ─── Narrative Generation ────────────────────────────────────────────────────

/** Extract human-readable context from the loaded world object */
function extractWorldContext(world: any): {
  name: string;
  description: string;
  thesis: string;
  guardDescriptions: Record<string, { label: string; description: string }>;
  invariantDescriptions: Record<string, { label: string; description: string }>;
} {
  const worldJson = world?.world ?? world ?? {};
  const guardsArr: any[] = world?.guards?.guards ?? [];
  const invariantsArr: any[] = world?.invariants ?? [];

  const guardDescriptions: Record<string, { label: string; description: string }> = {};
  for (const g of guardsArr) {
    if (g?.id) {
      guardDescriptions[g.id] = { label: g.label ?? g.id, description: g.description ?? '' };
    }
  }

  const invariantDescriptions: Record<string, { label: string; description: string }> = {};
  for (const inv of invariantsArr) {
    if (inv?.id) {
      invariantDescriptions[inv.id] = { label: inv.label ?? inv.id, description: inv.description ?? '' };
    }
  }

  return {
    name: worldJson.name ?? worldJson.world_id ?? 'Unknown',
    description: worldJson.description ?? '',
    thesis: worldJson.thesis ?? '',
    guardDescriptions,
    invariantDescriptions,
  };
}

/** Build a prompt for AI narrative of a guard decision */
function buildGuardNarrativePrompt(
  worldCtx: ReturnType<typeof extractWorldContext>,
  verdict: GuardVerdict,
  resolvedIntent: string,
  tool: string,
  trace: any,
  evidence: any,
  contentScanOverride: boolean,
  toolIsKnown: boolean,
): string {
  const matchedGuards = (trace?.guardChecks ?? [])
    .filter((gc: any) => gc.matched || gc.triggered)
    .map((gc: any) => {
      const id = gc.guardId ?? gc.id;
      const desc = worldCtx.guardDescriptions[id];
      return desc ? `- ${desc.label}: ${desc.description}` : `- ${gc.label ?? id}`;
    })
    .join('\n');

  const failedInvariants = (trace?.invariantChecks ?? [])
    .filter((ic: any) => !ic.satisfied)
    .map((ic: any) => {
      const id = ic.invariantId ?? ic.id;
      const desc = worldCtx.invariantDescriptions[id];
      return desc ? `- ${desc.label}: ${desc.description}` : `- ${ic.label ?? id}`;
    })
    .join('\n');

  return `You are interpreting a governance guard decision for a business user who needs to understand what happened and why.

## The World
Name: ${worldCtx.name}
Description: ${worldCtx.description}
${worldCtx.thesis ? `\nThesis: ${worldCtx.thesis}` : ''}

## The Action
Intent: ${resolvedIntent}
${tool ? `Tool: ${tool}` : ''}
${!toolIsKnown && tool ? `(This tool is NOT recognized by the policy — evaluated with maximum scrutiny)` : ''}

## The Decision
Verdict: ${verdict.status}
${verdict.reason ? `Reason: ${verdict.reason}` : ''}
${contentScanOverride ? '\nNote: The agent\'s intent was acceptable, but the actual content contained policy-violating material.' : ''}

${matchedGuards ? `## Guards That Matched\n${matchedGuards}` : '## No guards matched this action.'}
${failedInvariants ? `\n## Failed Invariants\n${failedInvariants}` : ''}

## Your Task
Write a clear, direct explanation (3-5 sentences) that tells the reader:
1. What the agent tried to do and whether it was allowed
2. WHY — in terms a business person understands (not "guard X matched pattern Y")
3. What the implications are — what should happen next

Write as if explaining to someone who manages the team using this AI agent. No headers, no bullet points, no JSON.`;
}

/** Call an AI provider for narrative generation */
async function callAIForNarrative(
  prompt: string,
  provider: string,
  model: string,
  apiKey: string,
  endpoint: string,
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  let url: string;
  let body: string;

  if (provider === 'anthropic') {
    url = endpoint || 'https://api.anthropic.com/v1/messages';
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = JSON.stringify({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
  } else if (provider === 'ollama') {
    url = (endpoint || 'http://localhost:11434') + '/api/chat';
    body = JSON.stringify({
      model: model || 'llama3',
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    });
  } else {
    url = (endpoint || 'https://api.openai.com/v1') + '/chat/completions';
    headers['Authorization'] = `Bearer ${apiKey}`;
    body = JSON.stringify({
      model: model || 'gpt-4.1-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    });
  }

  const response = await fetch(url, { method: 'POST', headers, body });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AI narrative call failed (${response.status}): ${text.substring(0, 200)}`);
  }

  const json = await response.json() as any;

  if (provider === 'anthropic') {
    return json.content?.[0]?.text ?? '';
  } else if (provider === 'ollama') {
    return json.message?.content ?? '';
  } else {
    return json.choices?.[0]?.message?.content ?? '';
  }
}

/** Fallback: template-based narrative using world context */
function buildFallbackGuardNarrative(
  worldCtx: ReturnType<typeof extractWorldContext>,
  verdict: GuardVerdict,
  resolvedIntent: string,
  tool: string,
  trace: any,
  evidence: any,
  contentScanOverride: boolean,
  toolIsKnown: boolean,
  intentSource: string,
): string[] {
  const lines: string[] = [];

  // Opening — what happened in context of the world
  if (worldCtx.description) {
    lines.push(`In the context of "${worldCtx.name}" (${worldCtx.description}):`);
  }

  if (verdict.status === 'ALLOW') {
    lines.push(`The action "${resolvedIntent}" was allowed${tool ? ` via ${tool}` : ''}.`);
  } else if (verdict.status === 'BLOCK') {
    lines.push(`The action "${resolvedIntent}" was blocked${tool ? ` via ${tool}` : ''}.`);
  } else if (verdict.status === 'PAUSE') {
    lines.push(`The action "${resolvedIntent}" was paused for human review${tool ? ` via ${tool}` : ''}.`);
  }

  if (verdict.reason) {
    lines.push(verdict.reason);
  }

  if (contentScanOverride) {
    lines.push('The agent\'s intent was acceptable, but the actual content contained policy-violating material.');
  }

  if (!toolIsKnown && tool) {
    lines.push(`The tool "${tool}" is not recognized by this policy. Unknown tools are evaluated with maximum scrutiny.`);
  }

  // Guard matches with descriptions from the world
  if (trace?.guardChecks?.length) {
    const matched = trace.guardChecks.filter((gc: any) => gc.matched || gc.triggered);
    for (const gc of matched.slice(0, 3)) {
      const id = gc.guardId ?? gc.id;
      const desc = worldCtx.guardDescriptions[id];
      if (desc?.description) {
        lines.push(`Guard "${desc.label}": ${desc.description}`);
      }
    }
  }

  // Failed invariants
  const invSatisfied = evidence?.invariantsSatisfied;
  const invTotal = evidence?.invariantsTotal;
  if (invTotal != null && invTotal > 0 && invSatisfied !== invTotal) {
    if (trace?.invariantChecks?.length) {
      const failed = trace.invariantChecks.filter((ic: any) => !ic.satisfied);
      for (const ic of failed.slice(0, 3)) {
        const id = ic.invariantId ?? ic.id;
        const desc = worldCtx.invariantDescriptions[id];
        if (desc?.description) {
          lines.push(`Invariant violated — "${desc.label}": ${desc.description}`);
        }
      }
    }
  }

  if (intentSource === 'ai') {
    lines.push('The intent was classified by AI before evaluation.');
  }

  return lines;
}

// ─── Node ─────────────────────────────────────────────────────────────────────

export class NeuroVerseGuard implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'NeuroVerse Guard',
    name: 'neuroVerseGuard',
    icon: 'file:neuroverse.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["intent"]}}',
    description:
      'Evaluate an AI agent action against a NeuroVerse governance world. Routes to ALLOW, BLOCK, or PAUSE.',
    defaults: {
      name: 'NeuroVerse Guard',
    },
    inputs: [NodeConnectionTypes.Main] as any,
    outputs: [NodeConnectionTypes.Main, NodeConnectionTypes.Main, NodeConnectionTypes.Main] as any,
    outputNames: ['ALLOW', 'BLOCK', 'PAUSE'],
    properties: [
      // ─── World Source ─────────────────────────────────────────────
      {
        displayName: 'World Source',
        name: 'worldSource',
        type: 'options' as const,
        options: [
          {
            name: 'Bundled',
            value: 'bundled',
            description: 'Use a world that ships with this package — zero setup required',
          },
          {
            name: 'Custom Directory',
            value: 'customDir',
            description: 'Scan a folder of your own worlds and pick one from a dropdown',
          },
          {
            name: 'File Path',
            value: 'filePath',
            description: 'Load from a .nv-world.zip file or directory on disk',
          },
          {
            name: 'Base64',
            value: 'base64',
            description: 'Load from a base64-encoded .nv-world.zip (from another node or API)',
          },
        ],
        default: 'bundled',
        description: 'How to load the governance world file.',
      },
      {
        displayName: 'Bundled World',
        name: 'bundledWorld',
        type: 'options' as const,
        options: getBundledWorldChoices(),
        default: getBundledWorldChoices()[0]?.value ?? '',
        description: 'Select a governance world included with this package.',
        displayOptions: {
          show: {
            worldSource: ['bundled'],
          },
        },
      },
      {
        displayName: 'Custom Worlds Directory',
        name: 'customWorldsDir',
        type: 'string' as const,
        default: '',
        required: true,
        placeholder: '/data/my-worlds',
        description:
          'Path to a folder containing your world directories. Each subfolder is treated as a world.',
        displayOptions: {
          show: {
            worldSource: ['customDir'],
          },
        },
      },
      {
        displayName: 'Custom World',
        name: 'customWorld',
        type: 'options' as const,
        typeOptions: {
          loadOptionsMethod: 'getCustomWorldChoices',
          loadOptionsDependsOn: ['customWorldsDir'],
        },
        default: '',
        description: 'Select a world from your custom directory. Set the directory path above first, then click the refresh button.',
        displayOptions: {
          show: {
            worldSource: ['customDir'],
          },
        },
      },
      {
        displayName: 'World File Path',
        name: 'worldFilePath',
        type: 'string' as const,
        default: '',
        required: true,
        placeholder: '/data/policy.nv-world.zip',
        description:
          'Path to a .nv-world.zip file or extracted world directory. Build your world file free at neuroverseos.com.',
        displayOptions: {
          show: {
            worldSource: ['filePath'],
          },
        },
      },
      {
        displayName: 'World File (Base64)',
        name: 'worldFileBase64',
        type: 'string' as const,
        default: '',
        required: true,
        placeholder: 'UEsDBBQAAAAI...',
        description:
          'Base64-encoded .nv-world.zip content. Useful in Docker/cloud where file paths are unavailable.',
        displayOptions: {
          show: {
            worldSource: ['base64'],
          },
        },
      },
      // ─── Guard Event ──────────────────────────────────────────────
      {
        displayName: 'Intent',
        name: 'intent',
        type: 'string' as const,
        default: '',
        required: true,
        placeholder: 'Delete user account',
        description: 'What the agent is trying to do — a plain-language description of the action.',
      },
      {
        displayName: 'Tool',
        name: 'tool',
        type: 'string' as const,
        default: '',
        required: false,
        placeholder: 'admin-api',
        description: 'Which tool or API the agent is calling (optional but improves guard precision).',
      },
      {
        displayName: 'Enforcement Level',
        name: 'level',
        type: 'options' as const,
        options: [
          { name: 'Basic', value: 'basic', description: 'Permissive — only block clear violations' },
          { name: 'Standard', value: 'standard', description: 'Balanced — block violations, pause ambiguous' },
          { name: 'Strict', value: 'strict', description: 'Conservative — block or pause anything uncertain' },
        ],
        default: 'standard',
        description: 'How strictly to enforce governance rules.',
      },
      // ─── AI Intent Classification ─────────────────────────────────
      {
        displayName: 'AI Intent Classification',
        name: 'aiClassification',
        type: 'boolean' as const,
        default: false,
        description:
          'Use an AI model to classify the true intent before guard evaluation. Prevents false positives when raw text (emails, documents) contains trigger words that do not reflect the agent\'s actual action.',
      },
      {
        displayName: 'AI Provider',
        name: 'aiProvider',
        type: 'options' as const,
        options: [
          { name: 'OpenAI', value: 'openai' },
          { name: 'Anthropic', value: 'anthropic' },
          { name: 'Ollama (Local)', value: 'ollama' },
        ],
        default: 'openai',
        description: 'Which AI provider to use for intent classification.',
        displayOptions: { show: { aiClassification: [true] } },
      },
      {
        displayName: 'AI Model',
        name: 'aiModel',
        type: 'string' as const,
        default: 'gpt-4.1-mini',
        placeholder: 'gpt-4.1-mini',
        description: 'Model ID for intent classification. Use a fast, cheap model — this is a single short classification call.',
        displayOptions: { show: { aiClassification: [true] } },
      },
      {
        displayName: 'AI API Key',
        name: 'aiApiKey',
        type: 'string' as const,
        typeOptions: { password: true },
        default: '',
        description: 'API key for the AI provider. Not required for Ollama.',
        displayOptions: { show: { aiClassification: [true] } },
      },
      {
        displayName: 'AI Endpoint (Override)',
        name: 'aiEndpoint',
        type: 'string' as const,
        default: '',
        placeholder: 'http://localhost:11434',
        description: 'Custom API endpoint. Required for Ollama, optional for OpenAI/Anthropic.',
        displayOptions: { show: { aiClassification: [true] } },
      },
      // ─── Strict Enforcement (Fix 2) ───────────────────────────────
      {
        displayName: 'Strict Enforcement',
        name: 'strictEnforcement',
        type: 'boolean' as const,
        default: false,
        description:
          'When enabled, BLOCK verdicts throw a node error and stop the workflow entirely. Prevents downstream nodes from ignoring governance decisions.',
      },
      // ─── AI Narrative ──────────────────────────────────────────
      {
        displayName: 'AI Narrative',
        name: 'aiNarrative',
        type: 'boolean' as const,
        default: false,
        description:
          'Use an AI model to explain the guard decision in plain language. The AI reads the world\'s purpose, guard descriptions, and the verdict to produce a narrative a business person can act on.',
      },
      {
        displayName: 'Narrative AI Provider',
        name: 'narrativeAiProvider',
        type: 'options' as const,
        options: [
          { name: 'OpenAI', value: 'openai' },
          { name: 'Anthropic', value: 'anthropic' },
          { name: 'Ollama (Local)', value: 'ollama' },
        ],
        default: 'openai',
        description: 'Which AI provider to use for narrative generation.',
        displayOptions: { show: { aiNarrative: [true] } },
      },
      {
        displayName: 'Narrative AI Model',
        name: 'narrativeAiModel',
        type: 'string' as const,
        default: 'gpt-4.1-mini',
        placeholder: 'gpt-4.1-mini',
        description: 'Model ID. A fast, cheap model works well — this is a single interpretation call.',
        displayOptions: { show: { aiNarrative: [true] } },
      },
      {
        displayName: 'Narrative AI API Key',
        name: 'narrativeAiApiKey',
        type: 'string' as const,
        typeOptions: { password: true },
        default: '',
        description: 'API key for narrative AI. Not required for Ollama. Uses the same key as AI Classification if left empty.',
        displayOptions: { show: { aiNarrative: [true] } },
      },
      {
        displayName: 'Narrative AI Endpoint (Override)',
        name: 'narrativeAiEndpoint',
        type: 'string' as const,
        default: '',
        placeholder: 'http://localhost:11434',
        description: 'Custom API endpoint for narrative AI. Required for Ollama.',
        displayOptions: { show: { aiNarrative: [true] } },
      },
      // ─── Additional Fields ────────────────────────────────────────
      {
        displayName: 'Additional Fields',
        name: 'additionalFields',
        type: 'collection' as const,
        placeholder: 'Add Field',
        default: {},
        options: [
          {
            displayName: 'Irreversible',
            name: 'irreversible',
            type: 'boolean' as const,
            default: false,
            description: 'Whether this action is irreversible (deletes, sends, publishes).',
          },
          {
            displayName: 'Role',
            name: 'role',
            type: 'string' as const,
            default: '',
            description: 'The role of the agent performing the action.',
          },
          {
            displayName: 'Arguments (JSON)',
            name: 'args',
            type: 'string' as const,
            default: '',
            placeholder: '{"userId": "123"}',
            description: 'Tool arguments as a JSON object string.',
          },
        ],
      },
    ],
  };

  methods = {
    loadOptions: {
      async getCustomWorldChoices(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const customDir = this.getNodeParameter('customWorldsDir', '') as string;
        if (!customDir) {
          return [{ name: '(Set directory path above first)', value: '' }];
        }
        const worlds = scanDirectoryForWorlds(customDir);
        if (worlds.length === 0) {
          return [{ name: '(No worlds found in directory)', value: '' }];
        }
        return worlds;
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();

    const allowItems: INodeExecutionData[] = [];
    const blockItems: INodeExecutionData[] = [];
    const pauseItems: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const worldSource = this.getNodeParameter('worldSource', i) as string;
      const intent = this.getNodeParameter('intent', i) as string;
      const tool = this.getNodeParameter('tool', i) as string;
      const level = this.getNodeParameter('level', i) as string;
      const aiClassification = this.getNodeParameter('aiClassification', i, false) as boolean;
      const strictEnforcement = this.getNodeParameter('strictEnforcement', i, false) as boolean;
      const additionalFields = this.getNodeParameter('additionalFields', i) as {
        irreversible?: boolean;
        role?: string;
        args?: string;
      };

      // ─── Load world ─────────────────────────────────────────────
      let cacheKey: string;

      if (worldSource === 'bundled') {
        const worldName = this.getNodeParameter('bundledWorld', i) as string;
        cacheKey = `bundled:${worldName}`;
        const worldDir = join(BUNDLED_WORLDS_DIR, worldName);
        const currentMtime = getDirectoryMtime(worldDir);
        const cached = worldCache.get(cacheKey);

        if (!cached || cached.mtime < currentMtime) {
          const world = await loadWorld(worldDir);
          worldCache.set(cacheKey, { world, mtime: currentMtime });
        }
      } else if (worldSource === 'customDir') {
        const customDir = this.getNodeParameter('customWorldsDir', i) as string;
        const worldName = this.getNodeParameter('customWorld', i) as string;
        const worldDir = join(customDir, worldName);
        cacheKey = `custom:${worldDir}`;
        const currentMtime = getDirectoryMtime(worldDir);
        const cached = worldCache.get(cacheKey);

        if (!cached || cached.mtime < currentMtime) {
          const world = await loadWorld(worldDir);
          worldCache.set(cacheKey, { world, mtime: currentMtime });
        }
      } else if (worldSource === 'base64') {
        const base64 = this.getNodeParameter('worldFileBase64', i) as string;
        cacheKey = `base64:${base64.substring(0, 64)}:${base64.length}`;

        if (!worldCache.has(cacheKey)) {
          const tmp = mkdtempSync(join(tmpdir(), 'nv-guard-'));
          const tmpZip = join(tmp, 'world.nv-world.zip');
          writeFileSync(tmpZip, Buffer.from(base64, 'base64'));
          const world = await loadWorld(tmpZip);
          worldCache.set(cacheKey, { world, mtime: Date.now() });
        }
      } else {
        cacheKey = this.getNodeParameter('worldFilePath', i) as string;
        const currentMtime = getDirectoryMtime(cacheKey);
        const cached = worldCache.get(cacheKey);

        if (!cached || cached.mtime < currentMtime) {
          const world = await loadWorld(cacheKey);
          worldCache.set(cacheKey, { world, mtime: currentMtime });
        }
      }

      const world = worldCache.get(cacheKey)!.world;

      // ─── Parse args ───────────────────────────────────────────────
      let parsedArgs: Record<string, unknown> | undefined = undefined;
      if (additionalFields.args) {
        try {
          parsedArgs = JSON.parse(additionalFields.args);
        } catch {
          parsedArgs = { raw: additionalFields.args };
        }
      }

      // ─── Merge input data into args for content field extraction ─
      const inputJson = items[i].json as Record<string, unknown>;
      const mergedArgs: Record<string, unknown> = { ...parsedArgs };
      for (const [key, value] of Object.entries(inputJson)) {
        if (typeof value === 'string' && value.length > 0 && value.length < 10000) {
          if (!(key in mergedArgs)) {
            mergedArgs[key] = value;
          }
        }
      }

      // ─── Fix 3: Normalize field names before extraction ─────────
      const normalizedArgs = normalizeFieldNames(mergedArgs);

      // ─── Fix 1: Detect unknown tool surfaces ───────────────────
      const knownSurfaces = getKnownToolSurfaces(world);
      const toolIsKnown = !tool || knownSurfaces.has(tool.toLowerCase());

      // ─── Build guard event ──────────────────────────────────────
      const event: Record<string, unknown> = { intent };
      if (tool) event.tool = tool;
      if (additionalFields.irreversible) event.irreversible = true;
      if (additionalFields.role) event.roleId = additionalFields.role;
      if (Object.keys(normalizedArgs).length > 0) event.args = normalizedArgs;

      // ─── Evaluate ───────────────────────────────────────────────
      let verdict: GuardVerdict;
      let intentSource: string = 'raw';
      let classification: unknown = undefined;
      let originalIntent: string | undefined = undefined;
      let contentScanOverride = false;
      let contentScanGuardId: string | undefined = undefined;

      if (aiClassification) {
        const aiProvider = this.getNodeParameter('aiProvider', i) as string;
        const aiModel = this.getNodeParameter('aiModel', i) as string;
        const aiApiKey = this.getNodeParameter('aiApiKey', i, '') as string;
        const aiEndpoint = this.getNodeParameter('aiEndpoint', i, '') as string;

        const contentFields = extractContentFields(intent, normalizedArgs);

        const aiVerdict = await evaluateGuardWithAI(
          event as any,
          world,
          {
            level: level as 'basic' | 'standard' | 'strict',
            ai: {
              provider: aiProvider,
              model: aiModel,
              apiKey: aiApiKey,
              endpoint: aiEndpoint || null,
            },
            contentFields,
            fallbackOnError: true,
          },
        );

        verdict = aiVerdict;
        intentSource = aiVerdict.intent_source;
        classification = aiVerdict.classification;
        originalIntent = aiVerdict.originalIntent;
      } else {
        // Use extractContentFields to separate clean intent from content.
        const contentFields = extractContentFields(intent, normalizedArgs);

        // extractContentFields may put the intent into customer_input and leave
        // raw empty.  Extract the clean action label: take everything before the
        // first colon or newline (e.g. "Send general reply: Dear Customer..."
        // becomes "Send general reply").  If that's still long, truncate to the
        // first sentence.
        let cleanIntent = contentFields.raw || intent;
        if (cleanIntent.length > 80) {
          const colonIdx = cleanIntent.indexOf(':');
          const nlIdx = cleanIntent.indexOf('\n');
          const cutIdx = colonIdx > 0 && colonIdx < 120 ? colonIdx
            : nlIdx > 0 && nlIdx < 120 ? nlIdx
            : 80;
          cleanIntent = cleanIntent.substring(0, cutIdx).trim();
        }

        // If the cleaned intent matches a known safe vocabulary pattern from the
        // world, use the vocabulary KEY as the intent (e.g. "Send general reply"
        // → "reply_to_inquiry").  The engine's pattern matching can over-trigger
        // on action verbs like "send"/"share" when they appear in raw text —
        // vocabulary keys are what guards are designed to evaluate.
        cleanIntent = resolveToVocabularyKey(cleanIntent, world);
        event.intent = cleanIntent;

        // Pack content into payload for safety scanning (not intent matching).
        const contentParts: string[] = [];
        if (contentFields.customer_input) contentParts.push(contentFields.customer_input);
        if (contentFields.draft_reply) contentParts.push(contentFields.draft_reply);
        if (contentFields.context) contentParts.push(contentFields.context);
        if (contentParts.length > 0) {
          event.payload = contentParts.join('\n').substring(0, 20000);
        }

        verdict = evaluateGuard(event as any, world, { level, trace: true } as any);
      }

      // ─── Fix 1: Re-evaluate with known surfaces if tool is unknown ──
      // The guard engine skips guards with appliesTo when the event's tool
      // doesn't match (including when tool is absent).  If the provided tool
      // isn't recognized, re-evaluate with each known tool surface and take
      // the strictest verdict.  Fail closed, not open.
      if (!toolIsKnown) {
        for (const surface of knownSurfaces) {
          const probeEvent = { ...event, tool: surface };
          const probeVerdict = evaluateGuard(probeEvent as any, world, { level, trace: true } as any);
          verdict = takeStrictestVerdict(verdict, probeVerdict);
          if (verdict.status === 'BLOCK') break; // can't get stricter
        }
      }

      // ─── Fix 4: Content safety scan ─────────────────────────────
      // Even if the intent is clean (ALLOW), scan the actual content
      // (draft replies, email bodies) against immutable guard patterns.
      // An agent with intent "customer_reply" (ALLOW) could still put
      // "Your password is hunter2" in the reply body.
      if (verdict.status !== 'BLOCK') {
        const contentFields = extractContentFields(intent, normalizedArgs);
        const contentToScan = [
          contentFields.draft_reply,
          contentFields.customer_input,
          typeof event.payload === 'string' ? event.payload : '',
        ].filter(Boolean).join('\n');

        const contentResult = scanContentAgainstImmutableGuards(contentToScan, world);
        if (contentResult.violated) {
          contentScanOverride = true;
          contentScanGuardId = contentResult.guardId;
          verdict = {
            status: 'BLOCK',
            reason: contentResult.reason ?? 'Content violates immutable guard policy.',
            ruleId: contentResult.guardId ?? 'content-scan',
            evidence: verdict.evidence,
          } as GuardVerdict;
        }
      }

      // ─── Build output ───────────────────────────────────────────
      const evidence = verdict.evidence as any;
      const trace = (verdict as any).trace as any;

      // Build insights from evidence (always present) + trace (when available)
      const insights: Record<string, unknown> = {
        worldId: evidence?.worldId ?? null,
        worldName: evidence?.worldName ?? null,
        enforcementLevel: evidence?.enforcementLevel ?? level,
        evaluatedAt: evidence?.evaluatedAt ? new Date(evidence.evaluatedAt).toISOString() : null,
        invariantCoverage: {
          satisfied: evidence?.invariantsSatisfied ?? null,
          total: evidence?.invariantsTotal ?? null,
        },
        guardsMatched: evidence?.guardsMatched ?? [],
        rulesMatched: evidence?.rulesMatched ?? [],
      };

      // Rich trace data — every check the engine performed
      if (trace) {
        insights.durationMs = trace.durationMs ?? null;

        if (trace.guardChecks?.length) {
          insights.guardChecks = trace.guardChecks.map((gc: any) => ({
            guardId: gc.guardId ?? gc.id,
            label: gc.label,
            matched: gc.matched ?? gc.triggered,
            enforcement: gc.enforcement,
            matchedPatterns: gc.matchedPatterns ?? [],
          }));
        }

        if (trace.invariantChecks?.length) {
          insights.invariantChecks = trace.invariantChecks.map((ic: any) => ({
            invariantId: ic.invariantId ?? ic.id,
            label: ic.label,
            satisfied: ic.satisfied,
          }));
        }

        if (trace.kernelRuleChecks?.length) {
          insights.kernelRuleChecks = trace.kernelRuleChecks.map((kr: any) => ({
            ruleId: kr.ruleId ?? kr.id,
            label: kr.label,
            triggered: kr.triggered,
          }));
        }

        if (trace.safetyChecks?.length) {
          insights.safetyChecks = trace.safetyChecks;
        }

        if (trace.precedenceResolution) {
          insights.precedenceResolution = trace.precedenceResolution;
        }
      }

      // Intent classification info
      insights.intent = {
        resolved: (event.intent as string).substring(0, 500),
        source: intentSource,
        ...(originalIntent ? { original: originalIntent } : {}),
        ...(classification ? { classification } : {}),
      };

      if (contentScanOverride) {
        insights.contentScanOverride = {
          triggered: true,
          guardId: contentScanGuardId,
        };
      }

      // Warning from the engine (e.g. ALLOW with advisory)
      if ((verdict as any).warning) {
        insights.warning = (verdict as any).warning;
      }

      // Intent record (what agent wanted vs. what happened)
      if ((verdict as any).intentRecord) {
        insights.intentRecord = (verdict as any).intentRecord;
      }

      // ─── Narrative ──────────────────────────────────────────────
      const worldCtx = extractWorldContext(world);
      const aiNarrative = this.getNodeParameter('aiNarrative', i, false) as boolean;
      let narrativeSource: 'ai' | 'fallback' = 'fallback';

      if (aiNarrative) {
        // Use narrative-specific AI config, falling back to classification AI config
        const nProvider = this.getNodeParameter('narrativeAiProvider', i, 'openai') as string;
        const nModel = this.getNodeParameter('narrativeAiModel', i, 'gpt-4.1-mini') as string;
        const nApiKey = this.getNodeParameter('narrativeAiApiKey', i, '') as string
          || (aiClassification ? this.getNodeParameter('aiApiKey', i, '') as string : '');
        const nEndpoint = this.getNodeParameter('narrativeAiEndpoint', i, '') as string;

        const narrativePrompt = buildGuardNarrativePrompt(
          worldCtx, verdict, event.intent as string, tool, trace, evidence, contentScanOverride, toolIsKnown,
        );

        try {
          insights.narrative = await callAIForNarrative(narrativePrompt, nProvider, nModel, nApiKey, nEndpoint);
          narrativeSource = 'ai';
        } catch (err: any) {
          insights.narrative = buildFallbackGuardNarrative(
            worldCtx, verdict, event.intent as string, tool, trace, evidence, contentScanOverride, toolIsKnown, intentSource,
          );
          (insights.narrative as string[]).push(`(AI narrative unavailable: ${err.message?.substring(0, 100) ?? 'unknown error'})`);
        }
      } else {
        insights.narrative = buildFallbackGuardNarrative(
          worldCtx, verdict, event.intent as string, tool, trace, evidence, contentScanOverride, toolIsKnown, intentSource,
        );
      }
      insights.narrativeSource = narrativeSource;
      insights.worldDescription = worldCtx.description || null;
      insights.thesis = worldCtx.thesis || null;

      // ─── Behavioral Analysis ──────────────────────────────────
      // Track what the agent intended vs. what governance forced.
      // This is the core value: "when agents couldn't do X, 40% did Y instead"
      const executedAction = verdict.status === 'ALLOW'
        ? intent
        : verdict.status === 'BLOCK'
          ? `blocked (${verdict.reason?.substring(0, 80) ?? 'policy violation'})`
          : `paused for review (${verdict.reason?.substring(0, 80) ?? 'requires approval'})`;

      const adaptation: Adaptation = adaptationFromVerdict(
        'agent', // agentId — n8n doesn't track multi-agent, but downstream nodes can
        intent,
        executedAction,
        verdict,
      );

      // Detect patterns (single-event gives limited patterns, but it builds over a batch)
      const adaptations = [adaptation];
      const patterns = detectBehavioralPatterns(adaptations, 1);
      const behavioralNarrative = patterns.length > 0
        ? generateAdaptationNarrative(patterns)
        : null;

      insights.behavioral = {
        adaptation: {
          intended: adaptation.intendedAction,
          executed: adaptation.executedAction,
          shiftType: adaptation.shiftType,
          verdict: adaptation.verdict,
        },
        ...(behavioralNarrative ? { behavioralNarrative } : {}),
      };

      const outputItem: INodeExecutionData = {
        json: {
          ...items[i].json,
          verdict: {
            status: verdict.status,
            reason: verdict.reason ?? null,
            ruleId: verdict.ruleId ?? null,
          },
          insights,
        },
      };

      // ─── Fix 2: Strict enforcement — throw on BLOCK ────────────
      if (strictEnforcement && verdict.status === 'BLOCK') {
        throw new Error(
          `[NeuroVerse Guard] BLOCKED: ${verdict.reason ?? 'Policy violation'} (rule: ${verdict.ruleId ?? 'unknown'})`,
        );
      }

      // ─── Route to output ────────────────────────────────────────
      if (verdict.status === 'BLOCK') {
        blockItems.push(outputItem);
      } else if (verdict.status === 'PAUSE') {
        pauseItems.push(outputItem);
      } else {
        allowItems.push(outputItem);
      }
    }

    return [allowItems, blockItems, pauseItems];
  }
}
