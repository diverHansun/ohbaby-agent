export type PromptSecuritySeverity = "low" | "high" | "critical";
export type PromptSecurityAction = "allow" | "warn" | "omit";

export type PromptSecurityCategory =
  | "deception"
  | "hidden_content"
  | "instruction_override"
  | "secret_exfiltration"
  | "unsafe_execution";

export interface PromptSecuritySource {
  readonly kind:
    | "custom-instructions"
    | "memory"
    | "tool-description"
    | "unknown";
  readonly label: string;
  readonly path?: string;
}

export interface PromptSecurityFinding {
  readonly severity: PromptSecuritySeverity;
  readonly category: PromptSecurityCategory;
  readonly patternId: string;
  readonly message: string;
  readonly sourcePath?: string;
  readonly sourceLabel: string;
  readonly line: number;
  readonly action: PromptSecurityAction;
}

export interface PromptSecurityScanResult {
  readonly action: PromptSecurityAction;
  readonly findings: readonly PromptSecurityFinding[];
}

interface PromptSecurityRule {
  readonly patternId: string;
  readonly category: PromptSecurityCategory;
  readonly severity: PromptSecuritySeverity;
  readonly message: string;
  readonly pattern: RegExp;
}

const RULES: readonly PromptSecurityRule[] = [
  {
    category: "instruction_override",
    message: "The file asks the model to ignore higher-priority instructions.",
    pattern: /\bignore\s+(?:previous|all|above|prior)\s+instructions\b/i,
    patternId: "ignore_previous_instructions",
    severity: "critical",
  },
  {
    category: "instruction_override",
    message: "The file declares a system prompt override.",
    pattern: /\bsystem\s+prompt\s+override\b/i,
    patternId: "system_prompt_override",
    severity: "critical",
  },
  {
    category: "instruction_override",
    message: "The file tells the model to disregard its rules or guidelines.",
    pattern:
      /\bdisregard\s+(?:your|all|any)\s+(?:instructions|rules|guidelines)\b/i,
    patternId: "disregard_rules",
    severity: "critical",
  },
  {
    category: "deception",
    message: "The file tries to hide behavior from the user.",
    pattern: /\bdo\s+not\s+tell\s+the\s+user\b/i,
    patternId: "hide_from_user",
    severity: "high",
  },
  {
    category: "instruction_override",
    message: "The file asks the model to act as if restrictions do not apply.",
    pattern:
      /\bact\s+as\s+(?:if|though)\s+you\s+(?:have\s+no|don'?t\s+have)\s+(?:restrictions|limits|rules)\b/i,
    patternId: "bypass_restrictions",
    severity: "high",
  },
  {
    category: "hidden_content",
    message: "The file hides suspicious instructions inside an HTML comment.",
    pattern: /<!--[\s\S]*?(?:ignore|override|system|secret|hidden)[\s\S]*?-->/i,
    patternId: "hidden_html_comment",
    severity: "high",
  },
  {
    category: "hidden_content",
    message: "The file hides content with display:none HTML.",
    pattern:
      /<\s*div\b[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>/i,
    patternId: "hidden_html_display_none",
    severity: "high",
  },
  {
    category: "unsafe_execution",
    message: "The file asks the model to translate content and execute it.",
    pattern: /\btranslate\b[\s\S]*?\b(?:execute|run|eval)\b/i,
    patternId: "translate_and_execute",
    severity: "high",
  },
  {
    category: "secret_exfiltration",
    message:
      "The file attempts to send secrets or credentials over the network.",
    pattern:
      /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^\n]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    patternId: "exfiltrate_secret",
    severity: "critical",
  },
  {
    category: "secret_exfiltration",
    message: "The file asks to read local secret files.",
    pattern:
      /\b(?:cat|type|Get-Content)\b[^\n]*(?:\.env|credentials|\.netrc|\.pgpass)/i,
    patternId: "read_secret_file",
    severity: "critical",
  },
  {
    category: "hidden_content",
    message: "The file contains invisible Unicode control characters.",
    pattern:
      /\u200B|\u200C|\u200D|\u2060|\uFEFF|\u202A|\u202B|\u202C|\u202D|\u202E/u,
    patternId: "invisible_unicode",
    severity: "low",
  },
];

export function scanPromptLikeContent(
  content: string,
  source: PromptSecuritySource,
): PromptSecurityScanResult {
  const findings = RULES.flatMap((rule) =>
    findRuleMatches(content, source, rule),
  );

  return {
    action: summarizeAction(findings),
    findings,
  };
}

export function shouldLoadPromptLikeContent(
  result: PromptSecurityScanResult,
): boolean {
  return result.action !== "omit";
}

function findRuleMatches(
  content: string,
  source: PromptSecuritySource,
  rule: PromptSecurityRule,
): PromptSecurityFinding[] {
  const matches: PromptSecurityFinding[] = [];
  const pattern = new RegExp(
    rule.pattern.source,
    rule.pattern.flags.includes("g")
      ? rule.pattern.flags
      : `${rule.pattern.flags}g`,
  );
  const seenLines = new Set<number>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const line = lineForIndex(content, match.index);
    if (!seenLines.has(line)) {
      seenLines.add(line);
      matches.push({
        action: actionForSeverity(rule.severity),
        category: rule.category,
        line,
        message: rule.message,
        patternId: rule.patternId,
        severity: rule.severity,
        sourceLabel: source.label,
        sourcePath: source.path,
      });
    }
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
    }
  }

  return matches;
}

function actionForSeverity(
  severity: PromptSecuritySeverity,
): PromptSecurityAction {
  return severity === "low" ? "warn" : "omit";
}

function summarizeAction(
  findings: readonly PromptSecurityFinding[],
): PromptSecurityAction {
  if (findings.some((finding) => finding.action === "omit")) {
    return "omit";
  }
  if (findings.some((finding) => finding.action === "warn")) {
    return "warn";
  }
  return "allow";
}

function lineForIndex(content: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content[cursor] === "\n") {
      line += 1;
    }
  }
  return line;
}
