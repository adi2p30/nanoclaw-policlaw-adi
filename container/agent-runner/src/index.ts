/**
 * NanoClaw Agent Runner - Gemini Edition
 * Runs inside a container, receives config via stdin, outputs result to stdout
 * Uses Gemini via OpenAI-compatible API instead of @anthropic-ai/claude-agent-sdk
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Output protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import OpenAI from 'openai';
import { glob } from 'glob';
import { CronExpressionParser } from 'cron-parser';

// ===== INTERFACES =====

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface Session {
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  createdAt: string;
  lastUpdated: string;
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

// ===== CONSTANTS =====

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_MESSAGES_DIR = '/workspace/ipc/messages';
const IPC_TASKS_DIR = '/workspace/ipc/tasks';
const IPC_POLL_MS = 500;
const SESSIONS_DIR = '/home/node/.claude/nanoclaw-sessions';
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const MAX_TOOL_OUTPUT = 50_000;
const MAX_AGENT_ITERATIONS = 50;
const BASH_TIMEOUT_MS = 120_000;
const SCRIPT_TIMEOUT_MS = 30_000;

// ===== GEMINI CLIENT =====

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/',
  apiKey: process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || 'no-key',
});

// ===== LOGGING & OUTPUT =====

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

// ===== STDIN =====

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ===== IPC =====

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR).filter(f => f.endsWith('.json')).sort();
    const messages: string[] = [];
    for (const file of files) {
      const fp = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf-8')) as { type?: string; text?: string };
        fs.unlinkSync(fp);
        if (data.type === 'message' && data.text) messages.push(data.text);
      } catch { try { fs.unlinkSync(fp); } catch { } }
    }
    return messages;
  } catch { return []; }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise(resolve => {
    const poll = () => {
      if (shouldClose()) { resolve(null); return; }
      const msgs = drainIpcInput();
      if (msgs.length > 0) { resolve(msgs.join('\n')); return; }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function writeIpcFile(dir: string, data: object): void {
  fs.mkdirSync(dir, { recursive: true });
  const fn = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const fp = path.join(dir, fn);
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, fp);
}

// ===== SESSION MANAGEMENT =====

function loadSession(sessionId: string): Session | null {
  const p = path.join(SESSIONS_DIR, `${sessionId}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as Session; } catch { return null; }
}

function saveSession(sessionId: string, session: Session): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SESSIONS_DIR, `${sessionId}.json`),
    JSON.stringify(session, null, 2),
  );
}

function generateSessionId(): string {
  return `gs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ===== TOOL HELPERS =====

function truncate(s: string, max = MAX_TOOL_OUTPUT): string {
  return s.length <= max ? s : s.slice(0, max) + `\n[truncated — ${s.length - max} more bytes]`;
}

// ===== TOOL IMPLEMENTATIONS =====

async function toolBash(command: string): Promise<string> {
  return new Promise(resolve => {
    const proc = spawn('bash', ['-c', command], {
      cwd: '/workspace/group',
      env: { ...process.env, HOME: '/home/node' },
    });

    let out = '';
    let err = '';
    let settled = false;

    const settle = (result: string) => {
      if (!settled) { settled = true; resolve(result); }
    };

    const killTimer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { } }, 5000);
      settle('[bash command timed out after 2 minutes]');
    }, BASH_TIMEOUT_MS);

    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });

    proc.on('close', code => {
      clearTimeout(killTimer);
      const combined = [out, err ? `stderr:\n${err}` : ''].filter(Boolean).join('\n').trim();
      settle(truncate(combined || `(exit ${code})`));
    });

    proc.on('error', e => {
      clearTimeout(killTimer);
      settle(`Error: ${e.message}`);
    });
  });
}

function toolReadFile(filePath: string, offset?: number, limit?: number): string {
  try {
    const resolved = filePath.startsWith('/') ? filePath : path.join('/workspace/group', filePath);
    if (!fs.existsSync(resolved)) return `File not found: ${resolved}`;
    const content = fs.readFileSync(resolved, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, (offset ?? 1) - 1);
    const end = limit != null ? start + limit : lines.length;
    return truncate(lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join('\n'));
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function toolWriteFile(filePath: string, content: string): string {
  try {
    const resolved = filePath.startsWith('/') ? filePath : path.join('/workspace/group', filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content);
    return `Written: ${resolved}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function toolEditFile(filePath: string, oldString: string, newString: string, replaceAll = false): string {
  try {
    const resolved = filePath.startsWith('/') ? filePath : path.join('/workspace/group', filePath);
    if (!fs.existsSync(resolved)) return `File not found: ${resolved}`;
    const content = fs.readFileSync(resolved, 'utf-8');
    if (!content.includes(oldString)) return `old_string not found in ${resolved}`;
    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
    fs.writeFileSync(resolved, updated);
    return `Edited ${resolved}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function toolFindFiles(pattern: string, dir?: string): Promise<string> {
  try {
    const cwd = dir || '/workspace/group';
    const files = await glob(pattern, { cwd, absolute: true, dot: false });
    if (files.length === 0) return 'No files matched';
    return files.sort((a, b) => a.localeCompare(b)).slice(0, 200).join('\n');
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function toolSearchFiles(
  pattern: string,
  searchPath?: string,
  fileGlob?: string,
  caseInsensitive?: boolean,
): Promise<string> {
  const sp = searchPath || '/workspace/group';
  const args = ['-r', '-n'];
  if (caseInsensitive) args.push('-i');
  if (fileGlob) args.push('--include', fileGlob);
  args.push(pattern, sp);

  return new Promise(resolve => {
    const proc = spawn('grep', args, { cwd: '/workspace/group' });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', code => {
      if (code === 2) { resolve('grep error (invalid pattern or path)'); return; }
      resolve(truncate(out.trim() || 'No matches found'));
    });
    proc.on('error', e => resolve(`Error: ${e.message}`));
  });
}

async function toolWebFetch(url: string): Promise<string> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NanoClaw/1.0)' },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text();
    const stripped = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return truncate(stripped);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// NanoClaw IPC tools

function toolSendMessage(chatJid: string, groupFolder: string, text: string, sender?: string): string {
  writeIpcFile(IPC_MESSAGES_DIR, {
    type: 'message', chatJid, text, sender: sender || undefined,
    groupFolder, timestamp: new Date().toISOString(),
  });
  return 'Message queued.';
}

function toolScheduleTask(
  chatJid: string,
  groupFolder: string,
  isMain: boolean,
  prompt: string,
  scheduleType: string,
  scheduleValue: string,
  contextMode: string,
  targetGroupJid?: string,
  script?: string,
): string {
  if (scheduleType === 'cron') {
    try { CronExpressionParser.parse(scheduleValue); }
    catch { return `Invalid cron expression: "${scheduleValue}"`; }
  } else if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) return `Invalid interval: "${scheduleValue}" (must be positive ms)`;
  } else if (scheduleType === 'once') {
    if (/[Zz]$/.test(scheduleValue) || /[+-]\d{2}:\d{2}$/.test(scheduleValue)) {
      return `Timestamp must be local time without timezone suffix (e.g. "2026-02-01T15:30:00")`;
    }
  }
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const targetJid = isMain && targetGroupJid ? targetGroupJid : chatJid;
  writeIpcFile(IPC_TASKS_DIR, {
    type: 'schedule_task', taskId, prompt,
    script: script || undefined,
    schedule_type: scheduleType, schedule_value: scheduleValue,
    context_mode: contextMode, targetJid, createdBy: groupFolder,
    timestamp: new Date().toISOString(),
  });
  return `Task ${taskId} scheduled (${scheduleType}: ${scheduleValue}).`;
}

// ===== TOOL DEFINITIONS =====

const TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a bash command in /workspace/group. Use for running scripts, git, npm, file management, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file with line numbers',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute or relative (from /workspace/group) path' },
          offset: { type: 'number', description: 'Start line number (1-based)' },
          limit: { type: 'number', description: 'Maximum lines to read' },
        },
        required: ['file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file (creates or overwrites)',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to write to' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file by replacing old_string with new_string',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file' },
          old_string: { type: 'string', description: 'Exact string to find and replace' },
          new_string: { type: 'string', description: 'Replacement string' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: 'Find files matching a glob pattern',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/*.js")' },
          directory: { type: 'string', description: 'Base directory (default: /workspace/group)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a regex pattern in files using grep',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory or file to search (default: /workspace/group)' },
          file_glob: { type: 'string', description: 'Filter files by pattern (e.g. "*.ts")' },
          case_insensitive: { type: 'boolean', description: 'Case insensitive search' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch the content of a URL',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send a message to the user immediately while still processing. Use for progress updates.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to send' },
          sender: { type: 'string', description: 'Optional sender identity name' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description: `Schedule a recurring or one-time task. The task runs as a full agent session.
context_mode: "group" = runs with chat history, "isolated" = fresh session (include all context in prompt).
schedule_value: cron="0 9 * * *" | interval=milliseconds | once="2026-02-01T15:30:00" (local time, no Z suffix).`,
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What the agent should do when the task runs' },
          schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'] },
          schedule_value: { type: 'string', description: 'cron expression, interval ms, or local timestamp' },
          context_mode: { type: 'string', enum: ['group', 'isolated'], description: 'Default: group' },
          target_group_jid: { type: 'string', description: '(Main only) Target group JID' },
          script: { type: 'string', description: 'Optional bash script to run before agent (must output JSON with wakeAgent boolean)' },
        },
        required: ['prompt', 'schedule_type', 'schedule_value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List all scheduled tasks',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_task',
      description: 'Cancel and delete a scheduled task',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'Task ID to cancel' } },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_task',
      description: 'Pause a scheduled task',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'Task ID to pause' } },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resume_task',
      description: 'Resume a paused task',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'Task ID to resume' } },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Update an existing scheduled task',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID to update' },
          prompt: { type: 'string', description: 'New prompt' },
          schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'] },
          schedule_value: { type: 'string', description: 'New schedule value' },
          script: { type: 'string', description: 'New script (empty string to remove)' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'register_group',
      description: 'Register a new chat/group so the agent responds there. Main group only.',
      parameters: {
        type: 'object',
        properties: {
          jid: { type: 'string', description: 'Chat JID' },
          name: { type: 'string', description: 'Display name' },
          folder: { type: 'string', description: 'Channel-prefixed folder name (e.g. "telegram_my-group")' },
          trigger: { type: 'string', description: 'Trigger word (e.g. "@Andy")' },
        },
        required: ['jid', 'name', 'folder', 'trigger'],
      },
    },
  },
];

// ===== TOOL EXECUTOR =====

async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  containerInput: ContainerInput,
): Promise<string> {
  log(`Tool: ${toolName}`);

  switch (toolName) {
    case 'bash':
      return toolBash(String(args.command ?? ''));

    case 'read_file':
      return toolReadFile(
        String(args.file_path ?? ''),
        args.offset != null ? Number(args.offset) : undefined,
        args.limit != null ? Number(args.limit) : undefined,
      );

    case 'write_file':
      return toolWriteFile(String(args.file_path ?? ''), String(args.content ?? ''));

    case 'edit_file':
      return toolEditFile(
        String(args.file_path ?? ''),
        String(args.old_string ?? ''),
        String(args.new_string ?? ''),
        Boolean(args.replace_all),
      );

    case 'find_files':
      return toolFindFiles(
        String(args.pattern ?? ''),
        args.directory ? String(args.directory) : undefined,
      );

    case 'search_files':
      return toolSearchFiles(
        String(args.pattern ?? ''),
        args.path ? String(args.path) : undefined,
        args.file_glob ? String(args.file_glob) : undefined,
        args.case_insensitive ? Boolean(args.case_insensitive) : undefined,
      );

    case 'web_fetch':
      return toolWebFetch(String(args.url ?? ''));

    case 'send_message':
      return toolSendMessage(
        containerInput.chatJid,
        containerInput.groupFolder,
        String(args.text ?? ''),
        args.sender ? String(args.sender) : undefined,
      );

    case 'schedule_task':
      return toolScheduleTask(
        containerInput.chatJid,
        containerInput.groupFolder,
        containerInput.isMain,
        String(args.prompt ?? ''),
        String(args.schedule_type ?? ''),
        String(args.schedule_value ?? ''),
        String(args.context_mode ?? 'group'),
        args.target_group_jid ? String(args.target_group_jid) : undefined,
        args.script ? String(args.script) : undefined,
      );

    case 'list_tasks': {
      const fp = '/workspace/ipc/current_tasks.json';
      if (!fs.existsSync(fp)) return 'No scheduled tasks found.';
      try {
        const tasks = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Array<{ groupFolder: string }>;
        const filtered = containerInput.isMain
          ? tasks
          : tasks.filter(t => t.groupFolder === containerInput.groupFolder);
        return filtered.length === 0 ? 'No tasks found.' : JSON.stringify(filtered, null, 2);
      } catch { return 'Error reading tasks.'; }
    }

    case 'cancel_task':
      writeIpcFile(IPC_TASKS_DIR, {
        type: 'cancel_task', taskId: String(args.task_id),
        groupFolder: containerInput.groupFolder, isMain: containerInput.isMain,
        timestamp: new Date().toISOString(),
      });
      return `Task ${String(args.task_id)} cancellation requested.`;

    case 'pause_task':
      writeIpcFile(IPC_TASKS_DIR, {
        type: 'pause_task', taskId: String(args.task_id),
        groupFolder: containerInput.groupFolder, isMain: containerInput.isMain,
        timestamp: new Date().toISOString(),
      });
      return `Task ${String(args.task_id)} paused.`;

    case 'resume_task':
      writeIpcFile(IPC_TASKS_DIR, {
        type: 'resume_task', taskId: String(args.task_id),
        groupFolder: containerInput.groupFolder, isMain: containerInput.isMain,
        timestamp: new Date().toISOString(),
      });
      return `Task ${String(args.task_id)} resumed.`;

    case 'update_task': {
      const data: Record<string, string> = {
        type: 'update_task',
        taskId: String(args.task_id),
        groupFolder: containerInput.groupFolder,
        isMain: String(containerInput.isMain),
        timestamp: new Date().toISOString(),
      };
      if (args.prompt !== undefined) data.prompt = String(args.prompt);
      if (args.script !== undefined) data.script = String(args.script);
      if (args.schedule_type !== undefined) data.schedule_type = String(args.schedule_type);
      if (args.schedule_value !== undefined) data.schedule_value = String(args.schedule_value);
      writeIpcFile(IPC_TASKS_DIR, data);
      return `Task ${String(args.task_id)} update requested.`;
    }

    case 'register_group':
      if (!containerInput.isMain) return 'Only the main group can register new groups.';
      writeIpcFile(IPC_TASKS_DIR, {
        type: 'register_group',
        jid: String(args.jid), name: String(args.name),
        folder: String(args.folder), trigger: String(args.trigger),
        timestamp: new Date().toISOString(),
      });
      return `Group "${String(args.name)}" registered.`;

    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ===== SYSTEM PROMPT =====

function buildSystemPrompt(containerInput: ContainerInput): string {
  const assistantName = containerInput.assistantName || 'Assistant';

  let systemPrompt = `You are ${assistantName}, a helpful AI assistant running inside a secure container.

Your current working directory is /workspace/group.

You have access to tools:
- bash: run shell commands
- read_file, write_file, edit_file: file operations
- find_files, search_files: find and search files
- web_fetch: retrieve web pages
- send_message: send a message to the user while you work
- schedule_task, list_tasks, cancel_task, pause_task, resume_task, update_task: manage scheduled tasks
- register_group: register new chat groups (main group only)

Be concise and helpful. Use tools when needed.`;

  // Load group CLAUDE.md
  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    systemPrompt += '\n\n---\n\n' + fs.readFileSync(groupClaudeMd, 'utf-8');
  }

  // Load global CLAUDE.md for non-main groups
  if (!containerInput.isMain) {
    const globalClaudeMd = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalClaudeMd)) {
      systemPrompt += '\n\n---\n\n' + fs.readFileSync(globalClaudeMd, 'utf-8');
    }
  }

  return systemPrompt;
}

// ===== AGENTIC LOOP =====

async function runAgentLoop(
  userMessage: string,
  containerInput: ContainerInput,
  history: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  systemPrompt: string,
): Promise<{ result: string; updatedHistory: OpenAI.Chat.Completions.ChatCompletionMessageParam[] }> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  let iterations = 0;

  while (iterations < MAX_AGENT_ITERATIONS) {
    iterations++;
    log(`Agent iteration ${iterations}/${MAX_AGENT_ITERATIONS}`);

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
    });

    const choice = response.choices[0];
    if (!choice) throw new Error('No response from model');

    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    const hasToolCalls = (choice.finish_reason === 'tool_calls' || assistantMsg.tool_calls?.length)
      && assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0;

    if (!hasToolCalls) {
      const result = assistantMsg.content || '';
      log(`Agent finished after ${iterations} iteration(s)`);
      return { result, updatedHistory: messages };
    }

    for (const tc of assistantMsg.tool_calls!) {
      let toolResult: string;
      try {
        const args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
        toolResult = await executeTool(tc.function.name, args, containerInput);
      } catch (e) {
        toolResult = `Tool error: ${e instanceof Error ? e.message : String(e)}`;
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
    }
  }

  log(`Max iterations (${MAX_AGENT_ITERATIONS}) reached`);
  return {
    result: 'Maximum number of steps reached. Please try a more focused request.',
    updatedHistory: messages,
  };
}

// ===== SCRIPT RUNNER =====

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise(resolve => {
    const proc = spawn('bash', [scriptPath], {
      env: process.env,
    });
    let out = '';
    let err = '';
    let settled = false;

    const settle = (v: ScriptResult | null) => {
      if (!settled) { settled = true; resolve(v); }
    };

    const killTimer = setTimeout(() => {
      proc.kill('SIGTERM');
      settle(null);
    }, SCRIPT_TIMEOUT_MS);

    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });

    proc.on('close', () => {
      clearTimeout(killTimer);
      if (err) log(`Script stderr: ${err.slice(0, 500)}`);
      const lines = out.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) { log('Script produced no output'); return settle(null); }
      try {
        const result = JSON.parse(lastLine) as ScriptResult;
        if (typeof result.wakeAgent !== 'boolean') { log('Script missing wakeAgent boolean'); return settle(null); }
        settle(result);
      } catch { log('Script output is not JSON'); settle(null); }
    });

    proc.on('error', e => {
      clearTimeout(killTimer);
      log(`Script error: ${e.message}`);
      settle(null);
    });
  });
}

// ===== MAIN =====

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData) as ContainerInput;
    try { fs.unlinkSync('/tmp/input.json'); } catch { }
    log(`Input received for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error', result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Load or create session
  const sessionId = containerInput.sessionId || generateSessionId();
  const session: Session = (containerInput.sessionId && loadSession(containerInput.sessionId)) || {
    history: [],
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };

  const systemPrompt = buildSystemPrompt(containerInput);

  // Set up IPC
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - automatic, not from user]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Prepending ${pending.length} pending IPC messages`);
    prompt += '\n' + pending.join('\n');
  }

  // Script phase (scheduled tasks only)
  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);
    if (!scriptResult?.wakeAgent) {
      log(`Script says don't wake agent`);
      writeOutput({ status: 'success', result: null });
      return;
    }
    log('Script wakeAgent=true, enriching prompt');
    prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${containerInput.prompt}`;
  }

  // Query loop: run agent → wait for IPC → run agent → repeat
  try {
    while (true) {
      log(`Starting agent loop (session: ${sessionId})...`);

      const { result, updatedHistory } = await runAgentLoop(
        prompt, containerInput, session.history, systemPrompt,
      );

      session.history = updatedHistory;
      session.lastUpdated = new Date().toISOString();
      saveSession(sessionId, session);

      writeOutput({ status: 'success', result: result || null, newSessionId: sessionId });

      if (shouldClose()) { log('Close sentinel, exiting'); break; }

      log('Waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) { log('Close sentinel received, exiting'); break; }

      log(`Got follow-up message (${nextMessage.length} chars)`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({ status: 'error', result: null, newSessionId: sessionId, error: errorMessage });
    process.exit(1);
  }
}

main();
