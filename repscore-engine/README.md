# RepScore Engine

On-chain reputation scoring engine powering repscore.xyz.

## Setup

```bash
npm install
cp .env.example .env
# Add your keys to .env
```

## Environment Variables

```env
# Required
HELIUS_API_KEY=your_helius_api_key

# Optional — falls back to in-memory cache
REDIS_URL=redis://localhost:6379

# Optional — comma-separated API keys for partner access
API_KEYS=key1,key2,key3

PORT=3001
NODE_ENV=development
```

## Running

```bash
# Development (hot reload)
npm run dev

# Production
npm run build && npm start

# Score a wallet from CLI
npm run score <wallet_address>
```

## API Endpoints

### GET /v1/score/:wallet
Returns the reputation score for any Solana wallet.

**Public** — 30 req/min (unauthenticated)
**API Key** — 300 req/min (header: `x-api-key`)

```bash
curl https://api.repscore.xyz/v1/score/7xKp...mR9s
```

Response:
```json
{
  "success": true,
  "fromCache": false,
  "data": {
    "wallet": "7xKp...mR9s",
    "score": 872,
    "tier": "VERIFIED",
    "role": "DEV",
    "components": {
      "launchHistory":    { "raw": 91, "weighted": 27.3, "weight": 0.30, "signals": ["..."] },
      "liquidityBehavior": { "raw": 88, "weighted": 22.0, "weight": 0.25, "signals": ["..."] },
      "holderRetention":  { "raw": 79, "weighted": 15.8, "weight": 0.20, "signals": ["..."] },
      "communitySignals": { "raw": 85, "weighted": 12.75, "weight": 0.15, "signals": ["..."] },
      "walletHistory":    { "raw": 94, "weighted": 9.4,  "weight": 0.10, "signals": ["..."] }
    },
    "flags": [],
    "metadata": { ... },
    "cachedAt": "2025-01-15T12:00:00.000Z"
  }
}
```

### POST /v1/score/batch
Score up to 50 wallets in one call. Requires API key.

```bash
curl -X POST https://api.repscore.xyz/v1/score/batch \
  -H "x-api-key: your_key" \
  -H "Content-Type: application/json" \
  -d '{ "wallets": ["wallet1", "wallet2"] }'
```

### POST /v1/score/:wallet/refresh
Force re-score bypassing cache. Requires API key.

## Score Tiers

| Range | Tier |
|-------|------|
| 1000 | LEGEND |
| 850–999 | VERIFIED |
| 600–849 | ESTABLISHED |
| 400–599 | UNPROVEN |
| 200–399 | FLAGGED |
| 0–199 | BLACKLISTED |

## Score Components

| Component | Weight | Key Signals |
|-----------|--------|-------------|
| Launch History | 30% | # launches, success rate, rug count |
| Liquidity Behavior | 25% | LP lock duration, pulls, initial LP size |
| Holder Retention | 20% | 7d / 30d / 90d retention rates |
| Community Signals | 15% | Telegram longevity, mint/freeze authority |
| Wallet History | 10% | Age, volume, linked wallet clusters |

## Hard Caps

- `SERIAL_RUGGER` flag → score capped at 199
- `FAST_RUG` flag → score capped at 250
- 2+ CRITICAL flags → score capped at 300

## Architecture

```
src/
  types/index.ts       — all TypeScript interfaces
  fetcher.ts           — Helius RPC + API data fetching
  scorers/index.ts     — 5 component scoring modules
  engine.ts            — orchestrator, assembles final score
  cache.ts             — Redis + memory fallback
  api/server.ts        — Express REST API
  cli.ts               — terminal scoring tool
```

## Deploying to Production

Recommended: Railway or Render (Node.js service)

1. Push to GitHub
2. Connect to Railway/Render
3. Set environment variables
4. Deploy — it will auto-run `npm start`

Point `api.repscore.xyz` CNAME to your deployment URL.
