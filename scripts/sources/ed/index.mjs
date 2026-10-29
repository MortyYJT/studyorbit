// The Ed course source (openspec change generic-adapters, design §1, §3, decision #443): lesson inventory, the owner's
// final-submission scores and a few introductions through the `edstem` CLI. Collection runs out of process; this
// object only builds the collector command (script relative to `scripts/`).
export const edSource = Object.freeze({
  id: 'ed',
  label: 'Ed',
  usesBrowser: false,
  limiter: 'ed',
  platforms: Object.freeze(['ed']),
  /** `<CODE> <term> <out>`. */
  collect: (course, ctx, out) => ({ script: 'sources/ed/collect.mjs', args: [course.subjectCode, typeof course.term === 'string' ? course.term : '', out], env: { ...ctx.env } }),
  placeholder: (reason = 'Ed 采集不可用') => ({ status: 'unavailable', lessons: [], scores: [], reason }),
});
