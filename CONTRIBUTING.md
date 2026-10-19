# Contributing to Viauna

Thanks for helping. Bug reports, fixes and features are all welcome.

## Getting set up

See "Development" in the [README](README.md). In short: `npm install`,
`npm run dev:mail`, `npm run seed`, `npm run dev`, and sign in as
`alice@example.test` / `pass`.

The dev mail server accepts **any** username with the password `pass` and allows
plaintext logins. Its ports are bound to `127.0.0.1` on purpose; keep it that way.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run test:integration   # needs `npm run dev:mail` running
```

- Keep changes focused; one feature or fix per PR.
- Add a test for anything in `server/mail/` or `server/imap/`: unit tests for pure
  logic, `test/integration.test.ts` for anything that talks IMAP.
- Anything touching `server/mail/render.ts`, `server/crypto.ts`, `server/auth.ts` or the
  CSP/headers in `server/app.ts` gets extra review. Explain the threat you considered.
- The UI follows Gmail's interaction model. If you change a behaviour, say what Gmail
  does and why Viauna should differ.
- A feature that relies on anything outside Viauna (a database, an account system, a
  sync server) follows [Backends and lock-in](docs/architecture.md#backends-and-lock-in):
  a standard protocol where one exists, a default that needs no setup, and vendor APIs
  only as optional drivers.
- Anything people will notice (a feature, a setting, a changed behaviour, a new
  requirement) updates the docs in `docs/` in the same pull request. Preview them with
  `cd docs && npm install && npm run dev`.
- Don't add Google's logos, the Google Sans font or other Google brand assets.

## Licence

By contributing you agree your work is released under the
[AGPL-3.0](LICENSE), the project's licence.
