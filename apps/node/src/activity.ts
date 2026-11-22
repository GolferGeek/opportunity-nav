import { object, string } from "./system.ts";

export function redact(text: string): string {
  return text
    .replace(/\b(?:sk-|opn_|gh[pousr]_|github_pat_|xox[a-z]*[-_]?|AIza|ya29\.)[\w.-]+/gi, "[redacted]")
    .replace(/\bBearer\s+[^\s"'\x60]+/gi, "Bearer [redacted]")
    .replace(/(\b[\w-]*(?:token|secret|password|api[_-]?key|credentials)[\w-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?(?:-----END [^-]+PRIVATE KEY-----|$)/g, "[redacted]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]")
    .replace(/[A-Za-z0-9+_/-]{40,}={0,2}/g, value =>
      /\/$|[+=]/.test(value) || /[A-Z]/.test(value) && /[0-9]/.test(value) ? "[redacted]" : value)
    .replace(/[A-Za-z0-9+]{40,}|[A-Za-z0-9_-]{40,}/g, "[redacted]");
}

export function shortText(value: unknown, limit = 300): string | undefined {
  const text = string(value);
  return text ? redact(text).replace(/\s+/g, " ").slice(0, limit) : undefined;
}

export function toolLine(rawName: unknown, rawInput: unknown): string | undefined {
  const name = string(rawName)?.toLowerCase().replace(/[- ]/g, "_");
  const input = object(rawInput);
  const path = shortText(input.file_path ?? input.path ?? input.filename ?? input.Path ?? input.RelativePath ?? input.AbsolutePath ?? input.TargetFile);
  const command = shortText(string(input.command ?? input.cmd ?? input.CommandLine)?.split(/\r?\n/, 1)[0], 120);
  const query = shortText(input.pattern ?? input.query ?? input.Query ?? input.SearchQuery ?? input.Pattern);
  switch (name) {
    case "bash": case "run_command": case "shell": case "terminal":
      return command ? `Ran: ${command}` : "Ran a command";
    case "read": case "read_file": case "view_file":
      return path ? `Read ${path}` : "Read a file";
    case "edit": case "multiedit": case "write": case "edit_file": case "write_file": case "apply_patch":
    case "replace_file_content": case "multi_replace_file_content": case "write_to_file":
      return path ? `Edited ${path}` : "Edited a file";
    case "grep": case "glob": case "grep_search": case "find_by_name": case "websearch":
    case "search": case "search_web":
      return query ? `Searched for ${query}` : "Searched";
    case "ls": case "list_dir": return path ? `Listed ${path}` : "Listed files";
    case "agent": case "task": return "Started a subtask";
    case "webfetch": return "Opened a web page";
    default: {
      const label = name && /^[a-z][a-z_]{0,59}$/.test(name) ? name.replaceAll("_", " ") : undefined;
      return label ? `Used ${label}` : undefined;
    }
  }
}

export function claudeActivity(event: Record<string, unknown>): string[] {
  const blocks = object(event.message).content;
  if (event.type !== "assistant" || !Array.isArray(blocks)) return [];
  return blocks.flatMap(raw => {
    const block = object(raw);
    const text = block.type === "tool_use" ? toolLine(block.name, block.input)
      : block.type === "text" ? shortText(block.text) : undefined;
    return text ? [text] : [];
  });
}

export function codexActivity(event: Record<string, unknown>): string[] {
  const item = object(event.item);
  if (event.type === "item.started" && item.type === "command_execution") {
    return [toolLine("shell", item)!];
  }
  if (event.type !== "item.completed") return [];
  if (item.type === "agent_message") {
    const text = shortText(item.text);
    return text ? [text] : [];
  }
  if (item.type === "web_search") return [toolLine("search", item)!];
  if (item.type === "file_change" && Array.isArray(item.changes)) {
    return item.changes.map(change => toolLine("edit", object(change))!);
  }
  return [];
}
