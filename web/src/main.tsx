import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './style.css';
import { migrateStoragePrefix } from './storage-prefix.js';

// Move browser data saved under the project's former key prefix first, so every reader below sees the new keys.
try { migrateStoragePrefix(localStorage); } catch { /* Storage may be blocked; readers fall back to their defaults. */ }

// Move previous prototype data aside once; keep a recoverable copy in this browser.
try {
  const marker = 'studyorbit.canonical-reset-v1';
  if (localStorage.getItem(marker) === null) {
    const keys = ['studyorbit.selected-course-ids', 'studyorbit.local-planning.work.v1', 'studyorbit.local-planning.corrections.v1', 'studyorbit.local-planning.assessments.v1', 'studyorbit.local-planning.order.v1'];
    const backup = Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)]));
    localStorage.setItem('studyorbit.backup-before-canonical-v1', JSON.stringify(backup));
    for (const key of keys) localStorage.removeItem(key);
    localStorage.setItem(marker, 'done');
  }
} catch { /* Keep existing data if a recoverable backup cannot be stored. */ }
createRoot(document.getElementById('root')!).render(<App />);
