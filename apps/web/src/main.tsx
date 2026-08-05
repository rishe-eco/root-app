import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ApolloProvider } from '@apollo/client';

// Self-hosted, per the build brief — no font CDN in production.
import '@fontsource-variable/inter';
import '@fontsource-variable/vazirmatn';

import './i18n';
import './styles/tokens.css';
import './styles/kit.css';
import './styles/base.css';
import './styles/public.css';
import './styles/portal.css';
import './styles/desk.css';
// Last, so its @media print rules override the app's screen layout.
import './styles/print.css';

import { apollo } from '@/lib/apollo';
import App from './App';

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <ApolloProvider client={apollo}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ApolloProvider>
  </StrictMode>,
);
