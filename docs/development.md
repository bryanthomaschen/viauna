# Development

You need Node.js 22.13 or newer, and Docker.

```bash
npm install
cp .env.example .env
npm run dev:mail      # a throwaway Dovecot + SMTP sink on localhost (any user, password "pass")
npm run seed          # fill alice@example.test with realistic sample mail
npm run dev           # http://127.0.0.1:5173: sign in as alice@example.test / pass
```

`npm run seed -- bob@example.test` seeds a second mailbox. Mail sent between them is
delivered for real, so you can watch live updates arrive.

```bash
npm run typecheck
npm test                  # unit tests
npm run test:integration  # end-to-end against the dev mail server
npm run build && npm start
```

### On PostgreSQL, MySQL and MariaDB

`npm test` checks the state store on SQLite. To check it on every engine, as CI does,
start throwaway databases and pass their URLs:

```bash
npm run dev:databases
export VIAUNA_TEST_PG=postgres://viauna:viauna@127.0.0.1:55432/viauna
export VIAUNA_TEST_MYSQL=mysql://viauna:viauna@127.0.0.1:53306/viauna
export VIAUNA_TEST_MARIADB=mariadb://viauna:viauna@127.0.0.1:53307/viauna
npm test
VIAUNA_TEST_DATABASE_URL=$VIAUNA_TEST_PG npm run test:integration   # end-to-end on one of them
```

The tests empty those databases, so don't point them at anything else.

How the pieces fit together is in [Architecture](./architecture.md). Before opening a pull
request, read
[CONTRIBUTING.md](https://github.com/bryanthomaschen/viauna/blob/main/CONTRIBUTING.md).

## Releasing

1. Set the new version in `package.json` and `package-lock.json`, and commit:
   `npm version 0.3.0 --no-git-tag-version` updates both.
2. Tag the commit and push the tag: `git tag v0.3.0 && git push origin v0.3.0`.

The [Release workflow](https://github.com/bryanthomaschen/viauna/blob/main/.github/workflows/release.yml)
then builds the image for `linux/amd64` and `linux/arm64`, publishes `0.3.0`, `0.3` and
`latest` to `ghcr.io/bryanthomaschen/viauna`, and creates the GitHub Release with notes
generated from the changes since the last one. It refuses a tag that doesn't match
`package.json`. Every push to `main` also publishes `edge`.

## These docs

The docs are the Markdown files in `docs/`, published to GitHub Pages with
[VitePress](https://vitepress.dev) on every push to `main`. Link between pages with
relative `.md` paths so they work on GitHub too. To preview your changes:

```bash
cd docs
npm install
npm run dev           # http://127.0.0.1:5173/viauna/
```
