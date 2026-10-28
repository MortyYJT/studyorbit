import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './style.css';

// Move previous prototype data aside once; keep a recoverable copy in this browser.
try {
  const marker = 'coursework.canonical-reset-v1';
  if (localStorage.getItem(marker) === null) {
    const keys = ['coursework.selected-course-ids', 'coursework.local-planning.work.v1', 'coursework.local-planning.corrections.v1', 'coursework.local-planning.assessments.v1', 'coursework.local-planning.order.v1'];
    const backup = Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)]));
    localStorage.setItem('coursework.backup-before-canonical-v1', JSON.stringify(backup));
    for (const key of keys) localStorage.removeItem(key);
    localStorage.setItem(marker, 'done');
  }
} catch { /* Keep existing data if a recoverable backup cannot be stored. */ }
createRoot(document.getElementById('root')!).render(<App />);
