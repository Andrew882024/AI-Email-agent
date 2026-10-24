import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Router } from './router/routes';
import { StateProvider } from './state/query-client';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StateProvider>
      <Router />
    </StateProvider>
  </StrictMode>,
);
