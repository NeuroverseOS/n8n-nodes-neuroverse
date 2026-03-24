import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeConnectionTypes,
} from 'n8n-workflow';

// ─── Types ──────────────────────────────────────────────────────────────────

interface StateDelta {
  from: number | string | boolean;
  to: number | string | boolean;
  change?: number;
}

interface ProfileData {
  worldName: string;
  profile: string;
  viable: boolean;
  viability: string;
  collapsed: boolean;
  report: string;
  narrative: string;
  stateDeltas: Record<string, StateDelta>;
  simulation: Record<string, unknown>;
}

type Decision = 'APPROVE' | 'APPROVE_WITH_GUARDRAILS' | 'REVIEW' | 'BLOCK';

// ─── Node ───────────────────────────────────────────────────────────────────

export class NeuroVerseCompare implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'NeuroVerse Compare',
    name: 'neuroVerseCompare',
    icon: 'file:neuroverse.svg',
    group: ['transform'],
    version: 1,
    subtitle: '{{$parameter["decisionLabel"] || "Compare Profiles"}}',
    description:
      'Compare multiple simulation profiles side-by-side and make a governance decision. Connect to Simulate node outputs. Routes to APPROVE, REVIEW, or BLOCK.',
    defaults: {
      name: 'NeuroVerse Compare',
    },
    inputs: [NodeConnectionTypes.Main] as any,
    outputs: [NodeConnectionTypes.Main, NodeConnectionTypes.Main, NodeConnectionTypes.Main] as any,
    outputNames: ['APPROVE', 'REVIEW', 'BLOCK'],
    properties: [
      {
        displayName: 'Decision Label',
        name: 'decisionLabel',
        type: 'string' as const,
        default: '',
        placeholder: 'e.g. "Enable auto-refunds" or "Deploy v2.0"',
        description: 'Human-readable label for what this decision is about. Appears in the report header.',
      },
      {
        displayName: 'Collapse Tolerance',
        name: 'collapseTolerance',
        type: 'options' as const,
        default: 'none',
        description: 'How many profiles can collapse before the decision becomes BLOCK?',
        options: [
          { name: 'None — any collapse blocks', value: 'none' },
          { name: 'Edge cases only — block if expected/baseline collapses', value: 'edge' },
          { name: 'Majority — block only if most profiles collapse', value: 'majority' },
        ],
      },
      {
        displayName: 'Require All Viable',
        name: 'requireAllViable',
        type: 'boolean' as const,
        default: false,
        description: 'If true, ALL profiles must be viable (THRIVING or STABLE) to APPROVE. Otherwise, only the expected/baseline profile needs to be viable.',
      },
      {
        displayName: 'Include Step Details in Output',
        name: 'includeStepDetails',
        type: 'boolean' as const,
        default: false,
        description: 'Include the full step-by-step simulation data in the output. Useful for debugging, but makes the output much larger.',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();

    const decisionLabel = this.getNodeParameter('decisionLabel', 0, '') as string;
    const collapseTolerance = this.getNodeParameter('collapseTolerance', 0, 'none') as string;
    const requireAllViable = this.getNodeParameter('requireAllViable', 0, false) as boolean;
    const includeStepDetails = this.getNodeParameter('includeStepDetails', 0, false) as boolean;

    // ─── Collect profiles from input items ───────────────────────
    const profiles: Record<string, ProfileData> = {};

    for (let i = 0; i < items.length; i++) {
      const json = items[i].json as Record<string, unknown>;
      const profileName = (json.profile as string) || `profile_${i}`;

      profiles[profileName] = {
        worldName: (json.worldName as string) || 'Unknown',
        profile: profileName,
        viable: json.viable as boolean ?? false,
        viability: (json.viability as string) || 'UNKNOWN',
        collapsed: json.collapsed as boolean ?? false,
        report: (json.report as string) || '',
        narrative: (json.narrative as string) || '',
        stateDeltas: (json.stateDeltas as Record<string, StateDelta>) || {},
        simulation: (json.simulation as Record<string, unknown>) || {},
      };
    }

    const profileNames = Object.keys(profiles);
    const profileList = Object.values(profiles);
    const worldName = profileList[0]?.worldName || 'Unknown';

    if (profileList.length === 0) {
      throw new Error('[NeuroVerse Compare] No simulation profiles received. Connect this node to Simulate node outputs.');
    }

    // ─── Decision logic ──────────────────────────────────────────

    const allViable = profileList.every((p) => p.viable);
    const anyCollapsed = profileList.some((p) => p.collapsed);
    const collapsedCount = profileList.filter((p) => p.collapsed).length;
    const anyCritical = profileList.some(
      (p) => p.viability === 'CRITICAL' || p.viability === 'MODEL_COLLAPSES',
    );

    // Find the "expected" or "baseline" profile (the middle ground)
    const expectedProfile =
      profiles['expected'] || profiles['baseline'] || profiles['default'] ||
      profileList[Math.floor(profileList.length / 2)];
    const expectedOk = expectedProfile?.viable ?? false;

    // Collapse tolerance check
    let collapseBlocks = false;
    if (anyCollapsed) {
      if (collapseTolerance === 'none') {
        collapseBlocks = true;
      } else if (collapseTolerance === 'edge') {
        // Block if expected/baseline collapsed
        collapseBlocks = expectedProfile?.collapsed ?? false;
      } else if (collapseTolerance === 'majority') {
        collapseBlocks = collapsedCount > profileList.length / 2;
      }
    }

    let decision: Decision;
    let recommendation: string;

    if (collapseBlocks || anyCritical) {
      decision = 'BLOCK';
      recommendation = anyCollapsed
        ? `System collapses under ${collapsedCount} of ${profileList.length} scenarios. Do not proceed without changes.`
        : 'System reaches CRITICAL under realistic conditions. Do not proceed without changes.';
    } else if (requireAllViable ? allViable : expectedOk) {
      if (allViable) {
        decision = 'APPROVE';
        recommendation = `All ${profileNames.length} scenarios remain healthy. Safe to proceed.`;
      } else {
        decision = 'APPROVE_WITH_GUARDRAILS';
        recommendation = 'Expected case is stable, but edge cases show degradation. Proceed with monitoring.';
      }
    } else {
      decision = 'REVIEW';
      recommendation = 'Mixed results across profiles. Requires human review before proceeding.';
    }

    // ─── Build comparison report ─────────────────────────────────

    const lines: string[] = [];
    const header = decisionLabel
      ? `${decisionLabel.toUpperCase()} — ${worldName}`
      : worldName;

    lines.push(`===== COMPARISON: ${header} =====`);
    lines.push(`Profiles: ${profileNames.join(', ')}`);
    lines.push(`Decision: ${decision}`);
    lines.push('');

    for (const [name, profile] of Object.entries(profiles)) {
      const label = name.replace(/_/g, ' ').toUpperCase();
      const collapsed = profile.collapsed ? ' [COLLAPSED]' : '';
      lines.push(`--- ${label}: ${profile.viability}${collapsed} ---`);

      if (profile.report) {
        lines.push(profile.report);
      }

      const deltaEntries = Object.entries(profile.stateDeltas);
      if (deltaEntries.length > 0) {
        lines.push('  State changes:');
        for (const [key, delta] of deltaEntries) {
          if (delta && delta.from !== undefined) {
            const from = typeof delta.from === 'number' ? Math.round(delta.from * 100) / 100 : delta.from;
            const to = typeof delta.to === 'number' ? Math.round(delta.to * 100) / 100 : delta.to;
            lines.push(`    ${key}: ${from} → ${to}`);
          }
        }
      }
      lines.push('');
    }

    lines.push(`--- RECOMMENDATION ---`);
    lines.push(recommendation);

    const report = lines.join('\n');

    // ─── Build output ────────────────────────────────────────────

    const profileSummaries = Object.fromEntries(
      Object.entries(profiles).map(([name, p]) => [
        name,
        {
          viable: p.viable,
          viability: p.viability,
          collapsed: p.collapsed,
          stateDeltas: p.stateDeltas,
          narrative: p.narrative,
          ...(includeStepDetails ? { simulation: p.simulation } : {}),
        },
      ]),
    );

    const outputItem: INodeExecutionData = {
      json: {
        // ── Top-level (wire into downstream nodes) ──
        decision,
        recommendation,
        report,
        worldName,
        allViable,
        anyCollapsed,
        profileCount: profileList.length,

        // ── Per-profile detail ──
        profiles: profileSummaries,
      },
    };

    // ─── Route to output ─────────────────────────────────────────
    // Output 0: APPROVE (includes APPROVE_WITH_GUARDRAILS)
    // Output 1: REVIEW
    // Output 2: BLOCK

    const approveItems: INodeExecutionData[] = [];
    const reviewItems: INodeExecutionData[] = [];
    const blockItems: INodeExecutionData[] = [];

    if (decision === 'APPROVE' || decision === 'APPROVE_WITH_GUARDRAILS') {
      approveItems.push(outputItem);
    } else if (decision === 'REVIEW') {
      reviewItems.push(outputItem);
    } else {
      blockItems.push(outputItem);
    }

    return [approveItems, reviewItems, blockItems];
  }
}
