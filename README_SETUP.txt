MR.DooD QR HUNT v2 - SETUP, SECURITY AND TEST NOTES
====================================================

IMPORTANT: this is a NEW build, not an in-place upgrade. The original ZIP was never
received, so nothing was migrated from it. Old player data, old QR codes and your real
letter images are NOT included. Replace private/img/1.jpg ... 7.jpg with your own images
(placeholders are included). Order: 1=M 2=r 3=. 4=D 5=o 6=o 7=D.

1. RUN LOCALLY
   npm install
   ADMIN_PASSWORD='choose-a-long-password' PUBLIC_URL='http://localhost:3000' npm start
   Player game: http://localhost:3000/     Admin: http://localhost:3000/admin
   If ADMIN_PASSWORD is not set, a random super-admin password is printed ONCE in the log.

2. ENVIRONMENT VARIABLES
   PORT                      HTTP port (default 3000; Render sets it)
   PUBLIC_URL                Public https URL of the site. Embedded in every QR code.
                             Set it BEFORE printing. (Without it the request Host header is used.)
   ADMIN_USER                First super admin username (default "admin"). First boot only.
   ADMIN_PASSWORD            First super admin password. First boot only.
   UPSTASH_REDIS_REST_URL    } Persistent storage. If both are set, the whole game state is stored
   UPSTASH_REDIS_REST_TOKEN  } in Upstash Redis. Otherwise a JSON file in DATA_DIR is used.
   STATE_KEY                 Redis key (default dood:state:v1)
   DATA_DIR                  Folder for state.json in file mode (default ./data)
   TRUST_PROXY               "0" to ignore X-Forwarded-For (default: trusted; Render needs it)

3. DEPLOY ON RENDER
   a. Push this folder to GitHub and create a Blueprint from render.yaml (or a Web Service:
      build "npm install --omit=dev", start "npm start", health check /healthz).
   b. Create a free Upstash Redis database; copy its REST URL and token into the two UPSTASH_*
      variables. Render's disk is ephemeral: WITHOUT Upstash every restart or redeploy deletes
      players, winners, QR tokens and admins.
   c. Set PUBLIC_URL to your final https address and set ADMIN_PASSWORD, then deploy.
   d. Open /admin, sign in, go to QR Management and print the sheet AFTER PUBLIC_URL is final.
   Free Render instances sleep when idle; the first scan after a sleep is slow.
   Run exactly one instance (state is a single document; do not scale horizontally).

4. ROLES (enforced server-side on every request)
   Super Administrator  everything (QR, settings, admins, reset, backup, audit)
   Game Manager         stats, live activity, players, winners, pause/resume, scan restrictions.
                        No QR access unless a super admin ticks "Allow QR Management" for them.
   QR Manager           QR Management only (generate, regenerate, revoke, on/off, labels, downloads)

5. HOW QR SECURITY WORKS
   - Exactly 7 slots, created by the server. Letters are fixed in code (M r . D o o D).
   - Each QR holds https://YOUR-SITE/s/<192-bit random token>. Only the server knows the tokens.
   - Scans are validated by the server against the 7 stored tokens (constant-time comparison).
     The browser can never submit a letter or QR number; such requests are rejected.
   - Regenerate / revoke / reset-all replaces or destroys the token at once: old printed codes die.
   - Label and notes are editable; the letter mapping is not.
   - Letter images are served only after the player scanned that slot. Images are not in /public.
   - Tokens never appear in player pages, public APIs, dashboard, settings, activity or audit data.
     They exist as images only inside QR Management (permission "qr") and inside backups.
   - The token is removed from the address bar right after the page loads, server logs redact
     /s/<token>, and the page is sent with Referrer-Policy: no-referrer.
   Players need cookies: progress is tied to a secure cookie in the browser that registered.
   If a phone's camera app opens links in a different browser than the one used to register,
   the player must register again there. Tell players to scan with the same browser.

6. OTHER SECURITY MEASURES
   scrypt password hashing; HttpOnly + SameSite cookies (Secure on https); CSRF token on every
   admin write; sliding session expiry; rate limits (login, registration, scans, answers);
   lockout after wrong answers; suspicious-scan flags; strict CSP and security headers; audit log
   of admin actions and denied requests; no stack traces in responses; request size limits.
   Limits: rate-limit counters and admin sessions are in memory (a restart signs admins out).
   Registrations are capped at 60 per 10 min per IP so a venue sharing one Wi-Fi still works.
   Backups contain QR tokens and password hashes: keep them private.

7. WINNER RULES
   Position is assigned atomically when the correct word is accepted. Claim codes look like
   DOOD-ABCD2345. Positions are permanent: removing a winner later does not shift other positions.
   "Prize positions" (0 = unlimited): later finishers still finish but are flagged "no prize".

8. DEPENDENCY
   qrcode 1.5.4 (npm) generates QR images. Nothing else beyond Node >= 20.

9. FILES (all new)
   server.js, package.json, package-lock.json, render.yaml, README_SETUP.txt, .gitignore
   public/index.html, public/admin.html
   public/assets/game.js, style.css, admin.js, admin.css, sheet.js, sheet.css
   private/img/1.jpg ... 7.jpg (placeholders)
   tests/test.js

10. TEST RESULTS (what was actually run, in the build sandbox)
   npm test: 15 integration tests, all passing. They cover: health and static files; private files
   and path traversal blocked; no tokens in public data; registration validation and duplicate names;
   admin login, CSRF, logout; role permissions through direct API calls (3 roles); Settings and
   dashboard contain no QR data; scans of slots 1-7; forged, modified, fabricated, array and object
   tokens rejected; image gating; duplicate scans do not add progress; regenerate / revoke /
   deactivate invalidate old tokens; letter mapping immutable and exactly 7 slots; wrong and correct
   secret word; answer lockout; concurrent winners get distinct positions and claim codes;
   pause/resume; disqualify / reset / remove player; game reset; suspicious detection; audit log;
   backup and restore; persistence across a restart; session expiry; login rate limiting.

   A headless Chromium run (ad-hoc script, not shipped) walked: welcome, register, scan via /s/ link,
   reveal animation, invalid-QR screen, all 7 letters, wrong then right secret word, winner screen;
   all 7 admin views loaded; QR previews rendered; Settings tabs showed no QR images; the mobile
   admin menu opened. No JavaScript errors were seen.

   NOT tested: real phone cameras and real iOS/Android browsers; a live Render deploy; a live Upstash
   database (written, but only file mode was exercised); ntfy/Telegram delivery; browser notification
   and sound behaviour; load with hundreds of players; Safari/Firefox rendering; animation smoothness
   on mid-range phones. Test these before the event: scan a printed sheet with an iPhone and an
   Android phone.
