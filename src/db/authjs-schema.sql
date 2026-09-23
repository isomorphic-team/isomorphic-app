-- Auth.js (@auth/d1-adapter) tables — vendored DDL.
--
-- The adapter's D1Adapter() runs raw SQL against these tables but does NOT
-- create them. Rather than call its `up()` at runtime, we vendor its
-- `upSQLStatements`; migrations/0001_init.sql creates the tables. Keep in sync
-- with the installed @auth/d1-adapter version (vendored from 1.11.2) if it bumps: a
-- change lands as a new migration.
--
-- REFERENCE ONLY: the current shape, gathered in one place for reading. The
-- canonical schema is `migrations/` (wrangler's migrations framework): apply it
-- locally with `pnpm db:migrate`; the deploy workflow applies it to the remote
-- database. Never apply this file to a database.
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
