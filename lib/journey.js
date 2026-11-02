import { buildProfile, gatherProfile, profileFrom } from './profile.js';
import { candidatesFor, brief, full, isSolid, isUsable, patternById, productsFor, recordById, PATTERNS } from './catalog.js';
import { relatedTo, resourceById } from './resources.js';
import { retrieve } from './knowledge.js';
import { ask } from './studio.js';
import { isBusinessEmail } from './apollo.js';
import { fitScore, lyzrScore, gate, total, worthResearching, adjacency } from './score.js';
import { research } from './research.js';
import { verify } from './verify.js';
import { termSet } from './words.js';
import { playsFor, playById, briefOf, eligibility, motionOf, PLAYS } from './plays.js';
import { compatible, stepsFor, domains, systems, families, objects, drifts } from './fit.js';

/* The journey is a state machine here, not a conversation the model improvises. Three LLM
 * calls at three fixed points, each with one job and a schema. That keeps the order of the
 * steps guaranteed — value before qualification, nothing asked that we could have read —
 * rather than hoping a prompt holds. */

/* The two questions no website can answer — what they want next, and where their clients
 * actually are — are asked by the UI the moment the email is in, while the profile is still
 * being built. The server's job is only the adaptive remainder: whatever the profiler could
 * not establish and that would change the recommendation. */
export const MAX_ADAPTIVE = 1;
export const questionsFor = (profile) => (profile.confirm ?? []).slice(0, MAX_ADAPTIVE);

/* Step one, in two requests.
 *
 * Reading their site and reading the model are about forty seconds together, and neither
 * is under our control. One serverless function cannot hold both inside a sixty second
 * limit, so the browser makes two calls: the first gathers, the second profiles. The
 * visitor sees one loading screen either way. */
export async function step1Gather(email, website) {
  if (!email || !email.includes('@')) return { ok: false, error: 'Please enter your work email.' };
  if (!isBusinessEmail(email)) return { ok: false, error: 'Please use your work email so we can look up your company.' };

  const r = await gatherProfile(email, website);
  if (!r.ok) {
    return { ok: false, error: 'no-signal', message: "We couldn't read that website. Tell us in one line what your company does and we'll carry on." };
  }
  return r;
}

export async function step1Profile(material) {
  const r = await profileFrom(material);
  if (!r.ok) {
    return { ok: false, error: 'no-signal', message: "We couldn't read that website. Tell us in one line what your company does and we'll carry on." };
  }
  return {
    ok: true,
    profile: r.profile,
    brand: r.brand,
    evidence: r.evidence,
    questions: questionsFor(r.profile),
    ms: r.ms,
  };
}

export async function step1(email, website) {
  if (!email || !email.includes('@')) return { ok: false, error: 'Please enter your work email.' };
  if (!isBusinessEmail(email)) return { ok: false, error: 'Please use your work email so we can look up your company.' };

  const r = await buildProfile(email, website);
  if (!r.ok) {
    return { ok: false, error: 'no-signal', message: "We couldn't read that website. Tell us in one line what your company does and we'll carry on." };
  }
  return {
    ok: true,
    profile: r.profile,
    brand: r.brand,
    evidence: r.evidence,
    questions: questionsFor(r.profile),
    ms: r.ms,
  };
}

/* Company size is not a criterion and must never appear in the copy. Prompting for that
 * held most of the time and then wrote "you have 220 people", so the number simply does not
 * travel past the profiler: it stays on the profile for the record and is stripped here. */
/* The capability map goes with it, because every caller prints the map separately and
 * under its own heading. Left in, it was serialised twice into the same prompt: fourteen
 * thousand characters of duplicate context, paid for on every call. */
const withoutSize = (profile) => ({
  ...profile,
  capabilities: undefined,
  company: { ...profile.company, employees: undefined },
});

/* The capability map, small enough to sit inside another prompt. The brief and the
 * account ranker need to know what this firm has delivered; they do not need every step
 * of every engagement. */
/* The world this card lives in: the industries the partner actually serves and the systems
 * their clients actually run. Wider than anything one line says about itself, and the
 * thing a catalogue record has to be reconcilable with. */
/* Arrays, not Sets.
 *
 * The scope rides on every pick, and the picks go out to the browser after discovery and
 * come back to /api/recommend. A Set does not survive that: JSON writes it as {}, and the
 * other side does `new Set({})`, which is the "object is not iterable" the visitor saw
 * once discovery finally got far enough for its picks to be handed back. Everything that
 * reads these wraps them in a Set of its own anyway. */
const scopeOf = (profile) => ({
  domains: [...domains([
    ...(profile.industries ?? []).map((i) => i.name ?? i),
    ...(profile.capabilities?.industries ?? []),
  ].join(' '))],
  systems: [...systems([
    ...(profile.platforms ?? []).map((p) => p.name ?? p),
    ...(profile.capabilities?.technologies ?? []),
  ].join(' '))],
});

/* Anything that went out to the browser and came back has been through JSON, so a value
 * that was a Set is now {}. The scope is the one that matters and it is repaired here,
 * next to the step that receives it, rather than trusted to have survived. */
const iterable = (v) => (Array.isArray(v) ? v : v instanceof Set ? [...v] : []);
const safeScope = (found) => (found?.picks?.length
  ? { ...found, picks: found.picks.map((p) => (p?.scope
    ? { ...p, scope: { domains: iterable(p.scope.domains), systems: iterable(p.scope.systems) } }
    : p)) }
  : found);

const capsBrief = (profile) => (profile.capabilities?.capabilities ?? []).map((c) => ({
  function: c.function, service: c.service, projects: c.projects,
  stack: c.stack.slice(0, 6), outcomes: c.outcomes.slice(0, 2), confidence: c.confidence,
}));

/* Two halves, because writing three cards in one call was the longest wait in the journey.
 * A cheap shortlist picks the entries, then one writer per entry runs in parallel — wall
 * time is now one card, not three. */
/* Split in two on purpose. Finding the lines takes about ten seconds and needs only what
 * the visitor has already told us, so the browser starts it as they answer the last
 * question and that ten seconds is spent while they are reading rather than while they
 * are waiting. Writing the cards is the part that cannot start early. */
