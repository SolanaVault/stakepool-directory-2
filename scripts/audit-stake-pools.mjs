/**
 * Weekly freshness audit for data/stake-pools.json.
 *
 * For each directory entry we re-fetch the page it links to. Claude first
 * proposes field-level corrections, then a separate Claude
 * call judges whether each proposal changes the meaning or merely rewrites
 * the same information. Only meaningfully different, well-supported
 * corrections are written back to the JSON. The workflow turns a dirty
 * working tree into a pull request.
 *
 * Deliberately dependency-free (plain fetch) so CI needs no install
 * step, and deliberately conservative: a page we cannot fetch, or a
 * verdict the model is unsure about, never rewrites stored data.
 *
 * Env:
 *   ANTHROPIC_API_KEY  required
 *   AUDIT_MODEL        optional, defaults to claude-sonnet-5
 *   AUDIT_JUDGE_MODEL  optional, defaults to AUDIT_MODEL
 *   AUDIT_REPORT       optional, path for the markdown report
 */

import { readFile, writeFile } from 'node:fs/promises';

const DATA_PATH = new URL('../stake-pools.json', import.meta.url);
const REPORT_PATH = process.env.AUDIT_REPORT ?? 'stake-pool-audit.md';
const MODEL = process.env.AUDIT_MODEL ?? 'claude-sonnet-5';
const JUDGE_MODEL = process.env.AUDIT_JUDGE_MODEL ?? MODEL;
const API_KEY = process.env.ANTHROPIC_API_KEY;

/** Page text beyond this is noise for our purposes and costs tokens. */
const MAX_PAGE_CHARS = 14_000;
const FETCH_TIMEOUT_MS = 20_000;

/** Thrown when the key is out of credit — we stop cleanly, not loudly. */
class OutOfCreditError extends Error {}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Some doc hosts serve a JS shell or 403 to unknown agents.
        'user-agent':
          'Mozilla/5.0 (compatible; validator-metrics-directory-audit/1.0; +https://github.com/SolanaVault/stakepool-directory)',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, text: '' };
    }
    const html = await res.text();
    return { ok: true, status: res.status, text: htmlToText(html) };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Several pool doc hosts sit behind Cloudflare and refuse scripted
 * requests outright. That is not link rot, and reporting it as such
 * every week trains everyone to ignore the report — so a refusal is
 * called out as "blocked" and kept distinct from a genuine 404.
 */
const BLOCKED_STATUSES = new Set([401, 403, 405, 406, 429, 503]);

function classify(res) {
  if (res.ok) return 'ok';
  if (BLOCKED_STATUSES.has(res.status)) return 'blocked';
  if (res.status === 0) return 'error';
  return 'broken';
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PAGE_CHARS);
}

const FIELD_NAMES = ['summary', 'howToApply', 'requirements', 'url'];

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      maxItems: FIELD_NAMES.length,
      description: 'Candidate field changes. Return an empty array when no field needs changing.',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: FIELD_NAMES },
          replacement: {
            description: 'The complete replacement value for this field.',
            anyOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
          evidence: {
            type: 'string',
            description: 'A short quote or close paraphrase of the page text supporting this replacement.',
          },
          reason: {
            type: 'string',
            description: 'Why the stored value may now be inaccurate.',
          },
        },
        required: ['field', 'replacement', 'evidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
};

const JUDGMENT_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      maxItems: FIELD_NAMES.length,
      description: 'Exactly one decision for every numbered suggestion.',
      items: {
        type: 'object',
        properties: {
          suggestionIndex: { type: 'integer', minimum: 0 },
          verdict: {
            type: 'string',
            enum: ['meaningful_change', 'same_meaning', 'unsupported'],
            description:
              'meaningful_change = the replacement changes a material fact; same_meaning = wording differs but the stored value remains accurate; unsupported = the page does not establish the replacement.',
          },
          confidence: { type: 'string', enum: ['high', 'low'] },
          notes: { type: 'string' },
        },
        required: ['suggestionIndex', 'verdict', 'confidence', 'notes'],
        additionalProperties: false,
      },
    },
  },
  required: ['decisions'],
  additionalProperties: false,
};

