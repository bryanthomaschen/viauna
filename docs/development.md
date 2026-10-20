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

`npm run cli -- admin add alice@example.test` makes alice an admin of your dev server
(open `/admin`); `npm run cli -- settings` lists every setting. It's the
[`viauna` command](./self-hosting/admin.md#the-command-line), run from source.

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
export VIAUNA_TEST_LDAP=ldap://127.0.0.1:53389   # password changes over LDAP
npm test
VIAUNA_TEST_DATABASE_URL=$VIAUNA_TEST_PG npm run test:integration   # end-to-end on one of them
```

The tests empty those databases, so don't point them at anything else.

How the pieces fit together is in [Architecture](./architecture.md). Before opening a pull
request, read
[CONTRIBUTING.md](https://github.com/bryanthomaschen/viauna/blob/main/CONTRIBUTING.md).

## Releasing

Changes land on `main` as they're ready, and every push publishes the `edge` image.
Releases come in batches: one when a batch on the [roadmap](./roadmap.md) is done, or a
patch release for fixes. Each change people will notice adds a line under
**Unreleased** in [CHANGELOG.md](https://github.com/bryanthomaschen/viauna/blob/main/CHANGELOG.md)
as it lands, so the notes are written by release time. To cut release X.Y.Z:

1. In `CHANGELOG.md`, rename `## Unreleased` to `## X.Y.Z - YYYY-MM-DD` and put a new,
   empty `## Unreleased` above it. Edit the entries into release notes: that section
   becomes the GitHub Release text as written.
2. Set the version: `npm version X.Y.Z --no-git-tag-version` updates `package.json` and
   `package-lock.json`.
3. Bring the docs up to date: image tags (`ghcr.io/bryanthomaschen/viauna:X.Y`) and the
   tag table in [Getting started](./self-hosting/getting-started.md#image-tags); a
   "From … to X.Y" section in [Upgrading](./self-hosting/upgrading.md) if anything needs
   doing; and take the batch off the roadmap.
4. `npm run check:release` checks that the version, the changelog and the docs agree.
   Commit as "Release X.Y.Z", push to `main` and wait for CI.
5. Tag that commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The [Release workflow](https://github.com/bryanthomaschen/viauna/blob/main/.github/workflows/release.yml)
then builds the image for `linux/amd64` and `linux/arm64`, publishes `X.Y.Z`, `X.Y` and
`latest` to `ghcr.io/bryanthomaschen/viauna`, starts it on both, creates the GitHub
Release from the changelog section, and last publishes these docs. It publishes nothing
if the tag, `package.json`, the changelog and the docs disagree.

## These docs

The docs are the Markdown files in `docs/`, built with [VitePress](https://vitepress.dev).
The site describes the latest release, so it's published to GitHub Pages only when a
release is tagged; on `main`, the docs describe the next release. Pushes and pull
requests still build it, so a broken link fails the check. Link between pages with
relative `.md` paths so they work on GitHub too. To preview your changes:

```bash
cd docs
npm install
npm run dev           # http://127.0.0.1:5173/viauna/
```