export async function discover(profile, answers, { partial = false } = {}) {
  const caps = profile.capabilities;
  /* The Lyzr side, scored in code and instant. It is no longer where opportunities come
   * from: it is how we check that there is something for Lyzr to contribute to one. */
  const candidates = candidatesFor(profile, answers);
  /* The product-led half. Filtered here rather than in the prompt: a play the partner has
   * shown no sign of being able to deliver is never put in front of the model, so it
   * cannot be proposed however good the story would sound. */
  const plays = playsFor(profile);
  const t0 = Date.now();
  /* Every department we can evidence: the capability map, plus any grounded engagement
   * that named one. The gate is keyed on these, so the model is handed them. */
  const deliveredIn = [...new Set([
    ...(caps?.capabilities ?? []).map((c) => c.function),
    ...(caps?.evidence ?? []).filter((e) => e.grounded).map((e) => e.function),
  ].filter(Boolean))];

  /* Two calls, run together, looking at the same firm from two directions.
   *
   * One call writing six candidates was the longest step in the journey and the thinnest
   * shortlist: the gate rejects anything their delivered work will not carry, and six
   * proposals routinely leave two survivors, sometimes one. More candidates is the only
   * honest way to more cards, and asking one call for more made the step slower still.
   * Apart, each writes half as much, they run at the same time, and between them they
   * propose eight. Duplicates across the two are expected and are what the dedupe below
   * is for. */
  const LENSES = [
    'Work inside the accounts they already hold: extending an engagement they are already delivering, governing or operating what their clients already run, and upselling the next thing into a relationship that exists.',
    'Offerings they could add: a service they do not sell today, a segment they could enter on the strength of what they have delivered, and capability they could package, embed or productise.',
  ];
  const askWith = (lens) => ask('partner_discovery', [
    ...contextOf(profile, answers),
    partial
      ? '# Note: the visitor has not yet said where their clients are based. Do not propose a line whose case depends on data residency, sovereignty or in-country hosting, because you cannot know it applies.\n'
      : '',
    /* The departments their delivered work actually covers.
     *
     * A candidate whose `function` is not one of these is capped below the gate and
     * thrown away, and the model was never told which they were: four of eight proposals
     * died this way on one run, which is how a firm with a readable site and agents in
     * production came back with a single card. The rule was always there, in code; it is
     * now in front of the model that has to satisfy it. */
    deliveredIn.length
      ? `# The departments their delivered work covers\n${JSON.stringify(deliveredIn)}\nA product candidate whose \`function\` is not one of these cannot be evidenced and will be thrown away, however good it sounds. Governance and platform-IP products are the exception: those sit above every department and may use any of them.\n`
      : '',
    '# What Lyzr can contribute (check your advantage against these, cite by id)',
    JSON.stringify(candidates.map(brief), null, 1), '',
    plays.length
      ? `# Lyzr products this firm is eligible for (propose product opportunities only from these, by id)\n${JSON.stringify(plays.map(briefOf), null, 1)}\n`
      : '# No Lyzr product is a direct fit for this firm on the evidence we have. Propose capability opportunities only.\n',
    '# How this kind of work is sold and delivered (pick one by id)',
    JSON.stringify(PATTERNS.map((p) => ({ id: p.id, growth_path: p.growth_path, when: p.when })), null, 1), '',
    '# What a partner builds on and can demo',
    JSON.stringify(productsFor([...new Set(candidates.flatMap((r) => r.functions ?? []))]), null, 1), '',
    `# Propose four candidates, all of them of this kind\n${lens}\nAnother pass is looking at the rest of their business, so do not reach outside this.`,
  ].join('\n'), { model: 'haiku' });

  const halves = await Promise.all(LENSES.map((lens) => askWith(lens)
    .catch((e) => { console.error('discovery half failed:', e.message); return null; })));
  console.error(`[discover] proposed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!halves.some(Boolean)) throw new Error('discovery returned nothing');

  /* One shortlist out of two. The ids are only unique within a call, so the second half's
   * are prefixed before anything keys on them. The selections concatenate: the ranking
   * below already drops a pick that earns the same money as one above it, which is the
   * judgement that matters once both halves are on the table. */
  const found = {
    opening: halves.find((h) => h?.opening)?.opening ?? '',
    opportunities: halves.flatMap((h, i) => (h?.opportunities ?? [])
      .map((o) => ({ ...o, id: i ? `b${o.id}` : String(o.id) }))),
    selection: {
      recommended: halves.flatMap((h, i) => (h?.selection?.recommended ?? [])
        .map((r) => ({ ...r, id: i ? `b${r.id}` : String(r.id) }))),
      rejected: halves.flatMap((h) => h?.selection?.rejected ?? []),
    },
  };

  const proposed = found.opportunities ?? [];
  let evidence = caps?.evidence ?? [];
  let scored = assess(proposed, caps, candidates, plays);

  /* One more look, only for the candidate that earns it: commercially strong, and failing
   * only because we could not find the delivery behind it on their site. Everything else
   * is latency spent on a candidate we would drop anyway. */
  const thin = worthResearching(scored);
  /* Only when we are actually short.
   *
   * This call exists to rescue a strong commercial idea whose delivery we could not find
   * on their site, and it is eleven seconds. With two lenses proposing there are usually
   * enough survivors already, and spending the eleven seconds then buys a fourth
   * candidate for a document that holds three. Short means short: fewer than three
   * through the gate. */
  const through = scored.filter((x) => x.gate.pass).length;
  let looked = { records: [], ms: 0, looked: 0 };
  if (through >= 3) console.error(`[discover] ${through} through the gate, skipping research`);
  else if (thin.length && profile.company?.name) {
    looked = await research({ name: profile.company.name, domain: profile.company.website ?? '' }, thin, evidence)
      .catch(() => ({ records: [], ms: 0, looked: 0 }));
    if (looked.records.length) {
      evidence = [...evidence, ...looked.records];
      /* Scored again over the larger evidence set, as the whole point of looking was to
       * change the ranking rather than to decorate it. */
      scored = assess(proposed, { ...caps, evidence }, candidates, plays);
    }
  }

  console.error(`[discover] scored and researched at ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  /* Validation first, judgement second.
   *
   * The gate is deterministic and it is absolute: a candidate whose citations do not
   * resolve, or that has no Lyzr product behind it, is not a thing we are willing to say
   * however well it was argued. Everything that survives it is something we *could* say,
   * and choosing between those is a commercial question rather than an arithmetic one. */
  const survived = scored.filter((x) => x.gate.pass);
  const byOppId = new Map(survived.map((x) => [String(x.opp.id ?? x.opp.headline), x]));

  /* The model's own ranking, strongest first.
   *
   * This used to be `sort((a, b) => b.score - a.score)` over a weighted total, and the
   * weights could not tell the difference between a firm that would obviously buy a
   * governance layer and one where the same five numbers happened to land in the same
   * place. The score is still computed and still recorded, so the partner team can see
   * where the judgement and the arithmetic disagreed, but it no longer picks. */
  const sel = found.selection ?? {};
  const ranked = [];
  const seen = new Set();
  /* Picks dropped for naming no incremental value, kept for the run record: a slot lost
   * this way is a thing the partner team should see rather than a silent gap. */
  const noValue = [];
  /* Picks dropped for earning the same money as one already taken. */
  const sameMoney = [];
  for (const r of sel.recommended ?? []) {
    const x = byOppId.get(String(r.id)) ?? survived.find((c) => sameProduct(c, r.product));
    if (!x || seen.has(x)) continue;
    /* What they could not sell before is the whole case for a recommendation, so a pick
     * that cannot name it is not a pick. The model is asked for it directly and told to
     * reject the product where the honest answer is that the firm could already do this
     * themselves; a blank or a shrug here is that answer arriving unsaid. */
    const adds = String(r.incremental_value ?? '').trim();
    if (adds.length < 25) {
      noValue.push({ product: x.play?.name, headline: x.opp.headline });
      continue;
    }
    /* Two picks that earn the same money are one pick.
     *
     * HatchWorks came back with a build platform that "moves you from rebuilding per
     * client" and embedded infrastructure that lets them "ship a platform without
     * rebuilding the stack each time". Different products, different motions, one
     * sentence. The model is asked to say what each later pick earns that the earlier
     * ones do not, and here that answer is checked: where it cannot distinguish them, or
     * where the value it names is the one already taken, the slot goes unfilled rather
     * than filled twice. */
    if (ranked.length) {
      const differs = String(r.differs_how ?? '').trim();
      const twin = ranked.find((y) => sameValue(y.incremental_value, adds));
      if (twin || differs.length < 20) {
        sameMoney.push({
          product: x.play?.name,
          headline: x.opp.headline,
          as: twin?.play?.name ?? ranked[0].play?.name,
        });
        continue;
      }
    }
    seen.add(x);
    ranked.push({
      ...x,
      chosen_because: String(r.why_strongest ?? '').trim(),
      /* What they could not sell before. The one thing a firm that already builds agents
       * wants to know, and the thing a product name on its own never answers. */
      incremental_value: adds,
      differs_how: String(r.differs_how ?? '').trim(),
    });
  }
  /* Three, where three can be filled honestly.
   *
   * This used to be however many the model named, because padding a shortlist back up is
   * how a reader learns the last card was filler. That was the right call when the only
   * thing standing between a weak candidate and the page was the model's own judgement.
   * It is not any more: a candidate reaching the fill below has already resolved its
   * citations, survived their quote check, cleared the department gate, named a product
   * it is eligible for and said what the partner's customer could buy afterwards that
   * they cannot buy now. The fill is also deduped on product, buyer, customer problem
   * and Lyzr record, so a third card has to be a different proposition and not a third
   * way of saying the first.
   *
   * What the model is better at is ordering, and it still does that: its own picks lead.
   * Where only two clear all of that, two is still the answer. Nothing is padded; the
   * bar simply stopped being one model's willingness to name a third. */
  const want = 3;

  /* Anything the model proposed and that passed the gate, but did not rank. A fallback
   * rather than a filler: it fills a slot only where one of the model's own picks failed
   * validation. Ordered by score, because at this point nobody has made a commercial
   * judgement about them and the arithmetic is what is left. */
  for (const x of survived.sort((a, b) => b.score - a.score)) {
    if (ranked.length >= want) break;
    if (!seen.has(x)) { seen.add(x); ranked.push(x); }
  }

  const { picks: distinct, dropped } = dedupe(ranked, want);
  const scope = scopeOf(profile);
  const chosen = distinct.slice(0, want);
  if (chosen.length < 3) {
    console.error(`[discover] ${chosen.length} distinct opportunities, not three: ${survived.length} survived the gate`);
  }
  const picks = chosen.map((x) => toLine(x, scope));

  /* Every product this firm qualified for, with what became of it. `not_recommended` only
   * ever held candidates the model bothered to propose, so a product it silently passed
   * over left no trace at all, which is the one failure we could not see. */
  const chosenProducts = new Set(chosen.map((x) => x.play?.offering_id).filter(Boolean));
  const said = new Map((sel.rejected ?? [])
    .map((r) => [norm(r.product), String(r.why_not ?? '').trim()]).filter(([k]) => k));
  /* One row per eligible product, never two. The model names products inconsistently,
   * sometimes by id and sometimes by title, so its verdicts are keyed the same way the
   * products are and merged rather than appended. A product it passed over in silence
   * still gets a row, because that silence is the thing worth seeing. */
  const rejected = plays
    .filter((p) => !chosenProducts.has(p.play.offering_id))
    .map((p) => ({
      product: p.play.name,
      motion: p.play.commercial_motion,
      eligible_because: p.fit.why,
      why: said.get(norm(p.play.name)) ?? said.get(norm(p.play.offering_id))
        ?? (scored.some((x) => x.play?.offering_id === p.play.offering_id)
          ? 'proposed, but not among the strongest and not carried through'
          : 'eligible, and the model proposed nothing on it'),
    }));

  return {
    opening: found.opening ?? '',
    picks,
    /* Kept for the run record. A brief nobody can explain is worse than a thin one, and
     * the reason a candidate was dropped is the most useful thing in the file. */
    not_recommended: [
      ...scored.filter((x) => !x.gate.pass)
        .map((x) => ({ headline: x.opp.headline, product: x.play?.name, score: x.score, why: x.gate.fails })),
      ...dropped.map((x) => ({ headline: x.opp.headline, product: x.play?.name, score: x.score, why: ['another candidate sells the same thing to the same buyer'] })),
      ...distinct.filter((x) => !chosen.includes(x))
        .map((x) => ({ headline: x.opp.headline, product: x.play?.name, score: x.score, why: ['sound, but not among the three the model judged strongest'] })),
      ...noValue.map((x) => ({ headline: x.headline, product: x.product, score: 0, why: ['recommended without naming what it adds beyond what they already build'] })),
      ...sameMoney.map((x) => ({ headline: x.headline, product: x.product, score: 0, why: [`earns the same money as the ${x.as} line, through a different product`] })),
    ],
    /* What the model was offered, what it took and what it turned down, so a reviewer can
     * see the whole stack being considered rather than only the survivors. */
    stack: {
      eligible: plays.map((p) => ({ product: p.play.name, motion: p.play.commercial_motion, why: p.fit.why })),
      chosen: chosen.map((x) => ({
        product: x.play?.name, motion: x.play?.commercial_motion,
        headline: x.opp.headline, score: x.score, because: x.chosen_because ?? '',
        adds: x.incremental_value ?? '',
      })),
      rejected,
    },
    considered: scored.length,
    research: { pages: looked.records.length, looked: looked.looked, ms: looked.ms },
    ms: Date.now() - t0,
  };
}

/* The model names the product it meant in prose, so matching is on the name rather than
 * on an id it was never given. Loose on purpose: "Lyzr Optimus" and "Optimus" are the
 * same product and a reviewer would never accept the opposite. */
const norm = (s) => String(s ?? '').toLowerCase().replace(/^lyzr\s+/, '').replace(/[^a-z0-9]/g, '');
const sameName = (a, b) => Boolean(norm(a)) && norm(a) === norm(b);
const sameProduct = (x, name) => sameName(x.play?.name, name) || sameName(x.play?.offering_id, name);

/* Do two statements of incremental value describe the same money?
 *
 * Compared on the words that carry the claim, so "stop rebuilding agents per client" and
 * "ship a platform without rebuilding the stack each time" land on the same handful:
 * rebuilding, client, platform. Deliberately blunt. It is a backstop under a model that
 * has been asked the question directly, not a judgement of its own, and it only has to
 * catch the case where the same sentence is being made twice. */
const VALUE_STOP = new Set(['that', 'this', 'with', 'from', 'your', 'you', 'they', 'them', 'their',
  'into', 'than', 'what', 'have', 'been', 'will', 'more', 'each', 'rather', 'without', 'which',
  'clients', 'client', 'customers', 'customer', 'lyzr', 'agents', 'agent', 'revenue', 'service',
  'services', 'sell', 'selling', 'cannot', 'could', 'already', 'every', 'work', 'build']);
const valueWords = (t) => new Set(String(t ?? '').toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !VALUE_STOP.has(w)) ?? []);
function sameValue(a, b) {
  const A = valueWords(a); const B = valueWords(b);
  if (A.size < 3 || B.size < 3) return false;
  const shared = [...A].filter((w) => B.has(w)).length;
  return shared / Math.min(A.size, B.size) >= 0.5;
}

