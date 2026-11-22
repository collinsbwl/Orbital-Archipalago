import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = {
  isAuthenticated: false,
  isLoading: false,
  error: undefined as Error | undefined,
  user: undefined,
  loginWithRedirect: vi.fn(async () => undefined),
  logout: vi.fn(),
};
vi.mock('@auth0/auth0-react', () => ({ useAuth0: () => auth }));
// The island needs WebGL; the gate only cares about the button.
vi.mock('./landing/island-scene', () => ({ startIslandScene: () => () => undefined }));

const { AuthGate, currentReturnTo, onRedirectCallback, safeReturnTo } = await import('./auth');

const gate = (enabled: boolean) =>
  render(
    <AuthGate enabled={enabled}>
      <p>the app</p>
    </AuthGate>,
  );

afterEach(() => {
  auth.isAuthenticated = false;
  auth.isLoading = false;
  auth.error = undefined;
  auth.loginWithRedirect.mockClear();
  window.history.replaceState({}, '', '/');
});

describe('AuthGate with Auth0', () => {
  it('shows the landing page and not the app until signed in', () => {
    gate(true);
    expect(screen.getByRole('heading', { name: 'Orbital Archipelago' })).toBeTruthy();
    expect(screen.queryByText('the app')).toBeNull();
  });

  it('sends the user to Auth0 and remembers where they were, minus callback params', () => {
    window.history.replaceState({}, '', '/?live=1&code=stale&state=stale#x');
    gate(true);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(auth.loginWithRedirect).toHaveBeenCalledWith({ appState: { returnTo: '/?live=1#x' } });
  });

  it('holds the button while Auth0 is still finishing the redirect', () => {
    auth.isLoading = true;
    gate(true);
    const button = screen.getByRole('button', { name: 'Signing in...' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('shows why sign-in failed and lets the user try again', () => {
    auth.error = new Error('access_denied');
    gate(true);
    expect(screen.getByRole('alert').textContent).toContain('access_denied');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(auth.loginWithRedirect).toHaveBeenCalled();
  });

  it('renders the app once signed in', () => {
    auth.isAuthenticated = true;
    gate(true);
    expect(screen.getByText('the app')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });
});

describe('AuthGate without Auth0 (anonymous dev)', () => {
  it('lets you in with Enter and never calls Auth0', () => {
    gate(false);
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    expect(screen.getByText('the app')).toBeTruthy();
    expect(auth.loginWithRedirect).not.toHaveBeenCalled();
  });
});

describe('login redirect', () => {
  it('restores the path and query the user signed in from', () => {
    window.history.replaceState({}, '', '/?code=abc&state=xyz');
    onRedirectCallback({ returnTo: '/?live=1' });
    expect(window.location.pathname + window.location.search).toBe('/?live=1');
  });

  it('falls back to the root without a return path', () => {
    window.history.replaceState({}, '', '/?code=abc&state=xyz');
    onRedirectCallback(undefined);
    expect(window.location.pathname + window.location.search).toBe('/');
  });

  it('only returns to same-origin paths', () => {
    expect(safeReturnTo('/planets?live=1')).toBe('/planets?live=1');
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo('//evil.example')).toBe('/');
    expect(safeReturnTo('/\\evil.example')).toBe('/');
    expect(safeReturnTo(42)).toBe('/');
  });

  it('builds the return path from the current location', () => {
    expect(currentReturnTo({ pathname: '/', search: '?error=login_required&state=s&fixtures=1', hash: '' })).toBe('/?fixtures=1');
    expect(currentReturnTo({ pathname: '/a', search: '', hash: '' })).toBe('/a');
  });
});
