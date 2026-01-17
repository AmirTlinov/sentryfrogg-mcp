 [LEGEND]
TOOL_BUS = The contract for how tools are invoked and reported.
RESPONSE_MODE = Optional per-call response format selector.
ARTIFACT_URI = A stable `artifact://...` reference stored under the configured context repo root.

 [CONTENT]
Contract: Tool bus v1

## Purpose
Define [TOOL_BUS]: how tools are invoked, how results are returned, and how failures are represented.

## Scope
- In scope: request/response envelopes, streaming semantics (if any), error taxonomy.
- Out of scope: tool-specific payload schemas (those are per-tool contracts).

## Interface
### Request (MCP `tools/call`)
Tools are invoked via MCP `tools/call` with:
- `name` (tool name)
- `arguments` (tool args)

Common semantic args (supported across tools):
- `trace_id`, `span_id`, `parent_span_id` — correlation ids
- `output` — output shaping (path/pick/omit/map)
- `store_as`, `store_scope` — store shaped result into `mcp_state`
- `response_mode` ([RESPONSE_MODE]) — optional per-call response format selector (defaults to `ai`)

[RESPONSE_MODE] values:
- `ai` (default): strict JSON envelope (machine-readable)
- `compact`: strict JSON envelope (currently identical to `ai`, reserved for future trimming)

### Response
The tool call returns a single `text` content block containing **strict JSON**:
- stable top-level envelope (tool/action/trace + bounded/redacted results)
- `artifact_uri_json` pointing at the persisted `result.json` (when available)

### Artifacts
When a context repo root is configured (`SF_CONTEXT_REPO_ROOT` / `SENTRYFROGG_CONTEXT_REPO_ROOT`), each tool call stores:
1) a human-readable `.context` artifact: [ARTIFACT_URI] like `artifact://runs/<trace>/tool_calls/<span>.context`
2) a machine-readable JSON artifact: [ARTIFACT_URI] like `artifact://runs/<trace>/tool_calls/<span>/result.json`

Both artifacts MUST be bounded and redacted by default (no secrets unless a tool explicitly supports a break-glass flag).

## Errors
Tool failures are returned as MCP errors (e.g., invalid params, internal error).
Tools SHOULD provide recovery hints either:
- in the JSON envelope (`next_actions`), or
- via stable fields in the result payload.

## Examples
```json
{"tool":"example_tool","input":{"q":"ping"}}
```
