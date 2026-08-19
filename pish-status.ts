// PISH status — prompt vivo: inietta lo stato del sistema a ogni turno
// -----------------------------------------------------------------------------
// A ogni before_agent_start raccoglie in modo compatto: load, RAM, disco,
// docker, branch git, uptime, servizi critici. Lo aggiunge al system prompt
// così il modello ha SEMPRE il contesto fresco senza che l'utente chieda.
// -----------------------------------------------------------------------------
import { execFile } from "node:child_process";

function run(cmd: string, timeout = 4000): Promise<string> {
  return new Promise((resolve) => {
    execFile("bash", ["-c", cmd], { timeout, maxBuffer: 64 * 1024 }, (err, stdout) => {
      resolve(err ? "" : String(stdout || "").trim());
    });
  });
}

async function collectStatus(): Promise<string> {
  const parts: string[] = [];

  // load + uptime
  const load = await run("cat /proc/loadavg | awk '{print $1, $2, $3}'");
  const cores = await run("nproc");
  if (load) parts.push(`load: ${load} (${cores} core)`);

  // RAM
  const mem = await run("free -h | awk '/Mem:/{print $3\"/\"$2\" used, \"$7\" avail\"}'");
  if (mem) parts.push(`RAM: ${mem}`);

  // disco
  const disk = await run("df -h / | awk 'NR==2{print $5\" used (\"$4\" free)\"}'");
  if (disk) parts.push(`disk /: ${disk}`);

  // docker (se presente)
  const docker = await run("docker ps --format '{{.Names}}' 2>/dev/null | wc -l");
  if (docker && docker !== "0") parts.push(`docker: ${docker} container up`);

  // git branch (se in un repo)
  const git = await run("git rev-parse --abbrev-ref HEAD 2>/dev/null");
  if (git) parts.push(`git: ${git}`);

  // servizi critici (systemd)
  const failed = await run("systemctl --failed --no-legend 2>/dev/null | wc -l");
  if (failed && failed !== "0") parts.push(`⚠ ${failed} servizi falliti`);

  // uptime
  const up = await run("uptime -p 2>/dev/null | sed 's/up //'");
  if (up) parts.push(`up ${up}`);

  return parts.join(" · ");
}

export default function (pi: any) {
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    // solo per input interattivi (non per tool interni)
    if (event.prompt && event.prompt.startsWith("/")) return;

    const status = await collectStatus();
    if (!status) return;

    const block = `\n\n[STATO SISTEMA — aggiornato a questo turno]\n${status}\n`;
    return {
      systemPrompt: event.systemPrompt + block,
    };
  });
}
