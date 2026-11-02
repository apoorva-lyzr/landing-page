const $ = (id) => document.getElementById(id);
const S = {
  id: null, profile: null, questions: [], answers: [], qi: 0,
  brand: null, cards: [], pick: 0, picked: [], chosen: [], brief: null, accounts: [],
  pending: {},   // work started before the visitor needs it
  seen: new Set(),  // questions already put in front of the visitor
};

/* Four stages now: the profile screen is gone. The visitor answers questions while we read
 * their site, so "Validate" was a screen that told them what they already knew. */
const STAGES = ['Discover', 'Focus', 'Explore', 'Unlock'];
const STEPS = ['s0', 's1', 's3', 's4', 's5', 's6', 's7', 's8'];
const STAGE_OF = [0, 0, 1, 2, 2, 3, 3, 3];
const WIDE = new Set(['s5', 's8']);

$('rail').innerHTML = STAGES.map((s, i) => `<div><i></i><span>0${i + 1} &nbsp;${s}</span></div>`).join('');

function show(id) {
  for (const s of [...STEPS, 'sx']) $(s).classList.toggle('on', s === id);
  /* The questions are asked while the site is still being read, so opening the agent used
   * to land on "02 Focus" with Discover already ticked and never seen. The visitor had
   * watched nothing happen under a stage that claimed to be finished. While there is no
   * profile yet, discovery is genuinely what is running, and the rail says so. */
  let now = STAGE_OF[STEPS.indexOf(id)] ?? 0;
  if (id === 's3' && !S.profile) now = 0;
  [...$('rail').children].forEach((el, i) => {
    el.classList.toggle('on', i <= now);
    el.classList.toggle('now', i === now);
  });
  $('wrap').classList.toggle('wide', WIDE.has(id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
const fail = (msg) => { $('xmsg').textContent = msg; show('sx'); };
const esc = (t = '') => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/* The model sometimes starts a sentence fragment lowercase; it reads like a typo. */
const up = (t = '') => String(t).replace(/^[a-z]/, (c) => c.toUpperCase());

async function post(path, payload) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `server error ${r.status}`);
  return r.json();
}

/* Three things about Lyzr, shown one at a time under the progress line while the visitor
 * waits. The cursor is module-level on purpose: the three waits in a session continue the
 * rotation rather than each restarting on the first one. */
/* The brand's own artwork rather than a sentence about it. A wait is the one moment the
 * visitor is looking at nothing, so it carries the pieces the design team has already
 * made: the CB Insights placement, the customers in production, and the product stack. */
const PROOF = [
  { src: '/brand/proof-cbinsights.png', alt: 'Lyzr, ranked 6th in the CB Insights AI 100 for 2026' },
  { src: '/brand/proof-customers.png', alt: 'Enterprises running Lyzr in production, including Accenture, Verifone, HFS, eMudhra, MSP Corp and WTW' },
  { src: '/brand/proof-stack.png', alt: 'The Lyzr stack: OpenController, Architect, Agent Studio, Agent Blocks and Optimus' },
];
let proofAt = 0;

function proof(el, ms = 6000) {
  if (!el) return () => {};
  let timer = null;
  el.innerHTML = `<div class="pwin"></div><div class="pdots">${PROOF.map(() => '<i></i>').join('')}</div>`;
  const win = el.querySelector('.pwin');
  const dots = el.querySelector('.pdots');
  const paint = () => {
    const i = proofAt++ % PROOF.length;
    const p = PROOF[i];
    /* Taken out of the flow before the next one lands, so the card never resizes. */
    const leaving = win.querySelector('.pi:not(.out)');
    if (leaving) { leaving.classList.add('out'); setTimeout(() => leaving.remove(), 600); }
    const d = document.createElement('div');
    d.className = 'pi';
    d.innerHTML = `<img src="${p.src}" alt="${esc(p.alt)}" loading="eager">`;
    win.append(d);
    [...dots.children].forEach((b, n) => b.classList.toggle('on', n === i));
    timer = setTimeout(paint, ms);
  };
  paint();
  return () => clearTimeout(timer);
}

function ticker(tickEl, barEl, lines, seconds) {
  let i = -1, t0 = Date.now(), stop = false;
  const paint = () => {
    if (stop) return;
    const pct = Math.min(96, ((Date.now() - t0) / (seconds * 1000)) * 100);
    if (barEl) barEl.style.width = pct + '%';
    const next = Math.min(lines.length - 1, Math.floor(pct / (100 / lines.length)));
    if (next !== i) { i = next; tickEl.innerHTML = lines[i]; }
    requestAnimationFrame(paint);
  };
  paint();
  /* Every wait screen carries one, so it starts and stops with the progress line rather
   * than at three separate call sites. */
  const stopProof = proof(tickEl.parentElement?.querySelector('.proof'));
  return () => { stop = true; stopProof(); if (barEl) barEl.style.width = '100%'; };
}

/* The five questions every visitor is asked, in order. Only the first one touches the
 * site, and only to pre-tick: its options stand on their own, so nobody waits on the crawl
 * to answer it. They are asked the moment the email is in — while the site is still being
 * read — because twenty seconds of watching a progress bar buys nothing. */
const FIXED_QUESTIONS = [
  {
    field: 'service_lines',
    question: 'What kind of work do you primarily deliver for clients?',
    /* The hint only claims a reading of their site once there is one. */
    hint: () => (serviceHits().size
      ? 'We found a few areas on your website. Tell us which ones matter most.'
      : 'Tell us which ones matter most.'),
    preselect: serviceHits,
    options: [
      'Cloud & infrastructure',
      'ERP & enterprise systems',
      'Software engineering',
      'Business process automation',
      'AI consulting',
    ],
  },
  {
    field: 'growth',
    question: 'Where do you see the biggest opportunity to grow?',
    hint: "We'll use this to shape what we recommend.",
    options: [
      'Win new enterprise customers',
      'Add AI services to existing offerings',
      'Build repeatable industry solutions',
    ],
  },
  {
    field: 'demand',
    /* The one question that decides the rest: everything else describes the firm, this is
     * the only place actual demand shows up. */
    question: 'What are your customers asking you for today?',
    options: [
      'Automating manual workflows',
      'AI agents connected to business systems',
      'Internal AI assistants',
      'Modernizing existing applications',
      'Private or on-prem AI',
      'Exploring AI but no defined use case',
      'Not seeing much demand yet',
    ],
  },
  {
    field: 'ai_delivery',
    question: 'How far along are you in delivering AI projects?',
    hint: 'It decides what kind of enablement and technical support is worth offering.',
    options: [
      'Already delivering in production',
      'Running pilots or POCs',
      'Have opportunities but need delivery capabilities',
      'Building our first offering',
      'Still evaluating',
    ],
  },
  {
    field: 'client_geography',
    question: 'Where are most of your customers based?',
    hint: 'Quick one — it changes what we can propose.',
    options: [
      'North America',
      'UK & Europe',
      'Middle East',
      'India & South Asia',
      'Asia Pacific',
    ],
  },
];

/* The crawl names service lines in the company's own words ("NetSuite implementation");
 * the question offers buckets. This maps one onto the other well enough to tick a box the
 * visitor can untick, never well enough to answer for them. An empty profile — the site is
 * still being read, or could not be — simply ticks nothing. */
const SERVICE_BUCKETS = [
  ['Cloud & infrastructure', /\b(cloud|aws|azure|gcp|devops|infrastructure|kubernetes|managed services|migration)\b/i],
  ['ERP & enterprise systems', /\b(erp|sap|netsuite|oracle|dynamics|salesforce|workday|servicenow|crm)\b/i],
  ['Software engineering', /\b(software|application|product engineering|web|mobile|full[ -]?stack|custom development)\b/i],
  ['Data & analytics', /\b(data|analytics|bi|warehouse|lakehouse|etl|reporting|power bi)\b/i],
  ['Business process automation', /\b(process automation|rpa|workflow|bpa|bpo)\b/i],
  ['AI consulting', /\b(ai|artificial intelligence|machine learning|ml ops|mlops|genai|llm)\b/i],
];

function serviceHits() {
  const text = (S.profile?.services ?? [])
    .map((x) => (typeof x === 'string' ? x : `${x.name ?? ''} ${x.evidence ?? ''}`))
    .join(' · ');
  return new Set(SERVICE_BUCKETS.filter(([, re]) => re.test(text)).map(([label]) => label));
}

/* ---------------- 00 discover ---------------- */
$('start').onclick = () => {
  const email = $('email').value.trim();
  $('e0').hidden = true;
  if (!email.includes('@')) { $('e0').textContent = 'Please enter your work email.'; $('e0').hidden = false; return; }

  /* The email domain is the website. Asking for both was asking the same question twice,
   * and people answered the second one with their email. */
  S.pending.profile = post('/api/profile', { email, staged: true })
    .then((r) => {
      if (!r.ok) throw new Error(r.message || r.error);
      S.id = r.id; S.profile = r.profile; S.brand = r.brand ?? null;
      /* Whatever the profiler could not establish gets appended, so the adaptive question
       * lands after the fixed two rather than holding them up. */
      for (const q of r.questions ?? []) if (!S.questions.some((x) => x.field === q.field)) S.questions.push(q);
      /* The site finishes being read while the visitor is still on the first question. If
       * they have not answered it yet, draw it again so what we found arrives in time to
       * be of use — ticked, and said in the hint — rather than a moment too late. */
      /* Discovery has finished, so the rail stops claiming it is still running. */
      if ($('s3').classList.contains('on')) show('s3');
      if (S.questions[S.qi]?.field === 'service_lines' && !$('qopts').querySelector('.opt.on')) {
        S.seen.delete('service_lines');
        askQ();
      }
      return r;
    });
  /* Work started ahead of the visitor can fail before anyone is waiting on it. Marking it
   * handled keeps that from surfacing as an unhandled rejection; the real await still
   * rejects and still shows the error screen. */
  S.pending.profile.catch(() => {});

  S.questions = [...FIXED_QUESTIONS];
  S.answers = [];
  S.seen = new Set();
  S.qi = 0;
  askQ();
};

/* ---------------- 03 focus ---------------- */
async function askQ() {
  if (S.qi >= S.questions.length) {
    /* Almost always already resolved — this is the seam where a slow site shows itself. */
    if (!S.profile) {
      show('s1');
      const done = ticker($('tick'), $('bar'), [
        'reading <b>' + esc(($('email').value.split('@')[1] || '').trim()) + '</b>',
        'what you build, and who for',
        'the industries your work keeps landing in',
      ], 18);
      try { await S.pending.profile; } catch (e) { done(); return fail(e.message); }
      done();
      /* Discovery is over, so the rail moves on even if the visitor is mid-question. */
      if ($('s3').classList.contains('on')) show('s3');
      if (S.qi < S.questions.length) return askQ();
    }
    return recommend();
  }
  const q = S.questions[S.qi], n = S.questions.length;
  const had = answerFor(q.field);
  $('qdots').innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i <= S.qi ? 'on' : ''}"></i>`).join('');
  $('qtext').textContent = q.question;
  $('qhint').textContent = (typeof q.hint === 'function' ? q.hint() : q.hint) ?? '';
  $('qfree').value = '';
  /* Nothing here is single-choice any more: a firm that sells to two regions should be
   * able to say so, and coming back to a question shows what they picked last time. */
  /* Pre-ticks are an opening offer, not an answer: they appear the first time a question
   * is shown and never again, so coming back shows what the visitor picked, not what we
   * guessed. */
  const first = !S.seen.has(q.field);
  S.seen.add(q.field);
  const chosen = new Set(had ? had.split(' · ') : (first && q.preselect ? q.preselect() : []));
  $('qopts').innerHTML = (q.options ?? []).map((o) =>
    `<button class="opt${chosen.has(o) ? ' on' : ''}">${esc(o)}</button>`).join('');
  [...$('qopts').children].forEach((b) => {
    b.onclick = () => b.classList.toggle('on');
  });
  $('qback').hidden = S.qi === 0;
  show('s3');
  /* Finding the lines takes about ten seconds and needs almost nothing the last question
   * adds, so it starts while the visitor is reading that question rather than after they
   * answer it. If they change an earlier answer it is thrown away, and if it fails the
   * server simply does the work itself. */
  if (S.qi === n - 1 && S.profile && !S.pending.found) prefetchLines();
}

