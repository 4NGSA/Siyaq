# Siyaq

AI-powered customer intelligence platform that unifies interaction history
across channels and generates a briefing report before each conversation.

## Run locally

Siyaq is a static application with no build step or package installation:

```sh
python3 -m http.server 4173
```

Open `http://127.0.0.1:4173`.

## Production setup

1. Run [`supabase/optimizations.sql`](supabase/optimizations.sql) in the
   Supabase SQL editor.
2. Deploy [`worker/siyaq-proxy.js`](worker/siyaq-proxy.js) as the AI proxy and
   configure the environment values documented at the top of that file.
3. Set the deployed application origin in the Worker's `ALLOWED_ORIGINS`
   variable.

The browser Supabase key is a publishable key, not a server secret. Never place
a Supabase service-role key or AI provider key in browser code.

## Verification

Run the dependency-free project checks:

```sh
node scripts/verify.mjs
```
