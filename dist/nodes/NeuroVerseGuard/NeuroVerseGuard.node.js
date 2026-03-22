"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NeuroVerseGuard = void 0;
const n8n_workflow_1 = require("n8n-workflow");
const governance_1 = require("@neuroverseos/governance");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const worldCache = new Map();
function getDirectoryMtime(dirPath) {
    try {
        // Check the directory's own mtime (changes when files are added/removed)
        let latest = (0, fs_1.statSync)(dirPath).mtimeMs;
        // Also check guards.json specifically since it's the most commonly edited
        try {
            const guardsMtime = (0, fs_1.statSync)((0, path_1.join)(dirPath, 'guards.json')).mtimeMs;
            if (guardsMtime > latest)
                latest = guardsMtime;
        }
        catch { /* file may not exist */ }
        try {
            const worldMtime = (0, fs_1.statSync)((0, path_1.join)(dirPath, 'world.json')).mtimeMs;
            if (worldMtime > latest)
                latest = worldMtime;
        }
        catch { /* file may not exist */ }
        try {
            const invariantsMtime = (0, fs_1.statSync)((0, path_1.join)(dirPath, 'invariants.json')).mtimeMs;
            if (invariantsMtime > latest)
                latest = invariantsMtime;
        }
        catch { /* file may not exist */ }
        try {
            const kernelMtime = (0, fs_1.statSync)((0, path_1.join)(dirPath, 'kernel.json')).mtimeMs;
            if (kernelMtime > latest)
                latest = kernelMtime;
        }
        catch { /* file may not exist */ }
        return latest;
    }
    catch {
        return 0;
    }
}
class NeuroVerseGuard {
    description = {
        displayName: 'NeuroVerse Guard',
        name: 'neuroVerseGuard',
        icon: 'file:neuroverse.svg',
        group: ['transform'],
        version: 1,
        subtitle: '={{$parameter["intent"]}}',
        description: 'Evaluate an AI agent action against a NeuroVerse governance world. Routes to ALLOW, BLOCK, or PAUSE. Deterministic, sub-millisecond, no LLM calls.',
        defaults: {
            name: 'NeuroVerse Guard',
        },
        inputs: [n8n_workflow_1.NodeConnectionTypes.Main],
        outputs: [n8n_workflow_1.NodeConnectionTypes.Main, n8n_workflow_1.NodeConnectionTypes.Main, n8n_workflow_1.NodeConnectionTypes.Main],
        outputNames: ['ALLOW', 'BLOCK', 'PAUSE'],
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
                description: 'Path to a .nv-world.zip file or extracted world directory. Build your world file free at neuroverseos.com.',
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
                description: 'Base64-encoded .nv-world.zip content. Useful in Docker/cloud where file paths are unavailable.',
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
                type: 'string',
                default: '',
                required: true,
                placeholder: 'Delete user account',
                description: 'What the agent is trying to do — a plain-language description of the action.',
            },
            {
                displayName: 'Tool',
                name: 'tool',
                type: 'string',
                default: '',
                required: false,
                placeholder: 'admin-api',
                description: 'Which tool or API the agent is calling (optional but improves guard precision).',
            },
            {
                displayName: 'Enforcement Level',
                name: 'level',
                type: 'options',
                options: [
                    { name: 'Basic', value: 'basic', description: 'Permissive — only block clear violations' },
                    { name: 'Standard', value: 'standard', description: 'Balanced — block violations, pause ambiguous' },
                    { name: 'Strict', value: 'strict', description: 'Conservative — block or pause anything uncertain' },
                ],
                default: 'standard',
                description: 'How strictly to enforce governance rules.',
            },
            {
                displayName: 'Additional Fields',
                name: 'additionalFields',
                type: 'collection',
                placeholder: 'Add Field',
                default: {},
                options: [
                    {
                        displayName: 'Irreversible',
                        name: 'irreversible',
                        type: 'boolean',
                        default: false,
                        description: 'Whether this action is irreversible (deletes, sends, publishes).',
                    },
                    {
                        displayName: 'Role',
                        name: 'role',
                        type: 'string',
                        default: '',
                        description: 'The role of the agent performing the action.',
                    },
                    {
                        displayName: 'Arguments (JSON)',
                        name: 'args',
                        type: 'string',
                        default: '',
                        placeholder: '{"userId": "123"}',
                        description: 'Tool arguments as a JSON object string.',
                    },
                ],
            },
        ],
    };
    async execute() {
        const items = this.getInputData();
        const allowItems = [];
        const blockItems = [];
        const pauseItems = [];
        for (let i = 0; i < items.length; i++) {
            const worldSource = this.getNodeParameter('worldSource', i);
            const intent = this.getNodeParameter('intent', i);
            const tool = this.getNodeParameter('tool', i);
            const level = this.getNodeParameter('level', i);
            const additionalFields = this.getNodeParameter('additionalFields', i);
            // ─── Load world ─────────────────────────────────────────────
            let cacheKey;
            if (worldSource === 'base64') {
                const base64 = this.getNodeParameter('worldFileBase64', i);
                cacheKey = `base64:${base64.substring(0, 64)}:${base64.length}`;
                if (!worldCache.has(cacheKey)) {
                    // Write to temp file then load (supports both current and future governance versions)
                    const tmp = (0, fs_1.mkdtempSync)((0, path_1.join)((0, os_1.tmpdir)(), 'nv-guard-'));
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
            // ─── Build guard event ──────────────────────────────────────
            // The governance engine matches patterns against intent + tool + scope.
            // To ensure guards also catch violations in args/content (e.g. refund
            // language in a draft_reply), we enrich the intent with content from
            // both the args parameter AND the input item's JSON data.
            let enrichedIntent = intent;
            let parsedArgs = undefined;
            if (additionalFields.args) {
                try {
                    parsedArgs = JSON.parse(additionalFields.args);
                }
                catch {
                    parsedArgs = additionalFields.args;
                }
                // Extract text content from args for pattern scanning
                const argsText = typeof parsedArgs === 'string'
                    ? parsedArgs
                    : typeof parsedArgs === 'object' && parsedArgs !== null
                        ? Object.values(parsedArgs)
                            .filter((v) => typeof v === 'string')
                            .join(' ')
                        : '';
                if (argsText) {
                    enrichedIntent = `${intent} ${argsText}`;
                }
            }
            // Also scan known content fields from the input data directly.
            // This ensures guard patterns catch violations even if the args
            // parameter doesn't resolve correctly at runtime (n8n collection quirk).
            const contentFields = ['draft_reply', 'content', 'body', 'message', 'text', 'reply'];
            const inputJson = items[i].json;
            for (const field of contentFields) {
                const value = inputJson[field];
                if (typeof value === 'string' && value.length > 0 && !enrichedIntent.includes(value.substring(0, 50))) {
                    enrichedIntent = `${enrichedIntent} ${value}`;
                }
            }
            const event = { intent: enrichedIntent };
            if (tool)
                event.tool = tool;
            if (additionalFields.irreversible)
                event.irreversible = true;
            if (additionalFields.role)
                event.role = additionalFields.role;
            if (parsedArgs !== undefined)
                event.args = parsedArgs;
            // ─── Evaluate ───────────────────────────────────────────────
            const verdict = (0, governance_1.evaluateGuard)(event, world, { level });
            const outputItem = {
                json: {
                    ...items[i].json,
                    verdict: {
                        status: verdict.status,
                        reason: verdict.reason ?? null,
                        ruleId: verdict.ruleId ?? null,
                        evidence: verdict.evidence ?? null,
                    },
                },
            };
            // ─── Route to output ────────────────────────────────────────
            if (verdict.status === 'BLOCK') {
                blockItems.push(outputItem);
            }
            else if (verdict.status === 'PAUSE') {
                pauseItems.push(outputItem);
            }
            else {
                allowItems.push(outputItem);
            }
        }
        return [allowItems, blockItems, pauseItems];
    }
}
exports.NeuroVerseGuard = NeuroVerseGuard;
//# sourceMappingURL=NeuroVerseGuard.node.js.map