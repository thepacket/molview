import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing');

// Right-click belongs to the pane context menus, not the browser's — except in
// text fields, where the native menu is still the useful one.
window.addEventListener('contextmenu', (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
  e.preventDefault();
});

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
