# Claude Code Prompt Anatomy

Structured discovery into the anatomy of a prompt when using Claude Code (the CLI / IDE extension) to understand what makes up the context window — what files it uses, in what order, and how static vs dynamic content is separated. This is based on direct source code analysis of the Claude Code open-source repository.

Unlike GitHub Copilot, Claude Code is open source so this reflects the actual code, not a best guess.

## Context Window

Claude Code is careful about the context window because of [context rot](https://www.understandingai.org/p/context-rot-the-emerging-challenge) — the gradual degradation of usefulness as conversation grows longer. It addresses this with:

- **Prompt caching**: splits the system prompt at a hard boundary so the static prefix can be cached globally (across orgs) or per-session
- **Automatic compression**: prior messages are summarized as the window fills (`"The system will automatically compress prior messages..."`)
- **Dynamic boundary marker**: `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` separates cacheable static content from per-session dynamic content

---

## System Prompt

**Source:** `src/constants/prompts.ts` — `getSystemPrompt()` (line 444)

The system prompt is an ordered array of string sections. Everything before the boundary marker can use a `scope: 'global'` cache control header (cross-org cache hit). Everything after is session-specific.

```
┌─────────────────────────────────────────────────────────────┐
│  STATIC SECTIONS (globally cacheable)                       │
│                                                             │
│  1. Intro Identity                                          │
│  2. System Rules                                            │
│  3. Doing Tasks                                             │
│  4. Executing Actions with Care                             │
│  5. Using Your Tools                                        │
│  6. Tone and Style                                          │
│  7. Output Efficiency                                       │
│                                                             │
│  ── __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ ──                   │
│                                                             │
│  DYNAMIC SECTIONS (session/user-specific, not cached)       │
│                                                             │
│  8.  Session Guidance (agent tool, skills, plan mode...)    │
│  9.  Memory (MEMORY.md files from memdir)                   │
│  10. Ant Model Override (internal Anthropic staff only)     │
│  11. Environment Info (CWD, OS, shell, model)               │
│  12. Language Preference                                     │
│  13. Output Style (if configured)                           │
│  14. MCP Server Instructions                                │
│  15. Scratchpad Directory Instructions                      │
│  16. Function Result Clearing                               │
│  17. Summarize Tool Results                                  │
│  18. Token Budget (if feature enabled)                      │
│  19. Brief/Kairos Section (if feature enabled)              │
└─────────────────────────────────────────────────────────────┘
```

### Static Sections Detail

#### 1. Intro / Identity (`getSimpleIntroSection`)
```
You are an interactive agent that helps users with software engineering tasks.
Use the instructions below and the tools available to you to assist the user.

IMPORTANT: Assist with authorized security testing... [cyber risk instruction]
IMPORTANT: You must NEVER generate or guess URLs...
```

#### 2. System Rules (`getSimpleSystemSection`)
- How output text is rendered (GitHub-flavored markdown, monospace)
- How tool permissions work and what to do when a user denies a tool call
- `<system-reminder>` tag explanation
- Prompt injection warning for external tool results
- Hooks explanation (`<user-prompt-submit-hook>`)
- Automatic context compression notice

#### 3. Doing Tasks (`getSimpleDoingTasksSection`)
- Primary task types (bugs, features, refactors, explanations)
- Code style rules: don't over-engineer, no speculative abstractions, don't add comments unless non-obvious
- Security guidance (OWASP top 10)
- How to handle task failure (diagnose before switching tactics)
- `/help` and feedback instructions

#### 4. Executing Actions with Care (`getActionsSection`)
- Reversibility and blast radius guidance
- Examples of risky actions requiring confirmation (force push, drop tables, send messages)
- "Measure twice, cut once" philosophy

#### 5. Using Your Tools (`getUsingYourToolsSection`)
- Prefer dedicated tools: `Read` over `cat`, `Edit` over `sed`, `Glob` over `find`, `Grep` over `rg`
- When to use `Agent` subagents vs direct tools
- Task list tools (`TaskCreate`, `TodoWrite`)
- Skills/slash commands guidance

#### 6. Tone and Style (`getSimpleToneAndStyleSection`)
- No emojis unless requested
- Short, concise responses
- File path + line number format for code references
- GitHub issue link format

#### 7. Output Efficiency (`getOutputEfficiencySection`)
- Lead with answers, not reasoning
- Skip filler, preamble, unnecessary transitions
- When to give status updates vs when to just do it

### Dynamic Sections Detail

#### 8. Session Guidance
Injected from `getSessionSpecificGuidanceSection()`. Includes:
- How to use the `Agent` tool (when to use Explore vs Plan subagents)
- `EnterPlanMode` / `ExitPlanMode` guidance
- Skill invocation instructions (`Skill` tool)
- Task management guidance

#### 9. Memory (`loadMemoryPrompt`)
Content of any `.claude/` memory files the user has configured. These are the persistent, file-based memory entries written via the `Write` tool to `MEMORY.md` + individual memory files.

#### 10. Environment Info (`computeSimpleEnvInfo`)

Note: git status is **not** here — it lives in the separate System Context section appended via `appendSystemContext`.

```
# Environment
You have been invoked in the following environment:
- Primary working directory: /path/to/project
- Is a git repository: true
- Platform: darwin
- Shell: bash (use Unix shell syntax...)
- OS Version: macOS 14.x
- You are powered by the model named Sonnet 4.6. The exact model ID is claude-sonnet-4-6.
- Assistant knowledge cutoff is August 2025.
- The most recent Claude model family is Claude 4.5/4.6. Model IDs — Opus 4.6: '...', Sonnet 4.6: '...', Haiku 4.5: '...'
- Claude Code is available as a CLI in the terminal, desktop app (Mac/Windows), web app, and IDE extensions (VS Code, JetBrains).
- Fast mode for Claude Code uses the same Claude Opus 4.6 model with faster output. It does NOT switch to a different model.
```

#### 11-19. Other Dynamic Sections
- **Language**: `Always respond in [language]...` if user has set a language preference
- **Output Style**: Named style config with its own prompt (e.g., custom output modes)
- **MCP Server Instructions**: Any `instructions` field from connected MCP servers
- **Scratchpad**: Path to the scratchpad directory if enabled
- **Function Result Clearing**: Instructions for managing tool result memory
- **Numeric Length Anchors** (Anthropic-internal only): `≤25 words between tool calls`, `≤100 words final response`
- **Token Budget**: Guidance about working to a token target (if feature-flagged on)

---

## User Context (per-message injection)

**Source:** `src/context.ts` — `getUserContext()` (line 155)

This is **not** in the system prompt. It is prepended to the messages array as a `<system-reminder>` block at the start of each conversation turn:

```
<system-reminder>
As you answer the user's questions, you can use the following context:
# currentDate
Today's date is 2026-04-01.

# claudeMd
[content of CLAUDE.md files found by walking up the directory tree]

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>
```

**CLAUDE.md loading:**
- Walks up the directory tree from CWD looking for `CLAUDE.md` files
- Also checks `~/.claude/CLAUDE.md` (global) and any `--add-dir` directories
- Disabled by `CLAUDE_CODE_DISABLE_CLAUDE_MDS` env var
- Disabled in bare mode unless explicit `--add-dir` was passed

---

## System Context (appended to system prompt)

**Source:** `src/context.ts` — `getSystemContext()` (line 116), appended via `appendSystemContext()` in `src/utils/api.ts` (line 437)

Appended to the end of the system prompt sections array (not the messages). The format uses `key: value` — no `#` heading, colon-separated — which is different from the user context format.

```
gitStatus: Current branch: main

Main branch (you will usually use this for PRs): main

Git user: Your Name

Status:
(clean)

Recent commits:
abc1234 Most recent commit message
def5678 Previous commit message
```

Git data collected: current branch, default/main branch, `git status --short` (max 2000 chars), last 5 commits from `git log --oneline`, `git config user.name`.

---

## Tool Definitions

**Source:** `src/services/api/claude.ts` — `queryModel()` and `toolToAPISchema()` in `src/utils/api.ts`

Each tool is sent as a JSON schema alongside the messages:

```json
{
  "name": "Read",
  "description": "...(from tool.prompt())...",
  "input_schema": { "type": "object", "properties": {...} },
  "cache_control": { "type": "ephemeral" }
}
```

Tools added to the request:
1. All enabled built-in tools (Read, Write, Edit, Bash, Glob, Grep, Agent, etc.)
2. MCP tools (from connected MCP servers)
3. Advisor tool (if advisor feature enabled)
4. Extra tool schemas passed via options

---

## Conversation History (Messages Array)

**Source:** `src/query.ts` — `query()` generator; normalization in `src/utils/messages.ts`

Messages are normalized before being sent to the API:
- Consecutive same-role messages are merged
- System-tagged messages are filtered out (they go in the system prompt, not messages)
- Tool result messages are paired with their tool use
- Thinking blocks are normalized

Message structure sent to API:
```
[
  { role: "user",      content: "<system-reminder>...context...</system-reminder>" },
  { role: "user",      content: "user's first message" },
  { role: "assistant", content: "assistant response + tool_use blocks" },
  { role: "user",      content: tool_result blocks + new user message },
  ...
]
```

---

## Memory Attachments (Relevant Memory Files)

**Source:** `src/utils/attachments.ts`, triggered from `src/query.ts` (line 301)

Separate from `CLAUDE.md` files. Claude Code has a second memory system:
- Prefetched asynchronously at the start of each turn
- Relevant memory files are discovered based on paths referenced in the conversation
- Injected into the `toolResults` array after tool execution
- Deduplicated across turns

---

## Skills / Slash Commands

**Source:** `src/query.ts` (line 1617), `src/utils/attachments.ts`

Skills are user-invocable prompts (slash commands like `/commit`, `/review-pr`). When a skill search is prefetched:
- Relevant skills are injected as `<system-reminder>` attachments listing available skills
- Format: `Skills relevant to your task: [skill name] — [description]`
- The `Skill` tool in the system prompt tells the model how to invoke them

---

## Full API Request Structure

**Source:** `src/services/api/claude.ts` — `paramsFromContext()` (line ~1538)

```typescript
{
  model: "claude-sonnet-4-6",

  system: [
    // Static cacheable prefix (global scope cache)
    { text: "...[sections 1-7]...", cache_control: { type: "ephemeral", scope: "global" } },
    // Dynamic boundary — session-specific content
    { text: "...[sections 8-19]...", cache_control: { type: "ephemeral" } },
    // System context (git status etc) — key: value format, no # heading
    { text: "gitStatus: Current branch: main\n..." }
  ],

  messages: [
    { role: "user",      content: "<system-reminder>currentDate + claudeMd</system-reminder>" },
    { role: "user",      content: "Hello" },
    { role: "assistant", content: "Hi! How can I help?" },
    // ...conversation history...
  ],

  tools: [
    { name: "Read",  description: "...", input_schema: {...} },
    { name: "Write", description: "...", input_schema: {...} },
    // ...all enabled tools...
  ],

  max_tokens: 32000,  // per-model limit

  thinking: {
    type: "enabled" | "disabled" | "adaptive",
    budget_tokens: 10000   // if enabled
  },

  temperature: 1,  // when thinking is enabled

  betas: ["...feature flags as beta headers..."],

  metadata: {
    user_id: "{\"a\":\"account_id\",\"d\":\"device_id\",\"s\":\"session_id\"}"
  }
}
```

---

## CLAUDE.md Files

**Source:** `src/utils/claudemd.ts`, loaded via `src/context.ts`

CLAUDE.md is the primary way to give Claude project-specific instructions. It is the equivalent of Copilot's `copilot-instructions.md`.

**Discovery order** (loaded lowest-to-highest priority — later entries win):
1. **Managed memory** — `/etc/claude-code/CLAUDE.md` — system-wide instructions for all users on the machine
2. **User memory** — `~/.claude/CLAUDE.md` — private global instructions across all projects
3. **Project memory** — discovered by walking up from CWD to filesystem root, at each directory:
   - `CLAUDE.md`
   - `.claude/CLAUDE.md`
   - `.claude/rules/*.md` (all `.md` files in the rules subdirectory)
4. **Local memory** — `CLAUDE.local.md` in project roots — private, not checked into source control
5. Any `--add-dir` directories follow the same project memory rules

Files closer to CWD are loaded later and therefore have higher priority (the model pays more attention to them).

**`@include` directive:** Memory files can include other files using `@path` notation:
- `@./relative/path` or `@/absolute/path` or `@~/home/path`
- Included files are inserted before the including file
- Circular references are prevented; missing files are silently ignored

**Injected as:** User context in a `<system-reminder>` block at the start of messages (not in the system prompt itself).

**Tips:**
- Keep it focused: architecture, patterns, project-specific conventions
- Unlike Copilot's 50-line guideline, CLAUDE.md files can be longer — but context window cost applies
- Use `.claude/rules/*.md` to split instructions into topic-focused files
- Use `CLAUDE.local.md` for personal preferences you don't want committed to the repo

---

## Key Source Files

| File | Purpose |
|------|---------|
| `src/constants/prompts.ts` | System prompt assembly — all static and dynamic sections |
| `src/context.ts` | User context (CLAUDE.md, date) and system context (git status) loading |
| `src/utils/claudemd.ts` | CLAUDE.md file discovery and loading |
| `src/utils/api.ts` | Tool schema conversion, message normalization, context injection |
| `src/services/api/claude.ts` | API call construction, streaming, caching, betas |
| `src/query.ts` | Main query loop — orchestrates messages, tool execution, attachments |
| `src/utils/messages.ts` | Message creation and normalization for the API |
| `src/utils/attachments.ts` | Memory file and skill attachment loading |
| `src/memdir/memdir.ts` | Memory directory (persistent memory) loading |
| `src/constants/systemPromptSections.ts` | Section registry with caching metadata |

## References

- Claude Code source: https://github.com/anthropics/claude-code
- Context rot: https://www.understandingai.org/p/context-rot-the-emerging-challenge
- CLAUDE.md docs: https://docs.anthropic.com/en/docs/claude-code/memory
