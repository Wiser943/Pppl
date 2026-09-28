# MongoDB Setup

## Configure

Set these values in Netlify's environment settings. Do not commit a populated `.env` file.

- `MONGODB_URI`: Atlas connection string. Use a replica set deployment because wallet operations use transactions.
- `MONGODB_DB_NAME`: optional; defaults to `viral_play`.
- `JWT_SECRET`: random secret with at least 32 characters.
- `GOOGLE_CLIENT_ID`: OAuth client ID with the production site origin authorized.
- `ADMIN_EMAILS`: comma-separated email allowlist for admin sessions.
- `ADMIN_EMAIL`: dedicated Mongo admin panel login email.
- `ADMIN_PASSWORD`: dedicated Mongo admin panel login password.
- `SITE_ORIGIN` and `ADMIN_ORIGIN`: exact browser origins used by the site and separate admin panel.
- Payment settings: `MERCHANT_ID`, `DEPOSIT_KEY`, and `KORAPAY_SECRET_KEY`. `WEBSHARE_PROXY_URL` is optional.

Use `.env.example` as the variable checklist. The repository does not include real credentials.

## Seed Products And Settings

Copy `mongo-seed.example.json` to `mongo-seed.json`, then add the approved product catalog. Each product needs a unique `id`, `name`, positive `price`, positive `dailyIncome`, and positive `cycle`. The sample settings preserve the application's existing defaults; review them before running the seed.

With `MONGODB_URI` and optional `MONGODB_DB_NAME` set in the shell, run:

```powershell
npm run seed:mongodb -- .\mongo-seed.json
```

The seed command upserts only products listed in the file and the `globals`, `rates`, and `settings` documents. It does not delete other products or touch user documents. User accounts are new; no Firebase user data is imported.

## Admin Panel

The separate admin panel is not part of this workspace. It must use the Mongo auth session and send `Authorization: Bearer <token>` when requesting impersonation or a Korapay payout. Admin access is determined by `ADMIN_EMAILS`, not a caller-supplied user ID.

## Verification Limit

Source syntax and unauthenticated-route checks can run locally without credentials. A live sign-in, wallet, gateway, or webhook test requires the Netlify environment variables and a seeded catalog.
