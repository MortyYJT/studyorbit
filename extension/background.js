const API_PREFIX = 'https://canvas.lms.unimelb.edu.au/api/v1/';
const BRIDGE = 'ws://127.0.0.1:47613';
let socket;
let heartbeat;

async function read(connection, request) {
  try {
    if (typeof request.url !== 'string' || !request.url.startsWith(API_PREFIX)) throw new Error('URL not allowed');
    // A signed-out API call redirects to the SSO host; report the redirect instead of following it.
    const response = await fetch(request.url, { method: 'GET', credentials: 'include', redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    const redirected = response.type === 'opaqueredirect';
    const text = redirected ? '' : await response.text();
    if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({
      id: request.id, status: redirected ? 302 : response.status, finalUrl: redirected ? 'redirect' : response.url, text,
    }));
  } catch (error) {
    if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ id: request.id, error: error.message }));
  }
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const connection = new WebSocket(BRIDGE);
  socket = connection;
  connection.onopen = () => {
    connection.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version }));
    heartbeat = setInterval(() => {
      if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'ping' }));
    }, 20_000);
  };
  connection.onmessage = event => {
    let request;
    try { request = JSON.parse(event.data); } catch { return; }
    if (request?.type === 'read' && typeof request.id === 'string') void read(connection, request);
  };
  connection.onclose = () => { clearInterval(heartbeat); };
  connection.onerror = () => { connection.close(); };
}

// Edge does not start the worker on launch by itself, and alarms may not survive a restart.
async function wake() {
  if (!await chrome.alarms.get('reconnect')) await chrome.alarms.create('reconnect', { periodInMinutes: 1 });
  connect();
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'reconnect') connect(); });
chrome.runtime.onStartup.addListener(wake);
chrome.runtime.onInstalled.addListener(wake);
void wake();