function prefetchLines() {
  const answers = [...S.answers];
  S.pending.found = post('/api/discover', { id: S.id, profile: S.profile, answers, partial: true })
    .then((r) => (r?.picks?.length ? r : null))
    .catch(() => null);
}

const answerFor = (field) => S.answers.find((a) => a.field === field)?.answer;

function recordAnswer(q, value) {
  S.answers = S.answers.filter((a) => a.field !== q.field);
  if (value) S.answers.push({ field: q.field, question: q.question, answer: value });
}

function nextQ() {
  const q = S.questions[S.qi];
  /* Past the last question there is nothing to record: the screen has already moved on. */
  if (!q) return;
  const picked = [...$('qopts').querySelectorAll('.opt.on')].map((b) => b.textContent.trim());
  const free = $('qfree').value.trim();
  recordAnswer(q, [...picked, free].filter(Boolean).join(' · '));
  S.qi++;
  /* Changing an answer invalidates anything built on the old one, the prefetched lines
   * included. */
  S.cards = []; S.pending = { profile: S.pending.profile };
  askQ();
}

$('qnext').onclick = nextQ;
$('qfree').addEventListener('keydown', (e) => { if (e.key === 'Enter') nextQ(); });
$('qskip').onclick = () => {
  const q = S.questions[S.qi];
  if (!q) return;
  recordAnswer(q, ''); S.qi++; askQ();
};
$('qback').onclick = () => { S.qi = Math.max(0, S.qi - 1); askQ(); };