async function callClaude({ model, system, schema, user }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      temperature: 0,
      system,
      tools: [
        {
          name: 'report',
          description: 'Return the structured audit result.',
          input_schema: schema,
        },
      ],
      tool_choice: { type: 'tool', name: 'report' },
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (/credit|quota|billing/i.test(body) || res.status === 402) {
      throw new OutOfCreditError(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
    }
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  const block = json.content?.find((c) => c.type === 'tool_use');
  if (block == null) {
    throw new Error('Model returned no tool_use block');
  }
  return block.input;
}

async function proposeChanges(pool, page) {
  return callClaude({
    model: MODEL,
    schema: PROPOSAL_SCHEMA,
    system:
      'You are the proposer in the first round of a stake-pool directory audit. Compare the stored entry with the cited page and list candidate field corrections. ' +
      'Suggest at most one complete replacement per field. Focus on factual differences, not stylistic improvements. ' +
      'A detail missing from marketing copy is not proof that it is false. Never invent requirements, URLs, or numbers that are absent from the page.',
    user:
      `Stored directory entry:\n\`\`\`json\n${JSON.stringify(pool, null, 2)}\n\`\`\`\n\n` +
      `Current text of ${pool.url}:\n"""\n${page}\n"""\n\n` +
      'List any field-level changes that may be needed. Return an empty suggestions list if the stored entry remains accurate.',
  });
}

async function judgeChanges(pool, page, suggestions) {
  return callClaude({
    model: JUDGE_MODEL,
    schema: JUDGMENT_SCHEMA,
    system:
      'You are the independent judge in the second round of a stake-pool directory audit. You did not create the proposed edits. ' +
      'For every proposal, decide whether it fixes a material difference in meaning, merely rephrases information that is already accurate, or is not directly supported by the cited page. ' +
      'Approve a meaningful change with high confidence only when the page explicitly establishes the new fact and the old value would mislead a validator. ' +
      'Omission is not contradiction. Do not improve wording and do not create alternative edits.',
    user:
      `Stored directory entry:\n\`\`\`json\n${JSON.stringify(pool, null, 2)}\n\`\`\`\n\n` +
      `Proposer's numbered suggestions:\n\`\`\`json\n${JSON.stringify(suggestions, null, 2)}\n\`\`\`\n\n` +
      `Current text of ${pool.url}:\n"""\n${page}\n"""\n\n` +
      'Judge each suggestion independently. Use its zero-based array index as suggestionIndex.',
  });
}

function validReplacement(field, replacement) {
  if (field === 'requirements') {
    return Array.isArray(replacement) && replacement.every((item) => typeof item === 'string');
  }
  return typeof replacement === 'string' && replacement.trim().length > 0;
}

function normalizeSuggestions(input) {
  if (!Array.isArray(input)) return [];
  const seenFields = new Set();
  return input.filter((suggestion) => {
    if (suggestion == null || !FIELD_NAMES.includes(suggestion.field)) return false;
    if (seenFields.has(suggestion.field)) return false;
    if (!validReplacement(suggestion.field, suggestion.replacement)) return false;
    if (typeof suggestion.evidence !== 'string' || typeof suggestion.reason !== 'string') return false;
    seenFields.add(suggestion.field);
    return true;
  });
}

function normalizeDecisions(input, suggestionCount) {
  if (!Array.isArray(input)) return [];
  const seenIndexes = new Set();
  return input.filter((decision) => {
    if (decision == null || !Number.isInteger(decision.suggestionIndex)) return false;
    if (decision.suggestionIndex < 0 || decision.suggestionIndex >= suggestionCount) return false;
    if (seenIndexes.has(decision.suggestionIndex)) return false;
    if (!['meaningful_change', 'same_meaning', 'unsupported'].includes(decision.verdict)) return false;
    if (!['high', 'low'].includes(decision.confidence) || typeof decision.notes !== 'string') return false;
    seenIndexes.add(decision.suggestionIndex);
    return true;
  });
}

/** Applies only high-confidence semantic changes approved in round two. */
function applyApprovedChanges(pool, suggestions, judgment) {
  const changed = [];
  const handledFields = new Set();
  for (const decision of judgment.decisions ?? []) {
    if (decision.verdict !== 'meaningful_change' || decision.confidence !== 'high') continue;
    const suggestion = suggestions[decision.suggestionIndex];
    if (suggestion == null || !FIELD_NAMES.includes(suggestion.field)) continue;
    if (handledFields.has(suggestion.field)) continue;
    if (!validReplacement(suggestion.field, suggestion.replacement)) continue;

    const before = JSON.stringify(pool[suggestion.field]);
    const after = JSON.stringify(suggestion.replacement);
    if (before !== after) {
      pool[suggestion.field] = suggestion.replacement;
      changed.push(suggestion.field);
      handledFields.add(suggestion.field);
    }
  }
  return changed;
}

async function main() {
  if (!API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set.');
    process.exit(1);
  }

  const directory = JSON.parse(await readFile(DATA_PATH, 'utf8'));
  const rows = [];
  let edits = 0;
  let ranOut = false;

  for (const pool of directory.pools) {
    const page = await fetchText(pool.url);
    if (!page.ok) {
      const kind = classify(page);
      rows.push({
        name: pool.name,
        status: kind === 'blocked' ? 'blocked' : 'unreachable',
        notes:
          kind === 'blocked'
            ? `${pool.url} refused a scripted request (HTTP ${page.status}) — likely bot protection, not a dead link. Not audited this run.`
            : `Could not fetch ${pool.url} (${page.error ?? `HTTP ${page.status}`}). Check whether the page moved.`,
      });
      continue;
    }

    let proposal;
    try {
      proposal = await proposeChanges(pool, page.text);
    } catch (err) {
      if (err instanceof OutOfCreditError) {
        console.warn(`Stopping early — API credit exhausted. ${err.message}`);
        ranOut = true;
        break;
      }
      rows.push({ name: pool.name, status: 'error', notes: String(err.message) });
      continue;
    }

    const suggestions = normalizeSuggestions(proposal.suggestions);
    if (!Array.isArray(proposal.suggestions) || suggestions.length !== proposal.suggestions.length) {
      rows.push({
        name: pool.name,
        status: 'proposal error',
        proposed: Array.isArray(proposal.suggestions) ? proposal.suggestions.length : '—',
        notes: 'Round one returned an invalid or duplicate field suggestion; nothing was changed.',
        changed: [],
      });
      continue;
    }
    if (suggestions.length === 0) {
      rows.push({
        name: pool.name,
        status: 'current',
        proposed: 0,
        notes: 'Round one suggested no changes.',
        changed: [],
      });
      continue;
    }

    let judgment;
    try {
      judgment = await judgeChanges(pool, page.text, suggestions);
    } catch (err) {
      if (err instanceof OutOfCreditError) {
        console.warn(`Stopping early — API credit exhausted during judging. ${err.message}`);
        ranOut = true;
        break;
      }
      rows.push({
        name: pool.name,
        status: 'judge error',
        proposed: suggestions.length,
        notes: String(err.message),
        changed: [],
      });
      continue;
    }

    const decisions = normalizeDecisions(judgment.decisions, suggestions.length);
    const changed = applyApprovedChanges(pool, suggestions, { decisions });
    const hasUnresolved =
      decisions.length !== suggestions.length || decisions.some((decision) => decision.confidence !== 'high');
    const row = {
      name: pool.name,
      status:
        changed.length > 0
          ? hasUnresolved
            ? 'drifted + review'
            : 'drifted'
          : hasUnresolved
            ? 'review'
            : 'unchanged',
      proposed: suggestions.length,
      notes: summarizeJudgments(suggestions, decisions),
      changed,
      suggestions,
      decisions,
    };
    edits += changed.length > 0 ? 1 : 0;
    rows.push(row);
  }

  // Link rot is a plain HTTP question — no model needed.
  const linkRows = [];
  for (const [label, url] of Object.entries(directory.sourceUrls)) {
    const res = await fetchText(url);
    linkRows.push({ label, url, kind: classify(res), status: res.status, error: res.error });
  }

  if (edits > 0) {
    directory.reviewed = new Date().toISOString().slice(0, 10);
    await writeFile(DATA_PATH, `${JSON.stringify(directory, null, 2)}\n`, 'utf8');
  }

  await writeFile(REPORT_PATH, renderReport({ rows, linkRows, edits, ranOut }), 'utf8');
  console.log(`Audited ${rows.length} entries; ${edits} updated. Report: ${REPORT_PATH}`);
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `edits=${edits}\n`, { flag: 'a' });
  }
}

