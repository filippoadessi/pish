// PISH hybrid — modalità ibrida: comando E direttiva + orchestrazione multicore
// -----------------------------------------------------------------------------
// 1) MODALITÀ IBRIDA: l'input che inizia con un comando noto (ls, docker,
//    systemctl, git, df, ...) viene eseguito DIRETTAMENTE via pi.exec e l'output
//    mostrato nel TUI — zero token LLM. Tutto il resto è una direttiva in
//    linguaggio naturale per il modello.
// 2) ORCHESTRAZIONE MULTICORE: /spawn istanzia sessioni pi worker in tmux
//    (collegate al mesh remote-pi), /workers le elenca, /send invia un task a
//    un worker via tmux send-keys (il worker risponde nel mesh/intercom).
// -----------------------------------------------------------------------------
import { execFile } from "node:child_process";

// Comandi noti: eseguiti direttamente (pass-through a bash)
const KNOWN_COMMANDS = new Set([
  // shell builtins / navigazione
  "ls", "cd", "pwd", "cat", "echo", "head", "tail", "grep", "find", "which",
  "whoami", "id", "date", "uname", "hostname", "env", "export", "history",
  // sistema
  "df", "du", "free", "ps", "top", "htop", "uptime", "vmstat", "iostat",
  "ss", "netstat", "ip", "ping", "curl", "wget", "nslookup", "dig",
  // file
  "mkdir", "rmdir", "touch", "cp", "mv", "rm", "chmod", "chown", "ln",
  "tar", "zip", "unzip", "gzip", "gunzip", "xz", "file", "stat", "tree",
  // git
  "git", "git-status", "git-log", "git-diff", "git-branch", "git-commit",
  // docker / systemd
  "docker", "docker-compose", "systemctl", "journalctl", "service",
  // package manager
  "apt", "apt-get", "dnf", "yum", "npm", "npx", "pip", "pip3", "cargo",
  // rete / ssh
  "ssh", "scp", "rsync", "nc", "telnet",
  // editor / vari
  "vim", "nano", "less", "more", "sort", "uniq", "wc", "cut", "awk", "sed",
  "xargs", "tee", "diff", "patch", "make", "cmake", "node", "python3",
  "python", "bash", "sh", "zsh", "crontab", "at", "nohup", "screen", "tmux",
]);

// Comandi pericolosi: richiedono conferma prima dell'esecuzione diretta
const DANGEROUS = /^(rm\s+-rf|rm\s+-fr|mkfs|dd\s|shutdown|reboot|halt|poweroff|:\(\)|>\/dev\/sda)/;

const WORKER_PREFIX = "pi-worker-";

function runCmd(args: string[], opts: { timeout?: number } = {}): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile("bash", ["-c", args.join(" ")], { timeout: opts.timeout ?? 30000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout || ""), err: String(stderr || "") });
      });
  });
}

// ------------------------- 1) MODALITÀ IBRIDA ------------------------------
function isKnownCommand(text: string): string | null {
  const t = text.trim();
  if (!t || t.startsWith("/") || t.startsWith("!")) return null;
  // primo token (gestisce anche "sudo ls", "docker ps", "git status")
  const [first] = t.split(/\s+/);
  if (first === "sudo" || first === "time") {
    const [, second] = t.split(/\s+/);
    if (KNOWN_COMMANDS.has(second)) return t;
    return null;
  }
  if (KNOWN_COMMANDS.has(first)) return t;
  return null;
}

async function handleHybrid(event: any, ctx: any): Promise<any> {
  const text = event.text;
  const cmd = isKnownCommand(text);
  if (!cmd) return { action: "continue" }; // direttiva NL → modello

  // conferma per comandi pericolosi
  if (DANGEROUS.test(cmd)) {
    const ok = await ctx.ui.confirm("Comando pericoloso", `Eseguire: ${cmd}`);
    if (!ok) {
      ctx.ui.notify("Annullato.", "warn");
      return { action: "handled" };
    }
  }

  ctx.ui.notify(`$ ${cmd}`, "info");
  const r = await runCmd([cmd]);
  const out = (r.out + (r.err ? `\n${r.err}` : "")).trim();
  const preview = out.length > 4000 ? out.slice(0, 4000) + `\n… (${out.length - 4000} caratteri in più)` : out;
  ctx.ui.notify(preview || "(nessun output)", r.ok ? "info" : "warn");
  return { action: "handled" };
}

