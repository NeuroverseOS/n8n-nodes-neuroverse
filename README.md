# NeuroVerse Guard for n8n

Stop AI automations before they do something stupid.

The NeuroVerse Guard node evaluates an agent's intent against your governance rules and routes the workflow based on the result.

**Outputs:**
- **ALLOW** — continue execution
- **BLOCK** — stop the action
- **PAUSE** — require human approval

Deterministic. Sub-millisecond. No LLM calls. Full audit trail.

## Installation

In n8n, go to **Settings → Community Nodes → Browse** and search:

```
neuroverse
```

Or install via CLI:

```bash
cd ~/.n8n
npm install @neuroverseos/n8n-nodes-neuroverse
```

## How It Works

The NeuroVerse Guard evaluates every action against your governance world — a portable set of rules, invariants, guards, and roles defined in a `.nv-world.zip` file.

```typescript
import { loadWorld, evaluateGuard } from '@neuroverseos/governance';

const world = await loadWorld('./policy.nv-world.zip');
const verdict = evaluateGuard({ intent: 'Delete user account', tool: 'admin-api' }, world);
// verdict.status → 'ALLOW' | 'BLOCK' | 'PAUSE'
```

Three functions. No network. No LLM. Deterministic.

## Node Configuration

| Field | Description |
|-------|-------------|
| **World Source** | Load from a file path or base64-encoded zip |
| **World File Path** | Path to your `.nv-world.zip` or extracted directory |
| **World File (Base64)** | Base64-encoded zip — useful in Docker/cloud environments |
| **Intent** | What the agent is trying to do |
| **Tool** | Which tool/API the agent is calling (optional) |
| **Enforcement Level** | Basic, Standard, or Strict |
| **Strict Enforcement** | When enabled, BLOCK verdicts throw a node error and stop the workflow entirely |
| **AI Intent Classification** | Use an AI model to classify true intent before evaluation (prevents false positives) |

### Strict Enforcement

By default, the Guard node routes BLOCK verdicts to the second output — but downstream nodes can still be wired to continue execution. Enable **Strict Enforcement** to make BLOCK verdicts throw a node error, stopping the entire workflow. This prevents anyone from wiring around governance decisions.

### AI Intent Classification

When enabled, the node uses a fast AI model (OpenAI, Anthropic, or Ollama) to classify the true intent before guard evaluation. This prevents false positives when raw text — like customer emails mentioning "refund" — gets evaluated as if the agent is issuing a refund.

Supported providers: OpenAI, Anthropic, Ollama (local).

### Outputs

The node has three separate output connections on the canvas:

| Output | When | Contains |
|--------|------|----------|
| **ALLOW** | Action is permitted | Original data + verdict |
| **BLOCK** | Action violates rules | Original data + verdict.reason + verdict.evidence |
| **PAUSE** | Action needs human review | Original data + verdict.reason + verdict.evidence |

Wire each output to different downstream nodes to handle each case visually.

## Security Features

### Tool Surface Validation

Guards define which tools they apply to (e.g., `email`, `smtp`, `gmail`). If an action uses a tool name that doesn't match any known surface, the node evaluates against **all** known surfaces and takes the strictest verdict. This prevents bypass by using unknown tool names like `slack-bot` or `billing-api`.

### Content Safety Scanning

After intent evaluation, the node scans the actual message body and draft replies for sensitive data — regardless of intent classification. Catches:

- Passwords and credentials (`password: hunter2`)
- API keys and tokens (`api_key = sk-proj-...`)
- SSNs (`123-45-6789`)
- Credit card numbers
- Private keys (`-----BEGIN PRIVATE KEY-----`)

An agent with a clean intent like "reply to customer inquiry" will still be blocked if the reply body contains a password.

### Field Name Normalization

Real-world n8n workflows use many different field names for the same concept. The node normalizes 30+ common synonyms before evaluation:

| Your field name | Normalized to |
|---|---|
| `reply_text`, `response`, `draft`, `answer`, `ai_output` | `draft_reply` |
| `email_body`, `message`, `msg`, `inquiry`, `ticket_body` | `customer_input` |
| `subject`, `topic`, `metadata`, `category` | `context` |

### Vocabulary Resolution

