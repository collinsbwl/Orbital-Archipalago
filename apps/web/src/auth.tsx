import { useState, type ReactNode } from 'react';
import { useAuth0, type AppState } from '@auth0/auth0-react';
import { Landing } from './landing/Landing';

const env = import.meta.env;
export const AUTH0_ENABLED = Boolean(env.VITE_AUTH0_DOMAIN && env.VITE_AUTH0_CLIENT_ID);
export const AUTH0_AUDIENCE = env.VITE_AUTH0_AUDIENCE;

/** Query params Auth0 puts on the callback URL. They must never be carried into the place we return to. */
const CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description'];

/** Where to come back to after login: the current path, query and hash, minus any leftover Auth0 callback params. */
export function currentReturnTo(loc: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location): string {
  const q = new URLSearchParams(loc.search);
  CALLBACK_PARAMS.forEach((p) => q.delete(p));
  const search = q.toString();
  return `${loc.pathname}${search ? `?${search}` : ''}${loc.hash}`;
}

/** A same-origin path to return to, or "/" for anything else (absolute or protocol-relative URLs). */
export function safeReturnTo(target: unknown): string {
  return typeof target === 'string' && target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/\\') ? target : '/';
}

/**
 * Auth0Provider's onRedirectCallback. Login always lands on the bare origin (the single callback URL registered with
 * Auth0); this puts back the path and query the user signed in from (e.g. `?live=1`) and drops `code` and `state`.
 */
export function onRedirectCallback(appState?: AppState): void {
  window.history.replaceState({}, document.title, safeReturnTo(appState?.returnTo));
}

/** Log in / Log out + user name. Renders nothing when Auth0 is not configured (anonymous dev). */
export function AuthControls() {
  const { isAuthenticated, isLoading, user, loginWithRedirect, logout } = useAuth0();
  if (!AUTH0_ENABLED) return <span className="muted">anonymous</span>;
  if (isLoading) return <span className="muted">auth...</span>;
  return isAuthenticated ? (
    <span>
      {user?.name ?? user?.email ?? 'user'}{' '}
      <button onClick={() => void logout({ logoutParams: { returnTo: window.location.origin } })}>Log out</button>
    </span>
  ) : (
    <button onClick={() => void loginWithRedirect({ appState: { returnTo: currentReturnTo() } })}>Log in</button>
  );
}

function Auth0Gate({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, error, loginWithRedirect } = useAuth0();
  if (isAuthenticated) return <>{children}</>;
  return (
    <Landing
      actionLabel="Sign in"
      busy={isLoading}
      error={error ? `Sign-in failed: ${error.message}` : null}
      onAction={() => void loginWithRedirect({ appState: { returnTo: currentReturnTo() } })}
    />
  );
}

/** Anonymous dev (Auth0 not configured): there is nobody to sign in as, so the button just lets you in. */
function AnonymousGate({ children }: { children: ReactNode }) {
  const [entered, setEntered] = useState(false);
  if (entered) return <>{children}</>;
  return <Landing actionLabel="Enter" onAction={() => setEntered(true)} />;
}

/**
 * Shows the landing page until the user is signed in, then the app. With Auth0 configured there is no way past it
 * without logging in; the engine still checks the token, so this is the front door, not the lock.
 */
export function AuthGate({ children, enabled = AUTH0_ENABLED }: { children: ReactNode; enabled?: boolean }) {
  return enabled ? <Auth0Gate>{children}</Auth0Gate> : <AnonymousGate>{children}</AnonymousGate>;
}
