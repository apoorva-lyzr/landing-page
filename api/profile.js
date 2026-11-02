import { step1Gather, step1Profile } from '../lib/journey.js';
import { guard, json, body, record } from './_handler.js';
import crypto from 'node:crypto';

/* Two requests, not one.
 *
 * Reading their site and reading the model are about forty seconds together, and a
 * serverless function has a wall clock: this step kept walking into it and the visitor
 * got a 504 on the first screen. The browser posts twice, once to gather and once to
 * profile, and carries the material between them. The total is what it always was and
 * neither half is close to the limit. */
export default guard(async (req, res) => {
  const { email, website, material, id: given } = await body(req);

  if (material) {
    const r = await step1Profile(material);
    const id = given || crypto.randomUUID();
    if (!r.ok) return json(res, 200, { ...r, id });
    await record(id, { profile: r.profile, evidence: r.evidence });
    return json(res, 200, { ...r, id });
  }

  const id = crypto.randomUUID();
  const r = await step1Gather(email, website);
  if (!r.ok) return json(res, 200, { ...r, id });
  await record(id, { email, website });
  /* The capability map and the evidence travel back to the browser and return with the
   * second call. They are the first half's whole output, and holding them on the server
   * between two requests would mean holding state a serverless function does not have. */
  return json(res, 200, { ok: true, stage: 'gathered', id, material: r });
});
