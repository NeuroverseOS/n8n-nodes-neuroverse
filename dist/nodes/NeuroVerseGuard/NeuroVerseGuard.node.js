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
        let latest = (0, fs_1.statSync)(dirPath).mtimeMs;
        for (const file of ['guards.json', 'world.json', 'invariants.json', 'kernel.json']) {
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
// ─── Node ─────────────────────────────────────────────────────────────────────
class NeuroVerseGuard {
    description = {
        displayName: 'NeuroVerse Guard',
        name: 'neuroVerseGuard',
        icon: 'file:neuroverse.svg',
        group: ['transform'],
        version: 1,
        subtitle: '={{$parameter["intent"]}}',
        description: 'Evaluate an AI agent action against a NeuroVerse governance world. Routes to ALLOW, BLOCK, or PAUSE.',
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
            // ─── AI Intent Classification ─────────────────────────────────
            {
                displayName: 'AI Intent Classification',
                name: 'aiClassification',
                type: 'boolean',
                default: false,
                description: 'Use an AI model to classify the true intent before guard evaluation. Prevents false positives when raw text (emails, documents) contains trigger words that do not reflect the agent\'s actual action.',
            },
            {
                displayName: 'AI Provider',
                name: 'aiProvider',
                type: 'options',
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
                type: 'string',
                default: 'gpt-4.1-mini',
                placeholder: 'gpt-4.1-mini',
                description: 'Model ID for intent classification. Use a fast, cheap model — this is a single short classification call.',
                displayOptions: { show: { aiClassification: [true] } },
            },
            {
                displayName: 'AI API Key',
                name: 'aiApiKey',
                type: 'string',
                typeOptions: { password: true },
                default: '',
                description: 'API key for the AI provider. Not required for Ollama.',
                displayOptions: { show: { aiClassification: [true] } },
            },
            {
                displayName: 'AI Endpoint (Override)',
                name: 'aiEndpoint',
                type: 'string',
                default: '',
                placeholder: 'http://localhost:11434',
                description: 'Custom API endpoint. Required for Ollama, optional for OpenAI/Anthropic.',
                displayOptions: { show: { aiClassification: [true] } },
            },
            // ─── Additional Fields ────────────────────────────────────────
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
            const aiClassification = this.getNodeParameter('aiClassification', i, false);
            const additionalFields = this.getNodeParameter('additionalFields', i);
            // ─── Load world ─────────────────────────────────────────────
            let cacheKey;
            if (worldSource === 'base64') {
                const base64 = this.getNodeParameter('worldFileBase64', i);
                cacheKey = `base64:${base64.substring(0, 64)}:${base64.length}`;
                if (!worldCache.has(cacheKey)) {
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
            // ─── Parse args ───────────────────────────────────────────────
            let parsedArgs = undefined;
            if (additionalFields.args) {
                try {
                    parsedArgs = JSON.parse(additionalFields.args);
                }
                catch {
                    parsedArgs = { raw: additionalFields.args };
                }
            }
            // ─── Merge input data into args for content field extraction ─
            const inputJson = items[i].json;
            const mergedArgs = { ...parsedArgs };
            for (const [key, value] of Object.entries(inputJson)) {
                if (typeof value === 'string' && value.length > 0 && value.length < 10000) {
                    if (!(key in mergedArgs)) {
                        mergedArgs[key] = value;
                    }
                }
            }
            // ─── Build guard event ──────────────────────────────────────
            const event = { intent };
            if (tool)
                event.tool = tool;
            if (additionalFields.irreversible)
                event.irreversible = true;
            if (additionalFields.role)
                event.roleId = additionalFields.role;
            if (Object.keys(mergedArgs).length > 0)
                event.args = mergedArgs;
            // ─── Evaluate ───────────────────────────────────────────────
            let verdict;
            let intentSource = 'raw';
            let classification = undefined;
            let originalIntent = undefined;
            if (aiClassification) {
                // Use the governance package's evaluateGuardWithAI which:
                //   1. Extracts content fields from event.args (separates who said what)
                //   2. Classifies true intent via LLM
                //   3. Runs evaluateGuard with the clean classified intent
                //   4. Falls back to raw intent on AI failure
                const aiProvider = this.getNodeParameter('aiProvider', i);
                const aiModel = this.getNodeParameter('aiModel', i);
                const aiApiKey = this.getNodeParameter('aiApiKey', i, '');
                const aiEndpoint = this.getNodeParameter('aiEndpoint', i, '');
                // Pre-extract content fields from the merged args so the classifier
                // can distinguish customer input from AI output
                const contentFields = (0, governance_1.extractContentFields)(intent, mergedArgs);
                const aiVerdict = await (0, governance_1.evaluateGuardWithAI)(event, world, {
                    level: level,
                    ai: {
                        provider: aiProvider,
                        model: aiModel,
                        apiKey: aiApiKey,
                        endpoint: aiEndpoint || null,
                    },
                    contentFields,
                    fallbackOnError: true,
                });
                verdict = aiVerdict;
                intentSource = aiVerdict.intent_source;
                classification = aiVerdict.classification;
                originalIntent = aiVerdict.originalIntent;
            }
            else {
                // Use extractContentFields to separate the clean intent from content.
                // Content (draft replies, email bodies, etc.) goes into a payload field
                // for safety scanning, but does NOT pollute the intent that guards
                // pattern-match against. This prevents false positives like "refund"
                // mentioned in a reply body triggering a refund-block guard.
                const contentFields = (0, governance_1.extractContentFields)(intent, mergedArgs);
                // The clean intent is whatever extractContentFields determines is the
                // actual action — stripped of content that belongs to args/payload.
                event.intent = contentFields.raw || intent;
                // Pack all content text into payload so safety checks (prompt injection,
                // scope escape) still scan the full text — only intent-pattern matching
                // uses the clean label.
                const contentParts = [];
                if (contentFields.customer_input)
                    contentParts.push(contentFields.customer_input);
                if (contentFields.draft_reply)
                    contentParts.push(contentFields.draft_reply);
                if (contentFields.context)
                    contentParts.push(contentFields.context);
                if (contentParts.length > 0) {
                    event.payload = contentParts.join('\n').substring(0, 20000);
                }
                verdict = (0, governance_1.evaluateGuard)(event, world, { level });
            }
            const outputItem = {
                json: {
                    ...items[i].json,
                    verdict: {
                        status: verdict.status,
                        reason: verdict.reason ?? null,
                        ruleId: verdict.ruleId ?? null,
                        evidence: verdict.evidence ?? null,
                    },
                    _debug: {
                        intent: event.intent.substring(0, 500),
                        intentSource,
                        ...(classification ? {
                            classification,
                            originalIntent,
                        } : {}),
                        stringFieldsScanned: Object.keys(inputJson).filter((k) => typeof inputJson[k] === 'string'),
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