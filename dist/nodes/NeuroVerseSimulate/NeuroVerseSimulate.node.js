"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NeuroVerseSimulate = void 0;
const n8n_workflow_1 = require("n8n-workflow");
const governance_1 = require("@neuroverseos/governance");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const worldCache = new Map();
function getDirectoryMtime(dirPath) {
    try {
        let latest = (0, fs_1.statSync)(dirPath).mtimeMs;
        for (const file of ['rules.json', 'state.json', 'gates.json', 'world.json', 'assumptions.json']) {
            try {
                const mt = (0, fs_1.statSync)((0, path_1.join)(dirPath, file)).mtimeMs;
                if (mt > latest)
                    latest = mt;
            }
            catch { /* file may not exist */ }
        }
        return latest;
    }
    catch {
        return 0;
    }
}
function viabilityToOutput(status) {
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
class NeuroVerseSimulate {
    description = {
        displayName: 'NeuroVerse Simulate',
        name: 'neuroVerseSimulate',
        icon: 'file:neuroverse.svg',
        group: ['transform'],
        version: 1,
        subtitle: 'Steps: {{$parameter["steps"]}} · Profile: {{$parameter["profile"]}}',
        description: 'Simulate state evolution against a NeuroVerse governance world. Routes to HEALTHY, DEGRADED, or CRITICAL based on viability after N steps.',
        defaults: {
            name: 'NeuroVerse Simulate',
        },
        inputs: [n8n_workflow_1.NodeConnectionTypes.Main],
        outputs: [n8n_workflow_1.NodeConnectionTypes.Main, n8n_workflow_1.NodeConnectionTypes.Main, n8n_workflow_1.NodeConnectionTypes.Main],
        outputNames: ['HEALTHY', 'DEGRADED', 'CRITICAL'],
        properties: [
            // ─── World Source ─────────────────────────────────────────────
            {
                displayName: 'World Source',
                name: 'worldSource',
                type: 'options',
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
                type: 'string',
                default: '',
                required: true,
                placeholder: '/data/policy.nv-world.zip',
                description: 'Path to a .nv-world.zip file or extracted world directory.',
                displayOptions: {
                    show: {
                        worldSource: ['filePath'],
                    },
                },
            },
            {
                displayName: 'World File (Base64)',
                name: 'worldFileBase64',
                type: 'string',
                default: '',
                required: true,
                placeholder: 'UEsDBBQAAAAI...',
                description: 'Base64-encoded .nv-world.zip content.',
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
                type: 'number',
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
                type: 'string',
                default: '',
                placeholder: 'worst_case',
                description: 'Assumption profile to use (e.g. best_case, worst_case, regulatory_scrutiny). Leave empty for world default.',
            },
            {
                displayName: 'State Overrides (JSON)',
                name: 'stateOverrides',
                type: 'string',
                default: '',
                placeholder: '{"trust_score": 40, "misinfo_level": 60}',
                description: 'Override starting state variables with a JSON object. Values from upstream nodes can be injected here using expressions.',
            },
            // ─── Strict Mode ────────────────────────────────────────────
            {
                displayName: 'Halt on Collapse',
                name: 'haltOnCollapse',
                type: 'boolean',
                default: false,
                description: 'When enabled, a MODEL_COLLAPSES result throws a node error and stops the workflow entirely.',
            },
        ],
    };
    async execute() {
        const items = this.getInputData();
        const healthyItems = [];
        const degradedItems = [];
        const criticalItems = [];
        for (let i = 0; i < items.length; i++) {
            const worldSource = this.getNodeParameter('worldSource', i);
            const steps = this.getNodeParameter('steps', i);
            const profile = this.getNodeParameter('profile', i, '');
            const stateOverridesRaw = this.getNodeParameter('stateOverrides', i, '');
            const haltOnCollapse = this.getNodeParameter('haltOnCollapse', i, false);
            // ─── Load world ─────────────────────────────────────────────
            let cacheKey;
            if (worldSource === 'base64') {
                const base64 = this.getNodeParameter('worldFileBase64', i);
                cacheKey = `base64:${base64.substring(0, 64)}:${base64.length}`;
                if (!worldCache.has(cacheKey)) {
                    const tmp = (0, fs_1.mkdtempSync)((0, path_1.join)((0, os_1.tmpdir)(), 'nv-sim-'));
                    const tmpZip = (0, path_1.join)(tmp, 'world.nv-world.zip');
                    (0, fs_1.writeFileSync)(tmpZip, Buffer.from(base64, 'base64'));
                    const world = await (0, governance_1.loadWorld)(tmpZip);
                    worldCache.set(cacheKey, { world, mtime: Date.now() });
                }
            }
            else {
                cacheKey = this.getNodeParameter('worldFilePath', i);
                const currentMtime = getDirectoryMtime(cacheKey);
                const cached = worldCache.get(cacheKey);
                if (!cached || cached.mtime < currentMtime) {
                    const world = await (0, governance_1.loadWorld)(cacheKey);
                    worldCache.set(cacheKey, { world, mtime: currentMtime });
                }
            }
            const world = worldCache.get(cacheKey).world;
            // ─── Parse state overrides ──────────────────────────────────
            let stateOverrides;
            if (stateOverridesRaw) {
                try {
                    stateOverrides = JSON.parse(stateOverridesRaw);
                }
                catch {
                    throw new Error(`[NeuroVerse Simulate] Invalid JSON in State Overrides: ${stateOverridesRaw}`);
                }
            }
            // ─── Run simulation ─────────────────────────────────────────
            const options = { steps };
            if (profile)
                options.profile = profile;
            if (stateOverrides)
                options.stateOverrides = stateOverrides;
            const result = (0, governance_1.simulateWorld)(world, options);
            // ─── Build output ───────────────────────────────────────────
            const outputItem = {
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
                            viability: step.viability,
                            collapsed: step.collapsed,
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
                },
            };
            // ─── Halt on collapse ──────────────────────────────────────
            if (haltOnCollapse && result.collapsed) {
                throw new Error(`[NeuroVerse Simulate] MODEL_COLLAPSES at step ${result.collapseStep} (rule: ${result.collapseRule ?? 'unknown'}). Viability: ${result.finalViability}`);
            }
            // ─── Route to output ──────────────────────────────────────
            const outputIndex = viabilityToOutput(result.finalViability);
            if (outputIndex === 0) {
                healthyItems.push(outputItem);
            }
            else if (outputIndex === 1) {
                degradedItems.push(outputItem);
            }
            else {
                criticalItems.push(outputItem);
            }
        }
        return [healthyItems, degradedItems, criticalItems];
    }
}
exports.NeuroVerseSimulate = NeuroVerseSimulate;
//# sourceMappingURL=NeuroVerseSimulate.node.js.map