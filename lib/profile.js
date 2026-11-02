import { crawl } from './crawl.js';
import { searchCompany } from './search.js';
import { enrich, domainOf, isBusinessEmail } from './apollo.js';
import { ask } from './studio.js';
import { env } from './env.js';
import { buildEvidence, forReasoning } from './evidence.js';

/* Three rules the prompt states and the model still breaks, so they are enforced here
 * instead. Each one reaches the visitor if it slips, which is why none of them is left to
 * the prompt alone. */

const WORDS = (s = '') => s.trim().split(/\s+/).filter(Boolean).length;
/* Their own address is not evidence of where their customers are. The model keeps writing
 * "HQ in New York" under a US customer market, which is the exact conflation the markets
 * split exists to prevent. */
const SELF_LOCATION = /\b(hq|headquarters|headquartered|based in|office|offices)\b/i;

function tidy(profile) {
  const p = { ...profile };

  if (p.markets) {
    const customers = (p.markets.customers ?? []).filter((c) => !SELF_LOCATION.test(c.evidence ?? ''));
    /* Dropping the last piece of customer evidence has to drop the confidence with it,
     * or the card claims "confirmed" over an empty row. */
    const confidence = customers.length ? p.markets.customers_confidence : 'unknown';
    p.markets = { ...p.markets, customers, customers_confidence: confidence };
  }

  /* A question the profile has already answered is worse than no question: it tells the
   * visitor we were not reading. The prompt bans these; this is the backstop. */
  const settled = [];
  if (['builds', 'advises'].includes(p.delivery_capability?.verdict)) settled.push(/build|advis|deliver|engineer|implement/i);
  if (p.customer_type && p.customer_type !== 'unclear') settled.push(/enterprise|mid-market|smb|customer segment|sell to/i);
  /* The five the app asks every visitor itself. The prompt bans them by name; these catch
   * the rewordings, which is how they come back. */
  settled.push(/what kind of work|service lines?|deliver for (your )?clients/i);
  settled.push(/opportunit(y|ies) to grow|where.*grow|grow(th)? (plan|priorit)/i);
  settled.push(/asking (you )?for|demand|use cases? .*(want|ask)/i);
  settled.push(/how far along|maturity|pilots? or poc|in production/i);
  settled.push(/where are .*(customers|clients) based|geograph|region/i);

  p.confirm = (p.confirm ?? [])
    .filter((q) => !settled.some((re) => re.test(q.question) || re.test(q.field)))
    .filter((q) => WORDS(q.question) <= 20)
    .slice(0, 1);

  return p;
}

/* The profiler builds the company picture: what they sell, to whom, on what, and what
 * they have already shipped. It does not need every page of delivered work, because the
 * evidence pass is reading those properly and in parallel. Feeding it all of them made
 * the longest call in the journey longer for nothing, so it gets the pages that describe
 * the business plus the few densest pieces of work as corroboration. */
const PROFILE_CHARS = 24_000;

function profileText(pages) {
  const describes = pages.filter((p) => ['home', 'services', 'products', 'industries', 'about', 'partners', 'announcement'].includes(p.kind));
  const work = pages.filter((p) => !describes.includes(p)).slice(0, 3);
  let left = PROFILE_CHARS;
  const out = [];
  for (const p of [...describes, ...work]) {
    if (left <= 0) break;
    const text = p.text.slice(0, Math.min(p.text.length, left));
    left -= text.length;
    out.push(`## ${p.kind.toUpperCase()}: ${p.title}\n${p.url}\n${text}`);
  }
  return out.join('\n\n');
}

/* email + website in, profile out. Each source is optional: a dead site still profiles from
 * Apollo, and an Apollo miss still profiles from the crawl. Both missing is the one real
 * failure, and the caller asks the visitor to describe the business instead. */
