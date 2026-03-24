"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NeuroVerseGuard = void 0;
const n8n_workflow_1 = require("n8n-workflow");
const governance_1 = require("@neuroverseos/governance");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
// ─── Bundled Worlds ──────────────────────────────────────────────────────────
const BUNDLED_WORLDS_DIR = (0, path_1.resolve)(__dirname, '..', '..', '..', 'worlds');
function getBundledWorldChoices() {
    try {
        return (0, fs_1.readdirSync)(BUNDLED_WORLDS_DIR, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => ({
            name: d.name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
            value: d.name,
        }));
    }
    catch {
        return [];
    }
}
function scanDirectoryForWorlds(dirPath) {
    try {
        return (0, fs_1.readdirSync)(dirPath, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => ({
            name: d.name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
            value: d.name,
        }));
    }
    catch {
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
function normalizeFieldNames(args) {
    const normalized = {};
    let hasDraftReply = false;
    let hasCustomerInput = false;
    let hasContext = false;
    for (const [key, value] of Object.entries(args)) {
        const lowerKey = key.toLowerCase();
        if (!hasDraftReply && DRAFT_REPLY_ALIASES.has(lowerKey)) {
            normalized['draft_reply'] = value;
            hasDraftReply = true;
        }
        else if (!hasCustomerInput && CUSTOMER_INPUT_ALIASES.has(lowerKey)) {
            normalized['customer_input'] = value;
            hasCustomerInput = true;
        }
        else if (!hasContext && CONTEXT_ALIASES.has(lowerKey)) {
            normalized['context'] = value;
            hasContext = true;
        }
        else {
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
function resolveToVocabularyKey(intent, world) {
    try {
        const vocabulary = world?.guards?.intent_vocabulary ?? {};
        const guards = world?.guards?.guards ?? [];
        // Build a set of vocabulary keys that are referenced by blocking guards —
        // we never want to resolve TO a blocking intent.
        const blockingKeys = new Set();
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
            if (blockingKeys.has(key))
                continue; // don't resolve to blocking intents
            if (!entry.pattern)
                continue;
            try {
                const regex = new RegExp(entry.pattern, 'i');
                if (regex.test(intent)) {
                    return key; // e.g. "reply_to_inquiry", "send_information"
                }
            }
            catch { /* invalid regex */ }
        }
    }
    catch { /* world structure may vary */ }
    return intent; // no match — keep original
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
// ─── Tool Surface Validation (Fix 1) ─────────────────────────────────────────
// If the tool doesn't match any guard's appliesTo, also evaluate WITHOUT the
// tool so guards with appliesTo still fire.  Attacker can't bypass by using
// an unknown tool name.
function getKnownToolSurfaces(world) {
    const surfaces = new Set();
    try {
        const toolSurfaces = world?.guards?.tool_surfaces ?? [];
        for (const s of toolSurfaces) {
            if (typeof s === 'string')
                surfaces.add(s.toLowerCase());
        }
        const guards = world?.guards?.guards ?? [];
        for (const g of guards) {
            if (Array.isArray(g.appliesTo)) {
                for (const t of g.appliesTo) {
                    if (typeof t === 'string')
                        surfaces.add(t.toLowerCase());
                }
            }
        }
    }
    catch { /* world structure may vary */ }
    return surfaces;
}
function takeStrictestVerdict(a, b) {
    const severity = { BLOCK: 3, PAUSE: 2, WARN: 1, ALLOW: 0 };
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
const SENSITIVE_CONTENT_PATTERNS = [
    // Actual credential-like values in text
    { id: 'raw-password', pattern: /password\s*[:=]\s*\S+/i, label: 'Password value in content' },
    { id: 'raw-api-key', pattern: /api[_-]?key\s*[:=]\s*\S+/i, label: 'API key value in content' },
    { id: 'raw-token', pattern: /(access[_-]?token|bearer|secret[_-]?key)\s*[:=]\s*\S+/i, label: 'Token/secret value in content' },
    { id: 'raw-ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: 'SSN pattern in content' },
    { id: 'raw-credit-card', pattern: /\b(?:\d[ -]*?){13,19}\b/, label: 'Credit card number pattern in content' },
    { id: 'raw-private-key', pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i, label: 'Private key in content' },
];
function scanContentAgainstImmutableGuards(contentText, world) {
    if (!contentText || contentText.length === 0) {
        return { violated: false };
    }
    // Layer 1: World's intent vocabulary patterns (verb+noun combos)
    try {
        const guards = world?.guards?.guards ?? [];
        const vocabulary = world?.guards?.intent_vocabulary ?? {};
        for (const guard of guards) {
            if (!guard.immutable)
                continue;
            if (guard.enforcement !== 'block')
                continue;
            for (const patternKey of guard.intent_patterns ?? []) {
                const vocabEntry = vocabulary[patternKey];
                if (!vocabEntry?.pattern)
                    continue;
                try {
                    const regex = new RegExp(vocabEntry.pattern, 'i');
                    if (regex.test(contentText)) {
                        return {
                            violated: true,
                            guardId: guard.id,
                            reason: `Content violates ${guard.label}: matched pattern "${patternKey}" in reply/message body. The agent's intent was allowed, but the content itself contains a policy violation.`,
                        };
                    }
                }
                catch { /* invalid regex — skip */ }
            }
        }
    }
    catch { /* world structure may vary */ }
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
function extractWorldContext(world) {
    const worldJson = world?.world ?? world ?? {};
    const guardsArr = world?.guards?.guards ?? [];
    const invariantsArr = world?.invariants ?? [];
    const guardDescriptions = {};
    for (const g of guardsArr) {
        if (g?.id) {
            guardDescriptions[g.id] = { label: g.label ?? g.id, description: g.description ?? '' };
        }
    }
    const invariantDescriptions = {};
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
function buildGuardNarrativePrompt(worldCtx, verdict, resolvedIntent, tool, trace, evidence, contentScanOverride, toolIsKnown) {
    const matchedGuards = (trace?.guardChecks ?? [])
        .filter((gc) => gc.matched || gc.triggered)
        .map((gc) => {
        const id = gc.guardId ?? gc.id;
        const desc = worldCtx.guardDescriptions[id];
        return desc ? `- ${desc.label}: ${desc.description}` : `- ${gc.label ?? id}`;
    })
        .join('\n');
    const failedInvariants = (trace?.invariantChecks ?? [])
        .filter((ic) => !ic.satisfied)
        .map((ic) => {
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
async function callAIForNarrative(prompt, provider, model, apiKey, endpoint) {
    const headers = { 'Content-Type': 'application/json' };
    let url;
    let body;
    if (provider === 'anthropic') {
        url = endpoint || 'https://api.anthropic.com/v1/messages';
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        body = JSON.stringify({
            model: model || 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
        });
    }
    else if (provider === 'ollama') {
        url = (endpoint || 'http://localhost:11434') + '/api/chat';
        body = JSON.stringify({
            model: model || 'llama3',
            messages: [{ role: 'user', content: prompt }],
            stream: false,
        });
    }
    else {
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
    const json = await response.json();
    if (provider === 'anthropic') {
        return json.content?.[0]?.text ?? '';
    }
    else if (provider === 'ollama') {
        return json.message?.content ?? '';
    }
    else {
        return json.choices?.[0]?.message?.content ?? '';
    }
}
/** Fallback: template-based narrative using world context */
function buildFallbackGuardNarrative(worldCtx, verdict, resolvedIntent, tool, trace, evidence, contentScanOverride, toolIsKnown, intentSource) {
    const lines = [];
    // Opening — what happened in context of the world
    if (worldCtx.description) {
        lines.push(`In the context of "${worldCtx.name}" (${worldCtx.description}):`);
    }
    if (verdict.status === 'ALLOW') {
        lines.push(`The action "${resolvedIntent}" was allowed${tool ? ` via ${tool}` : ''}.`);
    }
    else if (verdict.status === 'BLOCK') {
        lines.push(`The action "${resolvedIntent}" was blocked${tool ? ` via ${tool}` : ''}.`);
    }
    else if (verdict.status === 'PAUSE') {
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
        const matched = trace.guardChecks.filter((gc) => gc.matched || gc.triggered);
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
            const failed = trace.invariantChecks.filter((ic) => !ic.satisfied);
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
                type: 'options',
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
                type: 'string',
                default: '',
                required: true,
                placeholder: '/data/my-worlds',
                description: 'Path to a folder containing your world directories. Each subfolder is treated as a world.',
                displayOptions: {
                    show: {
                        worldSource: ['customDir'],
                    },
                },
            },
            {
                displayName: 'Custom World',
                name: 'customWorld',
                type: 'options',
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
            // ─── Strict Enforcement (Fix 2) ───────────────────────────────
            {
                displayName: 'Strict Enforcement',
                name: 'strictEnforcement',
                type: 'boolean',
                default: false,
                description: 'When enabled, BLOCK verdicts throw a node error and stop the workflow entirely. Prevents downstream nodes from ignoring governance decisions.',
            },
            // ─── AI Narrative ──────────────────────────────────────────
            {
                displayName: 'AI Narrative',
                name: 'aiNarrative',
                type: 'boolean',
                default: false,
                description: 'Use an AI model to explain the guard decision in plain language. The AI reads the world\'s purpose, guard descriptions, and the verdict to produce a narrative a business person can act on.',
            },
            {
                displayName: 'Narrative AI Provider',
                name: 'narrativeAiProvider',
                type: 'options',
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
                type: 'string',
                default: 'gpt-4.1-mini',
                placeholder: 'gpt-4.1-mini',
                description: 'Model ID. A fast, cheap model works well — this is a single interpretation call.',
                displayOptions: { show: { aiNarrative: [true] } },
            },
            {
                displayName: 'Narrative AI API Key',
                name: 'narrativeAiApiKey',
                type: 'string',
                typeOptions: { password: true },
                default: '',
                description: 'API key for narrative AI. Not required for Ollama. Uses the same key as AI Classification if left empty.',
                displayOptions: { show: { aiNarrative: [true] } },
            },
            {
                displayName: 'Narrative AI Endpoint (Override)',
                name: 'narrativeAiEndpoint',
                type: 'string',
                default: '',
                placeholder: 'http://localhost:11434',
                description: 'Custom API endpoint for narrative AI. Required for Ollama.',
                displayOptions: { show: { aiNarrative: [true] } },
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
    methods = {
        loadOptions: {
            async getCustomWorldChoices() {
                const customDir = this.getNodeParameter('customWorldsDir', '');
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
            const strictEnforcement = this.getNodeParameter('strictEnforcement', i, false);
            const additionalFields = this.getNodeParameter('additionalFields', i);
            // ─── Load world ─────────────────────────────────────────────
            let cacheKey;
            if (worldSource === 'bundled') {
                const worldName = this.getNodeParameter('bundledWorld', i);
                cacheKey = `bundled:${worldName}`;
                const worldDir = (0, path_1.join)(BUNDLED_WORLDS_DIR, worldName);
                const currentMtime = getDirectoryMtime(worldDir);
                const cached = worldCache.get(cacheKey);
                if (!cached || cached.mtime < currentMtime) {
                    const world = await (0, governance_1.loadWorld)(worldDir);
                    worldCache.set(cacheKey, { world, mtime: currentMtime });
                }
            }
            else if (worldSource === 'customDir') {
                const customDir = this.getNodeParameter('customWorldsDir', i);
                const worldName = this.getNodeParameter('customWorld', i);
                const worldDir = (0, path_1.join)(customDir, worldName);
                cacheKey = `custom:${worldDir}`;
                const currentMtime = getDirectoryMtime(worldDir);
                const cached = worldCache.get(cacheKey);
                if (!cached || cached.mtime < currentMtime) {
                    const world = await (0, governance_1.loadWorld)(worldDir);
                    worldCache.set(cacheKey, { world, mtime: currentMtime });
                }
            }
            else if (worldSource === 'base64') {
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
            // ─── Fix 3: Normalize field names before extraction ─────────
            const normalizedArgs = normalizeFieldNames(mergedArgs);
            // ─── Fix 1: Detect unknown tool surfaces ───────────────────
            const knownSurfaces = getKnownToolSurfaces(world);
            const toolIsKnown = !tool || knownSurfaces.has(tool.toLowerCase());
            // ─── Build guard event ──────────────────────────────────────
            const event = { intent };
            if (tool)
                event.tool = tool;
            if (additionalFields.irreversible)
                event.irreversible = true;
            if (additionalFields.role)
                event.roleId = additionalFields.role;
            if (Object.keys(normalizedArgs).length > 0)
                event.args = normalizedArgs;
            // ─── Evaluate ───────────────────────────────────────────────
            let verdict;
            let intentSource = 'raw';
            let classification = undefined;
            let originalIntent = undefined;
            let contentScanOverride = false;
            let contentScanGuardId = undefined;
            if (aiClassification) {
                const aiProvider = this.getNodeParameter('aiProvider', i);
                const aiModel = this.getNodeParameter('aiModel', i);
                const aiApiKey = this.getNodeParameter('aiApiKey', i, '');
                const aiEndpoint = this.getNodeParameter('aiEndpoint', i, '');
                const contentFields = (0, governance_1.extractContentFields)(intent, normalizedArgs);
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
                // Use extractContentFields to separate clean intent from content.
                const contentFields = (0, governance_1.extractContentFields)(intent, normalizedArgs);
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
                verdict = (0, governance_1.evaluateGuard)(event, world, { level, trace: true });
            }
            // ─── Fix 1: Re-evaluate with known surfaces if tool is unknown ──
            // The guard engine skips guards with appliesTo when the event's tool
            // doesn't match (including when tool is absent).  If the provided tool
            // isn't recognized, re-evaluate with each known tool surface and take
            // the strictest verdict.  Fail closed, not open.
            if (!toolIsKnown) {
                for (const surface of knownSurfaces) {
                    const probeEvent = { ...event, tool: surface };
                    const probeVerdict = (0, governance_1.evaluateGuard)(probeEvent, world, { level, trace: true });
                    verdict = takeStrictestVerdict(verdict, probeVerdict);
                    if (verdict.status === 'BLOCK')
                        break; // can't get stricter
                }
            }
            // ─── Fix 4: Content safety scan ─────────────────────────────
            // Even if the intent is clean (ALLOW), scan the actual content
            // (draft replies, email bodies) against immutable guard patterns.
            // An agent with intent "customer_reply" (ALLOW) could still put
            // "Your password is hunter2" in the reply body.
            if (verdict.status !== 'BLOCK') {
                const contentFields = (0, governance_1.extractContentFields)(intent, normalizedArgs);
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
                    };
                }
            }
            // ─── Build output ───────────────────────────────────────────
            const evidence = verdict.evidence;
            const trace = verdict.trace;
            // Build insights from evidence (always present) + trace (when available)
            const insights = {
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
                    insights.guardChecks = trace.guardChecks.map((gc) => ({
                        guardId: gc.guardId ?? gc.id,
                        label: gc.label,
                        matched: gc.matched ?? gc.triggered,
                        enforcement: gc.enforcement,
                        matchedPatterns: gc.matchedPatterns ?? [],
                    }));
                }
                if (trace.invariantChecks?.length) {
                    insights.invariantChecks = trace.invariantChecks.map((ic) => ({
                        invariantId: ic.invariantId ?? ic.id,
                        label: ic.label,
                        satisfied: ic.satisfied,
                    }));
                }
                if (trace.kernelRuleChecks?.length) {
                    insights.kernelRuleChecks = trace.kernelRuleChecks.map((kr) => ({
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
                resolved: event.intent.substring(0, 500),
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
            if (verdict.warning) {
                insights.warning = verdict.warning;
            }
            // Intent record (what agent wanted vs. what happened)
            if (verdict.intentRecord) {
                insights.intentRecord = verdict.intentRecord;
            }
            // ─── Narrative ──────────────────────────────────────────────
            const worldCtx = extractWorldContext(world);
            const aiNarrative = this.getNodeParameter('aiNarrative', i, false);
            let narrativeSource = 'fallback';
            if (aiNarrative) {
                // Use narrative-specific AI config, falling back to classification AI config
                const nProvider = this.getNodeParameter('narrativeAiProvider', i, 'openai');
                const nModel = this.getNodeParameter('narrativeAiModel', i, 'gpt-4.1-mini');
                const nApiKey = this.getNodeParameter('narrativeAiApiKey', i, '')
                    || (aiClassification ? this.getNodeParameter('aiApiKey', i, '') : '');
                const nEndpoint = this.getNodeParameter('narrativeAiEndpoint', i, '');
                const narrativePrompt = buildGuardNarrativePrompt(worldCtx, verdict, event.intent, tool, trace, evidence, contentScanOverride, toolIsKnown);
                try {
                    insights.narrative = await callAIForNarrative(narrativePrompt, nProvider, nModel, nApiKey, nEndpoint);
                    narrativeSource = 'ai';
                }
                catch (err) {
                    insights.narrative = buildFallbackGuardNarrative(worldCtx, verdict, event.intent, tool, trace, evidence, contentScanOverride, toolIsKnown, intentSource);
                    insights.narrative.push(`(AI narrative unavailable: ${err.message?.substring(0, 100) ?? 'unknown error'})`);
                }
            }
            else {
                insights.narrative = buildFallbackGuardNarrative(worldCtx, verdict, event.intent, tool, trace, evidence, contentScanOverride, toolIsKnown, intentSource);
            }
            insights.narrativeSource = narrativeSource;
            insights.worldDescription = worldCtx.description || null;
            insights.thesis = worldCtx.thesis || null;
            const outputItem = {
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
                throw new Error(`[NeuroVerse Guard] BLOCKED: ${verdict.reason ?? 'Policy violation'} (rule: ${verdict.ruleId ?? 'unknown'})`);
            }
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