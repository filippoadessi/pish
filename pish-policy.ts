// PISH policy — policy di sicurezza, ruoli e audit trail
// -----------------------------------------------------------------------------
// Persiste in ~/.pi/pish/policy.json:
//   rules — [{ id, pattern, action: allow|deny|ask, role? }] (primo match vince)
//   roles — { <utente>: admin|operator|readonly }
// Audit in ~/.pi/pish/audit.log (JSONL): timestamp, utente, direttiva, comando,
// azione, esito.
//
// Comportamento di default:
//   - comandi pericolosi (rm -rf, mkfs, dd, reboot, shutdown, DROP, DELETE...)
//     → ask (conferma)
//   - ruolo readonly → blocca i tool che modificano stato (write/edit/bash
//     con comandi di modifica)
//   - tutto il resto → allow
//
// Comandi: /policy · /policy allow|deny|ask <pattern> · /policy remove <id>
//          /audit [n] · /role <utente> <admin|operator|readonly>
// -----------------------------------------------------------------------------
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PISH_DIR = join(homedir(), ".pi", "pish");
const POLICY_FILE = join(PISH_DIR, "policy.json");
const AUDIT_FILE = join(PISH_DIR, "audit.log");

type Action = "allow" | "deny" | "ask";
interface Rule { id: string; pattern: string; action: Action; role?: string; }
interface Policy { rules: Rule[]; roles: Record<string, string>; }

const DEFAULT_DANGEROUS = [
  "rm -rf", "rm -fr", "mkfs", "dd if=", "shutdown", "reboot", "halt", "poweroff",
  "DROP TABLE", "DROP DATABASE", "DELETE FROM", "TRUNCATE", "docker rm -f",
  "docker system prune", "git push --force", "> /dev/sd", ":(){", "chmod -R 777 /",
  "chown -R", "kill -9 1", "systemctl stop docker", "apt remove", "dnf remove",
];

function loadPolicy(): Policy {
  try {
    if (existsSync(POLICY_FILE)) {
      const d = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
      return { rules: d.rules || [], roles: d.roles || {} };
    }
  } catch { /* corrotto → default */ }
  return { rules: [], roles: {} };
}

function savePolicy(p: Policy): void {
  try {
    mkdirSync(PISH_DIR, { recursive: true });
    writeFileSync(POLICY_FILE, JSON.stringify(p, null, 1), { mode: 0o600 });
  } catch { /* best-effort */ }
}

