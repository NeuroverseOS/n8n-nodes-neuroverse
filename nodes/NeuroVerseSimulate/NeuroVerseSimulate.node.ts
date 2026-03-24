import {
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  NodeConnectionTypes,
} from 'n8n-workflow';

import { loadWorld, simulateWorld, renderSimulateText, explainWorld, renderExplainText } from '@neuroverseos/governance';
import type { SimulationResult } from '@neuroverseos/governance';
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

// ─── World Cache (shared pattern with Guard node) ────────────────────────────

interface CachedWorld {
  world: Awaited<ReturnType<typeof loadWorld>>;
  mtime: number;
}
const worldCache = new Map<string, CachedWorld>();

function getDirectoryMtime(dirPath: string): number {
  try {
    let latest = statSync(dirPath).mtimeMs;
    for (const file of ['rules.json', 'state.json', 'gates.json', 'world.json', 'assumptions.json']) {
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

// ─── Viability routing ───────────────────────────────────────────────────────

type ViabilityStatus = 'THRIVING' | 'STABLE' | 'COMPRESSED' | 'CRITICAL' | 'MODEL_COLLAPSES';

function viabilityToOutput(status: ViabilityStatus): 0 | 1 | 2 {
  switch (status) {
    case 'THRIVING':
    case 'STABLE':
      return 0; // HEALTHY
    case 'COMPRESSED':
      return 1; // DEGRADED
    case 'CRITICAL':
    case 'MODEL_COLLAPSES':
      return 2; // CRITICAL
    default:
      return 0;
  }
}

// ─── Narrative Generation ────────────────────────────────────────────────────

/** Extract human-readable context from the loaded world object */
function extractWorldContext(world: any): {
  name: string;
  description: string;
  thesis: string;
  stateLabels: Record<string, { label: string; description: string; display_as?: string }>;
  ruleCausalTranslations: Record<string, {
    label: string;
    description: string;
    trigger_text: string;
    rule_text: string;
    shift_text: string;
    effect_text: string;
  }>;
} {
  const worldJson = world?.world ?? world ?? {};
  const stateJson = world?.state ?? {};
  const rulesArr: any[] = world?.rules ?? [];

  const stateLabels: Record<string, { label: string; description: string; display_as?: string }> = {};
  const vars = stateJson?.variables ?? stateJson;
  for (const [key, val] of Object.entries(vars)) {
    const v = val as any;
    if (v?.label) {
      stateLabels[key] = {
        label: v.label,
        description: v.description ?? '',
        display_as: v.display_as,
      };
    }
  }

  const ruleCausalTranslations: Record<string, any> = {};
  for (const rule of rulesArr) {
    if (rule?.causal_translation) {
      ruleCausalTranslations[rule.id] = {
        label: rule.label ?? rule.id,
        description: rule.description ?? '',
        ...rule.causal_translation,
      };
    }
  }

  return {
    name: worldJson.name ?? worldJson.world_id ?? 'Unknown',
    description: worldJson.description ?? '',
    thesis: worldJson.thesis ?? '',
    stateLabels,
    ruleCausalTranslations,
  };
}

/** Build the prompt sent to the AI for narrative interpretation */
function buildNarrativePrompt(
  worldCtx: ReturnType<typeof extractWorldContext>,
  result: SimulationResult,
  stateDeltas: Record<string, { from: unknown; to: unknown }>,
  allRules: Map<string, { ruleId: string; label: string; triggeredSteps: number[]; excludedSteps: number[] }>,
  profile: string,
): string {
  const totalSteps = result.steps.length;

  // State changes with human labels
  const stateChangeSummary = Object.entries(stateDeltas)
    .map(([key, d]) => {
      const meta = worldCtx.stateLabels[key];
      const label = meta?.label ?? key.replace(/_/g, ' ');
      const unit = meta?.display_as === 'percentage' ? '%' : '';
      return `- ${label}: ${d.from}${unit} → ${d.to}${unit}`;
    })
    .join('\n');

  // Rules that fired, with their causal translations
  const firedRules = [...allRules.values()].filter((r) => r.triggeredSteps.length > 0);
  const ruleNarratives = firedRules
    .sort((a, b) => a.triggeredSteps[0] - b.triggeredSteps[0])
    .map((r) => {
      const ct = worldCtx.ruleCausalTranslations[r.ruleId];
      if (ct) {
        return `- "${ct.label}" (steps ${r.triggeredSteps.join(', ')}): ${ct.rule_text} → ${ct.shift_text}`;
      }
      return `- "${r.label}" (steps ${r.triggeredSteps.join(', ')})`;
    })
    .join('\n');

  // Collapse info
  const collapseSection = result.collapsed
    ? `\nCOLLAPSE: The model collapsed at step ${result.collapseStep}. Rule: ${result.collapseRule ?? 'unknown'}. ${worldCtx.ruleCausalTranslations[result.collapseRule ?? '']?.shift_text ?? ''}`
    : `\nOUTCOME: The system ended at ${result.finalViability} after ${totalSteps} steps. No collapse.`;

  return `You are interpreting the results of a governance simulation for a business user who needs to understand what happened and what it means.

## The World Being Tested
Name: ${worldCtx.name}
Description: ${worldCtx.description}
${worldCtx.thesis ? `\nThesis being tested: ${worldCtx.thesis}` : ''}
Profile: ${profile || 'default'}

## What Happened (${totalSteps} steps)
Viability path: ${result.steps.map((s) => s.viability).join(' → ')}
${collapseSection}

## State Changes
${stateChangeSummary || '(no changes)'}

## Rules That Fired (in order)
${ruleNarratives || '(no rules fired)'}

## Your Task
Write a clear, direct narrative (4-8 sentences) that explains:
1. What was being tested and why it matters
2. What happened — in cause-and-effect terms a business person understands
3. The cascade: how one thing led to another
4. The bottom line: was the thesis proven? What should the reader take away?

Use the world's own language (the thesis, the causal translations). Do NOT use technical terms like "rule fired" or "step 3" — translate into meaning. Write as if explaining to a VP who needs to make a decision based on this.

Respond with ONLY the narrative paragraphs. No headers, no bullet points, no JSON.`;
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
    // OpenAI (default)
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

/** Fallback: build a basic narrative without AI, using world context */
function buildFallbackNarrative(
  worldCtx: ReturnType<typeof extractWorldContext>,
  result: SimulationResult,
  stateDeltas: Record<string, { from: unknown; to: unknown }>,
  allRules: Map<string, { ruleId: string; label: string; triggeredSteps: number[]; excludedSteps: number[] }>,
): string[] {
  const lines: string[] = [];
  const totalSteps = result.steps.length;
  const firedRules = [...allRules.values()].filter((r) => r.triggeredSteps.length > 0);

  // Opening — what was tested
  if (worldCtx.thesis) {
    lines.push(`This simulation tested the thesis: ${worldCtx.thesis}`);
  } else if (worldCtx.description) {
    lines.push(`${worldCtx.name}: ${worldCtx.description}`);
  }

  // Outcome
  if (result.collapsed) {
    const collapseCtx = worldCtx.ruleCausalTranslations[result.collapseRule ?? ''];
    lines.push(
      `After ${totalSteps} step${totalSteps > 1 ? 's' : ''}, the model collapsed.${collapseCtx ? ` ${collapseCtx.shift_text}` : ''}`,
    );
  } else {
    lines.push(
      `After ${totalSteps} step${totalSteps > 1 ? 's' : ''}, the system ended at ${result.finalViability}.`,
    );
  }

  // State changes with human labels
  const numericDeltas = Object.entries(stateDeltas)
    .filter(([, d]) => typeof d.from === 'number' && typeof d.to === 'number')
    .map(([key, d]) => ({
      key,
      label: worldCtx.stateLabels[key]?.label ?? key.replace(/_/g, ' '),
      unit: worldCtx.stateLabels[key]?.display_as === 'percentage' ? '%' : '',
      from: d.from as number,
      to: d.to as number,
      delta: (d.to as number) - (d.from as number),
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  if (numericDeltas.length > 0) {
    const top = numericDeltas.slice(0, 4);
    const descriptions = top.map((d) => {
      const direction = d.delta > 0 ? 'rose' : 'fell';
      return `${d.label} ${direction} from ${d.from}${d.unit} to ${d.to}${d.unit}`;
    });
    lines.push(descriptions.join('. ') + '.');
  }

  // Causal chain — use causal translations
  const sortedFired = [...firedRules].sort((a, b) => a.triggeredSteps[0] - b.triggeredSteps[0]);
  for (const rule of sortedFired.slice(0, 4)) {
    const ct = worldCtx.ruleCausalTranslations[rule.ruleId];
    if (ct?.rule_text && ct?.shift_text) {
      lines.push(`${ct.rule_text}. ${ct.shift_text}.`);
    }
  }

  // Bottom line
  if (result.collapsed && worldCtx.thesis) {
    lines.push('The thesis was confirmed — the system reached irreversible collapse under these conditions.');
  } else if (!result.collapsed && result.finalViability === 'STABLE') {
    lines.push('Under these conditions, the system remained viable.');
  }

  return lines;
}

// ─── Node ────────────────────────────────────────────────────────────────────

export class NeuroVerseSimulate implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'NeuroVerse Simulate',
    name: 'neuroVerseSimulate',
    icon: 'file:neuroverse.svg',
    group: ['transform'],
    version: 1,
    subtitle: 'Steps: {{$parameter["steps"]}} · Profile: {{$parameter["profile"]}}',
    description:
      'Simulate state evolution against a NeuroVerse governance world. Routes to HEALTHY, DEGRADED, or CRITICAL based on viability after N steps.',
    defaults: {
      name: 'NeuroVerse Simulate',
    },
    inputs: [NodeConnectionTypes.Main] as any,
    outputs: [NodeConnectionTypes.Main, NodeConnectionTypes.Main, NodeConnectionTypes.Main] as any,
    outputNames: ['HEALTHY', 'DEGRADED', 'CRITICAL'],
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
          'Path to a .nv-world.zip file or extracted world directory.',
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
          'Base64-encoded .nv-world.zip content.',
        displayOptions: {
          show: {
            worldSource: ['base64'],
          },
        },
      },
      // ─── Simulation Parameters ──────────────────────────────────
      {
        displayName: 'Steps',
        name: 'steps',
        type: 'number' as const,
        default: 1,
        typeOptions: {
          minValue: 1,
          maxValue: 100,
        },
        description: 'Number of simulation rounds. 1 = immediate impact, 5+ = cascading effects.',
      },
      {
        displayName: 'Profile',
        name: 'profile',
        type: 'string' as const,
        default: '',
        placeholder: 'worst_case',
        description: 'Assumption profile to use (e.g. best_case, worst_case, regulatory_scrutiny). Leave empty for world default.',
      },
      {
        displayName: 'State Overrides (JSON)',
        name: 'stateOverrides',
        type: 'string' as const,
        default: '',
        placeholder: '{"trust_score": 40, "misinfo_level": 60}',
        description: 'Override starting state variables with a JSON object. Values from upstream nodes can be injected here using expressions.',
      },
      // ─── Strict Mode ────────────────────────────────────────────
      {
        displayName: 'Halt on Collapse',
        name: 'haltOnCollapse',
        type: 'boolean' as const,
        default: false,
        description: 'When enabled, a MODEL_COLLAPSES result throws a node error and stops the workflow entirely.',
      },
      // ─── AI Narrative ──────────────────────────────────────────
      {
        displayName: 'AI Narrative',
        name: 'aiNarrative',
        type: 'boolean' as const,
        default: false,
        description:
          'Use an AI model to interpret simulation results in plain language. The AI reads the world\'s thesis, causal logic, and state changes to produce a narrative a business person can act on.',
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
        description: 'Which AI provider to use for narrative generation.',
        displayOptions: { show: { aiNarrative: [true] } },
      },
      {
        displayName: 'AI Model',
        name: 'aiModel',
        type: 'string' as const,
        default: 'gpt-4.1-mini',
        placeholder: 'gpt-4.1-mini',
        description: 'Model ID. A fast, cheap model works well — this is a single interpretation call.',
        displayOptions: { show: { aiNarrative: [true] } },
      },
      {
        displayName: 'AI API Key',
        name: 'aiApiKey',
        type: 'string' as const,
        typeOptions: { password: true },
        default: '',
        description: 'API key for the AI provider. Not required for Ollama.',
        displayOptions: { show: { aiNarrative: [true] } },
      },
      {
        displayName: 'AI Endpoint (Override)',
        name: 'aiEndpoint',
        type: 'string' as const,
        default: '',
        placeholder: 'http://localhost:11434',
        description: 'Custom API endpoint. Required for Ollama, optional for OpenAI/Anthropic.',
        displayOptions: { show: { aiNarrative: [true] } },
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

    const healthyItems: INodeExecutionData[] = [];
    const degradedItems: INodeExecutionData[] = [];
    const criticalItems: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const worldSource = this.getNodeParameter('worldSource', i) as string;
      const steps = this.getNodeParameter('steps', i) as number;
      const profile = this.getNodeParameter('profile', i, '') as string;
      const stateOverridesRaw = this.getNodeParameter('stateOverrides', i, '') as string;
      const haltOnCollapse = this.getNodeParameter('haltOnCollapse', i, false) as boolean;
      const aiNarrative = this.getNodeParameter('aiNarrative', i, false) as boolean;

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
          const tmp = mkdtempSync(join(tmpdir(), 'nv-sim-'));
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

      // ─── Parse state overrides ──────────────────────────────────
      let stateOverrides: Record<string, string | number | boolean> | undefined;
      if (stateOverridesRaw) {
        try {
          stateOverrides = JSON.parse(stateOverridesRaw);
        } catch {
          throw new Error(
            `[NeuroVerse Simulate] Invalid JSON in State Overrides: ${stateOverridesRaw}`,
          );
        }
      }

      // ─── Run simulation ─────────────────────────────────────────
      const options: Record<string, unknown> = { steps };
      if (profile) options.profile = profile;
      if (stateOverrides) options.stateOverrides = stateOverrides;

      const result: SimulationResult = simulateWorld(world as any, options as any);

      // ─── Build output ───────────────────────────────────────────

      // Collect all unique rules evaluated across all steps
      const allRulesEvaluated = new Map<string, { ruleId: string; label: string; triggeredSteps: number[]; excludedSteps: number[] }>();
      for (const step of result.steps) {
        for (const r of step.rulesEvaluated) {
          const existing = allRulesEvaluated.get(r.ruleId);
          if (!existing) {
            allRulesEvaluated.set(r.ruleId, {
              ruleId: r.ruleId,
              label: r.label,
              triggeredSteps: r.triggered ? [step.step] : [],
              excludedSteps: r.excluded ? [step.step] : [],
            });
          } else {
            if (r.triggered) existing.triggeredSteps.push(step.step);
            if (r.excluded) existing.excludedSteps.push(step.step);
          }
        }
      }

      // Compute state deltas — which variables changed and by how much
      const stateDeltas: Record<string, { from: unknown; to: unknown }> = {};
      for (const [key, finalVal] of Object.entries(result.finalState)) {
        const initialVal = result.initialState[key];
        if (initialVal !== finalVal) {
          stateDeltas[key] = { from: initialVal, to: finalVal };
        }
      }

      // ─── Extract world context for narrative + output ────────
      const worldCtx = extractWorldContext(world);

      // ─── Generate narrative ────────────────────────────────────
      // Layer 1: Native governance package narrative (always present)
      const nativeNarrative = renderSimulateText(result);

      // Layer 2: World-context enriched narrative (always present)
      const contextNarrative = buildFallbackNarrative(worldCtx, result, stateDeltas, allRulesEvaluated);

      // Layer 3: AI interpretation (optional, premium)
      let aiInterpretation: string | null = null;
      let narrativeSource: 'native' | 'ai' = 'native';

      if (aiNarrative) {
        const aiProvider = this.getNodeParameter('aiProvider', i) as string;
        const aiModel = this.getNodeParameter('aiModel', i) as string;
        const aiApiKey = this.getNodeParameter('aiApiKey', i, '') as string;
        const aiEndpoint = this.getNodeParameter('aiEndpoint', i, '') as string;

        const prompt = buildNarrativePrompt(worldCtx, result, stateDeltas, allRulesEvaluated, profile);

        try {
          aiInterpretation = await callAIForNarrative(prompt, aiProvider, aiModel, aiApiKey, aiEndpoint);
          narrativeSource = 'ai';
        } catch (err: any) {
          aiInterpretation = `(AI narrative unavailable: ${err.message?.substring(0, 100) ?? 'unknown error'})`;
        }
      }

      const outputItem: INodeExecutionData = {
        json: {
          ...items[i].json,
          simulation: {
            worldId: result.worldId,
            worldName: result.worldName,
            profile: result.profile,
            steps: result.steps.length,
            finalViability: result.finalViability,
            collapsed: result.collapsed,
            ...(result.collapsed ? {
              collapseStep: result.collapseStep,
              collapseRule: result.collapseRule,
            } : {}),
            initialState: result.initialState,
            finalState: result.finalState,
            stepDetails: result.steps.map((step) => ({
              step: step.step,
              rulesFired: step.rulesFired,
              rulesChecked: step.rulesEvaluated.length,
              viability: step.viability,
              collapsed: step.collapsed,
              stateAfter: step.stateAfter,
              rulesTriggered: step.rulesEvaluated
                .filter((r) => r.triggered)
                .map((r) => ({
                  ruleId: r.ruleId,
                  label: r.label,
                  effects: r.effects.map((e) => ({
                    target: e.target,
                    operation: e.operation,
                    before: e.before,
                    after: e.after,
                  })),
                })),
            })),
          },
          insights: {
            narrative: aiInterpretation ?? contextNarrative,
            nativeNarrative,
            contextNarrative,
            ...(aiInterpretation ? { aiInterpretation } : {}),
            narrativeSource,
            thesis: worldCtx.thesis || null,
            worldDescription: worldCtx.description || null,
            stateDeltas,
            totalRulesEvaluated: allRulesEvaluated.size,
            totalRulesFired: [...allRulesEvaluated.values()].filter((r) => r.triggeredSteps.length > 0).length,
            rulesNeverTriggered: [...allRulesEvaluated.values()]
              .filter((r) => r.triggeredSteps.length === 0)
              .map((r) => ({ ruleId: r.ruleId, label: r.label })),
            rulesSummary: [...allRulesEvaluated.values()].map((r) => ({
              ruleId: r.ruleId,
              label: r.label,
              triggeredSteps: r.triggeredSteps,
              excluded: r.excludedSteps.length > 0,
            })),
          },
        },
      };

      // ─── Halt on collapse ──────────────────────────────────────
      if (haltOnCollapse && result.collapsed) {
        throw new Error(
          `[NeuroVerse Simulate] MODEL_COLLAPSES at step ${result.collapseStep} (rule: ${result.collapseRule ?? 'unknown'}). Viability: ${result.finalViability}`,
        );
      }

      // ─── Route to output ──────────────────────────────────────
      const outputIndex = viabilityToOutput(result.finalViability as ViabilityStatus);
      if (outputIndex === 0) {
        healthyItems.push(outputItem);
      } else if (outputIndex === 1) {
        degradedItems.push(outputItem);
      } else {
        criticalItems.push(outputItem);
      }
    }

    return [healthyItems, degradedItems, criticalItems];
  }
}
