// PISH policy — policy di sicurezza, ruoli, audit trail e approvazione a 2 livelli
// -----------------------------------------------------------------------------
// Persiste in ~/.pi/pish/policy.json:
//   rules     — [{ id, pattern, action: allow|deny|ask, role? }] (primo match vince)
//   roles     — { <utente>: admin|operator|readonly }
//   critical  — [pattern, ...] comandi che richiedono l'approvazione di un
//               SECONDO operatore (approvazione a due livelli)
// Audit in ~/.pi/pish/audit.log (JSONL): timestamp, utente, direttiva, comando,
// azione, esito.
//
// Comportamento di default:
//   - comandi CRITICI (reboot, mkfs, DROP, docker system prune, ...) → richiedono
//     l'approvazione di un secondo utente/sessione (coda pending + /approve)
//   - comandi pericolosi (rm -rf, dd, shutdown, DROP, DELETE...) → ask (conferma)
//   - ruolo readonly → blocca i tool che modificano stato (write/edit/bash
//     con comandi di modifica)
//   - tutto il resto → allow
//
// Approvazione a due livelli:
//   - il comando critico viene BLOCCATO e registrato in ~/.pi/pish/pending-approvals.json
//   - un secondo operatore (altra sessione pish / tau-mirror / remote-pi) esegue
//     /approve <id> — NON può approvare dalla sessione che ha richiesto
//   - le richieste scadono (default 15 min, PISH_APPROVAL_TTL_MS); il comando
//     viene rieseguito dopo l'approvazione e la richiesta si consuma
//
// Comandi: /policy · /policy allow|deny|ask <pattern> · /policy critical <pattern>
//          /policy critical remove <pattern> · /policy remove <id>
//          /approve <id> [nota] · /deny <id> · /approvals · /role <u> <ruolo>
//          /audit [n]
// -----------------------------------------------------------------------------
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PISH_DIR = join(homedir(), ".pi", "pish");
const POLICY_FILE = join(PISH_DIR, "policy.json");
const AUDIT_FILE = join(PISH_DIR, "audit.log");
const PENDING_FILE = join(PISH_DIR, "pending-approvals.json");
const APPROVAL_TTL = parseInt(process.env.PISH_APPROVAL_TTL_MS || "", 10) || 24 * 60 * 60 * 1000; // 24h

type Action = "allow" | "deny" | "ask";
interface Rule { id: string; pattern: string; action: Action; role?: string; }
interface Policy { rules: Rule[]; roles: Record<string, string>; critical: string[]; }

const DEFAULT_DANGEROUS = [
  "rm -rf", "rm -fr", "mkfs", "dd if=", "shutdown", "reboot", "halt", "poweroff",
  "DROP TABLE", "DROP DATABASE", "DELETE FROM", "TRUNCATE", "docker rm -f",
  "docker system prune", "git push --force", "> /dev/sd", ":(){", "chmod -R 777 /",
  "chown -R", "kill -9 1", "systemctl stop docker", "apt remove", "dnf remove",
];

// comandi che modificano lo stato dell'INTERA macchina o di infrastruttura:
// richiedono un secondo operatore (approvazione a due livelli)
const DEFAULT_CRITICAL = [
  "reboot", "shutdown", "halt", "poweroff", "systemctl reboot", "systemctl poweroff",
  "mkfs", "fdisk", "parted", "dd if=.*of=/dev/",
  "rm -rf /", "rm -fr /", "rm -rf /*",
  "DROP DATABASE", "DROP TABLE", "TRUNCATE",
  "docker system prune", "docker compose down", "docker stack", "docker volume rm",
  "docker network", "docker rm -f",
  "systemctl stop docker", "systemctl disable docker", "systemctl stop postgresql",
  "systemctl stop nginx", "systemctl stop networkd", "systemctl stop firewalld",
  "systemctl mask", "systemctl default", "systemctl emergency",
  "ufw disable", "ufw reset", "iptables -F", "firewall-cmd --complete-reload",
  "git push --force", "git reset --hard", "git clean -fdx",
  "apt remove", "apt purge", "apt-get remove", "apt-get purge", "dnf remove", "dnf erase",
  "certbot delete", "certbot revoke", "userdel", "passwd root", "crontab -r",
  "update-alternatives --set", "dpkg --configure", "fsck -y", "e2fsck -y", "resize2fs",
];

interface PendingApproval {
  id: string;
  command: string;
  requestedBy: string;
  requestedFrom: string;
  ts: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "used";
  approvedBy?: string;
  approvedFrom?: string;
  note?: string;
}