/* ---------------- 05 explore ---------------- */
async function recommend() {
  show('s4');
  const done = ticker($('tick2'), $('bar2'), [
    'where your clients already trust you',
    'what they are being asked for',
    'what you could deliver without rebuilding',
    'what the first engagement looks like',
    'and the proof to put behind it',
  ], 48);
  try {
    if (S.cards.length) { renderExplorer(); done(); return show('s5'); }   // coming back
    /* Whatever the prefetch got, if it got anything. The server falls back to running
     * discovery itself, so a failed or missing prefetch costs time and nothing else. */
    const found = await (S.pending.found ?? Promise.resolve(null)).catch(() => null);
    const r = await post('/api/recommend', { id: S.id, profile: S.profile, answers: S.answers, found });
    done();
    S.cards = r.cards; S.pick = 0; S.picked = [0];
    $('opening').textContent = r.opening ?? '';
    $('s5h').textContent = r.cards.length === 1 ? 'Where you could grow.'
      : `${['One', 'Two', 'Three', 'Four'][r.cards.length - 1]} ways you could grow with Lyzr.`;
    renderExplorer();
    show('s5');
  } catch (e) { done(); fail(e.message); }
}

/* The three picks are three different ways to grow, and the shortlist says which is
 * which. The eyebrow used to be assigned by position, so the second card was always
 * "Cross-industry play" whatever it actually was. */
