// Read-only check against the real Codex registration. No project content is logged.
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
const configCommand = process.env.CODEX_CLI_PATH || 'codex';
const configured = spawnSync(configCommand, ['mcp', 'get', 'project_list', '--json'], { encoding: 'utf8', windowsHide: true });
if (configured.status !== 0) throw new Error('Could not read the project_list registration.');
const config = JSON.parse(configured.stdout);
const transport = config.transport;
const child = spawn(transport.command, transport.args, { env: { ...process.env, ...transport.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });
const lines = createInterface({ input: child.stdout });
let id = 0;
const pending = new Map();
lines.on('line', line => { const message = JSON.parse(line); const waiting = pending.get(message.id); if (waiting) { clearTimeout(waiting.timer); pending.delete(message.id); waiting.resolve(message); } });
function call(method, params) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP smoke test timed out: ${stderr}`)), 5000);
    pending.set(requestId, { resolve, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
}
try {
  const initialized = await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'local-read-check', version: '1' } });
  if (initialized.error) throw new Error(initialized.error.message);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const catalog = await call('tools/list', {});
  const read = await call('tools/call', { name: 'list_projects', arguments: {} });
  if (read.error || read.result.isError) throw new Error('Reading the actual local list failed.');
  console.log(JSON.stringify({ registered: config.enabled, protocol: initialized.result.protocolVersion, tools: catalog.result.tools.map(tool => tool.name), localReadSucceeded: true, projectCount: read.result.structuredContent.projects.length }));
} finally { child.stdin.end(); lines.close(); for (const waiting of pending.values()) clearTimeout(waiting.timer); }
