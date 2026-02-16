# CUDIS NTT Claimer

Monitors a Solana custody token account and automatically redeems a stuck Wormhole NTT transfer once the custody balance reaches a required threshold.

## Setup

1. Copy the template and fill secrets:

   ```bash
   cp .env.example .env
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Run:

   ```bash
   npx tsx src/index.ts
   ```

## Behavior

- Polls custody account balance every `POLL_INTERVAL_MS` (default 30s)
- Attempts redeem when balance is at least `REQUIRED_AMOUNT`
- Fetches signed VAA from Wormhole SDK first, then Wormholescan API fallback
- Submits `redeem` flow via Wormhole SDK (`postVaa`, `redeem`, `releaseInboundUnlock`)
- Retries up to 3 times with exponential backoff (5s, 15s, 45s)
- Exits with code `0` on success

## Notes

- This project is intended for Solana mainnet and CUDIS NTT constants in `.env.example`.
- Never commit your `.env` file.