export async function gatherProfile(email, website) {
  const site = website || domainOf(email);
  const t0 = Date.now();
  /* The brand is taken from the domain rather than waited on from Apollo: the search runs
   * beside the crawl instead of behind it, and for a services firm the domain label is the
   * name on the building. A wrong guess returns little and the profile carries on. */
  const brand = domainOf(site).split('.')[0].replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  /* The evidence pass starts the moment the crawl lands, not after the profiler, so the
   * capability map is built while the profiler is still reading. Two models on the same
   * pages at the same time, and the step costs what the slower of them costs. */
  /* Where the forty five seconds of this step actually go, in the log rather than in
   * somebody's head. The crawl turned out to be six of them. */
  const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const timed = (name, p) => p.then((v) => { console.error(`[profile] ${name} ${since()}`); return v; });

  const crawling = timed('crawl', crawl(site));
  const reading = timed('evidence', crawling.then((c) => (c.ok ? buildEvidence(c.pages) : null)).catch(() => null));

  const [crawled, enriched, searched] = await Promise.all([
    crawling,
    timed('apollo', enrich(email, site)),
    timed('search', searchCompany(brand, domainOf(site)).catch(() => ({ ok: false, hits: [], text: '' }))),
  ]);

  if (!crawled.ok && !enriched.org) {
    /* The visitor is told we could not read their site and nothing else is written down,
     * so the one question worth answering afterwards, which site and what went wrong,
     * had no answer at all. */
    console.error(`[profile] no signal for ${site}: crawl ${JSON.stringify((crawled.errors ?? []).slice(0, 3))}, apollo ${enriched.org ? 'matched' : 'no match'}`);
    return { ok: false, reason: 'no-signal', errors: crawled.errors, ms: Date.now() - t0 };
  }

  const message = [
    `# The company`,
    `website given: ${site}`,
    `email domain: ${domainOf(email)}`,
    '',
    '# Apollo — organisation',
    enriched.org ? JSON.stringify(enriched.org, null, 1) : '(no match)',
    '',
    '# Apollo — the person who entered their email',
    enriched.person ? JSON.stringify(enriched.person, null, 1) : '(no match)',
    '',
    '# Crawled pages',
    crawled.ok ? profileText(crawled.pages) : '(the site could not be read)',
    '',
    '# What the web says about them',
    '(launch posts, partnerships, coverage. Use it for already_built and recent_moves.)',
    /* Capped for the same reason the crawl is: the profiler reads this for what they have
     * already shipped and who they have partnered with, both of which are in the first
     * page or two of any announcement. */
    searched.ok ? searched.text.slice(0, 12_000) : '(no web results)',
  ].join('\n');

  console.error(`[profile] gathered at ${since()}, prompt ${message.length} chars`);
  const evidence = await reading;

  /* Everything the second half needs and nothing it does not.
   *
   * The two halves are separate requests because a serverless function has a wall clock
   * and this step kept walking into it: reading the site and reading the model are forty
   * seconds together and neither is under our control. Apart, each is comfortably inside
   * the limit, and the total is what it always was. The browser carries this between
   * them, so it holds the composed prompt rather than the pages it was composed from. */
  return {
    ok: true,
    stage: 'gathered',
    message,
    capabilities: forReasoning(evidence),
    brandFrom: { name: enriched.org?.name || site, logo: enriched.org?.logo || null, site },
    evidenceOut: {
      pages: crawled.pages.map((p) => ({ kind: p.kind, url: p.url, title: p.title })),
      apollo_org: Boolean(enriched.org),
      apollo_person: Boolean(enriched.person),
      business_email: isBusinessEmail(email),
      web: searched.hits ?? [],
      web_provider: searched.provider ?? null,
      crawl_errors: crawled.errors,
      source_quality: crawled.ok ? (enriched.org ? 'site+apollo' : 'site-only') : 'apollo-only',
      evidence: evidence?.stats ?? null,
      records: evidence?.records ?? [],
    },
    ms: Date.now() - t0,
  };
}

/* The second half: one model call over what the first half gathered. */
export async function profileFrom(material) {
  const t0 = Date.now();
  const { message, capabilities, brandFrom = {}, evidenceOut = {} } = material ?? {};
  if (!message) return { ok: false, reason: 'no-material', ms: 0 };

  /* Two models on the same material at the same time: one reads off their pages, one
   * decides what it means. One call writing all eighteen fields was forty seconds of
   * decode on its own, which is most of a serverless function's wall clock, and the
   * fields divide cleanly because half of them are extraction and half are judgement.
   * Halved and run together, the step costs the slower half.
   *
   * The judgement half is the one that found Doxim's own payment intent capability, so
   * it keeps the same model as before. Neither half is allowed to fail the other: a
   * profile missing its strengths is worth more than no profile at all. */
  const [facts, judged] = await Promise.all([
    ask('partner_profiler', message, { model: env.PROFILER_MODEL }),
    ask('partner_profiler_judgement', message, { model: env.PROFILER_MODEL })
      .catch((e) => { console.error('[profile] judgement half failed:', e.message); return {}; }),
  ]);
  console.error(`[profile] profiler ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const profile = tidy({ ...facts, ...judged });
  /* The capability map rides on the profile because the browser carries the profile back
   * for every later step, and an opportunity that cannot see what the firm has delivered
   * is the thing this whole pass exists to stop. */
  /* The capability map rides on the profile because the browser carries the profile back
   * for every later step, and an opportunity that cannot see what the firm has delivered
   * is the thing this whole pass exists to stop. */
  profile.capabilities = capabilities ?? null;
  return {
    ok: true,
    profile,
    /* Their name and mark, carried beside the profile rather than through the model: a
     * logo URL is not something to let a language model retype. */
    brand: {
      name: profile.company?.name || brandFrom.name || brandFrom.site,
      logo: brandFrom.logo || null,
    },
    evidence: evidenceOut,
    ms: Date.now() - t0,
  };
}

/* Both halves in one call. The browser runs them as two requests; everything that is not
 * a serverless function, the dry run and the fixtures, still wants one. */
export async function buildProfile(email, website) {
  const gathered = await gatherProfile(email, website);
  if (!gathered.ok) return gathered;
  const done = await profileFrom(gathered);
  return done.ok ? { ...done, ms: gathered.ms + done.ms } : done;
}
