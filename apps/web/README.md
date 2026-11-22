# @orbital/web

A full-screen 3D view of the archipelago with floating panels (planet metrics and charts, event feed, god-mode panel for operators).

The scene (`src/scene/`, built with React Three Fiber): a glowing sun and starfield, low-poly planets that each have their own look (`planet-look.ts`), faint trade lanes between every pair of planets, and a freighter with an engine trail for each shipment in flight. Every planet carries its name; hover a planet for its currency, GDP, inflation and population, or a ship for its owner, cargo, route and arrival. Drag to rotate, scroll to zoom. Planets are stationary (set `PLANETS_ORBIT` in `src/scene/frame.ts` to make them circle the sun), and ships glide smoothly along the lane between their two planets (`clock.ts` learns the cycle length from the gaps between snapshots). In fixture mode there are pause and 1x/2x/4x buttons.

Focus mode: click a zoomable planet (for now only Verdan; see `ZOOMABLE_PLANETS` in `src/scene/focus.ts`) and the camera flies in, the planet glows, its lanes turn gold and everything else steps back (the same spotlight shows when you just hover any planet on the map), and a card shows its economy numbers (it keeps updating while the simulation runs). Back to map, or press Esc, flies the camera back to where it was.

The camera lands at a little city on the planet (`src/scene/city.ts` for the layout and walking rules, `CityView.tsx` for the drawing): a grassy mesa with a cross of roads, a plaza with a fountain, houses, a farm with a barn and silo, a landing pad, and aliens walking the roads. The numbers come from the planet: population sets how many houses and aliens there are, and consumer confidence sets how fast they walk. These aliens are placeholders; real per-agent aliens need per-agent data in the snapshot.

## Run

```sh
pnpm install
pnpm --filter @orbital/web dev          # fixtures: plays public/fixtures/snapshots.json in a loop
```

Against a live engine:

```sh
pnpm --filter @orbital/engine-server dev -- --port 8787 --interval 500
# then open http://localhost:5173/?live=1   (ws://localhost:8787 by default)
```

Re-record the fixtures with `pnpm --filter @orbital/engine record-snapshots`.

## Mode

Live if `VITE_ENGINE_WS_URL` is set or `?live=1`; fixtures otherwise. `?fixtures=1` forces fixtures.
The role comes from the engine's `hello` message, never from the client. With Auth0 unset the engine (auth disabled) decides it (`DEV_ROLE`, default operator).

## Env (see `.env.example`)

| Var | Meaning |
| --- | --- |
| `VITE_ENGINE_WS_URL` | Engine WebSocket URL: absolute (`ws://localhost:8787/ws`) or a path (`/ws`) on the page's own origin, which becomes `wss://` on https |
| `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID` | Enable Auth0 login when both set |
| `VITE_AUTH0_AUDIENCE` | API audience; must match `AUTH0_AUDIENCE` on the engine |

The access token goes on the socket handshake as `?access_token=`. Add the app origin to the Auth0 application's callback, logout and web origins.

Operators: the engine reads roles from the `https://orbital/roles` claim of the access token (`DEFAULT_ROLES_CLAIM` in `packages/engine/src/server/auth.ts`). Auth0 does not add it by itself; a Post-Login Action has to set it, for example `api.accessToken.setCustomClaim('https://orbital/roles', event.authorization?.roles ?? [])`. Without it every user is a spectator.

## Docker / Coolify

`Dockerfile.web` builds the SPA and serves it with Caddy, which also proxies `/ws` to the engine, so the image is built with `VITE_ENGINE_WS_URL=/ws`. Auth0 settings are build args, filled by docker-compose from `VITE_AUTH0_*` in the environment (repo-root `.env`, or Coolify build variables). Local `.env` files are never copied into images.

## Landing page and sign-in

Until the user signs in, the app shows a landing page (`src/landing/`): the title forms out of melted letters (the Climate Crisis font's YEAR axis), then a low-poly island bursts toward the camera, drops under gravity and bounces to rest (`boom.ts` holds the motion, `island-scene.ts` draws it with three.js). Its one button is the only way in.

With Auth0 configured the button calls `loginWithRedirect`. Auth0 always redirects back to the bare origin (the one callback URL to register), and `onRedirectCallback` in `src/auth.tsx` puts back the path and query the user started from (e.g. `?live=1`), with `code` and `state` removed. A failed login shows its error under the button. With Auth0 unset (anonymous dev) the button reads Enter and just lets you in. The gate is only the front door: the engine still checks the token.

## Vercel

Set the project root to `apps/web`; `vercel.json` installs and builds from the monorepo root. Set the `VITE_*` vars in the project settings.