/* Score every candidate the model proposed, and gate it. The two are deliberately
 * separate: a candidate can be the best idea on the list and still not be something we
 * are willing to say. */
function assess(opportunities, caps, candidates, plays = []) {
  /* Every name this play answers to.
   *
   * The map was keyed on `play.id` while the model is handed `play.offering_id`. The nine
   * platform records carry the same string in both, so they resolved; the twenty nine
   * packaged solutions have no `id` at all, so all of them keyed to `undefined` and not
   * one could ever be matched back. The model would propose Madison GRC for a bank, the
   * lookup would miss, and the candidate would fall through as a generic capability line.
   * That is the whole reason the industry layer never reached a partner, and once a
   * product became mandatory it stopped being a silent degradation and started emptying
   * whole runs. */
  const eligible = new Map();
  for (const x of plays) {
    for (const k of [x.play.offering_id, x.play.id, x.play.product_id, x.play.name]) {
      if (k) eligible.set(String(k).toLowerCase().trim(), x);
    }
  }
  /* A model that names the product in prose rather than by id still meant one of ours. */
  const resolvePlay = (name) => {
    const k = String(name ?? '').toLowerCase().trim();
    if (!k) return null;
    return eligible.get(k)
      ?? plays.find((x) => norm(x.play.name) === norm(k) || norm(x.play.offering_id) === norm(k))
      ?? null;
  };
  const out = [];
  for (const opp of opportunities ?? []) {
    /* A product opportunity is only a product opportunity if the product was one we
     * offered. The model naming something else is a capability line that mentioned a
     * product, and it is scored as one. */
    const chosen = resolvePlay(opp.product);
    const play = chosen?.play ?? null;
    if (!play) console.error('product not eligible, candidate dropped:', opp.product);

    /* A second product, where the opportunity genuinely needs two of ours doing different
     * jobs: orchestration running the process and a build platform supplying the agents
     * inside it. Resolved the same way as the first and held to the same rule, so a name
     * the model liked the sound of does not become a bundle on the page. It has to be
     * eligible, and it has to not be the first one again. */
    const second = resolvePlay(opp.with_product)?.play ?? null;
    const alsoPlay = second && second.offering_id !== play?.offering_id ? second : null;
    if (opp.with_product && !alsoPlay) console.error('second product not eligible, dropped:', opp.with_product);

    const pattern = resolvePattern(opp, play);
    if (!pattern) { console.error('dropped candidate, no pattern fits:', opp.pattern); continue; }

    /* What the partner's customer could buy afterwards that they cannot buy now. The
     * model is asked for it directly and told not to propose the opportunity where it
     * cannot write the sentence, so a blank or a shrug here is that answer arriving
     * unsaid, and a candidate that cannot say it is the partner's own offering handed
     * back to them. Checked at proposal rather than only at selection, because a
     * shortlist of three of these leaves nothing to select between. */
    const beyond = String(opp.beyond_today ?? '').trim();
    if (beyond.length < 25 || /^(faster|less engineering|more scalable|easier)/i.test(beyond)) {
      console.error('dropped candidate, nothing beyond what they sell today:', opp.headline);
      continue;
    }

    /* How well each Lyzr record supports this, matched on the words of the work rather
     * than on the model's citation. The citation picks the field to look in; this decides
     * whether it holds. */
    const cited = new Set(opp.lyzr_cites ?? []);
    /* The whole catalogue, not only what was cited. The citation is a hint about where to
     * look, not a limit on where we may look: the catalogue is ours and we can find the
     * right record ourselves. Rejecting a sound opportunity because a haiku call cited
     * the wrong one of our own pages is a failure of ours, not of the opportunity.
     * Their evidence is the opposite case, and is checked strictly. */
    const ranked = candidates.map((r) => ({ r, s: support(r, opp) + (cited.has(r.id) ? 3 : 0) }))
      .filter((x) => isUsable(x.r))
      .sort((a, b) => b.s - a.s);

    /* The play decides whether the department cap applies: a governance layer is not a
     * department this firm delivers into, and never will be. */
    const fit = fitScore(opp, caps, play);
    /* On a product line the Lyzr contribution is the product, and the product is a fact
     * about our own estate rather than something to be inferred from a case study. It
     * still has to be a product this partner qualified for, which was decided from their
     * evidence before the model ever saw it. */
    const lyzr = play ? playScore(play, chosen.fit, ranked) : lyzrScore(opp, ranked);
    const judged = {
      fit: fit.score,
      lyzr: lyzr.score,
      /* Computed from their evidence, not asked of the model: how far this is from what
       * they already do is exactly what their own delivered work can answer. */
      adjacency: adjacency(opp, caps, fit, play),
      monetisation: clamp(opp.monetisation ?? opp.clarity),
      trigger: clamp(opp.trigger ?? opp.feasibility),
    };
    out.push({
      opp, pattern, ranked, fit, lyzr, play, alsoPlay,
      scores: judged,
      score: total(judged),
      /* The play decides whether this is a licensed opportunity at all, so the gate has
       * to see it rather than infer it from the score. */
      gate: gate(opp, fit, lyzr, play),
    });
  }
  return out;
}

const clamp = (n) => Math.max(1, Math.min(5, Number(n) || 3));

/* What Lyzr contributes to a product line. The product is the contribution, so this scores
 * how well the partner is placed to deliver it rather than how well a case study matches:
 * a strong eligibility read on their delivered work is worth more than a word that
 * happened to appear on their site. A catalogue record on point still adds, because it
 * means we have shipped something like it. */
function playScore(play, fit, ranked) {
  let s = fit.onFamily.length ? 4.2 : 3.4;
  if (fit.onFamily.length >= 2) s += 0.4;
  if ((ranked ?? []).some((x) => x.s >= LEADS)) s += 0.4;
  return {
    score: Math.min(5, Math.round(s * 10) / 10),
    lead: ranked?.[0] ?? null,
    why: `${play.name}: ${fit.why}`,
  };
}

/* The model is asked for a pattern id and sometimes answers with the growth path instead,
 * which is the field next to it in the list it was given. Dropping the candidate for that
 * throws away a good opportunity over a labelling slip, so the shape of the work decides
 * instead: running or governing something after it ships is a retainer, a packaged offer
 * into a new account is a win, and work inside a process they already run is expansion. */
const RUNS = /\b(run|runs|running|monitor|monitoring|govern|governance|manage[ds]?|managed|support|observability|audit trail|compliance reporting|operate|operations centre|estate)\b/i;

/* Which commercial motion maps onto which growth path, where the model gave us one. */
const MOTION_PATH = {
  new_implementation: 'win',
  product_deployment: 'win',
  productization: 'win',
  account_expansion: 'expand',
  managed_service: 'retain',
  embedding: 'win',
};

