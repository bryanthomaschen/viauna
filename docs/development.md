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

How the pieces fit together is in [Architecture](./architecture.md). Before opening a pull
request, read
[CONTRIBUTING.md](https://github.com/bryanthomaschen/viauna/blob/main/CONTRIBUTING.md).

## These docs

The docs are the Markdown files in `docs/`, published to GitHub Pages with
[VitePress](https://vitepress.dev) on every push to `main`. Link between pages with
relative `.md` paths so they work on GitHub too. To preview your changes:

```bash
cd docs
npm install
npm run dev           # http://127.0.0.1:5173/viauna/
```
