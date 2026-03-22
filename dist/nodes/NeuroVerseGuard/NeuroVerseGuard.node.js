"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NeuroVerseGuard = void 0;
const n8n_workflow_1 = require("n8n-workflow");
const governance_1 = require("@neuroverseos/governance");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
async function callAIProvider(systemPrompt, userPrompt, config) {
    const { provider, model, apiKey, endpoint } = config;
    if (provider === 'anthropic') {
        const url = endpoint || 'https://api.anthropic.com/v1/messages';
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model,
                system: systemPrompt,
                messages: [{ role: 'user', content: userPrompt }],
                max_tokens: 60,
                temperature: 0,
            }),
        });
        if (!res.ok) {
            throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
        }
        const data = (await res.json());
        return data.content[0]?.text ?? '';
    }
    if (provider === 'ollama') {
        const url = endpoint || 'http://localhost:11434';
        const res = await fetch(`${url}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                stream: false,
            }),
        });
        if (!res.ok) {
            throw new Error(`Ollama API ${res.status}: ${await res.text()}`);
        }
        const data = (await res.json());
        return data.message?.content ?? '';
    }
    // Default: OpenAI-compatible
    const url = endpoint || 'https://api.openai.com/v1/chat/completions';
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            max_tokens: 60,
            temperature: 0,
        }),
    });
    if (!res.ok) {
        throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json());
    return data.choices[0]?.message?.content ?? '';
}
/**
 * Classify the true intent of an action using an LLM.
 *
 * The classifier distinguishes between what the agent is DOING (the intent)
 * and what the content being processed SAYS.  For example, an agent replying
 * to a customer who mentioned "refund" has the intent "customer_reply", not
 * "refund_request".
 */
async function classifyIntentWithAI(rawIntent, tool, inputData, world, config) {
    // Extract guard labels from the world to give the classifier context
    const guards = [];
    try {
        const worldGuards = world?.guards?.guards ??
            world?.guards ??
            [];
        for (const g of worldGuards) {
            if (g && g.id) {
                guards.push({ id: g.id, label: g.label ?? g.id, description: g.description ?? '' });
            }
        }
    }
    catch { /* world may not expose guards */ }
    const vocabularyLines = guards.length > 0
        ? guards.map((g) => `- ${g.id}: ${g.label} — ${g.description}`).join('\n')
        : '(no guard vocabulary available)';
    const systemPrompt = `You are an intent classifier for a governance system.
Given an action's context, determine the TRUE intent — what the agent is DOING,
not what the text content mentions.

Critical distinction:
- Agent REPLYING to a customer who asked about a refund → intent: "customer_reply"
- Agent ISSUING a refund → intent: "issue_refund"
- Agent READING a file that mentions passwords → intent: "read_file"
- Agent DELETING user credentials → intent: "delete_credentials"

The intent describes the agent's action, not the subject matter of the data.

Known governance categories:
${vocabularyLines}

Respond with ONLY a short intent label (1-4 words, snake_case). No explanation.`;
    const dataSummary = Object.entries(inputData)
        .filter(([, v]) => typeof v === 'string' && v.length > 0)
        .map(([k, v]) => `${k}: ${v.substring(0, 300)}`)
        .join('\n')
        .substring(0, 2000);
    const userPrompt = `Stated intent: ${rawIntent}
Tool: ${tool || 'none'}
Input data:
${dataSummary}`;
    const raw = await callAIProvider(systemPrompt, userPrompt, config);
    const classifiedIntent = raw.trim().toLowerCase().replace(/[^a-z0-9_ ]/g, '').replace(/\s+/g, '_');
    return { classifiedIntent: classifiedIntent || rawIntent, raw };
}
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
                    parsedArgs = additionalFields.args;
                }
            }
            // ─── Build guard event ──────────────────────────────────────
            const inputJson = items[i].json;
            let finalIntent;
            let classificationUsed = false;
            let classificationRaw = '';
            if (aiClassification) {
                // ── AI-classified intent ──────────────────────────────────
                // The LLM determines the TRUE intent of the action, separating
                // "what the agent is doing" from "what the content says".
                const aiProvider = this.getNodeParameter('aiProvider', i);
                const aiModel = this.getNodeParameter('aiModel', i);
                const aiApiKey = this.getNodeParameter('aiApiKey', i, '');
                const aiEndpoint = this.getNodeParameter('aiEndpoint', i, '');
                try {
                    const result = await classifyIntentWithAI(intent, tool, inputJson, world, { provider: aiProvider, model: aiModel, apiKey: aiApiKey, endpoint: aiEndpoint || undefined });
                    finalIntent = result.classifiedIntent;
                    classificationUsed = true;
                    classificationRaw = result.raw;
                }
                catch (err) {
                    // AI classification failed — fall back to enriched intent
                    classificationRaw = `error: ${err instanceof Error ? err.message : String(err)}`;
                    finalIntent = intent;
                }
            }
            else {
                // ── Legacy enriched intent (no AI) ────────────────────────
                // Concatenate all text from args and input fields into the intent
                // string for regex matching.  This is the original behavior.
                finalIntent = intent;
                if (parsedArgs) {
                    const argsText = typeof parsedArgs === 'string'
                        ? parsedArgs
                        : typeof parsedArgs === 'object' && parsedArgs !== null
                            ? Object.values(parsedArgs)
                                .filter((v) => typeof v === 'string')
                                .join(' ')
                            : '';
                    if (argsText) {
                        finalIntent = `${intent} ${argsText}`;
                    }
                }
                for (const [, value] of Object.entries(inputJson)) {
                    if (typeof value === 'string' && value.length > 0 && value.length < 10000) {
                        const sample = value.substring(0, 50);
                        if (!finalIntent.includes(sample)) {
                            finalIntent = `${finalIntent} ${value}`;
                        }
                    }
                }
            }
            const event = { intent: finalIntent };
            if (tool)
                event.tool = tool;
            if (additionalFields.irreversible)
                event.irreversible = true;
            if (additionalFields.role)
                event.role = additionalFields.role;
            if (parsedArgs !== undefined)
                event.args = parsedArgs;
            // When AI classification is active, pass the raw input as payload so the
            // guard engine's safety checks (prompt injection, scope escape) still
            // scan the full text — only the intent-pattern matching uses the clean label.
            if (classificationUsed) {
                const rawPayload = Object.entries(inputJson)
                    .filter(([, v]) => typeof v === 'string' && v.length > 0)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\n')
                    .substring(0, 20000);
                event.payload = rawPayload;
            }
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
                    _debug: {
                        finalIntent: finalIntent.substring(0, 500),
                        aiClassification: classificationUsed
                            ? { used: true, raw: classificationRaw, classified: finalIntent }
                            : { used: false },
                        bodyFieldValue: typeof inputJson['body'] === 'string' ? inputJson['body'].substring(0, 100) : String(inputJson['body']),
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