function audit(entry: Record<string, unknown>): void {
  try {
    mkdirSync(PISH_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* best-effort */ }
}

function globToRegex(pattern: string): RegExp {
  // pattern con * e ? → regex (case-insensitive)
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

function matchRule(p: Policy, command: string, role: string): Rule | undefined {
  for (const r of p.rules) {
    if (r.role && r.role !== role) continue;
    if (globToRegex(r.pattern).test(command)) return r;
  }
  return undefined;
}

function isDangerous(command: string): boolean {
  return DEFAULT_DANGEROUS.some(d => command.toLowerCase().includes(d.toLowerCase()));
}

function isReadOnlyCommand(command: string): boolean {
  // comandi che modificano stato
  const write = /(^|\s)(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|dd|mkfs|mount|umount|kill|pkill|systemctl|service|docker|apt|apt-get|dnf|yum|npm|pip|pip3|git\s+(commit|push|merge|rebase|reset|checkout|clean|tag|branch\s+-[dD]))/;
  return !write.test(command);
}

function currentUser(): string {
  return process.env.SUDO_USER || process.env.USER || "root";
}

// ------------------------------ export --------------------------------------
export default function (pi: any) {
  // intercetta i tool che eseguono comandi
  pi.on("tool_call", async (event: any, ctx: any) => {
    const p = loadPolicy();
    const user = currentUser();
    const role = p.roles[user] || "admin";

    // ruolo readonly: blocca i tool di scrittura
    if (role === "readonly") {
      if (event.toolName === "write" || event.toolName === "edit") {
        audit({ user, tool: event.toolName, action: "deny", reason: "readonly" });
        return { block: true, reason: "Ruolo readonly: scrittura non consentita." };
      }
    }

    if (event.toolName !== "bash") return;
    const command = String(event.input?.command || "");

    // policy esplicita (primo match vince)
    const rule = matchRule(p, command, role);
    if (rule) {
      if (rule.action === "deny") {
        audit({ user, tool: "bash", command, action: "deny", rule: rule.pattern });
        return { block: true, reason: `Bloccato da policy: ${rule.pattern}` };
      }
      if (rule.action === "ask") {
        const ok = await ctx.ui.confirm("Conferma comando", `Eseguire: ${command}`);
        audit({ user, tool: "bash", command, action: ok ? "allow" : "deny", rule: rule.pattern, confirmed: ok });
        if (!ok) return { block: true, reason: "Annullato dall'utente." };
        return;
      }
      // allow
      audit({ user, tool: "bash", command, action: "allow", rule: rule.pattern });
      return;
    }

    // default: pericolosi → ask; readonly → blocca modifiche; altrimenti allow
    if (isDangerous(command)) {
      const ok = await ctx.ui.confirm("Comando pericoloso", `Eseguire: ${command}`);
      audit({ user, tool: "bash", command, action: ok ? "allow" : "deny", reason: "dangerous", confirmed: ok });
      if (!ok) return { block: true, reason: "Annullato dall'utente." };
      return;
    }
    if (role === "readonly" && !isReadOnlyCommand(command)) {
      audit({ user, tool: "bash", command, action: "deny", reason: "readonly" });
      return { block: true, reason: "Ruolo readonly: comando di modifica non consentito." };
    }
    audit({ user, tool: "bash", command, action: "allow", reason: "default" });
  });

  // comandi slash
  pi.registerCommand("policy", {
    description: "Mostra le policy attive. Uso: /policy",
    handler: async (args: string, ctx: any) => {
      const p = loadPolicy();
      const parts = (args || "").trim().split(/\s+/);
      const sub = parts[0] || "";

      if (sub === "allow" || sub === "deny" || sub === "ask") {
        let pattern = parts.slice(1).join(" ");
        // rimuovi virgolette esterne se presenti (es. /policy deny "rm -rf *")
        pattern = pattern.replace(/^["']|["']$/g, "");
        if (!pattern) { ctx.ui.notify(`Uso: /policy ${sub} <pattern> (es. /policy deny "rm -rf *")`, "warn"); return; }
        const id = `r${Date.now().toString(36)}`;
        p.rules.push({ id, pattern, action: sub as Action });
        savePolicy(p);
        audit({ user: currentUser(), action: "policy-add", pattern, decision: sub });
        ctx.ui.notify(`✓ Policy aggiunta: ${sub} "${pattern}"`, "info");
        return;
      }
      if (sub === "remove") {
        const id = parts[1];
        if (!id) { ctx.ui.notify("Uso: /policy remove <id>", "warn"); return; }
        const before = p.rules.length;
        p.rules = p.rules.filter(r => r.id !== id);
        if (p.rules.length === before) { ctx.ui.notify(`✗ Policy non trovata: ${id}`, "warn"); return; }
        savePolicy(p);
        ctx.ui.notify(`✓ Policy rimossa: ${id}`, "info");
        return;
      }

      // mostra
      const roles = Object.entries(p.roles).map(([u, r]) => `${u}=${r}`).join(", ") || "tutti=admin";
      const rules = p.rules.length
        ? p.rules.map(r => `- [${r.id}] ${r.action} "${r.pattern}"${r.role ? ` (${r.role})` : ""}`).join("\n")
        : "- (nessuna policy esplicita — default: pericolosi=ask, resto=allow)";
      ctx.ui.notify(`RUOLI: ${roles}\n\nPOLICY:\n${rules}`, "info");
    },
  });

  pi.registerCommand("role", {
    description: "Imposta il ruolo di un utente. Uso: /role <utente> <admin|operator|readonly>",
    handler: async (args: string, ctx: any) => {
      const parts = (args || "").trim().split(/\s+/);
      const user = parts[0];
      const role = parts[1];
      if (!user || !["admin", "operator", "readonly"].includes(role || "")) {
        ctx.ui.notify("Uso: /role <utente> <admin|operator|readonly>", "warn");
        return;
      }
      const p = loadPolicy();
      p.roles[user] = role;
      savePolicy(p);
      audit({ user: currentUser(), action: "role-set", target: user, role });
      ctx.ui.notify(`✓ Ruolo di ${user} → ${role}`, "info");
    },
  });

  pi.registerCommand("audit", {
    description: "Mostra le ultime voci di audit. Uso: /audit [n]",
    handler: async (args: string, ctx: any) => {
      const n = Math.min(parseInt((args || "").trim() || "10", 10) || 10, 50);
      try {
        if (!existsSync(AUDIT_FILE)) { ctx.ui.notify("Audit vuoto.", "info"); return; }
        const lines = readFileSync(AUDIT_FILE, "utf8").trim().split("\n").filter(Boolean).slice(-n);
        const out = lines.map(l => {
          try {
            const d = JSON.parse(l);
            return `- ${d.ts.slice(11, 19)} ${d.user} ${d.action}${d.command ? `: ${String(d.command).slice(0, 60)}` : ""}${d.rule ? ` [${d.rule}]` : ""}`;
          } catch { return `- ${l.slice(0, 80)}`; }
        }).join("\n");
        ctx.ui.notify(`AUDIT (ultime ${lines.length}):\n${out}`, "info");
      } catch (e) { ctx.ui.notify(`Errore audit: ${e}`, "warn"); }
    },
  });
}
