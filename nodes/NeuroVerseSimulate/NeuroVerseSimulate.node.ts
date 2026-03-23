import {
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  NodeConnectionTypes,
} from 'n8n-workflow';

import { loadWorld, simulateWorld } from '@neuroverseos/governance';
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
