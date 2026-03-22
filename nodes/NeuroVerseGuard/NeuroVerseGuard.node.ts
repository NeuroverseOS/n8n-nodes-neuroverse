import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeConnectionTypes,
} from 'n8n-workflow';

import {
  loadWorld,
  evaluateGuard,
  evaluateGuardWithAI,
  extractContentFields,
} from '@neuroverseos/governance';
import type { GuardVerdict } from '@neuroverseos/governance';
import { writeFileSync, mkdtempSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
        default: 'filePath',
        description: 'How to load the governance world file.',
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
      const additionalFields = this.getNodeParameter('additionalFields', i) as {
        irreversible?: boolean;
        role?: string;
        args?: string;
      };

      // ─── Load world ─────────────────────────────────────────────
      let cacheKey: string;

      if (worldSource === 'base64') {
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

      // ─── Build guard event ──────────────────────────────────────
      const event: Record<string, unknown> = { intent };
      if (tool) event.tool = tool;
      if (additionalFields.irreversible) event.irreversible = true;
      if (additionalFields.role) event.roleId = additionalFields.role;
      if (Object.keys(mergedArgs).length > 0) event.args = mergedArgs;

      // ─── Evaluate ───────────────────────────────────────────────
      let verdict: GuardVerdict;
      let intentSource: string = 'raw';
      let classification: unknown = undefined;
      let originalIntent: string | undefined = undefined;

      if (aiClassification) {
        // Use the governance package's evaluateGuardWithAI which:
        //   1. Extracts content fields from event.args (separates who said what)
        //   2. Classifies true intent via LLM
        //   3. Runs evaluateGuard with the clean classified intent
        //   4. Falls back to raw intent on AI failure
        const aiProvider = this.getNodeParameter('aiProvider', i) as string;
        const aiModel = this.getNodeParameter('aiModel', i) as string;
        const aiApiKey = this.getNodeParameter('aiApiKey', i, '') as string;
        const aiEndpoint = this.getNodeParameter('aiEndpoint', i, '') as string;

        // Pre-extract content fields from the merged args so the classifier
        // can distinguish customer input from AI output
        const contentFields = extractContentFields(intent, mergedArgs);

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
        // Legacy path: enrich intent with all text content for regex matching
        let enrichedIntent = intent;

        if (parsedArgs) {
          const argsText = Object.values(parsedArgs)
            .filter((v) => typeof v === 'string')
            .join(' ');
          if (argsText) {
            enrichedIntent = `${intent} ${argsText}`;
          }
        }

        for (const [, value] of Object.entries(inputJson)) {
          if (typeof value === 'string' && value.length > 0 && value.length < 10000) {
            const sample = value.substring(0, 50);
            if (!enrichedIntent.includes(sample)) {
              enrichedIntent = `${enrichedIntent} ${value}`;
            }
          }
        }

        event.intent = enrichedIntent;
        verdict = evaluateGuard(event as any, world, { level } as any);
      }

      const outputItem: INodeExecutionData = {
        json: {
          ...items[i].json,
          verdict: {
            status: verdict.status,
            reason: verdict.reason ?? null,
            ruleId: verdict.ruleId ?? null,
            evidence: verdict.evidence ?? null,
          },
          _debug: {
            intent: (event.intent as string).substring(0, 500),
            intentSource,
            ...(classification ? {
              classification,
              originalIntent,
            } : {}),
            stringFieldsScanned: Object.keys(inputJson).filter(
              (k: string) => typeof inputJson[k] === 'string',
            ),
          },
        },
      };

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
