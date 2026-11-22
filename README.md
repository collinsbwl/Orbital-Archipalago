# Orbital Archipelago - Watch an Economy Think

## Description
Orbital Archipelago is a small economy in space that runs itself. Three planets orbit a sun, and about 100 AI characters live on them: colonists, traders and governments. Each planet has its own currency. The characters buy and sell, ship goods between planets, take out loans, and argue over tariffs. Every trade is recorded on the Solana blockchain.

You watch it all happen in 3D in your browser. You can also play god: cause a drought, start an embargo, or split the universe in two to see how things would have turned out differently.


No API keys? You can still try it. The web app can replay a recorded run (see [Quick Start, step 2](#2-watch-a-recorded-run-no-keys-needed)).

## Motivation
Economics is usually taught with static charts and tidy assumptions. Real trade wars, currency crashes and recessions don't work like that. They happen when lots of people react to each other. We wanted to build a small economy you can actually *watch*. Give AI characters needs, money and markets, then stand back and see whether a trade war starts on its own.

Every run can be replayed exactly, which makes an experiment possible that the real world never allows: split the universe halfway through, add a tariff in one copy only, and compare the two timelines side by side.

---

## Quick Start

### 1. Install

You'll need **Node 22** and **pnpm 9**.

```bash
nvm use
corepack enable
pnpm install
pnpm build
```

### 2. Watch a recorded run (no keys needed)

```bash
pnpm --filter @orbital/web dev
```

Open **http://localhost:5173**. A saved run plays on a loop, with pause and speed controls.

### 3. Run it live

```bash
# Terminal 1: start the simulation
pnpm --filter @orbital/engine-server dev

# Terminal 2: start the website
pnpm --filter @orbital/web dev
```

Open **http://localhost:5173/?live=1**. Without an AI key the characters act at random (but always legally), so you can try everything for free. Until login is set up, god mode is unlocked for everyone.

<details>
<summary><b>Optional: plug in the real services (AI, database, blockchain, login)</b></summary>

<br>

Create a `.env` file in the repo root:

```bash
GEMINI_API_KEY=        # turns on the AI characters
RUN_BUDGET_USD=15      # the most a run can spend on AI before switching to simple rules
TIGER_DATABASE_URL=    # saves the economy's history (leave empty to keep it in memory)
LEDGER=solana          # record trades on Solana (default: memory)
SOLANA_RPC_URL=        # default: http://127.0.0.1:8899
AUTH0_ISSUER=          # set both to require login
AUTH0_AUDIENCE=
```

The website has its own settings in `apps/web/.env`. See [apps/web/README.md](apps/web/README.md) for those and for setting up Auth0 roles.

**Run a local database:**

```bash
docker compose --profile local up -d tiger
export TIGER_DATABASE_URL='postgres://orbital:orbital@localhost:5432/orbital'
```

> Each time the simulation starts, it wipes the previous run's data. Don't point a local run at the production database.

**Run everything in Docker:** `docker compose up -d --build` starts the website, the simulation and a local Solana chain. This is the setup we deploy with Coolify. To open it on your own machine, add a port mapping to the `web` service.

</details>

<details>
<summary><b>Useful commands</b></summary>

<br>

```bash
pnpm test                                        # run all tests
pnpm --filter @orbital/engine sim                # run 200 cycles in the terminal, no browser
pnpm --filter @orbital/engine record-snapshots   # re-record the demo run the website plays
pnpm --filter @orbital/engine-server dev -- --interval 500 --cycles 100   # faster, shorter run
```

</details>

---

## Tech Stack

<p align="center">
  <a href="docs/archipelago.svg">
    <img src="docs/archipelago.svg" alt="Tech stack diagram: the browser app, Auth0, the engine server on a Vultr VM, Gemini, Tiger Data and the Solana program" width="100%">
  </a>
</p>

| Technology | Its job |
|---|---|
| **Gemini** | The brains. Picks what each character does every cycle |
| **Solana** | The bank. Every balance, trade, shipment and loan is settled on-chain |
| **Tiger Data** | The memory. Stores the economy's history and powers the charts |
| **Auth0** | The front door. Handles login and decides who may use god mode |
| **React + Three.js** | The view. Draws the solar system and each planet's surface |
| **Vultr + Coolify** | The host. The whole thing runs on one server |

---

## Core Architecture

### The world

Three planets and five goods. One rule drives everything: **every colonist must eat 1 grain and drink 1 water each cycle.**

| Planet | Currency | Makes |
|---|---|---|
| 🔥 **Helion** | HLX | Iron and fuel |
| 🌿 **Verdan** | VRD | Grain and water |
| 🧊 **Tethys** | TTH | Water, tools and some iron |

Helion can't feed itself, and Verdan can't make tools, so the planets have to trade. They also keep orbiting, so the same trip can be quick at one point in a run and several times longer later.

### What happens each cycle

The simulation moves forward in steps called **cycles**. Each cycle goes like this:

1. **Events:** god-mode actions take effect
2. **Ships arrive:** freighters dock and pay tariffs at customs
3. **Make and eat:** planets produce goods and colonists eat. Colonists who keep going hungry move to another planet
4. **Decide:** every character chooses what to do next
5. **Check:** the engine makes sure each choice is allowed (enough money? enough goods?)
6. **Trade:** auctions set prices on each planet, and the currencies are exchanged
7. **Banks:** each planet's central bank adjusts its interest rate
8. **Publish:** the stats are saved and the new state is sent to your browser

### How the AI characters decide

**The AI never does the maths.** For each character, regular code first works out a short menu of sensible options, such as *"buy 20 grain on Verdan and ship it to Helion"*. A fast Gemini model then picks one.

- If a trader or government isn't sure, **Gemini Flash** takes a closer look. It can check prices on other planets before it chooses.
- If anything goes wrong (the AI is slow, its answer doesn't make sense, or the budget runs out), the character simply repeats its last orders.
- The engine double-checks every decision anyway, so an AI can never spend money it doesn't have.

The characters have no long memory, just a short note they leave for their next turn. That keeps every AI call small and cheap, no matter how long the run lasts.

### Where the money lives

Every balance, trade, shipment and loan is recorded by our own Solana program ([programs/orbital](programs/orbital)). Each planet's currency is a real token. Taking a loan creates new money and repaying it destroys it, just like a real bank.

### Data and live updates

- **Tiger Data** keeps a cycle-by-cycle history of GDP, inflation, prices, exchange rates and AI spend, and turns it into the charts you see.
- The engine **streams** each new cycle to your browser as it happens. Operators send god-mode commands back over the same connection.
- **Auth0** handles login. The engine checks your role itself, so nobody can unlock god mode from the browser.

📖 Want the deep dive? See [architecture.md](architecture.md).

---

## Extra Features

### ⚡ God mode
Operators can change the economy while it runs. Every action is logged along with who took it.

| Action | What it does |
|---|---|
| **Shock** | Drought, strike, windfall, blight or a demand surge on one planet |
| **Tariff** | Tax a good coming into a planet |
| **Embargo** | Stop one planet from accepting any cargo from another |
| **Interest rate** | Override a central bank |
| **Fork** | Split the universe into two copies that run side by side |
| **Pause / Resume** | Freeze time and start it again |

### 📰 Breaking news
The simulation watches for big moments: **trade wars, currency crises, recessions, shifting trade routes and collapses in confidence**. When one happens, it shows up as a headline, such as *"Currency crisis! HLX tumbles 23% in 5 cycles"*.

### Visit a planet
Click a planet to fly down to its surface. Everything you see there comes from the live economy:
- The city grows with the population, and the farms and factories match what the planet makes
- Freighters land at and take off from a working spaceport
- The weather follows the mood: storms in a crisis, gloomy skies in a slump, fireworks when times are good
- Aliens wander the streets, gossiping about prices and tariffs in an alien alphabet

### Spending limits
AI spending has a cap of $15 per run by default. Once a run reaches it, the characters switch to simple rules instead of stopping. The engine tracks spending as it goes.

### Repeatable runs
Run the same setup twice and you get exactly the same history. That's what makes forks a fair comparison. Every change is tested automatically, including a full 200-cycle run.
