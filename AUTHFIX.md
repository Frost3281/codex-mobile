# Password authentication fix

This branch preserves the source of `0.1.91-authfix.1`, based on upstream
commit `4471750828acd26c73a8c95a0a733e9643609959` (version `0.1.91`).

When password protection is enabled, HTTP and WebSocket requests must have a
valid login session. Loopback addresses, localhost Host headers, and Tailscale
addresses no longer bypass authentication. Existing valid sessions can still
keep a browser signed in.

The upstream `--no-password` option still disables password protection. Do not
use it for remote access. This fix does not change the server's listening
address; restrict access with loopback binding or the host firewall as needed.

## Build

```sh
npm ci
npm run build:frontend
npm run build:cli
npm pack
```

`npm-shrinkwrap.json` records the dependencies used by the patched package.
The package keeps the upstream npm name; these instructions create a local
archive and do not publish to the upstream npm package.

## Regression coverage

`src/server/authMiddleware.test.ts` covers missing, forged, expired, and valid
session cookies across loopback, Tailscale, and other addresses, plus HTTP
login and WebSocket authorization. Run it explicitly when validating changes:

```sh
npm run test:unit -- src/server/authMiddleware.test.ts
```

Manual verification and cleanup instructions are in
[`tests/cli-network-platform/mandatory-ui-password.md`](tests/cli-network-platform/mandatory-ui-password.md).

This repository contains source and dependency metadata. Keep deployment
passwords, SSH keys, provider credentials, chat history, and server-specific
configuration outside the repository.
