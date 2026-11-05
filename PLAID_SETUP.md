# Plaid bank feeds — setup

Live bank feeds connect a bank once (via Plaid Link) and import transactions
automatically into the same staging table the CSV import uses, so the
match/resolve UI in Books → Bank import needs no changes.

## 1. Get Plaid credentials

1. Create an account at https://dashboard.plaid.com and make a new app.
2. Start in **Sandbox** (free, fake banks) — switch to Production later after
   Plaid approves your use case (business verification required).
3. Copy the **Client ID** and **Secret** (Sandbox secret to start).

## 2. Set environment variables

On the server (or `backend/.env`):

```bash
PLAID_CLIENT_ID=your_client_id
PLAID_SECRET=your_sandbox_secret
PLAID_ENV=sandbox            # sandbox | development | production
TOKEN_ENCRYPTION_KEY=<key>   # see below
PUBLIC_APP_URL=https://your-app.example.com   # so Plaid webhooks can reach you
```

Generate the encryption key (used to encrypt Plaid access tokens at rest —
**never commit it**):

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Without these keys, Books → Bank import shows setup instructions instead of
the Connect button. Nothing breaks — CSV import keeps working.

## 3. Webhooks (optional but recommended)

Plaid notifies `POST /api/bankfeed/webhook` when new transactions post
(`TRANSACTIONS` → `SYNC_UPDATES`). Configure the webhook URL in the Plaid
dashboard:

```
https://your-app.example.com/api/bankfeed/webhook
```

The endpoint only logs the event; the next sync (manual "Sync now" or a cron
hitting `POST /api/bankfeed/sync`) pulls the actual transactions.

## 4. Going to production

1. In the Plaid dashboard, request Production access and complete verification.
2. Set `PLAID_ENV=production` and swap in the production secret.
3. Rotate `TOKEN_ENCRYPTION_KEY` only when no connections exist (old tokens
   can't be decrypted with a new key — users would reconnect).

## Costs

- Plaid Sandbox: free.
- Plaid Production: usage-based pricing per connected account — check
  https://plaid.com/pricing and factor it into your plan pricing before
  promising "everything included."

## Security notes

- Access tokens are Fernet-encrypted in the `bank_connections` collection and
  never returned by the API (the status endpoint strips them).
- Plaid amounts use the opposite sign convention from this app's CSV import
  (Plaid: positive = money out). The sync code negates them — do not "fix"
  this without checking both flows.
