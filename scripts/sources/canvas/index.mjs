// The Canvas course source (openspec change generic-adapters, design §1–§2, decision #442): discovers the owner's
// courses and collects one course's assignment groups, assignments and own submissions through the browser bridge.
// Collection runs out of process; this object only builds the collector command (script relative to `scripts/`).
export const canvasSource = Object.freeze({
  id: 'canvas',
  label: 'Canvas',
  usesBrowser: true,
  limiter: 'browser',
  platforms: Object.freeze(['canvas', 'canvas-group']),
  /** `discover <out>`: every active course with its term. */
  discover: (ctx, out) => ({ script: 'sources/canvas/collect.mjs', args: ['discover', out], env: { ...ctx.env } }),
  /** `<courseId> <out>`. */
  collect: (course, ctx, out) => ({ script: 'sources/canvas/collect.mjs', args: [course.id, out], env: { ...ctx.env } }),
  placeholder: (reason = 'Canvas 采集不可用') => ({ status: 'unavailable', reason }),
});