// --------------------- 2) ORCHESTRAZIONE MULTICORE --------------------------
async function spawnWorker(name: string, task: string, ctx: any): Promise<void> {
  const sname = `${WORKER_PREFIX}${name}`;
  const exists = await runCmd(["tmux has-session -t", `'${sname}'`, "2>/dev/null && echo yes"]);
  if (exists.out.trim() === "yes") {
    ctx.ui.notify(`✗ worker ${name} già attivo (tmux: ${sname})`, "warn");
    return;
  }
  // istanzia una sessione pi worker in tmux, collegata al mesh remote-pi
  const launch = `tmux new-session -d -s '${sname}' "pi --name ${name} --append-system-prompt 'Sei un worker PISH orchestrato dalla shell principale. Ricevi task via intercom/messaggi e rispondi con il risultato. Non avviare team/crew.'"`;
  const r = await runCmd([launch]);
  if (!r.ok) {
    ctx.ui.notify(`✗ spawn fallito: ${r.err}`, "warn");
    return;
  }
  ctx.ui.notify(`✓ worker ${name} avviato (tmux: ${sname})`, "info");
  // se c'è un task iniziale, invialo dopo che pi è pronto
  if (task) {
    setTimeout(async () => {
      const safe = task.split('"').join('\\"');
      await runCmd([`tmux send-keys -t '${sname}'`, `"${safe}"`, "Enter"]);
    }, 12000);
    ctx.ui.notify(`  task inviato a ${name}: ${task.slice(0, 80)}`, "info");
  }
}

async function listWorkers(ctx: any): Promise<void> {
  const r = await runCmd(["tmux ls 2>/dev/null | grep", `'${WORKER_PREFIX}'`, "|| true"]);
  const lines = r.out.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    ctx.ui.notify("Nessun worker attivo. Usa /spawn <nome> [task]", "info");
    return;
  }
  ctx.ui.notify(`Workers attivi:\n${lines.join("\n")}`, "info");
}

async function sendToWorker(name: string, msg: string, ctx: any): Promise<void> {
  const sname = `${WORKER_PREFIX}${name}`;
  const exists = await runCmd(["tmux has-session -t", `'${sname}'`, "2>/dev/null && echo yes"]);
  if (exists.out.trim() !== "yes") {
    ctx.ui.notify(`✗ worker ${name} non attivo`, "warn");
    return;
  }
  const safe = msg.split('"').join('\\"');
  await runCmd([`tmux send-keys -t '${sname}'`, `"${safe}"`, "Enter"]);
  ctx.ui.notify(`→ task inviato a ${name}`, "info");
}

async function killWorker(name: string, ctx: any): Promise<void> {
  const sname = `${WORKER_PREFIX}${name}`;
  const r = await runCmd([`tmux kill-session -t '${sname}'`, "2>/dev/null && echo ok"]);
  ctx.ui.notify(r.out.trim() === "ok" ? `✓ worker ${name} terminato` : `✗ worker ${name} non trovato`, r.out.trim() === "ok" ? "info" : "warn");
}

// ------------------------------ export --------------------------------------
export default function (pi: any) {
  // modalità ibrida: intercetta l'input utente
  pi.on("input", async (event: any, ctx: any) => {
    if (event.source === "extension") return { action: "continue" };
    return handleHybrid(event, ctx);
  });

  // orchestrazione multicore
  pi.registerCommand("spawn", {
    description: "Istanzia un worker pi in tmux (orchestrabile via intercom). Uso: /spawn <nome> [task]",
    handler: async (args: string, ctx: any) => {
      const parts = (args || "").split(/\s+/);
      const name = parts[0];
      if (!name) { ctx.ui.notify("Uso: /spawn <nome> [task]", "warn"); return; }
      const task = parts.slice(1).join(" ");
      await spawnWorker(name, task, ctx);
    },
  });

  pi.registerCommand("workers", {
    description: "Elenca i worker pi attivi",
    handler: async (_args: string, ctx: any) => { await listWorkers(ctx); },
  });

  pi.registerCommand("send", {
    description: "Invia un task a un worker. Uso: /send <nome> <messaggio>",
    handler: async (args: string, ctx: any) => {
      const parts = (args || "").split(/\s+/);
      const name = parts[0];
      if (!name || parts.length < 2) { ctx.ui.notify("Uso: /send <nome> <messaggio>", "warn"); return; }
      await sendToWorker(name, parts.slice(1).join(" "), ctx);
    },
  });

  pi.registerCommand("kill", {
    description: "Termina un worker. Uso: /kill <nome>",
    handler: async (args: string, ctx: any) => {
      const name = (args || "").trim();
      if (!name) { ctx.ui.notify("Uso: /kill <nome>", "warn"); return; }
      await killWorker(name, ctx);
    },
  });
}
