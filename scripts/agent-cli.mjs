#!/usr/bin/env node
/* =============================================================
 * agent-cli.mjs — Terminal UX for the autonomous agent.
 *
 * Thin wrapper over agent.mjs with:
 *   - colored log levels
 *   - live spinner on each step
 *   - pretty-printed final report
 *   - SIGINT (Ctrl-C) cleanly aborts the run
 *
 * Usage:
 *   npm run agent:cli -- "find 10 businesses in Jonesboro GA" \
 *     --url https://www.google.com/search?q=landscapers+jonesboro+ga \
 *     --max-steps 25
 *
 * Any flag you don't pass falls back to the env-var auto-detect
 * in agent.mjs (MINIMAX_API_KEY, OPENAI_API_KEY, LLM_PROXY).
 * ============================================================= */

import { runAgent } from '../agent.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COLORS = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
const c = (color, s) => process.stdout.isTTY ? `${COLORS[color]}${s}${COLORS.reset}` : String(s);
const LEVEL_COLOR = { info: 'blue', ok: 'green', warn: 'yellow', error: 'red' };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url')         out.url = argv[++i];
    else if (a === '--max-steps')  out.maxSteps = parseInt(argv[++i], 10);
    else if (a === '--controller') out.controllerUrl = argv[++i];
    else if (a === '--report')     out.report = argv[++i];
    else if (a === '--report-dir') out.reportDir = argv[++i];
    else if (a === '--provider')   out.provider = argv[++i];
    else if (a === '--quiet')      out.quiet = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else out._.push(a);
  }
  return out;
}

function printHelp() {
  console.log(`Usage: npm run agent:cli -- "<goal>" [options]

Options:
  --url <url>          Open this URL in a new tab to start
  --max-steps <n>      Cap on iterations (default 30)
  --controller <url>   Controller WebSocket URL (default ws://127.0.0.1:9223/ws)
  --report <path>      Write the final report JSON to this file
  --report-dir <path>  Write the report to <path>/agent-<ts>.json
  --provider <name>    minimax | openai | proxy | auto
  --quiet              Suppress per-step logs (only show final report)

Examples:
  npm run agent:cli -- "find 10 landscapers in Jonesboro GA"
  npm run agent:cli -- "log in to example.com and check the dashboard" --url https://example.com/login
  LLM_PROXY=1 npm run agent:cli -- "summarize this page"   # uses controller's /llm proxy`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) { printHelp(); process.exit(args.help ? 0 : 2); }
  const goal = args._.join(' ').trim();

  // Pretty logger
  const log = (level, msg) => {
    if (args.quiet && level !== 'ok' && level !== 'error') return;
    const tag = c(LEVEL_COLOR[level] || 'blue', `[${level}]`);
    const t = c('dim', new Date().toISOString().slice(11, 19));
    console.log(`${t} ${tag} ${msg}`);
  };

  // Build the LLM config override from --provider so the user
  // can switch providers per-run.
  const llmConfig = args.provider && args.provider !== 'auto' ? { provider: args.provider } : null;

  // Resolve report path
  let reportPath = args.report;
  if (!reportPath && args.reportDir) {
    await mkdir(args.reportDir, { recursive: true });
    reportPath = resolve(args.reportDir, `agent-${Date.now()}.json`);
  } else if (!reportPath) {
    reportPath = resolve(__dirname, '..', 'logs', `agent-${Date.now()}.json`);
  }

  // Clean shutdown on SIGINT
  let aborted = false;
  process.on('SIGINT', () => {
    if (aborted) { console.error('\nforced exit'); process.exit(130); }
    aborted = true;
    console.error('\n' + c('yellow', 'aborting agent… (Ctrl-C again to force)'));
  });

  log('info', c('bold', `goal: ${goal}`));
  if (args.url) log('info', `start URL: ${args.url}`);
  log('info', `report → ${reportPath}`);

  let report;
  try {
    report = await runAgent({
      goal,
      startUrl: args.url || null,
      maxSteps: args.maxSteps || 30,
      controllerUrl: args.controllerUrl || process.env.CONTROLLER_URL || 'ws://127.0.0.1:9223/ws',
      reportPath,
      llmConfig,
      log,
    });
  } catch (e) {
    log('error', 'fatal: ' + e.message);
    process.exit(1);
  }

  // Pretty final report
  console.log('\n' + c('bold', '──────── FINAL REPORT ────────'));
  console.log(`${c('dim', 'goal:')}     ${report.goal}`);
  console.log(`${c('dim', 'steps:')}    ${report.steps}`);
  console.log(`${c('dim', 'tab:')}      ${report.workingTabId || '(none)'}`);
  console.log(`${c('dim', 'completed:')} ${report.completedAt}`);
  console.log(`${c('dim', 'report:')}   ${reportPath}`);
  console.log('');
  console.log(c('bold', 'Summary:'));
  console.log((report.summary || '(no summary)').split('\n').map(l => '  ' + l).join('\n'));
  console.log('');
  if (report.history && report.history.length) {
    console.log(c('bold', 'Steps:'));
    for (const h of report.history) {
      const status = h.result?.ok === false ? c('red', '✗') : c('green', '✓');
      console.log(`  ${status} ${c('dim', '[' + h.step + ']')} ${h.action.action} ${JSON.stringify(h.action.params).slice(0, 80)}`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
