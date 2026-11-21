# @orbital/web

A full-screen 3D view of the archipelago with floating panels (planet metrics and charts, event feed, god-mode panel for operators).

The scene (`src/scene/`, built with React Three Fiber): a glowing sun and starfield, low-poly planets that each have their own look (`planet-look.ts`), faint trade lanes between every pair of planets, and a freighter with an engine trail for each shipment in flight. Hover a ship for its owner, cargo, route and arrival. Drag to rotate, scroll to zoom. Planets are stationary (set `PLANETS_ORBIT` in `src/scene/frame.ts` to make them circle the sun), and ships glide smoothly along the lane between their two planets (`clock.ts` learns the cycle length from the gaps between snapshots). In fixture mode there are pause and 1x/2x/4x buttons.

## Run

```sh
pnpm install
pnpm --filter @orbital/web dev          # fixtures: plays public/fixtures/snapshots.json in a loop
```

Against a live engine:

```sh
pnpm --filter @orbital/engine serve -- --port 8787 --interval 500
# then open http://localhost:5173/?live=1   (ws://localhost:8787 by default)
```

Re-record the fixtures with `pnpm --filter @orbital/engine record-snapshots`.

## Mode

Live if `VITE_ENGINE_WS_URL` is set or `?live=1`; fixtures otherwise. `?fixtures=1` forces fixtures.
The role comes from the engine's `hello` message, never from the client. With Auth0 unset the engine (auth disabled) decides it (`DEV_ROLE`, default operator).

## Env (see `.env.example`)

| Var | Meaning |
| --- | --- |
| `VITE_ENGINE_WS_URL` | Engine WebSocket URL (`wss://...` in production) |
| `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID` | Enable Auth0 login when both set |
| `VITE_AUTH0_AUDIENCE` | API audience; must match `AUTH0_AUDIENCE` on the engine |

The access token goes on the socket handshake as `?access_token=`. Add the app origin to the Auth0 application's callback, logout and web origins.

## Vercel

Set the project root to `apps/web`; `vercel.json` installs and builds from the monorepo root. Set the `VITE_*` vars in the project settings.
