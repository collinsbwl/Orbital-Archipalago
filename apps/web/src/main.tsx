import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Auth0Provider } from '@auth0/auth0-react';
import { App } from './App';
import { AUTH0_AUDIENCE, AUTH0_ENABLED } from './auth';
import './styles.css';

const env = import.meta.env;
const app = <App />;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {AUTH0_ENABLED ? (
      <Auth0Provider
        domain={env.VITE_AUTH0_DOMAIN!}
        clientId={env.VITE_AUTH0_CLIENT_ID!}
        authorizationParams={{ redirect_uri: window.location.origin, ...(AUTH0_AUDIENCE ? { audience: AUTH0_AUDIENCE } : {}) }}
      >
        {app}
      </Auth0Provider>
    ) : (
      app
    )}
  </StrictMode>,
);