function resolvePattern(opp, play = null) {
  const exact = patternById(opp.pattern);
  if (exact) return exact;
  /* A product play names the pattern for each of its two shapes, so a product line never
   * has to fall back on guesswork. Which of the two depends on whether the model framed
   * it as the deployment or as the thing that bills every month. */
  if (play) {
    const runs = RUNS.test(`${opp.headline} ${opp.paid_service} ${opp.work}`);
    return patternById(runs ? play.managed.pattern : play.implementation.pattern)
      ?? patternById(play.implementation.pattern);
  }
  const said = String(opp.pattern ?? '').toLowerCase();
  const path = ['expand', 'win', 'retain'].includes(said) ? said
    : MOTION_PATH[opp.motion]
      ?? (RUNS.test(`${opp.headline} ${opp.paid_service} ${opp.work}`) ? 'retain'
        : opp.relation === 'new' ? 'win' : 'expand');
  const options = PATTERNS.filter((x) => x.growth_path === path);
  if (!options.length) return null;
  /* Within the path, the one whose `when` reads most like this work. */
  const text = `${opp.headline} ${opp.paid_service} ${opp.work} ${opp.customer_problem}`.toLowerCase();
  const words = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const t = words(text);
  return options
    .map((x) => ({ x, n: [...words(x.when)].filter((w) => t.has(w)).length }))
    .sort((a, b) => b.n - a.n)[0].x;
}

/* Two candidates on the same engagement pattern and the same department are the same
 * candidate twice. Two leading on the same Lyzr record come back with the same proof and
 * the same steps, which is one idea wearing two headlines. Higher score keeps it. */
function dedupe(scored, want = 3) {
  /* Two recommendations are the same recommendation when they sell the same thing, to the
   * same buyer, for the same reason. Not when they share a label.
   *
   * This used to key on the commercial motion, which was too coarse: Agent Studio and
   * SuperFlow both widen an engagement, and they are still a build platform and an
   * orchestration layer, bought by different people to fix different problems, delivered
   * as different engagements. Collapsing them threw away a real second opportunity to
   * enforce a tidy-looking spread. A motion is a way of describing an opportunity, not a
   * slot that only one thing may occupy.
   *
   * What is genuinely duplicate: the same product twice, or two cards aimed at the same
   * buyer about the same process. Those a partner reads as one idea written out twice. */
  const subjectOf = (x) => `${x.opp.function ?? ''}|${String(x.opp.buyer ?? '').toLowerCase().trim()}`;
  /* Two candidates aimed at the same customer problem are one candidate, even where the
   * department and the buyer differ. The model is asked to compare on the problem, the
   * buyer, what the customer buys and what Lyzr adds; this is the backstop under the
   * first of those, which is the one a product name most easily disguises. */
  const samePain = (a, b) => sameValue(a.opp.customer_problem, b.opp.customer_problem);
  const byProduct = new Set();
  const bySubject = new Set();
  const byLead = new Set();
  const out = [];
  const held = [];
  for (const x of scored) {
    const productId = x.play?.offering_id ?? x.play?.id;
    const subject = subjectOf(x);
    const leadId = x.lyzr.lead?.r?.id;
    const entry = { ...x, id: `${productId}--${(x.opp.function || 'line').replace(/\W+/g, '-')}`.toLowerCase(), motion: x.play?.commercial_motion ?? 'unknown' };
    if ((productId && byProduct.has(productId)) || bySubject.has(subject)
      || out.some((y) => samePain(y, x))) { held.push(entry); continue; }
    if (productId) byProduct.add(productId);
    bySubject.add(subject);
    if (leadId) byLead.add(leadId);
    out.push(entry);
  }
  /* A firm with one strong product and two angles on it would otherwise end on one card.
   * A held candidate comes back only if it is a different product and a different Lyzr
   * record, so the two are at least different things to sell. */
  const dropped = [];
  for (const x of held) {
    const productId = x.play?.offering_id ?? x.play?.id;
    const leadId = x.lyzr.lead?.r?.id;
    if (out.length < want && !(productId && byProduct.has(productId)) && !(leadId && byLead.has(leadId))
      && !out.some((y) => samePain(y, x))) {
      if (productId) byProduct.add(productId);
      if (leadId) byLead.add(leadId);
      out.push(x);
    } else {
      dropped.push(x);
    }
  }
  return { picks: out, dropped };
}

/* The shape the card writer and the grounding step expect. Everything a promise is built
 * from, the engagement pattern and the Lyzr record, travels on it; everything the model
 * merely asserted is labelled as what it is. */
function toLine(x, scope = {}) {
  const { opp, pattern, lyzr, fit, play, alsoPlay } = x;
  /* A product line's Lyzr side is the product, so it may have no catalogue record behind
   * it at all. Everything that reads `lead` has to cope with that. */
  const lead = lyzr.lead?.r ?? null;
  /* Word overlap gets a record considered. Compatibility decides whether it may be used,
   * and for what: the same record can be fine as an explanation and wrong as proof. */
  const fits = (r, role) => compatible(r, opp, role, scope).ok;
  const onPoint = x.ranked.filter((r) => r.s >= LEADS);
  return {
    id: x.id,
    headline: opp.headline,
    angle: opp.angle,
    work: opp.work,
    unit: opp.unit,
    function: opp.function,
    buyer: opp.buyer,
    relation: opp.relation ?? 'new',
    pattern,
    growth_path: pattern.growth_path,
    lead,
    /* Which half of the engine this came from, and the product if it was the product
     * half. Carried through so the card can lead with the product rather than bury it. */
    path: play ? 'product' : 'capability',
    play,
    /* Three different jobs, so three different records, chosen on three different bars.
     * `lead` carries the Lyzr side of the argument and may match loosely. `proof_lead`
     * prints a number measured at another customer, which demands a close match and the
     * same department, or a procurement card ends up quoting an outbound sales result.
     * `ref_lead` is what we point at when nothing can prove it: a solution or product
     * page says what the thing is without claiming an outcome, which is the honest
     * fallback and reads better than a case study about something else. */
    proof_lead: onPoint.find((x) => isSolid(x.r) && x.s >= PROVES
      && (x.r.functions ?? []).includes(opp.function)
      /* A record filed under five departments is not about one piece of work: it is a
       * platform page or a partnership page, and its numbers are vendor metrics rather
       * than a client's outcome. "3 joint customer solutions in documented production"
       * reached a production planning card that way. */
      && (x.r.functions ?? []).length <= 4
      /* And about the same subject, not merely the same department. */
      && hits(x.r, opp) >= 3
      && fits(x.r, 'proof'))?.r ?? null,
    /* And a reference still has to be about the work. "Built on <a coding agent for
     * someone else>" under a procurement card is not a weaker claim than a result, it is
     * the same wrong claim without the number, so when nothing is close enough the card
     * shows no provenance line at all. */
    /* A product line points at the product's own page, which is the honest reference:
     * it says what the thing does and claims no customer outcome. */
    /* A product line points at the product's own page, which is the honest reference: it
     * says what the thing does and claims no customer outcome. */
    ref_lead: (play ? catalogueFor(play) : null)
      /* A customer story used as a reference is still a claim that we have done this
       * sort of thing, so it has to clear the same subject and department test as one
       * used as proof. Only a solution or product page, which describes a capability
       * rather than an engagement, gets in on the looser match. */
      ?? (onPoint.find((x) => x.r.kind !== 'delivered' && hits(x.r, opp) >= 2 && fits(x.r, 'reference'))
        ?? onPoint.find((x) => hits(x.r, opp) >= 3
          && (x.r.functions ?? []).includes(opp.function)
          && fits(x.r, 'reference')))?.r
      ?? null,
    /* "What the client actually gets" is a description rather than a promise, so it can
     * come from a record that was too loose to cite: what it may not do is describe steps
     * from a different piece of work. So the record is chosen by whether its own steps
     * survive the filter, and a record that contributes one step contributes none. */
    /* Explaining how the thing works is a looser claim than proving it, but not a loose
     * one: a record that shares only a department and one word is describing some other
     * engagement's machinery. Two words of real subject overlap, and the steps themselves
     * still have to survive their own filter. */
    mechanism_lead: onPoint.find((x) => hits(x.r, opp) >= 2 && fits(x.r, 'mechanism')
      && stepsFor(x.r, opp, scope).length >= 2)?.r ?? null,
    scope,
    stories: x.ranked.filter((r) => r.s >= LEADS / 2).map((r) => r.r),
    /* The partner's own work this stands on. The card quotes it back to them, which is
     * the single thing that proves we read their site rather than their sector. */
    stands_on: fit.cited.filter((e) => e.grounded).slice(0, 3)
      .map((e) => ({ id: e.id, what: e.what, client: e.client, url: e.url, outcomes: e.outcomes })),
    /* How the money is actually made, which decides what the card promises and what the
     * reader has to budget for. A deployment labelled as a build makes them budget for a
     * build they do not need. */
    motion: MOTION_PATH[opp.motion] ? opp.motion : null,
    /* Two or three things they could charge for, taken from the offering where there is
     * one so a product stays a product and the service stays theirs. */
    sellable_services: (play?.sellable_services ?? [])
      .map((x) => ({ name: x.name, client_gets: x.client_gets }))
      .concat((opp.sellable_services ?? []).map((x) => ({ name: String(x).slice(0, 60), client_gets: '' })))
      .slice(0, 4),
    /* What the model named for this line specifically, kept apart so it can stand in when
     * the offering's own services turn out to be about the product rather than this. */
    own_services: (opp.sellable_services ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 3),
    monetisation: String(opp.monetisation_note ?? '').slice(0, 160),
    /* What a client would have to confirm. Printed as things to check, which is what
     * makes everything beside them credible. */
    assumptions: (opp.assumptions ?? []).map((x) => String(x).trim()).filter(Boolean).slice(0, 2),
    restrictions: play?.restrictions ?? [],
    customer_problem: opp.customer_problem,
    /* An inferred problem is shown as a thing to confirm, never as a thing we know. A
     * line standing on a service page cannot attest to anything, whatever the model said:
     * the page describes what they sell, not a client who had the problem. */
    problem_status: opp.problem_status === 'attested' && !fit.advertised && !fit.profileOnly ? 'attested' : 'hypothesis',
    paid_service: opp.paid_service,
    lyzr_advantage: opp.lyzr_advantage,
    beyond_today: opp.beyond_today,
    /* The second Lyzr product, where the opportunity needs two doing different jobs. */
    also_play: alsoPlay ?? null,
    expansion_path: opp.expansion_path,
    scores: x.scores,
    score: x.score,
  };
}

