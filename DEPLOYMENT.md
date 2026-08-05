# Sticker Book deployment

This package contains the complete Sticker Book website, account flow, and database schema.

## What is included

- Sign in with ChatGPT for public user accounts
- A separate sticker collection for each signed-in user
- Saved album progress, missing stickers, and extras
- Saved trade baskets and trade history
- Cloudflare D1 database schema and migrations
- Cloudflare Worker-compatible production build

## Before you begin

Install Node.js 22 or newer, Git, and the Cloudflare Wrangler command line tool. You will also need a GitHub account and a Cloudflare account.

## 1. Put the project on GitHub

1. Unzip this package.
2. Create a new empty GitHub repository named `sticker-book`.
3. Open a terminal in the unzipped folder.
4. Run:

```bash
npm install
git init
git add .
git commit -m "Initial Sticker Book app"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

Replace `YOUR_GITHUB_REPOSITORY_URL` with the URL shown by GitHub.

## 2. Create the Cloudflare database

Run:

```bash
npx wrangler login
npx wrangler d1 create sticker-book-db
```

Cloudflare will return a database ID. Add a D1 binding named `DB` to your Cloudflare Worker or Pages project and select the new `sticker-book-db` database.

Apply the included migrations in order:

```bash
npx wrangler d1 migrations apply sticker-book-db --remote
```

## 3. Connect GitHub to Cloudflare

1. In Cloudflare, create a Workers and Pages application.
2. Choose to import an existing Git repository.
3. Select the `sticker-book` repository.
4. Use `npm run build` as the build command.
5. Use `dist` as the output directory when Cloudflare asks for one.
6. Confirm that the D1 binding is named `DB`.

## Important account note

The included account flow uses Sign in with ChatGPT. The Sites version handles this sign-in path automatically. If you deploy the project directly to your own Cloudflare account, you must configure a supported public identity provider or keep the app on Sites for the current ChatGPT sign-in flow. Do not store passwords in the D1 database.

## Verify before launch

Run these checks locally:

```bash
npm test
```

The test command builds the production Worker and checks the sticker catalog.
