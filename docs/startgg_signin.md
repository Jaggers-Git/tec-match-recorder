# start.gg sign-in for stations

Research note, 2026-11-09. Question: can the recorder get its start.gg token by itself, the way v1.6.0 reads the OBS WebSocket password from the PC? Nothing below is built or registered.

## Recommendation

Feasible in part, and not worth building yet. start.gg does offer "Sign in with start.gg" (OAuth), and any account can register an app in Developer Settings with no review. Every sign-in and every weekly refresh needs the app's client secret, though, and start.gg has no secret-free option (no PKCE, no public clients). A secret in this public MIT repo is a public secret, so a real sign-in button needs somewhere private to keep it.

For now, keep the pasted personal token, which lasts a year and is already checked the moment it is pasted. Add a reminder before it expires. If TOs outside TEC start to struggle with the paste step, build sign-in through a small TEC-hosted token exchange (option 4 below) that holds the secret, after a 15-minute test with a throwaway app.

## What start.gg offers (checked 2026-11-09)

| Point | Finding | Source |
|---|---|---|
| Registration | Developer Settings, **OAuth Applications** tab, **Create OAuth Client**. Self-serve on any account, with no review step. The form has four fields: Application Name, Application Description, Application URL, Application Authorization Callback (one URL) | Developer Settings page, read in Chrome |
| Client type | The form has no scope picker and no public or confidential choice | Same |
| Grant types | Authorization code and refresh token only | [OAuth overview](https://developer.start.gg/docs/oauth/oauth-overview) |
| Scopes | `user.identity`, `user.email`, `tournament.manager`, `tournament.reporter`. None of them is described as reading public brackets; the docs don't say whether a `user.identity` token can read events and sets the way a personal token can | [Scopes](https://developer.start.gg/docs/oauth/scopes) |
| Client secret | Required on the code exchange and on every refresh. PKCE is not documented, and both libraries checked (Arctic, Laravel Socialite) send the secret and do no PKCE | OAuth overview; [Arctic](https://v2.arcticjs.dev/providers/startgg); [Socialite](https://github.com/SocialiteProviders/StartGg/blob/master/Provider.php) |
| Endpoints | Authorize `https://start.gg/oauth/authorize`; token `https://api.start.gg/oauth/access_token` (JSON body); refresh `https://api.start.gg/oauth/refresh`. No discovery document (`.well-known` paths return 404) | OAuth overview; probe |
| Token lifetime | The example response has `expires_in: 604800` (7 days). Refresh-token lifetime and rotation are not documented. Personal tokens last 1 year | OAuth overview; [Authentication](https://developer.start.gg/docs/authentication) |
| Rate limits | 80 requests per 60 seconds on average, 1000 objects per request, with no separate figure for OAuth tokens. The API terms let start.gg limit "the number of users you may serve, one token per product" | [Rate limits](https://developer.start.gg/docs/rate-limits); [API terms](https://www.start.gg/about/apitos) |
| Localhost callback | Not documented either way. One callback URL per app | Docs; registration form |
| Revoking access | Apps a user has approved are listed under Developer Settings, **Third Party Access Tokens**, where the user can delete them | Developer Settings page |
| API terms | No mention of client secrets, credentials or OAuth. They ask for the minimum permissions an app needs and "appropriate protections" for the app | API terms |

A probe of the token endpoint with dummy values returned HTTP 401 `invalid_client`, "Client authentication failed", which matches the PHP League OAuth2 server's wording. That server skips the secret only for clients registered as public, and start.gg's form offers no way to register one. A Vercel forum post claims start.gg supports PKCE, but the token URL it gives (`/oauth/token`) returns 404, so I don't rely on it.

As far as the docs say, the limits are the same for both kinds of token, so sign-in would not change how often the recorder polls. Today it pages through each event's sets 40 at a time, every 45 seconds by default.

## Why the secret matters here

Anything in this repo or its release zip is public. With the secret, anyone could run a sign-in that shows "TEC Match Recorder" on start.gg's consent page. If start.gg revokes or rotates a leaked secret, sign-in and the weekly refresh stop on every station at once. start.gg's terms don't forbid shipping a secret outright, but they hold the app owner (Aaron or TEC) responsible for protecting the app.

## Options

1. **Keep the paste, add an expiry reminder (recommended now)**: Save the date the token was saved (`startgg.tokenSavedAt`). From 11 months on, the setup checklist and Settings show "Your start.gg token runs out around <date>: make a new one". This is a small change and needs no registration.
2. **Ship the secret in the repo or release**: This is the least code, but the secret becomes public. Not recommended.
3. **Secret on TEC stations only**: Aaron puts the client ID and secret in each TEC PC's `data/config.json` (gitignored) as `startgg.app`, and Settings shows the sign-in button only when it is there. It helps only PCs that Aaron already sets up himself, where pasting a token once a year is no burden, so the gain is small. Every station must also keep port 8420, because the app has a single callback URL.
4. **TEC-hosted token exchange**: A small Cloudflare Worker on a texasesports.org subdomain holds the secret. start.gg calls back to the Worker, which exchanges the code and posts the tokens back to the station on localhost. Refreshes also go through the Worker every week. This works for any TO on any port. The cost is one more service for TEC to keep running, and every station's weekly refresh depends on it. The free tier covers this volume.

## Sketch of the change (options 3 or 4)

Settings gets a **Sign in with start.gg** button beside today's token field, and the paste field stays as the fallback.

1. `GET /api/startgg/oauth/start` makes a random `state`, holds it in memory for 10 minutes, and redirects the browser to `https://start.gg/oauth/authorize?response_type=code&client_id=…&scope=user.identity&redirect_uri=…&state=…`. `user.identity` is the minimum scope, and the terms ask for the minimum.
2. On start.gg, the operator signs in and approves.
3. `GET /api/startgg/oauth/callback` checks `state` and gets the tokens: under option 3 it exchanges the code itself with the local secret, and under option 4 it receives them from the Worker as a form POST, which keeps them out of browser history. It saves them, runs the same `currentUser` query as `POST /api/startgg/check-token`, and returns to Settings with "Signed in as <gamerTag>".
4. Before each sync, if `expiresAt` is less than a day away, refresh. On an auth error, refresh once, and if that fails, show "Sign in to start.gg again" in the setup checklist.

Storage stays in `data/config.json`, which is already gitignored. `startgg.token` remains the token that `gql()` sends, so the sync, import and logo code don't change:

```json
"startgg": {
  "token": "<access token>",
  "auth": "oauth",
  "refreshToken": "<refresh token>",
  "expiresAt": "2026-11-16T15:00:00Z",
  "eventUrls": ["…"],
  "pollSeconds": 45
}
```

`auth` is `"personal"` for a pasted token. Two places in `server.js` need care:

- `publicConfig()` spreads `...cfg.startgg` into the dashboard state and blanks only `token`. It must blank `refreshToken` too, or the dashboard receives it.
- `updateConfig()` drops an empty incoming `token` so a save keeps the old one. A Settings save must also keep `refreshToken` and `expiresAt`, and pasting a personal token must clear them and set `auth` back to `"personal"`.

## Before building: a 15-minute test

Registering the app is an outward step and Aaron's call. Once a throwaway app exists, a short local script answers what the docs leave open:

- Does start.gg accept `http://localhost:8420/api/startgg/oauth/callback` as the callback?
- Can a `user.identity` token run the recorder's bracket query on a public event?
- What `expires_in` comes back, and does a refresh return a new refresh token?
- Does a code exchange with no secret and a PKCE `code_verifier` get turned down (confirming there is no public-client path)?

Steps for Aaron:

1. Open https://www.start.gg/admin/profile/developer, then the **OAuth Applications** tab, then **Create OAuth Client**
2. Name: `TEC Match Recorder test`; Application URL: `https://github.com/Jaggers-Git/tec-match-recorder`; Callback: `http://localhost:8420/api/startgg/oauth/callback`
3. Save, then put the client ID and secret in a file outside the repo, such as `Downloads\startgg_test_app.json` (never in chat or git)
4. Delete the test app from the same tab when the test is done
