import { useAuth0 } from '@auth0/auth0-react';

const env = import.meta.env;
export const AUTH0_ENABLED = Boolean(env.VITE_AUTH0_DOMAIN && env.VITE_AUTH0_CLIENT_ID);
export const AUTH0_AUDIENCE = env.VITE_AUTH0_AUDIENCE;

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
    <button onClick={() => void loginWithRedirect()}>Log in</button>
  );
}