const GROWTH = {
  expand: 'Account expansion',
  win: 'New business',
  retain: 'Recurring revenue',
};
const growthOf = (c) => GROWTH[c?.growth_path] ?? 'Opportunity';

function renderExplorer() {
  $('optabs').innerHTML = S.cards.map((c, i) => `
    <button class="optab${S.picked.includes(i) ? ' on' : ''}${i === S.pick ? ' open' : ''}" data-i="${i}">
      <em>${esc(growthOf(c))}</em>
      <strong>${esc(c.headline)}</strong>
      <span class="pickbox"><span class="box">${S.picked.includes(i) ? '✓' : ''}</span>${S.picked.includes(i) ? 'Selected' : 'Add to my brief'}</span>
    </button>`).join('');
  [...$('optabs').children].forEach((el) => {
    const i = +el.dataset.i;
    /* The tile opens the card; the tick decides whether it goes in the brief, so a
     * visitor can read all three and still take two. */
    el.onclick = (e) => {
      if (e.target.closest('.pickbox')) {
        S.picked = S.picked.includes(i) ? S.picked.filter((x) => x !== i) : [...S.picked, i].sort((a, b) => a - b);
      } else {
        S.pick = i;
      }
      renderExplorer();
    };
  });
  renderDetail();
}

/* One card, drawn once. The explore screen and the printed brief render the same blocks
 * in the same order with the same labels, because the thing they read while choosing
 * should be the thing they end up holding. `detail` is the on-screen version: it adds the
 * rows the brief leaves out and the copy button on the email. `num` and `seen` belong to
 * the brief, where plays are numbered and a link is not worth printing twice. */