Raw intent text like "Send general reply" is resolved to the matching vocabulary key (e.g., `reply_to_inquiry`) from your world file. This prevents the guard engine's pattern matching from over-triggering on action verbs like "send" or "share" when they appear in harmless contexts.

## Example Workflow

Import `example-workflow.json` from this repo to see a complete governance flow:

```
Webhook Trigger → Simulate Agent Action → NeuroVerse Guard
                                              ↓    ↓    ↓
                                           ALLOW BLOCK PAUSE
                                              ↓    ↓    ↓
                                           Execute Log  Request
                                           Action  +    Approval
                                                  Alert
```

The example accepts a POST request with `intent` and `tool`, runs it through the guard, and returns the appropriate response (200 for ALLOW, 403 for BLOCK, 202 for PAUSE).

## Building Your World File

A world file contains your governance rules: invariants that must always hold, guards that intercept specific actions, roles with permissions, and kernel rules for system-level constraints.

**[Build your world file free at neuroverseos.com](https://neuroverseos.com)** — upload your docs or start from a template.

## Verdict Object

Every output includes a `verdict` object:

```json
{
  "verdict": {
    "status": "BLOCK",
    "reason": "Action violates invariant: margin_floor_15_percent",
    "ruleId": "guard-pricing-change",
    "evidence": {
      "matchedGuard": "pricing-change-guard",
      "invariantRef": "margin_floor_15_percent",
      "evaluationChain": ["safety", "roles", "guards", "kernel", "level"]
    }
  }
}
```

The `_debug` object contains additional diagnostic information:

```json
{
  "_debug": {
    "intent": "reply_to_inquiry",
    "intentSource": "raw",
    "toolIsKnown": true,
    "stringFieldsScanned": ["email_body", "draft_reply"]
  }
}
```

---

## NeuroVerse Simulate

The **NeuroVerse Simulate** node runs your governance world's if/then rules engine forward in time. While the Guard node asks *"can this agent do this?"*, the Simulate node asks *"if this happens, what changes?"*

### How It Works

Your world file contains state variables (numeric/boolean/enum values), if/then rules (triggers that fire effects on state), and viability gates (thresholds that classify system health). The Simulate node evolves state through N rounds and routes based on the result.

### Node Configuration

| Field | Description |
|-------|-------------|
| **World Source** | File path or base64-encoded zip |
| **Steps** | Number of simulation rounds (1 = immediate impact, 5+ = cascading effects) |
| **Profile** | Assumption profile (e.g. `best_case`, `worst_case`, `regulatory_scrutiny`) |
| **State Overrides** | Override starting state variables with JSON — inject real metrics from upstream nodes |
| **Halt on Collapse** | When enabled, MODEL_COLLAPSES throws a node error and stops the workflow |

### Outputs

| Output | When | Viability Status |
|--------|------|-----------------|
| **HEALTHY** | System is stable | THRIVING or STABLE |
| **DEGRADED** | System is under pressure | COMPRESSED |
| **CRITICAL** | System is failing or collapsed | CRITICAL or MODEL_COLLAPSES |

### Simulation Result

Every output includes a `simulation` object:

```json
{
  "simulation": {
    "worldId": "social-media-network",
    "finalViability": "CRITICAL",
    "collapsed": true,
    "collapseStep": 3,
    "collapseRule": "rule-trust-erosion",
    "initialState": { "trust_score": 40, "engagement_health": 70 },
    "finalState": { "trust_score": 12, "engagement_health": 8 },
    "stepDetails": [
      {
        "step": 1,
        "rulesFired": 2,
        "viability": "COMPRESSED",
        "rulesTriggered": [
          {
            "ruleId": "rule-trust-erosion",
            "label": "Trust Erosion",
            "effects": [{ "target": "trust_score", "before": 40, "after": 28 }]
          }
        ]
      }
    ]
  }
}
```

### Example: Guard + Simulate Together

```
Customer Email → AI Draft Reply → NeuroVerse Guard → NeuroVerse Simulate
                                       ↓                    ↓        ↓
                                    ALLOW             HEALTHY   CRITICAL
                                       ↓                ↓          ↓
                                  [Feed into       Send reply   Hold for
                                   Simulate]                    review
```

The Guard says "you're allowed to reply." The Simulate says "but at this rate, customer satisfaction collapses in 3 steps." **Guard is the brake pedal. Simulate is the dashboard gauges.**

## License

Apache-2.0
