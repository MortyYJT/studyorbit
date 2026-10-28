// Same-origin guard for the local `/api/local/*` routes. Requests without an Origin header (curl, same-origin
// navigations) pass; any Origin that is not exactly this server's own origin is foreign, including other
// localhost ports, so a page served elsewhere on this machine cannot read grades or chats.
export function foreignOrigin({ origin, host }) {
  if (origin === undefined) return false;
  return !host || origin !== `http://${host}`;
}
