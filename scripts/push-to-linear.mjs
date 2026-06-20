#!/usr/bin/env node
/* =============================================================
 * push-to-linear.mjs — Push LINEAR_ISSUES.csv into Linear via
 * the GraphQL API. Set LINEAR_API_KEY (and optionally LINEAR_TEAM)
 * in the environment, then run this once.
 *
 * Usage:
 *   LINEAR_API_KEY=lin_api_... \
 *   LINEAR_TEAM="Engineering" \
 *   node scripts/push-to-linear.mjs
 *
 * Notes:
 *   - Each issue is created with the title, description, and
 *     priority from the CSV. Labels are auto-created if they don't
 *     exist on the team.
 *   - The CSV's ID column is for human reference only; Linear
 *     assigns its own IDs.
 *   - Re-running this script will create duplicate issues. Delete
 *     the first batch or change titles before re-running.
 * ============================================================= */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = resolve(__dirname, '..', 'LINEAR_ISSUES.csv');

const API_KEY  = process.env.LINEAR_API_KEY;
const TEAM_KEY = process.env.LINEAR_TEAM || '';
if (!API_KEY) {
  console.error('LINEAR_API_KEY is required');
  process.exit(1);
}

const PRIORITY = { Urgent: 1, High: 2, Medium: 3, Low: 4, 'No priority': 0 };

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const header = lines.shift().split(',').map(s => s.trim());
  return lines.map(line => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

async function gql(query, variables) {
  const r = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors, null, 2));
  return j.data;
}

const TEAM_QUERY = `
  query { teams { nodes { id name key } } }
`;

async function resolveTeam() {
  const data = await gql(TEAM_QUERY);
  const teams = data.teams.nodes;
  if (TEAM_KEY) {
    const t = teams.find(t => t.key === TEAM_KEY || t.name === TEAM_KEY);
    if (!t) throw new Error(`Team "${TEAM_KEY}" not found`);
    return t;
  }
  if (teams.length === 1) return teams[0];
  throw new Error(`Multiple teams; set LINEAR_TEAM. Found: ${teams.map(t => t.key).join(', ')}`);
}

const LABEL_CACHE = new Map();
async function ensureLabels(teamId, labelCsv) {
  const want = (labelCsv || '').split(';').map(s => s.trim()).filter(Boolean);
  if (want.length === 0) return [];
  const cached = want.map(l => LABEL_CACHE.get(l)).filter(Boolean);
  const missing = want.filter(l => !LABEL_CACHE.has(l));
  if (missing.length === 0) return cached;

  for (const name of missing) {
    let created = null;
    try {
      const data = await gql(`
        mutation($teamId: String!, $name: String!) {
          issueLabelCreate(input: {teamId: $teamId, name: $name, color: "#7c8db5"}) {
            success
            issueLabel { id name }
          }
        }
      `, { teamId, name });
      created = data.issueLabelCreate && data.issueLabelCreate.issueLabel;
    } catch (_) {
      // label already exists — fetch the existing one
      try {
        const q = await gql(`
          query($teamId: String!, $filter: String!) {
            team(id: $teamId) {
              labels(filter: { name: { eqIgnoreCase: $filter } }) { nodes { id name } }
            }
          }
        `, { teamId, filter: name });
        created = (q.team && q.team.labels && q.team.labels.nodes && q.team.labels.nodes[0]) || null;
      } catch {}
    }
    if (created) LABEL_CACHE.set(created.name, created);
  }
  return want.map(l => LABEL_CACHE.get(l));
}

const CREATE_ISSUE = `
  mutation($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier title url }
    }
  }
`;

async function main() {
  const team = await resolveTeam();
  console.log(`using team: ${team.key} (${team.id})`);

  const csv = readFileSync(CSV_PATH, 'utf8');
  const rows = parseCSV(csv);
  console.log(`parsed ${rows.length} issues from CSV`);

  // Pre-fetch existing issues in this team so reruns don't duplicate.
  const existing = new Set();
  try {
    let cursor = null;
    do {
      const data = await gql(`
        query($teamId: String!, $after: String) {
          team(id: $teamId) {
            issues(first: 100, after: $after) {
              nodes { title }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `, { teamId: team.id, after: cursor });
      const conn = data.team && data.team.issues;
      if (conn) {
        for (const n of conn.nodes) existing.add(n.title);
        if (conn.pageInfo.hasNextPage) cursor = conn.pageInfo.endCursor;
        else cursor = null;
      } else cursor = null;
    } while (cursor);
    if (existing.size) console.log(`(${existing.size} existing issues in team — will skip)`);
  } catch (e) {
    console.log('  (could not pre-fetch existing issues, may duplicate): ' + e.message);
  }

  let created = 0, skipped = 0;
  for (const r of rows) {
    if (existing.has(r.Title)) {
      console.log(`  ↩ ${r.Title}  (already exists, skipping)`);
      skipped++;
      continue;
    }
    let labels = [];
    try { labels = await ensureLabels(team.id, r.Labels); }
    catch (e) { console.log('  (label lookup failed, continuing without labels): ' + e.message); }
    const input = {
      teamId: team.id,
      title: r.Title,
      description: r.Description,
      priority: PRIORITY[r.Priority] ?? 0,
    };
    const labelIds = labels.filter(l => l && l.id).map(l => l.id);
    if (labelIds.length) input.labelIds = labelIds;
    const data = await gql(CREATE_ISSUE, { input });
    const issue = data.issueCreate.issue;
    console.log(`  ✓ ${issue.identifier}  ${issue.title}  ${issue.url}`);
  }
  console.log(`\ndone — ${created} created, ${skipped} skipped (of ${rows.length})`);
}

main().catch(e => { console.error(e); process.exit(1); });