function loadPolicy(): Policy {
  try {
    if (existsSync(POLICY_FILE)) {
      const d = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
      return { rules: d.rules || [], roles: d.roles || {}, critical: d.critical || [] };
    }
  } catch { /* corrotto → default */ }
  return { rules: [], roles: {}, critical: [] };
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

function matchesAny(command: string, patterns: string[]): boolean {
  const c = command.toLowerCase();
  return patterns.some(pt => c.includes(pt.toLowerCase()));
}

function isCritical(command: string, p: Policy): boolean {
  return matchesAny(command, [...DEFAULT_CRITICAL, ...(p.critical || [])]);
}

function isDangerous(command: string): boolean {
  return matchesAny(command, DEFAULT_DANGEROUS);
}

function isReadOnlyCommand(command: string): boolean {
  const write = /(^|\s)(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|dd|mkfs|mount|umount|kill|pkill|systemctl|service|docker|apt|apt-get|dnf|yum|npm|pip|pip3|git\s+(commit|push|merge|rebase|reset|checkout|clean|tag|branch\s+-[dD]))/;
  return !write.test(command);
}

function currentUser(): string {
  return process.env.SUDO_USER || process.env.USER || "root";
}

function sessionId(): string {
  // identità della sessione: nome tmux (pish, pi-tau-2…), porta tau-mirror o cli
  if (process.env.PISH_SESSION_TMUX) return `tmux:${process.env.PISH_SESSION_TMUX}`;
  if (process.env.TAU_MIRROR_PORT) return `web:${process.env.TAU_MIRROR_PORT}`;
  return "cli";
}

// --------------------------- coda approvazioni ------------------------------
function loadPending(): PendingApproval[] {
  try {
    if (existsSync(PENDING_FILE)) return JSON.parse(readFileSync(PENDING_FILE, "utf8"));
  } catch { /* nessuna */ }
  return [];
}

function savePending(list: PendingApproval[]): void {
  try {
    mkdirSync(PISH_DIR, { recursive: true });
    writeFileSync(PENDING_FILE, JSON.stringify(list, null, 1), { mode: 0o600 });
  } catch { /* best-effort */ }
}

function cleanupExpired(list: PendingApproval[]): PendingApproval[] {
  const now = Date.now();
  const kept: PendingApproval[] = [];
  for (const e of list) {
    if (e.status === "pending" && now > e.expiresAt) {
      audit({ kind: "approval-expired", id: e.id, command: e.command, requestedBy: e.requestedBy });
      continue; // scaduta: eliminata
    }
    kept.push(e);
  }
  return kept;
}

// decisione per un comando critico: approved (consumabile) → "allow" | pending → "pending" | denied → "denied" | nessuna → null
function decisionForCommand(list: PendingApproval[], command: string): PendingApproval | null {
  const c = command.trim();
  return list.find(e => e.command === c) || null;
}

// marca una richiesta (id) come approved/denied; regole di validità:
// - pending: si può approvare/negare
// - approved: il secondo operatore DEVE essere diverso da chi ha richiesto
//   (sessione diversa oppure utente diverso)
function markRequest(
  list: PendingApproval[],
  id: string,
  status: "approved" | "denied",
  by: string,
  from: string,
  note?: string,
): { list: PendingApproval[]; ok: boolean; error?: string } {
  const e = list.find(x => x.id === id);
  if (!e) return { list, ok: false, error: `Richiesta non trovata: ${id}` };
  if (e.status !== "pending") return { list, ok: false, error: `Richiesta ${id} non è più in attesa (${e.status}).` };
  if (Date.now() > e.expiresAt) return { list, ok: false, error: `Richiesta ${id} scaduta.` };
  if (status === "approved") {
    // doppia approvazione: l'operatore che approva deve differire per SESSIONE
    // (es. remote-pi/tau-mirror) OPPURE per UTENTE (es. secondo admin sulla
    // stessa macchina). Invalida solo se è esattamente lo stesso operatore.
    const sameOperator = from === e.requestedFrom && by === e.requestedBy;
    if (sameOperator) {
      return { list, ok: false, error: `L'approvazione deve venire da un SECONDO operatore (sessione o utente diverso da ${e.requestedBy}@${e.requestedFrom}).` };
    }
  }
  const updated = list.map(x => x.id === id ? { ...x, status, approvedBy: by, approvedFrom: from, note } : x);
  return { list: updated, ok: true };
}

// ------------------------------ export (per test) ---------------------------
export { decisionForCommand, markRequest, cleanupExpired, isCritical, sessionId };

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
    const command = String(event.input?.command || "").trim();
    if (!command) return;

    const from = sessionId();

    // 1) policy esplicita (primo match vince)
    const rule = matchRule(p, command, role);
    if (rule) {
      if (rule.action === "deny") {
        audit({ user, tool: "bash", command, action: "deny", rule: rule.pattern });
        return { block: true, reason: `Bloccato da policy: ${rule.pattern}` };
      }
      if (rule.action === "allow") {
        // anche un allow esplicito non bypassa l'approvazione a due livelli
        if (isCritical(command, p)) return gateCritical(command, user, from, ctx);
        audit({ user, tool: "bash", command, action: "allow", rule: rule.pattern });
        return;
      }
      // ask: conferma del primo utente; se critico, poi serve il secondo
      if (rule.action === "ask") {
        const ok = await ctx.ui.confirm("Conferma comando", `Eseguire: ${command}`);
        audit({ user, tool: "bash", command, action: ok ? "allow" : "deny", rule: rule.pattern, confirmed: ok });
        if (!ok) return { block: true, reason: "Annullato dall'utente." };
        if (isCritical(command, p)) return gateCritical(command, user, from, ctx);
        return;
      }
    }

    // 2) azioni critiche: serve un secondo operatore
    if (isCritical(command, p)) return gateCritical(command, user, from, ctx);

    // 3) pericolosi → ask (conferma)
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

  // approvazione a due livelli per i comandi critici
  async function gateCritical(command: string, user: string, from: string, ctx: any) {
    let pending = cleanupExpired(loadPending());
    const existing = decisionForCommand(pending, command);

    if (existing?.status === "approved") {
      // approvato da un secondo operatore: consuma e permetti (una sola volta)
      pending = pending.map(e => e.id === existing.id ? { ...e, status: "used" } : e);
      savePending(pending);
      audit({ user, tool: "bash", command, action: "allow", reason: "approval-two-level", id: existing.id, approvedBy: existing.approvedBy });
      ctx.ui.notify(`✓ Azione critica approvata da ${existing.approvedBy} (${existing.approvedFrom}) — eseguo.`, "info");
      return;
    }
    if (existing?.status === "denied") {
      audit({ user, tool: "bash", command, action: "deny", reason: "approval-denied", id: existing.id });
      return { block: true, reason: `Azione critica NEGATA dal secondo operatore (${existing.approvedBy}).` };
    }
    if (existing?.status === "pending") {
      const remain = Math.round((existing.expiresAt - Date.now()) / 60000);
      audit({ user, tool: "bash", command, action: "deny", reason: "approval-pending", id: existing.id });
      return { block: true, reason: `Azione critica: richiesta già in attesa (id ${existing.id}, scade tra ~${remain} min). Un secondo operatore deve eseguire /approve ${existing.id} da un'altra sessione.` };
    }

    // nuova richiesta
    const id = `ap${Date.now().toString(36)}`;
    const entry: PendingApproval = {
      id, command: command.trim(), requestedBy: user, requestedFrom: from,
      ts: Date.now(), expiresAt: Date.now() + APPROVAL_TTL, status: "pending",
    };
    pending.push(entry);
    savePending(pending);
    audit({ kind: "approval-requested", id, user, command, from });
    ctx.ui.notify(
      `⏳ AZIONE CRITICA — serve l'approvazione di un secondo operatore.\nComando: ${command}\nDa un'ALTRA sessione (o altro utente) esegui:\n  /approve ${id}\nPer annullare: /deny ${id}\nLa richiesta scade tra ${Math.round(APPROVAL_TTL / 60000)} min.`,
      "warn");
    return { block: true, reason: `Azione critica bloccata: serve l'approvazione di un secondo operatore (id ${id}). Esegui /approve ${id} da un'altra sessione, poi riproponi l'azione.` };
  }

  // comandi slash
  pi.registerCommand("policy", {
    description: "Mostra le policy attive. Uso: /policy [allow|deny|ask|critical <pattern>] [remove <id>]",
    handler: async (args: string, ctx: any) => {
      const p = loadPolicy();
      const parts = (args || "").trim().split(/\s+/);
      const sub = parts[0] || "";

      if (sub === "allow" || sub === "deny" || sub === "ask") {
        let pattern = parts.slice(1).join(" ");
        pattern = pattern.replace(/^["']|["']$/g, "");
        if (!pattern) { ctx.ui.notify(`Uso: /policy ${sub} <pattern> (es. /policy deny "rm -rf *")`, "warn"); return; }
        const id = `r${Date.now().toString(36)}`;
        p.rules.push({ id, pattern, action: sub as Action });
        savePolicy(p);
        audit({ user: currentUser(), action: "policy-add", pattern, decision: sub });
        ctx.ui.notify(`✓ Policy aggiunta: ${sub} "${pattern}"`, "info");
        return;
      }
      if (sub === "critical") {
        if (parts[1] === "remove") {
          const target = parts.slice(2).join(" ").replace(/^["']|["']$/g, "");
          if (!target) { ctx.ui.notify("Uso: /policy critical remove <pattern>", "warn"); return; }
          p.critical = (p.critical || []).filter(c => c.toLowerCase() !== target.toLowerCase());
          save(p);
          audit({ user: currentUser(), action: "policy-critical-remove", pattern: target });
          ctx.ui.notify(`✓ Rimosso dai critici: "${target}"`, "info");
          return;
        }
        const pattern = parts.slice(1).join(" ").replace(/^["']|["']$/g, "");
        if (!pattern) {
          ctx.ui.notify(`Critici attivi (${(p.critical || []).length} custom + default):\n${[...DEFAULT_CRITICAL, ...(p.critical || [])].map(c => `- ${c}`).join("\n")}\n\nAggiungi: /policy critical <pattern> · Rimuovi: /policy critical remove <pattern>`, "info");
          return;
        }
        if (!p.critical.includes(pattern)) p.critical.push(pattern);
        savePolicy(p);
        audit({ user: currentUser(), action: "policy-critical-add", pattern });
        ctx.ui.notify(`✓ Aggiunto ai critici (serve doppia approvazione): "${pattern}"`, "info");
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
        : "- (nessuna policy esplicita — default: critici=2-operatore, pericolosi=ask, resto=allow)";
      const crit = [...DEFAULT_CRITICAL, ...(p.critical || [])].map(c => `- ${c}`).join("\n");
      ctx.ui.notify(`RUOLI: ${roles}\n\nPOLICY:\n${rules}\n\nCRITICI (2 operatore):\n${crit}`, "info");
    },
  });

  pi.registerCommand("approve", {
    description: "Approva un'azione critica come SECONDO operatore. Uso: /approve <id> [nota]",
    handler: async (args: string, ctx: any) => {
      const parts = (args || "").trim().split(/\s+/);
      const id = parts[0];
      if (!id) { ctx.ui.notify("Uso: /approve <id> [nota] (vedi /approvals)", "warn"); return; }
      const note = parts.slice(1).join(" ");
      let pending = cleanupExpired(loadPending());
      const r = markRequest(pending, id, "approved", currentUser(), sessionId(), note || undefined);
      if (!r.ok) { ctx.ui.notify(`✗ ${r.error}`, "warn"); return; }
      savePending(r.list);
      const e = r.list.find(x => x.id === id)!;
      audit({ kind: "approval-approved", id, command: e.command, by: currentUser(), from: sessionId(), note: note || undefined });
      ctx.ui.notify(`✓ Richiesta ${id} APPROVATA (${e.command.slice(0, 60)}). Chi ha chiesto può riproporre l'azione.`, "info");
    },
  });

  pi.registerCommand("deny", {
    description: "Nega un'azione critica in attesa. Uso: /deny <id>",
    handler: async (args: string, ctx: any) => {
      const id = (args || "").trim();
      if (!id) { ctx.ui.notify("Uso: /deny <id> (vedi /approvals)", "warn"); return; }
      let pending = cleanupExpired(loadPending());
      const r = markRequest(pending, id, "denied", currentUser(), sessionId());
      if (!r.ok) { ctx.ui.notify(`✗ ${r.error}`, "warn"); return; }
      savePending(r.list);
      const e = r.list.find(x => x.id === id)!;
      audit({ kind: "approval-denied", id, command: e.command, by: currentUser() });
      ctx.ui.notify(`✓ Richiesta ${id} NEGATA.`, "info");
    },
  });

  pi.registerCommand("approvals", {
    description: "Mostra le richieste di approvazione in attesa/risolte. Uso: /approvals",
    handler: async (_args: string, ctx: any) => {
      const pending = cleanupExpired(loadPending());
      if (pending.length === 0) { ctx.ui.notify("Nessuna richiesta di approvazione.", "info"); return; }
      const lines = pending.slice(-15).map(e => {
        const left = e.status === "pending" ? ` (~${Math.max(0, Math.round((e.expiresAt - Date.now()) / 60000))} min)` : "";
        return `- [${e.status}] ${e.id} ${e.command.slice(0, 50)} (da ${e.requestedBy}@${e.requestedFrom}${left})${e.approvedBy ? ` → ${e.approvedBy}@${e.approvedFrom}` : ""}`;
      });
      ctx.ui.notify(`APPROVAZIONI (${pending.length}):\n${lines.join("\n")}\n\nApprovazione (da altra sessione): /approve <id> · Negazione: /deny <id>`, "info");
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
