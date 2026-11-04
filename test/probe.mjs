const started = Date.now();
const { getAgentDir } = await import('@earendil-works/pi-coding-agent');
const { loadProject } = await import('../src/model.ts');
const cwd = process.argv[2] ?? process.cwd();
const agentDir = process.argv[3] ?? getAgentDir();
const model = await loadProject(cwd, agentDir);
console.log(JSON.stringify({
  cwd,
  skills: model.rows.filter((row) => row.kind === 'skill').length,
  mcp: model.rows.filter((row) => row.kind === 'mcp').length,
  elapsedMs: Date.now() - started,
}, null, 2));
