import { createRoot } from 'react-dom/client';
import { createClient, takeOwnerSession } from './client.js';
import { ShellStore } from './shell.js';
import { App } from './App.js';
import './style.css';

// Consume the secret before rendering, fetching, or reading presentation preferences.
const store = new ShellStore(createClient(takeOwnerSession(window.location, window.history)));
createRoot(document.getElementById('root')!).render(<App store={store} />);
