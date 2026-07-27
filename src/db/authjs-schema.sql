-- Auth.js (@auth/d1-adapter) tables — vendored DDL.
--
-- The adapter's D1Adapter() runs raw SQL against these tables but does NOT
-- create them; you must run its `up()` migration once. Rather than call up() at
-- runtime, we vendor its `upSQLStatements` here so the tables are provisioned via
-- the same `wrangler d1 execute` flow as our own schema. Keep in sync with the
-- installed @auth/d1-adapter version (currently 1.11.2) if it bumps.
--
-- Apply locally: wrangler d1 execute platform-db --local  --file src/db/authjs-schema.sql
-- Apply remote:  wrangler d1 execute platform-db --remote --file src/db/authjs-schema.sql
--
-- NOTE: the adapter's `users` table is distinct from our app-level `app_users`
-- (see auth-schema.sql) — deliberately named apart to avoid a collision.

CREATE TABLE IF NOT EXISTS "accounts" (
    "id" text NOT NULL,
    "userId" text NOT NULL DEFAULT NULL,
    "type" text NOT NULL DEFAULT NULL,
    "provider" text NOT NULL DEFAULT NULL,
    "providerAccountId" text NOT NULL DEFAULT NULL,
    "refresh_token" text DEFAULT NULL,
    "access_token" text DEFAULT NULL,
    "expires_at" number DEFAULT NULL,
    "token_type" text DEFAULT NULL,
    "scope" text DEFAULT NULL,
    "id_token" text DEFAULT NULL,
    "session_state" text DEFAULT NULL,
    "oauth_token_secret" text DEFAULT NULL,
    "oauth_token" text DEFAULT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS "sessions" (
    "id" text NOT NULL,
    "sessionToken" text NOT NULL,
    "userId" text NOT NULL DEFAULT NULL,
    "expires" datetime NOT NULL DEFAULT NULL,
    PRIMARY KEY (sessionToken)
);

CREATE TABLE IF NOT EXISTS "users" (
    "id" text NOT NULL DEFAULT '',
    "name" text DEFAULT NULL,
    "email" text DEFAULT NULL,
    "emailVerified" datetime DEFAULT NULL,
    "image" text DEFAULT NULL,
    PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS "verification_tokens" (
    "identifier" text NOT NULL,
    "token" text NOT NULL DEFAULT NULL,
    "expires" datetime NOT NULL DEFAULT NULL,
    PRIMARY KEY (token)
);
