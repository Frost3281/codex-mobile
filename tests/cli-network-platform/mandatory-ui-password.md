# Mandatory UI password on loopback, proxies and Tailscale

This authfix replaces the address-trust behavior documented in the older Tailscale and reverse-tunnel test cases. Tunnel discovery behavior is unchanged.

## Setup

- Build/install 0.1.91-authfix.1; password protection must be enabled.
- Start the installed CLI with --no-tunnel --no-login --no-open --password TEST_PASSWORD on an unused test port.
- Use fresh browser cookies or HTTP clients with no cookie jar. Do not use /password= auto-login URLs.

## Actions and expected results

1. Request /codex-local-file with no cookie through localhost, SOCKS and Tailscale. Expect login HTML, not file data (login page has HTTP 200).
2. Upgrade /codex-api/ws without a cookie or with portal_session=forged. Expect HTTP 401, not a WebSocket connection.
3. POST /auth/login with a wrong password. Expect 401 with no session cookie.
4. POST the correct password. Expect 200, {ok:true} and portal_session cookie.
5. Request / with that cookie. Expect the SPA. Upgrade /codex-api/ws with the cookie. Expect 101 and the ready message.
6. Repeat from a new client without the cookie. Expect login again.
7. Run src/server/authMiddleware.test.ts: IPv4/IPv6 loopback, mapped loopback, Tailscale IPv4/IPv6/mapped, other remote, forged/expired/valid cookies and expiry after creation must pass.

## Cleanup / rollback

Stop only the temporary test process and remove its isolated session store. Do not alter production 5577, reverse SSH, CLIProxyAPI or MTProto. Deployment rollback should stop the UI and leave it stopped if reverting to an unfixed build.
