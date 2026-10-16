# Security policy

Wren handles people's mailboxes; we take vulnerabilities seriously.

## Reporting

Please **don't open a public issue**. Use GitHub's private vulnerability reporting
("Security" tab → "Report a vulnerability") on this repository. Include steps to
reproduce, affected versions, and the impact you expect. We aim to acknowledge reports
within three working days.

## Scope

In scope, for example:

- script execution or data exfiltration through a crafted email (HTML, CSS, headers,
  attachments, MIME structure);
- bypassing the remote-content block (tracking that fires before the user allows it);
- CSRF, session fixation/hijacking, credential recovery from the database;
- SSRF through server settings, cross-account access between sessions.

Out of scope: vulnerabilities in your IMAP/SMTP server, missing hardening headers on
your reverse proxy, and attacks requiring a compromised browser.

## Supported versions

Security fixes go into the latest release.

See [docs/architecture.md](docs/architecture.md#security-model) for the security model.