const contextOf = (profile, answers) => [
  '# Company profile', JSON.stringify(withoutSize(profile), null, 1), '',
  /* The capability map comes first in the model's attention and last in the prose, which
   * is the right way round: it is the material, and the profile is the frame. */
  '# What this firm has actually delivered (your primary material, cite by id)',
  profile.capabilities
    ? JSON.stringify(profile.capabilities, null, 1)
    : '(their site could not be read for delivered work. Lean on the profile, and mark every customer problem as a hypothesis.)',
  profile.capabilities?.basis === 'advertised'
    ? '\n# Note: this firm publishes no engagement write-ups. The records above are the service pages they wrote about themselves, which say what they sell and not what they have shipped. Cite them as usual, keep the claims about their delivery smaller, and mark every customer problem as a hypothesis.\n'
    : '',
  '',
  /* What they sell today, pulled out of the profile and stated as a rule rather than
   * left as one key among forty. Doxim was recommended conversational payment agents by a
   * brief whose own second paragraph said Doxim already captures payment intent through
   * conversation: the fact was in front of the model and read as background. */
  (profile.already_offers ?? []).length
    ? `# What this firm already sells its customers today\n${JSON.stringify(profile.already_offers, null, 1)}\nAn opportunity that is one of these back again is not an opportunity, however well it would sell. Propose it only where the Lyzr product extends it into something they demonstrably cannot offer now, and say in \`beyond_today\` what that is.\n`
    : '',
  '# What the visitor told us', JSON.stringify(answers, null, 1), '',
];

export async function step2(profile, answers, found) {
  /* The browser hands back what it prefetched. Without it, or if it came back with
   * nothing usable, the step runs it now: a slower journey beats a broken one. */
  const d = found?.picks?.length ? safeScope(found) : await discover(profile, answers);
  const { opening, picks, ms: discoveryMs, not_recommended, stack } = d;
  const context = contextOf(profile, answers);
  const t1 = Date.now();

  const written = await Promise.all(picks.map(async (p) => {
    try {
      const card = await ask('partner_opportunity', [
        ...context,
        '# The service line to write', '',
        JSON.stringify({
          headline: p.headline, work: p.work, unit: p.unit, function: p.function,
          buyer: p.buyer, paid_service: p.paid_service,
          customer_problem: p.customer_problem, problem_status: p.problem_status,
          lyzr_advantage: p.lyzr_advantage,
        }, null, 1), '',
        /* Their own delivered work, which is what the line was generated from and what
         * the card has to argue from. Without it the writer falls back on the sector and
         * the card reads like a template. */
        '# What THIS FIRM has already delivered that this line stands on (quote it back to them)',
        JSON.stringify(p.stands_on, null, 1), '',
        p.problem_status === 'hypothesis'
          ? '# The customer problem is an inference, not something their site evidences. Write it as something to confirm on the first call, never as a fact about their clients.\n'
          : '',
        '# The Lyzr engagements it was built from (your material, never your subject)',
        JSON.stringify(p.stories.map(full), null, 1), '',
        '# Why this one was chosen for them', p.angle,
        /* How it stands against what they already ship. Discovery decided it; the card has
         * to be written from it, or a firm that already runs agents reads a card telling
         * it to start. */
        `# How it stands against what they already have: ${p.relation}`,
        /* Which of the three kinds of growth this is. The three cards are three different
         * ways to make money rather than three use cases. */
        `# Which kind of growth this is: ${p.growth_path}`,
      ].join('\n'));
      return { ...card, id: p.id, growth_path: p.growth_path, line: p };
    } catch (e) {
      /* One card failing is not the step failing — the others still stand. */
      console.error('card failed for', p.id, e.message);
      return null;
    }
  }));

  const cards = written.filter(Boolean);
  if (!cards.length) throw new Error('No service lines could be written for this profile.');
  cards.forEach(tidyCard);
  groundCards(cards, profile);
  /* Nothing reaches the partner that has not been checked against the evidence it was
   * built from. Cheap, synchronous, and the only place in the journey that assumes the
   * model got it wrong. */
  const checked = verify(cards, profile);
  if (checked.issues.length) console.error('verify:', JSON.stringify(checked.issues));
  return {
    opening,
    cards: checked.cards,
    not_recommended,
    /* Carried through so the run record holds the whole stack that was weighed, not just
     * the three that came out of it. */
    stack,
    quality: { issues: checked.issues, blocking: checked.blocking, degraded: checked.degraded },
    ms: { discovery: discoveryMs ?? 0, cards: Date.now() - t1 },
  };
}

/* How well a customer story actually supports this line. The model cites generously, and
 * a loose citation is not a harmless one: the story it leads with supplies the proof and
 * the "what the client actually gets" steps, so a near-miss puts an insurance call
 * campaign under a clinical workflow card. Matched on the words of the work and on the
 * business function, not on the model's say-so. */
/* How many words of substance this line and this story actually share. Kept separate
 * from the score because the two are used for different decisions: the score decides
 * whether a story may back an argument, and this decides whether it may carry a number.
 * A shared department is not a shared subject, and scoring them together is how an HR
 * result ended up under a claims triage card. */
function hits(story, line) {
  const terms = termSet(`${line.work} ${line.headline} ${line.unit}`);
  const text = `${story.sellable_as} ${(story.built ?? []).join(' ')} ${story.industry}`.toLowerCase();
  return [...terms].filter((w) => text.includes(w)).length;
}

function support(story, line) {
  const sameFunction = (story.functions ?? []).includes(line.function);
  return hits(story, line) * 4 + (sameFunction ? 5 : 0) + (isSolid(story) ? 2 : 0);
}
/* Enough to lead a card on. Below this the story is about something else, whatever the
 * citation said. */
const LEADS = 9;
/* And what it takes to quote that record's published number on someone else's card. */
const PROVES = 14;

/* The questions that tell a partner whether an account is live are judgment, so they are
 * the model's to write. What it is not allowed to do is pad: three thin questions read as
 * filler and cost the whole card its authority. Short of the count, we show fewer. */
function tidyCard(card) {
  const lines = (xs, n) => [...new Set((xs ?? []).map((x) => String(x).trim()).filter(Boolean))].slice(0, n);
  card.qualify = lines(card.qualify, 3);
  card.where_it_lands = String(card.where_it_lands ?? '').trim();
  card.attaches_to = String(card.attaches_to ?? '').trim();
  return card;
}

/* The product's own page in the catalogue, where we have crawled one. Not every product
 * has a readable page: three of them are JavaScript shells that return no text, which is
 * why the play file carries its own description and the catalogue link is optional. */
const catalogueFor = (play) => (play.catalogue_id ? recordById(play.catalogue_id) : null);

/* The client's end state, from the writer, kept only where it survives three tests: it is
 * about the thing this card is about, it is concrete enough to check, and it is not a
 * sentence lifted off a product page. Two is the floor: one deliverable reads as an
 * afterthought and is worse than none. */
const FEATURE_TALK = /\b(ai.powered|end.to.end|seamless\w*|enterprise.grade|best.in.class|turnkey|out of the box|scalab\w*|robust|cutting.edge|next.generation|unified platform|single pane)\b/i;

function deliverables(card, line) {
  const subject = objects(`${card.headline} ${line.work} ${line.unit} ${card.what_it_is}`);
  const seen = new Set();
  return (card.client_gets ?? [])
    .map((x) => String(x ?? '').trim())
    .filter((x) => x.length > 12 && x.length < 180)
    .filter((x) => (seen.has(x.toLowerCase()) ? false : seen.add(x.toLowerCase())))
    /* A deliverable about a different thing from the card is a second service hiding
     * inside the first: order validation quietly becoming invoice reconciliation. */
    .filter((x) => !drifts(subject, x))
    /* And it has to describe something rather than praise it. */
    .filter((x) => !FEATURE_TALK.test(x))
    .slice(0, 4);
}

/* How much of this they already have. A partner reads a card very differently depending
 * on whether it asks them to start something, to package something they have built before,
 * or to take an existing service further. Derived from their own evidence rather than
 * asserted: if nothing they have delivered sits in this department, it is new to them,
 * whatever the model called it. */
const PACKAGES = new Set(['package-then-sell', 'embed-and-license']);
const DEPLOYS = new Set(['deploy-in-their-estate', 'roll-out-to-everyone']);

