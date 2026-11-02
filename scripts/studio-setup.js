/* Creates the partner agent's knowledge bases in Lyzr Studio and loads kb/ into them.
 *
 *   node scripts/studio-setup.js            # everything
 *   node scripts/studio-setup.js --only=kb  # just the knowledge bases
 *
 * Shares the workspace with the Leia build, so every name is prefixed partner_.
 * Ids live in studio/ids.json. Re-running is safe: KBs are reused, only changed docs reload. */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDS = path.join(ROOT, 'studio', 'ids.json');
const STATE = path.join(ROOT, 'studio', '.load-state.json');

const RAG_API = 'https://rag-prod.studio.lyzr.ai/v3';
const AGENT_API = 'https://agent-prod.studio.lyzr.ai/v3';
/* partner_playbook is gone: the opportunity step reads data/catalog.json, which is
 * built from what Lyzr has actually delivered, not from sixteen entries written by hand. */
const KBS = ['partner_program'];
const DIR = { partner_program: 'program' };
const BATCH = 20;

const env = Object.fromEntries(
  (await fs.readFile(path.join(ROOT, '.env'), 'utf8'))
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const KEY = env.LYZR_API_KEY;
if (!KEY) throw new Error('LYZR_API_KEY missing from .env');

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const readJson = (f, d) => fs.readFile(f, 'utf8').then(JSON.parse).catch(() => d);
const writeJson = (f, v) => fs.writeFile(f, JSON.stringify(v, null, 2) + '\n');
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

async function call(method, url, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : {};
    if (attempt >= 3 || res.status < 500) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
}

async function ensureKbs(ids) {
  ids.kb ??= {};
  for (const name of KBS) {
    if (ids.kb[name]) continue;
    const r = await call('POST', `${RAG_API}/rag/`, {
      user_id: KEY,
      name,
      description: `Partner Opportunity Agent: ${name}`,
      llm_credential_id: 'lyzr_openai',
      embedding_credential_id: 'lyzr_openai',
      vector_db_credential_id: 'lyzr_qdrant_2',
      collection_name: `${name}${crypto.randomBytes(2).toString('hex')}`,
      llm_model: 'gpt-4o-mini',
      embedding_model: 'text-embedding-3-large',
      vector_store_provider: 'Qdrant [Lyzr 2]',
      semantic_data_model: false,
      meta_data: {},
    });
    ids.kb[name] = r.id || r._id;
    console.log(`created knowledge base ${name}: ${ids.kb[name]}`);
    await writeJson(IDS, ids);
  }
}

/* One file = one document = one chunk. Review sheets and open-question lists stay out:
 * they are for humans, and retrieving them would put blanks in front of a visitor. */
async function documents() {
  const docs = [];
  for (const kb of KBS) {
    const dir = path.join(ROOT, 'kb', DIR[kb]);
    for (const f of (await fs.readdir(dir)).sort()) {
      if (f.startsWith('_REVIEW') || f.startsWith('_OPEN')) continue;
      const text = await fs.readFile(path.join(dir, f), 'utf8');
      docs.push({ kb, id: `${DIR[kb]}/${f}`, title: f.replace(/\.(ya?ml|md)$/, ''), text });
    }
  }
  return docs;
}

async function loadKbs(ids) {
  const state = await readJson(STATE, {});
  const docs = await documents();
  const todo = docs.filter((d) => state[d.id] !== sha(d.text));
  console.log(`${docs.length} documents; ${todo.length} new or changed to load`);

  for (const name of KBS) {
    const mine = todo.filter((d) => d.kb === name);
    for (let i = 0; i < mine.length; i += BATCH) {
      const batch = mine.slice(i, i + BATCH);
      await call('POST', `${RAG_API}/train/text/?rag_id=${ids.kb[name]}`, {
        data: batch.map((d) => ({ text: d.text, source: d.id, extra_info: { id: d.id, title: d.title } })),
        chunk_size: 6000,
        chunk_overlap: 0,
      });
      for (const d of batch) state[d.id] = sha(d.text);
      await writeJson(STATE, state);
      console.log(`  ${name}: ${Math.min(i + BATCH, mine.length)}/${mine.length}`);
    }
  }
}

/* ---------- agents ---------- */

const section = (md, from, to) => md.slice(md.indexOf(from) + from.length, to ? md.indexOf(to) : undefined).trim();

async function upsertAgent(ids, key, { name, description, file, model }) {
  const md = await fs.readFile(path.join(ROOT, 'studio', file), 'utf8');
  const schema = JSON.parse(section(md, '## Output schema (Studio Structured Output, strict)', '## What the backend does').replace(/^```json\s*|\s*```$/g, ''));
  const agent = {
    name,
    description,
    agent_role: section(md, '## Role', '## Goal'),
    agent_goal: section(md, '## Goal', '## Instructions'),
    agent_instructions: section(md, '## Instructions', '## Output schema'),
    provider_id: 'Anthropic',
    model: model || env.PARTNER_MODEL || 'anthropic/claude-sonnet-4-6',
    llm_credential_id: 'lyzr_anthropic',
    temperature: 0.1,
    top_p: 0.9,
    features: [],
    tools: [],
    tool_configs: [],
    managed_agents: [],
    examples: null,
    response_format: { type: 'json_schema', json_schema: { name: key, strict: true, schema } },
    store_messages: true,
    file_output: false,
  };
  ids.agents ??= {};
  if (ids.agents[key]) {
    await call('PUT', `${AGENT_API}/agents/${ids.agents[key]}`, agent);
    console.log(`updated agent ${key} ${ids.agents[key]}`);
  } else {
    const r = await call('POST', `${AGENT_API}/agents/`, agent);
    ids.agents[key] = r.agent_id;
    console.log(`created agent ${key}: ${ids.agents[key]}`);
  }
  await writeJson(IDS, ids);
}

const AGENTS = {
  partner_profiler: {
    name: 'Partner profiler (Emerging Partner Program)',
    description: 'Turns a services company website + Apollo enrichment into a correctable company profile.',
    file: 'profiler-prompt.md',
    /* Sonnet, measured 2026-10-25, reversing the earlier Haiku call. That call was right
     * while this step was pure extraction; it now also picks `strengths` and writes
     * `worth_exploring`, which are judgement. On the same two sites Haiku ran 11.7s and
     * Sonnet 18.1s, and Sonnet's strengths were specific where Haiku's were generic
     * ("Retail Media, Proprietary Ad Tech" against "AI-Driven Optimization") — on a card
     * whose whole job is to prove we read the site, generic is the failure. Flash-lite
     * remains out: it misread an audit firm as an IT consultancy. */
    model: 'anthropic/claude-sonnet-4-6',
  },
  /* The profile is written by two models on the same material at the same time: this one
   * reads off their pages, the judgement one decides what it means. One call writing all
   * eighteen fields was forty seconds of decode on its own, which is most of a serverless
   * function's wall clock. Halved and run together, the step costs the slower half. */
  partner_profiler_judgement: {
    name: 'Partner profiler, judgement half (Emerging Partner Program)',
    description: 'Writes what the firm has already built and sells, its strengths and what is worth asking.',
    file: 'profiler-judgement-prompt.md',
  },
  partner_shortlist: {
    name: 'Partner opportunity shortlist (Emerging Partner Program)',
    description: 'Picks the 3 playbook entries worth writing up, and the angle for each.',
    file: 'shortlist-prompt.md',
    /* Haiku: this is matching entries to a profile, not judging how to argue them. */
    model: 'anthropic/claude-haiku-4-5',
  },
  partner_discovery: {
    name: 'Partner opportunity discovery (Emerging Partner Program)',
    description: 'Finds the service lines a firm could sell, out of what Lyzr has actually delivered, and cites the evidence.',
    file: 'discovery-prompt.md',
    /* Haiku, in the slot the shortlist used to hold, so the rewrite costs no latency. It
     * is reading fourteen records against a profile and matching them to patterns, which
     * is closer to selection than to argument. */
    model: 'anthropic/claude-haiku-4-5',
  },
  partner_opportunity: {
    name: 'Partner opportunity strategist (Emerging Partner Program)',
    description: 'Picks 2-3 sellable AI service lines from the playbook and argues them from the firm\'s own profile.',
    file: 'opportunity-prompt.md',
  },
  partner_evidence: {
    name: 'Partner evidence extractor (Emerging Partner Program)',
    description: 'Turns one page of a partner\'s website into a structured record of what it proves.',
    file: 'evidence-prompt.md',
    /* Haiku: extraction against a schema, from a page in front of it, run a dozen times
     * in parallel while the profiler is still thinking. */
    model: 'anthropic/claude-haiku-4-5',
  },
  partner_catalog: {
    name: 'Partner catalog extractor (Emerging Partner Program)',
    description: 'Turns one Lyzr customer story page into a structured record of what was delivered.',
    file: 'catalog-prompt.md',
    /* Haiku: this is extraction from a page in front of it, not judgement, and it runs
     * sixty times in a batch. */
    model: 'anthropic/claude-haiku-4-5',
  },
  partner_accounts: {
    name: 'Partner account ranker (Emerging Partner Program)',
    description: 'Ranks the accounts a partner named against the service line they chose.',
    file: 'accounts-prompt.md',
  },
  partner_assessment: {
    name: 'Partner opportunity assessment writer (Emerging Partner Program)',
    description: 'Writes the visitor-facing assessment and the internal summary for the partner team.',
    file: 'assessment-prompt.md',
  },
};

const ids = await readJson(IDS, {});
await ensureKbs(ids);
if (!args.only || args.only === 'kb') await loadKbs(ids);
if (!args.only || args.only === 'agents') {
  for (const [key, cfg] of Object.entries(AGENTS)) await upsertAgent(ids, key, cfg);
}
await writeJson(IDS, ids);
console.log('done');