function renderReport({ rows, linkRows, edits, ranOut }) {
  const lines = [];
  lines.push('## Stake pool directory audit', '');
  lines.push(
    edits > 0
      ? `The two-round audit approved changes to **${edits}** entr${edits === 1 ? 'y' : 'ies'}. The applied changes are in the diff.`
      : 'The two-round audit applied no meaningfully different, high-confidence changes.',
    '',
  );
  if (ranOut) {
    lines.push(
      '> **Audit stopped early — the Anthropic key ran out of credit.** Entries below the cutoff were not checked.',
      '',
    );
  }

  lines.push(
    '### Entries',
    '',
    '| Pool | Status | Proposed | Applied | Judge notes |',
    '| --- | --- | ---: | --- | --- |',
  );
  for (const r of rows) {
    const applied = r.changed?.length ? r.changed.join(', ') : '—';
    lines.push(
      `| ${r.name} | ${r.status} | ${r.proposed ?? '—'} | ${applied} | ${escapeCell(r.notes)} |`,
    );
  }

  const proposedRows = rows.filter((row) => row.suggestions?.length > 0);
  if (proposedRows.length > 0) {
    lines.push('', '### Round-one suggestions and judge decisions', '');
    for (const row of proposedRows) {
      const decisionsByIndex = new Map(
        (row.decisions ?? []).map((decision) => [decision.suggestionIndex, decision]),
      );
      lines.push(`#### ${row.name}`, '');
      row.suggestions.forEach((suggestion, index) => {
        const decision = decisionsByIndex.get(index);
        const verdict = decision
          ? `${decision.verdict} (${decision.confidence} confidence)`
          : 'no valid judge decision';
        lines.push(
          `- **${suggestion.field}** — ${verdict}`,
          `  - Proposed: \`${escapeCode(JSON.stringify(suggestion.replacement))}\``,
          `  - Reason: ${escapeText(suggestion.reason)}`,
          `  - Evidence: ${escapeText(suggestion.evidence)}`,
          `  - Judge: ${escapeText(decision?.notes ?? 'Left unchanged because the judge returned no valid decision.')}`,
        );
      });
      lines.push('');
    }
  }

  const broken = linkRows.filter((l) => l.kind === 'broken' || l.kind === 'error');
  lines.push('', '### Legend links', '');
  lines.push(
    broken.length > 0
      ? `**${broken.length} link${broken.length === 1 ? '' : 's'} may be dead** — verify in a browser before changing anything.`
      : 'No dead links.',
    '',
  );
  lines.push('| Source | URL | Result |', '| --- | --- | --- |');
  for (const l of linkRows) {
    const state = {
      ok: '✅ ok',
      blocked: `🛡️ blocked (HTTP ${l.status}) — bot protection, probably fine`,
      broken: `❌ HTTP ${l.status}`,
      error: `❌ ${l.error ?? 'request failed'}`,
    }[l.kind];
    lines.push(`| ${l.label} | ${l.url} | ${state} |`);
  }

  lines.push(
    '',
    '---',
    '',
    '_Generated by `scripts/audit-stake-pools.mjs`. One Claude call proposes edits and a separate call judges their meaning. Only explicit, high-confidence semantic changes are applied. Verify against the linked pages before merging._',
  );
  return `${lines.join('\n')}\n`;
}

function summarizeJudgments(suggestions, decisions) {
  const byIndex = new Map(decisions.map((decision) => [decision.suggestionIndex, decision]));
  return suggestions
    .map((suggestion, index) => {
      const decision = byIndex.get(index);
      if (decision == null) return `${suggestion.field}: no judge decision (left unchanged)`;
      const result =
        decision.verdict === 'meaningful_change' && decision.confidence === 'high'
          ? 'meaningful change approved'
          : decision.verdict === 'same_meaning'
            ? 'same meaning; left unchanged'
            : decision.verdict === 'unsupported'
              ? 'unsupported; left unchanged'
              : 'low confidence; left unchanged';
      return `${suggestion.field}: ${result} — ${decision.notes}`;
    })
    .join('; ');
}

function escapeCell(text) {
  return escapeText(text).replace(/\|/g, '\\|');
}

function escapeCode(text) {
  return String(text ?? '').replace(/`/g, '′').replace(/\r?\n/g, ' ');
}

function escapeText(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