function offeringKind(line) {
  const proven = (line.stands_on ?? []).length > 0;
  /* The label has to agree with the engagement underneath it. A card sold as a packaged
   * solution that calls itself an extension, or a deployment that calls itself a new
   * service, contradicts its own first offer two inches down the page. So the pattern
   * decides, and only where the pattern is neutral does the relation. */
  if (PACKAGES.has(line.pattern?.id)) return 'Something you have built, packaged to sell again';
  if (DEPLOYS.has(line.pattern?.id)) return 'A deployment you would run for them';
  if (!proven) return 'A new service for you';
  if (line.relation === 'scales') return 'Something you have built, packaged to sell again';
  return 'An extension of what you already sell';
}

/* The kinds of work this card is about, read off the finished card rather than off the
 * line, because the writer may have made it more specific than the line was. */
const familiesOf = (line, card) => families([
  line.headline, line.work, line.unit, line.paid_service, line.customer_problem,
  card?.what_it_is, card?.headline,
].filter(Boolean).join(' '));

/* A solution page's own description is a sentence, and a sentence rendered as the name of
 * a thing reads as a mistake. First clause, and never more than a line. */
function shortTitle(s) {
  const first = String(s ?? '').split(/[.;]/)[0].trim();
  if (first.length <= 70) return first;
  const cut = first.slice(0, 70);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,\s]+$/, '');
}

/* Everything on a card that is a promise rather than an argument: the engagement they
 * would sell, how long it runs, who has to be on it, what the client actually gets, and
 * the proof. None of it is the model's to write. It comes from the engagement pattern the
 * line was matched to and from the customer stories the line cites, so a quietly inflated
 * "six weeks" or a mis-copied case study URL can never reach a partner. */
