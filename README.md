# Partner Opportunity Agent

Lyzr Emerging Partner Program. A services founder gives a work email and a website, answers
a few questions, and gets a brief naming two or three AI service lines they could sell to
the clients they already have — one A4 page each, with a Lyzr case study behind every one.

## Run it

```bash
npm start     # http://localhost:3000
```

Node 20+. No install, no dependencies.

Needs `.env` with `LYZR_API_KEY` (required), `APOLLO_API_KEY` and `SERPER_API_KEY`
(optional). See `.env.example`. It is gitignored.

## Pages

- `/` — the landing page
- `/partner-directory` — the partner directory
- `/agent` — the agent

The two static pages are built from the Claude Design standalone exports, which are the
design source and are not kept in the repo:

```bash
python3 scripts/build-site.py            # reads ~/Downloads/standalone/*.html
```

It writes `public/index.html`, `public/partner-directory.html` and every asset either
export carries into `public/assets/`. The agent overlay is part of the design source now, so
there is nothing to patch in afterwards — it opens `/agent` in an iframe.

For the lyzr.ai copies, every address the pages carry can be named at build time, so the
agent and its API stay on this deployment while the two pages go into the CMS:

```bash
python3 scripts/build-site.py \
  --agent     https://partners.lyzr.ai/agent \
  --assets    https://partners.lyzr.ai \
  --home      https://www.lyzr.ai/emerging-partners \
  --directory https://www.lyzr.ai/partner-directory
```

`public/agent.html` and `public/app.js` are hand-maintained, not generated.

## Layout

```
api/      one endpoint per step
lib/      crawl, profile, discovery, scoring, brief
public/   the three pages and their assets
studio/   the agent prompts (markdown + JSON schema)
data/     Lyzr's delivered work, products, resources
kb/       the partner program knowledge base
tests/    node --test
```

## Deploying

Vercel, project root here. No build step.

Set `LYZR_API_KEY`, `APOLLO_API_KEY` and `SERPER_API_KEY` in Project → Settings →
Environment Variables, for all three environments.

## Changing the prompts

The prompts live in Agent Studio, not in this repo. After editing `studio/*.md`:

```bash
node scripts/studio-setup.js --only=agents
```

Then restart anything already running — the code and the prompts are one version and have
to move together.

## Scripts

```bash
node scripts/run.js goml.io            # the whole journey in the terminal
node scripts/try.js goml.io            # just the profile
node scripts/build-catalog.js          # re-read Lyzr's customer stories
node scripts/fixtures.js goml.io       # save a real run
node scripts/preview.js                # then /_preview.html?to=brief
```