function playBlock(c, { num = '', seen = null, detail = false } = {}) {
  const o = c.first_offer ?? {}, pr = c.proof ?? {}, h = c.how_to_sell ?? {};
  /* The card is for choosing between three opportunities, so it shows a few links; the
   * brief page that follows prints the rest. */
  const res = (c.resources ?? []).filter((r) => !seen || (!seen.has(r.url) && seen.add(r.url))).slice(0, 3);
  const m = /^([\d.,]+(?:[–-][\d.,]+)?\s*(?:%|x|\+)?)\s+(.{4,})$/i.exec(pr.result ?? '');
  const row = (dt, dd) => (dd ? `<dt>${esc(dt)}</dt><dd>${esc(dd)}</dd>` : '');
  const by = { see: [], build: [], sell: [] };
  for (const r of res) (by[r.shelf] ?? by.build).push(r);
  const shelf = (key, label) => (by[key].length ? `<div class="shelf"><p class="shlab">${label}</p>
    <ul>${by[key].map((r) => `<li><a href="${encodeURI(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></li>`).join('')}</ul></div>` : '');

  return `<article class="play">
    <p class="playnum">${esc(c.motion_label || MOTIONS[c.motion] || growthOf(c))}${num ? ` <span>${esc(num)}</span>` : ''}</p>
    ${detail ? `<h2 class="playhead">${esc(c.headline)}</h2>` : `<h3>${esc(c.headline)}</h3>`}
    <p class="sh-body">${esc(c.what_it_is)}</p>

    <p class="shlab">Why you</p>
    <p class="playwhy">${esc(c.why_you)}</p>
    ${detail && (c.stands_on ?? []).length ? `<p class="playcite">You have done this: ${c.stands_on
      .map((e) => `<a href="${encodeURI(e.url)}" target="_blank" rel="noopener">${esc(e.what)}</a>`).join(' · ')}</p>` : ''}

    ${/* Every card is licence-led, so the product is named here and never replaced by a
          sentence about the platform in general. A card with no product does not reach
          this point: the gate drops it. */''}
    ${c.product ? `<p class="shlab">The licence behind it</p>
      <p class="sh-body"><b>${esc(c.product.name)}</b> ${esc(c.product.does.replace(/^./, (x) => x.toLowerCase()))}
      ${c.lyzr_advantage ? ` ${esc(c.lyzr_advantage)}` : ''}</p>` : ''}

    ${(c.sellable_services ?? []).length ? `<p class="shlab">What you could sell</p>
      <ul class="sells">${c.sellable_services.map((x) => `<li><b>${esc(x.name)}</b>${x.client_gets ? ` <span>${esc(x.client_gets)}</span>` : ''}</li>`).join('')}</ul>` : ''}

    ${(c.mechanism ?? []).length ? `<div class="kit">
      <p class="kitlab">What the client ends up with</p>
      <ol class="kitsteps">${c.mechanism.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
    </div>` : ''}

    <dl class="kv">
      ${row('Who buys it', c.who_buys)}
      ${row('What makes them buy now', up(h.trigger ?? ''))}
      ${row('How you earn', c.monetisation)}
      ${detail ? row('Where it lands first', up(c.where_it_lands ?? '')) : ''}
    </dl>

    ${pr.result ? `<p class="playproof">${m ? `<b>${esc(m[1].trim())}</b> ${esc(m[2])}` : esc(pr.result)},
      ${esc(pr.customer ?? '')}${pr.url ? ` · <a href="${encodeURI(pr.url)}" target="_blank" rel="noopener">${esc(pr.title || 'case study')}</a>` : ''}</p>`
      : (c.reference ? `<p class="playproof"><span class="noproof">Built on</span>
          <a href="${encodeURI(c.reference.url)}" target="_blank" rel="noopener">${esc(c.reference.title)}</a></p>` : '')}

    ${res.length ? `<div class="reading">
      ${shelf('see', 'See it')}${shelf('build', 'Build it')}${shelf('sell', 'Sell it')}
    </div>` : ''}

    ${detail && o.name ? `<p class="playfirst"><span>First move</span> ${esc(c.first_step || o.name)}</p>` : ''}
    ${!detail && c.first_step ? `<p class="playfirst"><span>First move</span> ${esc(c.first_step)}</p>` : ''}
  </article>`;
}

/* How the money is actually made, as a label a reader recognises. */
const MOTIONS = {
  new_implementation: 'New implementation',
  product_deployment: 'Product deployment',
  productization: 'Productised offer',
  account_expansion: 'Account expansion',
  managed_service: 'Managed service',
  embedding: 'Embedded in your product',
};


function renderDetail() {
  const c = S.cards[S.pick];

  $('detail').innerHTML = playBlock(c, { detail: true })
    + `<div class="dfoot"><button class="go accent" id="build">Build my brief &rarr;</button></div>`;
  /* The card they are reading always counts, ticked or not — having to tick the one on
   * screen before the button means anything is a step nobody expects. */
  $('build').onclick = () => {
    S.picked = [...new Set([...S.picked, S.pick])].sort((a, b) => a - b);
    S.chosen = S.picked.map((i) => S.cards[i]);
    startBrief(S.chosen);
    toAccounts();
  };

  /* Most visitors take the card they are looking at, and writing the brief is the longest
   * wait in the journey. So it starts once they have sat on a card for a moment, and by
   * the time they have typed three client names it is usually done. A brief for a card
   * they end up not choosing is one wasted call; a minute of staring at a progress bar is
   * worse. Cached by card id, so switching tabs and coming back costs nothing. */
  clearTimeout(S.pending.peek);
  /* The same selection the button above would build, card on screen included. Prefetching
   * S.picked alone only ever paid off for the visitor who took the first card untouched;
   * anyone who opened a second one got a key that missed and waited out the whole call. */
  S.pending.peek = setTimeout(() => startBrief(
    [...new Set([...S.picked, S.pick])].sort((a, b) => a - b).map((i) => S.cards[i])), 2500);
}

/* One request per card, kept so a second look costs nothing. */
function startBrief(chosen) {
  const picked = (Array.isArray(chosen) ? chosen : [chosen]).filter(Boolean);
  if (!picked.length) return null;
  /* Keyed by the whole selection: adding a second line is a different brief. */
  const key = 'brief:' + picked.map((c) => c.id).join('+');
  if (S.pending[key]) return S.pending[key];
  S.pending[key] = post('/api/assess', {
    id: S.id, profile: S.profile, answers: S.answers, chosen: picked, cards: S.cards,
  });
  /* A failed prefetch must not be cached, or the retry returns the same rejection. */
  S.pending[key].catch(() => { delete S.pending[key]; });
  return S.pending[key];
}

/* ---------------- 06 accounts, before the documents ---------------- */
function acctRow(prefill) {
  const d = document.createElement('div');
  d.className = 'acct';
  /* A short label: "How well do you know them?" was wider than any column that leaves
   * room for the name beside it, so it was always cut off mid-word. */
  d.innerHTML = `<input type="text" placeholder="Client name" aria-label="Client name">
    <select aria-label="How well do you know them?">
      <option value="">Relationship</option>
      <option>Champion inside</option>
      <option>Warm</option>
      <option>Dormant</option>
    </select>`;
  if (prefill) d.children[0].value = prefill;
  return d;
}
function toAccounts() {
  if (!$('accts').children.length) {
    /* Their own site named these clients, so the first rows arrive filled in. A blank
     * form asks the visitor to remember; a filled one asks them to react, and reacting is
     * both faster and more honest. The label below says plainly that these are public
     * references we read, not accounts we think are ready to buy. */
    const named = (S.profile?.named_clients ?? []).map((c) => c.name).filter(Boolean).slice(0, 3);
    for (let i = 0; i < 3; i++) $('accts').append(acctRow(named[i]));
    $('acctnote').hidden = !named.length;
  }
  show('s6');
}
$('addacct').onclick = () => { if ($('accts').children.length < 5) $('accts').append(acctRow()); };
$('acctgo').onclick = () => {
  S.accounts = [...$('accts').children]
    .map((r) => ({ name: r.children[0].value.trim(), strength: r.children[1].value || 'not said' }))
    .filter((a) => a.name);
  finish();
};
$('acctskip').onclick = () => { S.accounts = []; finish(); };

/* ---------------- 08 the brief ---------------- */
async function finish() {
  const brief = startBrief(S.chosen);                 // usually already resolved
  const ranked = S.accounts.length
    ? post('/api/accounts', { id: S.id, profile: S.profile, chosen: S.chosen[0], accounts: S.accounts })
        .then((r) => r.ranked).catch(() => [])
    : Promise.resolve([]);

  show('s7');
  const done = ticker($('tick3'), $('bar3'), [
    'the case for taking this to a client',
    'who sponsors it, and what sets it off',
    S.accounts.length ? 'which of your clients it lands with first' : 'what the first thirty days look like',
    'something you could send this afternoon',
  ], S.accounts.length ? 16 : 10);

  try {
    const [b, lands] = await Promise.all([brief, ranked]);
    done();
    S.brief = b.brief;
    S.brief.where_it_lands = lands;
    $('partnerdoc').innerHTML = partnerSheet();
    show('s8');
  } catch (e) {
    done();
    /* A failed prefetch must not poison the retry. */
    delete S.pending['brief:' + S.chosen.map((c) => c.id).join('+')];
    fail(e.message);
  }
}

/* Their mark beside ours. If Apollo has no logo we set their name instead — a wordmark in
 * type is honest, where a stretched favicon is not. */
function lockup() {
  const name = S.brand?.name || S.profile.company.name || '';
  const theirs = S.brand?.logo
    ? `<img class="theirs" src="${encodeURI(S.brand.logo)}" alt="${esc(name)}" onerror="this.outerHTML='<span class=\'name\'>${esc(name)}</span>'">`
    : `<span class="name">${esc(name)}</span>`;
  return `<span class="lockup">${theirs}<span class="x">&times;</span>
    <img class="mark" src="/brand/lyzr-mark-black.svg" alt="Lyzr"></span>`;
}

/* One opportunity, one A4 sheet.
 *
 * This is deliberately not `playBlock`: the explore screen is for choosing between three,
 * so it is compact and scannable; the brief is for reading and forwarding, so it is a
 * designed page. Each sheet answers five questions and stops: why this firm, what they
 * could sell, what Lyzr adds, where to start, what to read. The mechanics the card also
 * carries, the scope, the revenue table, the engagement shape, are not printed here: they
 * are what turned a brief into eight pages of things the partner already knew. */
function briefPage(c, page, i, n, co) {
  const num = String(i + 1).padStart(2, '0');
  const total = String(n).padStart(2, '0');
  const cites = (c.stands_on ?? []).slice(0, 3);

  /* Every link that genuinely helps them understand, validate or sell this one
   * opportunity, in the order the catalogue shelves them: see it, build it, sell it. The
   * proof story leads when there is one, because it is the thing they forward. */
  const res = [];
  const pr = c.proof ?? {};
  if (pr.url && pr.title) res.push({ url: pr.url, title: pr.title, tag: 'Case study' });
  const TAG = { see: 'See it', build: 'Build it', sell: 'Sell it' };
  for (const key of ['see', 'build', 'sell']) {
    for (const r of (c.resources ?? [])) {
      if ((r.shelf ?? 'build') === key && !res.some((x) => x.url === r.url)) {
        res.push({ url: r.url, title: r.title, tag: TAG[key] });
      }
    }
  }

  const adv = (page.advantage ?? []).filter((x) => x.capability && x.why);

  return `<article class="opg">
    <header class="opg-top">
      ${lockup()}
      <span class="opg-meta">Partner opportunity brief<b>${esc(co)}</b></span>
    </header>

    <div class="opg-lead">
      <p class="opg-rank"><span>${esc(num)} / ${esc(total)}</span>${i === 0 && n > 1
        ? '<em>Recommended starting point</em>' : ''}</p>
      <h1 class="opg-head">${esc(page.headline || c.headline)}</h1>
      ${c.product ? `<p class="opg-powered">Powered by <b>${esc(c.product.name)}${c.also_product ? ` + ${esc(c.also_product.name)}` : ''}</b></p>` : ''}
    </div>

    <section class="opg-sect opg-fit">
      <h3>Why this fits ${esc(co)}</h3>
      <p>${esc(page.why_fits)}</p>
      ${cites.length ? `<p class="opg-cite">${cites.map((e) => `<a href="${encodeURI(e.url)}" target="_blank" rel="noopener">${esc(e.what)}</a>`).join('<i>·</i>')}</p>` : ''}
    </section>

    <div class="opg-cols">
      <section class="opg-sect">
        <h3>The opportunity</h3>
        ${page.offering_name ? `<p class="opg-offer">${esc(page.offering_name)}</p>` : ''}
        <p>${esc(page.the_opportunity)}</p>
        ${(page.benefits ?? []).length ? `<ul class="opg-ticks">${page.benefits
          .map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      </section>

      <section class="opg-sect opg-adv">
        <h3>The Lyzr advantage</h3>
        ${c.product ? `<p class="opg-prod">${esc(c.product.name)}${c.also_product ? ` <span>with</span> ${esc(c.also_product.name)}` : ''}</p>` : ''}
        ${adv.length ? `<ul class="opg-advlist">${adv
          .map((x) => `<li><b>${esc(x.capability)}</b><span>${esc(x.why)}</span></li>`).join('')}</ul>`
        : (c.lyzr_advantage ? `<p>${esc(c.lyzr_advantage)}</p>` : '')}
      </section>
    </div>

    <section class="opg-sect opg-start">
      <h3>Where to start</h3>
      <div class="opg-startrow">
        ${page.start?.who ? `<div><span>Start with</span><b>${esc(page.start.who)}</b></div>` : ''}
        ${page.start?.buyer ? `<div><span>Who to speak to</span><b>${esc(up(page.start.buyer))}</b></div>` : ''}
      </div>
      ${page.start?.conversation ? `<p>${esc(page.start.conversation)}</p>` : ''}
    </section>

    ${res.length ? `<section class="opg-sect opg-res">
      <h3>Resources</h3>
      <ul class="opg-reslist">${res.map((r) => `<li><a href="${encodeURI(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><span>${esc(r.tag)}</span></li>`).join('')}</ul>
    </section>` : ''}

    <footer class="opg-foot">
      <span>${esc(co)} &times; Lyzr &middot; ${esc(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }))}</span>
      <span>Page ${esc(num)} of ${esc(total)}</span>
    </footer>
  </article>`;
}

/* The whole document: nothing but the opportunity pages. No cover, no summary table, no
 * closing. Every page is read on its own and carries its own header and footer, because
 * the one that gets forwarded is rarely page one. */
function partnerSheet() {
  const b = S.brief, co = S.profile.company.name || '';
  const chosen = S.chosen ?? [];
  /* Driven by the pages the writer actually wrote, in its order. An opportunity it could
   * not make a page for is not printed as an empty sheet. */
  const pageOf = new Map((b.pages ?? []).map((r) => [r.id, r]));
  const plays = (b.pages ?? []).map((r) => chosen.find((c) => c.id === r.id)).filter(Boolean);
  const n = plays.length;

  return `<div class="sheet" id="sheet-partner">
    ${plays.map((c, i) => briefPage(c, pageOf.get(c.id) ?? {}, i, n, co)).join('')}
  </div>`;
}

/* ---------------- export ---------------- */
/* A PDF, not a saved web page. The document is rendered into a hidden iframe carrying the
 * same stylesheet plus the print rules — A4, real margins, sections that do not split
 * across a page break — and printed. Everything stays live text: selectable, searchable
 * and sharp at any zoom, which a canvas-rasterised PDF is not. The browser's print dialog
 * is where the visitor chooses "Save as PDF". */
function exportPdf(sheetId, title, btn) {
  const sheet = $(sheetId);
  if (!sheet) return;
  const css = [...document.styleSheets]
    .flatMap((s) => { try { return [...s.cssRules].map((r) => r.cssText); } catch { return []; } })
    .join('\n');

  const was = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none';
  document.body.append(frame);

  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${css}
/* The print rules above are scoped to @media print; the iframe is only ever printed, so
   they are restated unconditionally here for the preview the dialog shows. */
body{background:#fff;margin:0}
.sheet{border:none;border-radius:0;padding:0}
.opg{border:none;border-radius:0;margin:0;padding:14mm 15mm 10mm;
  min-height:265mm;height:auto;box-sizing:border-box;break-after:page;page-break-after:always}
.opg:last-child{break-after:auto;page-break-after:auto}
.copy,.tabs{display:none}
/* Restated for the dialog's own preview, which does not always apply the print block. */
@page{size:A4;margin:0}
</style></head><body>${sheet.outerHTML}</body></html>`);
  doc.close();

  const go = () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = was; }
      /* Safari needs the frame to outlive the dialog. */
      setTimeout(() => frame.remove(), 60_000);
    }
  };
  /* Wait for the webfonts and the two logos, or the first page prints in a fallback face
     with the lockup missing. */
  const imgs = [...doc.images].filter((i) => !i.complete);
  const ready = Promise.all([
    doc.fonts?.ready ?? Promise.resolve(),
    ...imgs.map((i) => new Promise((res) => { i.onload = i.onerror = res; })),
  ]);
  Promise.race([ready, new Promise((r) => setTimeout(r, 3000))]).then(() => setTimeout(go, 120));
}

const docTitle = () => `Opportunity brief — ${S.profile.company.name || 'your company'}`;
$('dlpartner').onclick = (e) => exportPdf('sheet-partner', docTitle(), e.currentTarget);

$('talk').onclick = async (e) => {
  e.target.disabled = true; $('talkdone').hidden = false;
  try { await post('/api/contact', { id: S.id }); } catch {}
};
$('xagain').onclick = () => location.reload();

/* Back, everywhere. Nothing is thrown away by stepping back — the cards and the brief are
 * cached, so returning to a screen is instant unless an answer actually changed. */
document.querySelectorAll('[data-back]').forEach((b) => { b.onclick = () => show(b.dataset.back); });
$('exploreback').onclick = () => { S.qi = Math.max(0, S.questions.length - 1); askQ(); };

/* Embedded in the landing page: the hero already took the email, so prefill and start
 * rather than asking twice. */
/* Embedded in the landing page: the form there already took the work email, so prefill and
 * start rather than asking twice. */
const qp = new URLSearchParams(location.search);
if (qp.get('email')) {
  $('email').value = qp.get('email');
  if (qp.get('go') !== '0') setTimeout(() => $('start').click(), 120);
  else $('email').focus();
}