function groundCards(cards, profile) {
  for (const card of cards ?? []) {
    const line = card.line;
    if (!line) continue;
    const { pattern, stories } = line;
    /* {work} and {unit} are the only blanks the model fills in a promise, and they are
     * four words each: what the engagement is about, and the one thing a pilot runs on. */
    /* "{unit}s" is a plural in the template and the unit is a phrase, so the s lands on
     * the last word and only where English puts it there: "lead source or geographys" is
     * the kind of thing a reader stops on and stops trusting the rest of the page for. */
    const unit = line.unit || 'process';
    const plural = unit.replace(/(\w+)$/, (w) => (
      /(s|x|z|ch|sh)$/i.test(w) ? `${w}es`
        : /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies`
          : `${w}s`));
    const fill = (s) => String(s ?? '')
      .replace(/\{unit\}s\b/g, plural)
      .replace(/\{work\}/g, line.work || 'workflow')
      .replace(/\{unit\}/g, unit)
      /* "Multi-agent workflow operations" dropped into "{work} operations review" reads
       * as "operations operations review". The model is describing the work, not writing
       * the label, so the join is ours to clean up. */
      .replace(/\b(\w+)\s+\1\b/gi, '$1')
      .replace(/^./, (c) => c.toUpperCase());

    /* The strongest story this line stands on carries the proof, and it is one we read off
     * the page ourselves rather than one assigned to a service line by hand. The old
     * mapping used sixteen of sixty case studies and put a go-to-market figure under a
     * governance play. */
    /* The story that carries the proof and what the client gets has to be the one about
     * *this* work. Taking the first solid citation put an HR engagement's agents under a
     * software delivery line; matching on the function alone then put regulatory
     * monitoring under agent governance, because both are "compliance". So it is matched
     * on the words of the work itself. */
    /* A number is the strongest thing on the card and the easiest to misplace, so it
     * comes from the record chosen to prove rather than from the one chosen to argue. */
    const lead = line.proof_lead ?? line.ref_lead;
    /* Judged against the finished card, not against the line it grew from. The writer
     * makes a card more specific than the line was, and filtering against the looser text
     * kept material the final check then threw out wholesale. */
    const written = { ...line, headline: card.headline, what_it_is: card.what_it_is, why_you: card.why_you };
    /* "What the client actually gets" is the client's end state, which is a different
     * thing from what our product does and from what the partner configures with it. The
     * writer produces it for this workflow; we keep only what is about this workflow.
     *
     * The old fallback copied a product's own capability lines straight in, which put
     * SuperFlow's durable execution features inside a regression testing deliverable. A
     * product page is never a deliverable. */
    card.mechanism = deliverables(card, written);
    /* Nothing usable from the writer. The product the card is built on speaks next,
     * because what a client ends up with is what the product does, and that is on subject
     * by construction.
     *
     * The engagement record used to speak here instead, and for a card that sits *over*
     * the partner's delivered work rather than inside it, that was the wrong source: a
     * governance layer is sold above agents built for customer service and finance alike,
     * so the nearest catalogue story describes incident handling while the card is about
     * governance. The verifier then correctly judged the two to be different things and
     * deleted the mechanism, which cost the card its most concrete section. */
    if (!card.mechanism.length && line.play) {
      card.mechanism = (line.play.capabilities ?? [])
        .map((x) => String(x ?? '').trim())
        .filter((x) => x.length > 12 && x.length < 180)
        .slice(0, 4);
    }
    if (!card.mechanism.length) {
      /* Still nothing, so the engagement we cited speaks, step by step: one engagement
       * covers several kinds of work at once and the steps belonging to a different one
       * describe a toolchain this client does not have. */
      const shows = line.mechanism_lead ?? lead;
      card.mechanism = shows ? stepsFor(shows, written, line.scope).slice(0, 4) : [];
    }
    if (card.mechanism.length < 2) delete card.mechanism;
    if (line.proof_lead) {
      card.proof = { customer: lead.client, result: lead.results?.[0] ?? '', url: lead.url, title: lead.title, teaser: '' };
      /* What the client actually gets, taken from what the agents in that engagement
       * really do. This is the half of a card that used to be written once per service
       * line; now it is evidence. One engagement often covers several functions at once,
       * so the steps that belong to a different one are dropped before the first four:
       * a line about test automation should not open with the HR agent. */
    } else if (line.play) {
      /* No customer story is about this work yet, so there is no result to quote. The
       * honest thing to point at is the product the card is built on, and its own page.
       *
       * The nearest catalogue record used to stand here, which on a card that sits over
       * the partner's delivered work is a page about something adjacent: the verifier
       * judged it a different subject and deleted it, so the card pointed at nothing. The
       * product is never the wrong subject, because the product is what is being sold. */
      card.reference = { title: line.play.name, url: line.play.url, kind: 'product' };
    } else if (lead) {
      /* Either nothing we have published is about this work, or what we have is not close
       * enough to put a number on it. Both say the same honest thing. */
      /* Some solution pages are titled with nothing but the function they serve, and
       * "Built on IT operations" reads as a mistake. What the page says it is beats what
       * the page is called. */
      const title = lead.title.replace(/\s*overview$/i, '').replace(/:\s*what we do$/i, '').trim();
      card.reference = {
        title: shortTitle(title.length >= 18 ? title : (lead.sellable_as || title)),
        url: lead.url,
        kind: lead.kind,
      };
    }

    card.first_offer = {
      name: fill(pattern.first_offer.name),
      shape: fill(pattern.first_offer.shape),
      /* What the first engagement actually delivers, in the product's own words where it
       * has them. The pattern's version is written for a shape of work, so every card on
       * the same pattern ended on the same sentence whatever was being sold. The duration
       * and the staffing stay the pattern's: those are commitments, not descriptions. */
      ends_with: (line.play?.implementation?.offer
        ? String(line.play.implementation.offer)
        : fill(pattern.first_offer.ends_with)).replace(/^./, (c) => c.toLowerCase()),
    };
    card.who_buys = line.buyer;
    card.delivery = fill(pattern.delivery.shape);
    card.team_needed = fill(pattern.delivery.team_needed);
    /* The product's own questions where it has them, the pattern's where it does not.
     * The pattern's are written for a shape of engagement rather than for a thing being
     * sold, so an orchestration card inherited "where the data is allowed to live" from
     * a pattern it shares with a sovereign deployment. A partner reads that and knows we
     * are not really talking about their client. */
    card.discovery = (line.play?.discovery ?? []).length
      ? line.play.discovery.slice(0, 4)
      : (pattern.discovery ?? []).map(fill);
    card.roles = { partner: fill(pattern.roles.partner), lyzr: fill(pattern.roles.lyzr) };
    /* Where the money goes next is a revenue promise, so it comes from the pattern even
     * though the model was asked to think about it. */
    card.how_to_sell = { ...(card.how_to_sell ?? {}), expansion: fill(pattern.expansion) };
    /* The three streams the brief tables. Written per pattern for the same reason the
     * durations are: what a partner bills for is the part of this document they will be
     * held to, and it is not a thing to regenerate per run. */
    /* The product's own revenue lines where it has them, the pattern's where it does not.
     *
     * The pattern describes a shape of engagement, so its rows are the same for every
     * product that shares it: a governance upsell and a document extraction build came
     * out billing for identical things. What a partner charges for depends on what they
     * are selling, so the product speaks first and the pattern fills the gaps. */
    const fromPattern = pattern.revenue
      ? Object.fromEntries(Object.entries(pattern.revenue).map(([k, v]) => [k, fill(v)]))
      : {};
    card.revenue = {
      implementation: line.play?.revenue?.implementation || fromPattern.implementation || '',
      recurring: line.play?.revenue?.recurring || line.play?.follow_on || fromPattern.recurring || '',
      /* No product declares an expansion line, so this one stays the pattern's. */
      expansion: fromPattern.expansion || '',
    };

    /* What they build on, and what they can put in front of a client next week. A named
     * agent is worth more than a platform name here: a partner can demo Diane. */
    const kit = productsFor([line.function]);
    card.lyzr_products = kit.platform.map((p) => p.name);
    /* A demo is the strongest claim on the card, because the partner will put it in front
     * of a client. An agent built for an industry they do not serve fails that test
     * however its department tag reads: Benjie is an insurance claims agent and it reached
     * a supply chain forecasting card through the word "operations". */
    card.demo = kit.agents
      .filter((a) => compatible(
        { title: a.name, sellable_as: a.does, topics: a.for }, line, 'demo', line.scope).ok)
      .map((a) => ({ name: a.name, does: a.does }));

    /* What else the partner can send that client. Matched on the function and the topics
     * of the stories this line actually stands on, never by asking a model which links
     * sound relevant. */
    /* Matched on what this line is about, in its own words. Taking the topics off the
     * cited Lyzr stories put an outbound SDR case study under a ServiceNow incident card:
     * the story backed the argument loosely, and its topics were nothing to do with the
     * work. The stories still contribute, but behind the line's own vocabulary. */
    /* A play carries its own approved reading, which beats anything matched by topic. */
    const approved = (line.play?.resources ?? []).map(resourceById).filter(Boolean);
    /* Kept whatever the relevance filters later decide, so a card always has something
     * to send even when nothing matched its exact workflow. */
    card.productResources = approved;
    /* The product's own pages AND whatever is about this client's industry.
     *
     * The product pages used to win outright, so a card for a manufacturing ERP partner
     * sent "OpenController overview" and nothing else: the industry library could not get
     * in because it was never asked for. A partner forwarding that has sent a product
     * brochure. One product page to say what it is, then the pages about their world. */
    const onTopic = relatedTo({
      /* The line's own vocabulary, and the topics of the one record that was close
       * enough to prove it. The other cited stories are deliberately left out: their
       * topics are the taxonomy of a different engagement, and two coarse words shared
       * with it ("human", "resources") was enough to put a mentorship case study under a
       * field service card. */
      topics: [line.work, line.unit, card.headline, ...(line.proof_lead?.topics ?? [])],
      functions: [line.function],
      /* What this card is about and whose business it is, so a page about someone else's
       * industry cannot arrive on a department tag alone. */
      families: [...familiesOf(line, card)],
      domains: [...(line.scope?.domains ?? [])],
      products: card.lyzr_products,
      industries: (profile.industries ?? []).map((i) => i.name),
      exclude: stories.map((s) => s.id),
    }, 8);
    const merged = [];
    for (const r of [...approved.slice(0, 1), ...onTopic, ...approved.slice(1)]) {
      if (r && !merged.some((x) => x.id === r.id)) merged.push(r);
    }
    /* Six rather than three. The brief page prints every link that genuinely helps them
     * understand, validate or sell this one opportunity, and three was a limit set by how
     * much room a compact card had, not by how much is worth sending. The verifier still
     * drops anything too general to go with this offer, so the list gets longer only
     * where there is more that belongs on it. */
    card.resources = merged.slice(0, 6);
    /* Their own delivered work, carried onto the card. This is the thing that proves we
     * read their site rather than their sector, it is what the brief quotes back, and it
     * is what the verification pass checks every claim against. */
    card.stands_on = line.stands_on ?? [];
    card.offering = offeringKind(line);
    card.motion = line.motion;
    /* The offering's own services are written for the product, not for this card. Where
     * one is about a different workflow it is dropped, and what the model named for this
     * line stands instead: an OpenController card about release testing was offering
     * "agent estate discovery", which is the product's service and not this one. */
    const subj = objects(`${card.headline} ${written.work} ${written.unit} ${card.what_it_is}`);
    const onSubject = (line.sellable_services ?? []).filter((x) => !drifts(subj, `${x.name} ${x.client_gets}`));
    /* The offering's services and the writer's own can name the same thing twice. */
    const seenService = new Set();
    card.sellable_services = (onSubject.length ? onSubject : [])
      .filter((x) => { const k = x.name.toLowerCase().replace(/[^a-z ]/g, '').trim(); 
        if (seenService.has(k) || [...seenService].some((p) => k.startsWith(p) || p.startsWith(k))) return false;
        seenService.add(k); return true; })
      .slice(0, 3);
    if (!card.sellable_services.length && line.own_services?.length) {
      card.sellable_services = line.own_services.map((name) => ({ name, client_gets: '' })).slice(0, 3);
    }
    card.monetisation = line.monetisation || fill(pattern.expansion);
    card.assumptions = line.assumptions ?? [];
    /* What we are not entitled to promise about this offering, kept on the card so the
     * verifier can check nothing contradicted it. Never shown to a partner as a list. */
    card.restrictions = line.restrictions ?? [];
    /* A product line says which product up front rather than burying it among the
     * platform list. The commercial point of these is that they are obvious. */
    /* Every card has a play now: the gate drops the ones that do not, so this is the
     * product the whole recommendation is built on rather than a decoration on it. */
    if (line.play) {
      card.product = {
        name: line.play.name,
        does: line.play.one_line,
        url: line.play.url,
        /* What the product can actually do, so the brief explains Lyzr's role from the
         * product's own capabilities instead of a sentence that fits any of them. */
        capabilities: (line.play.capabilities ?? []).slice(0, 4),
      };
      /* The second product, named as itself. The page says which does what rather than
       * printing two logos and leaving the partner to guess why both are there. */
      if (line.also_play) {
        card.also_product = {
          name: line.also_play.name,
          does: line.also_play.one_line,
          url: line.also_play.url,
          capabilities: (line.also_play.capabilities ?? []).slice(0, 3),
        };
      }
      card.path = 'product';
      /* The commercial motion is the headline fact about this card: which of the five
       * conversations it is. Two cards can share a department and still be nothing alike. */
      const m = motionOf(line.play);
      card.commercial_motion = line.play.commercial_motion;
      card.motion_label = m?.label ?? '';
      card.follow_on = line.play.follow_on ?? '';
      /* What still has to be true at the client. Eligibility proved the partner can sell
       * it; nothing has yet proved a customer needs it, and that stays a question. */
      card.to_validate = (line.play.customer_problems ?? []).slice(0, 3);
      /* The platform list is noise next to a named product. */
      card.lyzr_products = [...new Set([line.play.name, ...(line.also_play ? [line.also_play.name] : []),
        ...(card.lyzr_products ?? [])])].slice(0, 3);
    }
    card.customer_problem = line.customer_problem ?? '';
    card.problem_status = line.problem_status ?? 'hypothesis';
    card.lyzr_advantage = line.lyzr_advantage ?? '';
    /* What their customer could buy afterwards and cannot buy now. The one sentence the
     * brief's Lyzr advantage has to stay inside. */
    card.beyond_today = line.beyond_today ?? '';
    card.scores = line.scores;
    card.score = line.score;

    /* The line object carried the pattern and the full stories through; the card goes to
     * the browser and to the run record, so it does not need to. */
    delete card.line;
  }
  return cards;
}

/* Its own call, because the brief is already being written while the visitor is still
 * typing account names. Small output, a few seconds, merged into the brief when both land. */
export async function rankAccounts(profile, chosen, accounts) {
  const named = (accounts ?? []).filter((a) => a.name);
  if (!named.length) return [];
  const message = [
    '# Company profile', JSON.stringify(withoutSize(profile), null, 1), '',
    '# The service line they chose', JSON.stringify(chosen, null, 1), '',
    '# The accounts they named', JSON.stringify(named, null, 1),
  ].join('\n');
  const out = await ask('partner_accounts', message);
  /* The model must not quietly lose or rename an account the partner typed. */
  const ranked = (out.ranked ?? []).filter((r) => named.some((a) => a.name.toLowerCase() === String(r.account).toLowerCase()));
  for (const a of named) {
    if (!ranked.some((r) => r.account.toLowerCase() === a.name.toLowerCase())) ranked.push({ account: a.name, why: '' });
  }
  return ranked;
}

export async function step3({ profile, answers, chosen, cards }) {
  /* One line or several. The model writes the prose only. The scope, the durations, the
   * revenue streams, the discovery questions and the proof are all rendered from the card
   * we already verified, so choosing three does not cost three more descriptions, and the
   * ones it would have written could not contradict them. */
  const picked = (Array.isArray(chosen) ? chosen : [chosen]).filter(Boolean);
  const company = profile?.company?.name ?? '';

  const rules = await retrieve('partner_program', `activation package eligibility what happens next ${picked[0]?.headline ?? ''}`, 6)
    .catch(() => '');

  /* One call per page, run together, rather than one call that writes all three.
   *
   * The pages have been independent since the brief lost its cover and its summary: no
   * cross references, nothing that reads the others. Writing them in one call meant the
   * step cost the sum of three pages and a rewrite cost all of them again, which is how
   * `/api/assess` reached 86 seconds against a 60 second function limit. Apart, the step
   * costs the slowest page and a rewrite costs one page. */
  const messageFor = (only) => [
    '# Company profile', JSON.stringify(withoutSize(profile), null, 1), '',
    `# Their name, as it should appear throughout: ${company}`, '',
    /* What they have actually delivered, as against what they advertise. `why_positioned`
     * is the paragraph a reader checks hardest, and answering "what have they built" from
     * a services page is how the brief ends up describing their marketing back to them. */
    '# What they have actually delivered (read off their own site)',
    JSON.stringify(capsBrief(profile), null, 1), '',
    '# What the visitor told us', JSON.stringify(answers, null, 1), '',
    '# The opportunity to write this page for',
    '(the mechanics are rendered from our own records: do not describe them again)',
    JSON.stringify([only].map((c) => ({
      id: c.id,
      name: c.headline, what_it_is: c.what_it_is, why_you: c.why_you,
      /* What their customer cannot buy from them today. The page exists to make this
       * case, so the writer is handed it rather than asked to rediscover it. */
      beyond_today: c.beyond_today,
      /* Both products, where there are two, so `advantage` can say which does what
       * instead of attributing one product's capability to the other. */
      lyzr_product: c.product ? { name: c.product.name, does: c.product.does, capabilities: c.product.capabilities } : null,
      lyzr_second_product: c.also_product
        ? { name: c.also_product.name, does: c.also_product.does, capabilities: c.also_product.capabilities }
        : null,
      who_buys: c.who_buys, first_offer: c.first_offer?.name,
      sellable_services: (c.sellable_services ?? []).map((x) => x.name),
      /* The grounded evidence behind the line, so `why_positioned` is written from the
       * work we actually found rather than from the one-line argument on the card. */
      stands_on: (c.stands_on ?? []).map((e) => ({ what: e.what, quote: e.quote })),
      /* The brief writes the prose over these, so it has to see what the card told them: a
       * brief that argues a different fit than the card they chose reads as two people who
       * never spoke. */
      attaches_to: c.attaches_to, where_it_lands: c.where_it_lands,
    })), null, 1), '',
    /* What the other pages are built on, so this one does not build on it too.
     *
     * Written apart, no page can see what the others said, and three pages that all open
     * on the same project and all point at the same account read as one argument printed
     * three times. The pages cannot see each other, but we can see all three cards, so
     * the division is made here and handed to each writer as a constraint rather than
     * left to a model that has no way to know. */
    picked.length > 1
      ? `# Taken by the other pages, which are being written at the same time as this one\n${JSON.stringify(
        picked.filter((c) => c.id !== only.id).map((c) => ({
          headline: c.headline,
          leads_on: (c.stands_on ?? []).slice(0, 2).map((e) => e.what),
          buyer: c.who_buys,
        })), null, 1)}\nLead on the evidence and the buyer given for your own opportunity, not on these. Where the same project is the only honest support for your page too, you may cite it, but open on something of your own.\n`
      : '',
    '# The service lines they were shown and did not choose',
    JSON.stringify((cards ?? []).filter((c) => !picked.some((p) => p.id === c.id)).map((c) => c.headline), null, 1), '',
    /* `where_to_start.first_account` names one of these, so the model has to be holding
     * the list rather than reaching for whichever client it remembers from the profile. */
    '# Accounts available to name first',
    JSON.stringify({
      named_on_their_site: (profile?.named_clients ?? []).map((c) => c.name).filter(Boolean),
      given_by_the_visitor: (answers?.accounts ?? []).map((a) => a?.name ?? a).filter(Boolean),
    }, null, 1), '',
    '# Program rules (authoritative — follow exactly)', rules,
  ].join('\n');

  /* One test, used to decide whether to write a page again and whether to drop it. It
   * runs on what the model returned, never on the mapped page, because the mapped page
   * falls back to the card and a fallback is exactly what this is looking for. The
   * thresholds are low on purpose: they catch an empty field and the word "Placeholder",
   * not a sentence that is merely short. */
  const thin = (r) => String(r?.why_fits ?? '').trim().length < 40
    || String(r?.the_opportunity ?? '').trim().length < 30
    || String(r?.start?.conversation ?? '').trim().length < 30
    || !(r?.advantage ?? []).some((a) => a?.capability && a?.why)
    || !(r?.benefits ?? []).some((x) => String(x ?? '').trim());

  /* The page this call was for, whatever the model keyed it to. Asked for one, it returns
   * one, and insisting on the id would throw away a good page over a typo. */
  const pageIn = (res, c) => (res?.brief?.pages ?? []).find((r) => r?.id === c.id)
    ?? (res?.brief?.pages ?? [])[0] ?? null;

  /* A page the writer returned empty is written again on its own, in a fresh session.
   * Asking only for the missing fields is what produced the word "Placeholder" in every
   * one of them, so the second attempt is the same request, not a patch. */
  const writePage = async (c) => {
    const msg = messageFor(c);
    let res = await ask('partner_assessment', msg);
    if (thin(pageIn(res, c))) {
      console.error('brief: incomplete page, writing it again:', c.id);
      const again = await ask('partner_assessment', msg).catch(() => null);
      if (again && !thin(pageIn(again, c))) res = again;
    }
    return { card: c, res, page: pageIn(res, c) };
  };

  const written = await Promise.all(picked.map((c) => writePage(c).catch((e) => {
    console.error('brief: page failed:', c.id, e.message);
    return { card: c, res: null, page: null };
  })));

  /* The internal note is written beside every page. The partner team reads one note per
   * brief, so the verdict comes from the first page that has one and the watch outs are
   * pooled: a caution raised on page three is still a caution about this partner. */
  const notes = written.map((w) => w.res?.internal).filter(Boolean);
  const out = {
    brief: { pages: written.map((w) => ({ ...(w.page ?? {}), id: w.card.id })) },
    internal: notes.length
      ? {
        fit: notes[0].fit,
        fit_reasons: [...new Set(notes.flatMap((n) => n.fit_reasons ?? []))].slice(0, 4),
        watch_outs: [...new Set(notes.flatMap((n) => n.watch_outs ?? []))].slice(0, 6),
        opening_line: notes[0].opening_line,
      }
      : undefined,
  };
  if (!written.some((w) => w.page)) return { brief: null, internal: out.internal };

  const b = out.brief;
  if (!b) return { brief: b, internal: out.internal };

  const str = (x) => String(x ?? '').trim();

  /* The recommended opportunity is page one. The writer used to choose, which it could do
   * while it saw all three at once; writing them apart, none of them sees the others. The
   * order is the one discovery already argued and scored, strongest first, which is the
   * same order the cards were shown in. */
  const order = [...picked].sort((x, y) => (y.score ?? 0) - (x.score ?? 0));

  /* Keyed by id, so a page lands under the opportunity it was written for. */
  const byId = new Map(written.map((w) => [w.card.id, w.page]).filter(([, r]) => r));
  const list = (xs, n, max) => [...new Set((xs ?? []).map(str).filter(Boolean))]
    .slice(0, n).map((t) => (max && t.length > max ? t : t));

  /* Every Lyzr product we have a record for, so a capability can be checked against the
   * product the page actually runs on.
   *
   * Doxim came back with a page powered by Agent Studio whose first capability began
   * "SuperFlow journals every step". Both are ours, which is what makes it plausible and
   * what makes it wrong: the partner reads a capability of a product they are not being
   * offered. The prompt forbids it; this is the check. */
  const productNames = [...new Set(PLAYS.map((pl) => pl.name).filter(Boolean))];
  const borrowed = (text, own) => {
    const low = String(text ?? '').toLowerCase();
    return productNames.some((n) => {
      const k = n.toLowerCase().replace(/^lyzr\s+/, '');
      return k.length > 4 && low.includes(k) && !own.some((o) => o.toLowerCase().includes(k));
    });
  };

  b.pages = order.map((c, i) => {
    const r = byId.get(c.id) ?? {};
    const st = r.start ?? {};
    return {
      id: c.id,
      /* Judged on what the model returned, before any of the fallbacks below hide it. */
      complete: !thin(r),
      /* Falling back to the card's own headline is better than a page with no name on it,
       * even though the card headline is written to be scanned rather than to lead. */
      headline: str(r.headline) || str(c.headline),
      offering_name: str(r.offering_name) || str(c.headline),
      why_fits: str(r.why_fits) || str(c.why_you),
      the_opportunity: str(r.the_opportunity) || str(c.what_it_is),
      benefits: list(r.benefits, 3),
      /* A capability with nothing said about what it adds is a feature list, which is the
       * thing this field exists to replace. */
      advantage: (r.advantage ?? [])
        .map((a) => ({ capability: str(a?.capability), why: str(a?.why) }))
        .filter((a) => a.capability && a.why)
        .filter((a) => {
          const own = [c.product?.name, c.also_product?.name].filter(Boolean);
          if (!own.length || !borrowed(`${a.capability} ${a.why}`, own)) return true;
          console.error('brief: dropped a capability borrowed from another product:', a.capability);
          return false;
        })
        .slice(0, 3),
      start: {
        who: str(st.who),
        buyer: str(st.buyer) || str(c.who_buys),
        conversation: str(st.conversation),
      },
    };
  });

  /* A page the writer would not write twice does not go in the brief.
   *
   * One HatchWorks line came back with a paragraph and nothing else: no benefits, no
   * capabilities, no opening move, and the same on the retry. Rendered, that is a sheet
   * of fallbacks, the card's own second-person argument under a heading that names the
   * firm. The honest reading is that the writer could not make the case from the evidence
   * it was given, and the brief is better two strong pages than three with a hole in one.
   * The first page survives regardless: a brief with no pages is not a brief. */
  /* Dropped only where both attempts refused to write it. The visitor chose these, so
   * this is the last resort and not a quality bar. The first page survives regardless: a
   * brief with no pages is not a brief. */
  const whole = b.pages.filter((pg) => pg.complete);
  if (whole.length && whole.length < b.pages.length) {
    console.error('brief: dropped empty pages:', b.pages.filter((pg) => !whole.includes(pg)).map((pg) => pg.id).join(', '));
    b.pages = whole;
  }

  /* The order the document runs in, so the renderer lays the sheets out the way the
   * recommendation already reads. */
  b.order = b.pages.map((pg) => pg.id);

  return { brief: b, internal: out.internal };
}
