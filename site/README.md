# GameNightly public site

The public website for **GameNightly**: the homepage, Privacy Policy, Terms of Service and logo. Google needs these to verify the OAuth consent screen for the bot's Google Calendar access (see [ryanhockstad/gamenight](https://github.com/ryanhockstad/gamenight) issues #2–#6).

Live: https://ryanhockstad.github.io/Gamenightly/

| Page | URL |
|---|---|
| Homepage | https://ryanhockstad.github.io/Gamenightly/ |
| Privacy Policy | https://ryanhockstad.github.io/Gamenightly/privacy.html |
| Terms of Service | https://ryanhockstad.github.io/Gamenightly/terms.html |
| Logo for the consent screen (120×120 PNG) | `assets/logo-120.png` |

## Files

- `index.html`, `privacy.html`, `terms.html`: plain HTML with no build step. The privacy and terms pages share one header and footer, so a nav change has to be made in both.
- `styles.css`: brand tokens copied from `web/src/styles.css`, plus the legal-page styles.
- `home.css`: homepage only (hero, scroll-driven core features, product cards). The homepage has its own header and footer.
- `assets/logo.svg`: the master logo. `logo-120.png` (Google consent screen) and `logo-512.png` (Discord app icon / social) are exported from it.

## Keep in sync with the code

The privacy policy and the homepage's "Find the overlap" and "Lock it in" steps describe exactly what the bot does with Google Calendar. When any of these change, update them:
Code in [ryanhockstad/gamenight](https://github.com/ryanhockstad/gamenight):
- `SCOPES` in `src/oauth_server/src/oauth_server/google.py`
- what's stored in Redis (`storage.py`, `services/store.py`)
- retention: `SESSION_TTL_SECONDS` in `services/sessions.py` (14 days), and the web app's 30-day session expiry

## Run locally

```bash
cd site && python3 -m http.server 8000
```

Then open http://localhost:8000.

## Deploy

`.github/workflows/pages.yml` publishes `site/` to GitHub Pages when `site/` changes on `main`, usually within a minute. The app in `web/` deploys to Cloudflare separately.

One-time setup: in the repo's Settings → Pages, set **Source** to **GitHub Actions**.

## Re-export the logo PNGs

```bash
for n in 120 512; do
  printf '<html><body style="margin:0;background:transparent"><img src="file://%s/assets/logo.svg" width="%s" height="%s" style="display:block"></body></html>' "$PWD" $n $n > /tmp/r$n.html
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --allow-file-access-from-files --window-size=$n,$n \
    --screenshot="$PWD/assets/logo-$n.png" "file:///tmp/r$n.html"
done
```

## Open TODOs

- Fill in `[CONTACT EMAIL — TODO]` (all three pages) and `[STATE — TODO]` (terms).
- Google usually wants the homepage on a domain you own and verify in Search Console. Plan to buy one (e.g. `gamenightly.app`) and point Pages at it before submitting for verification.
- These policies were drafted from the code as of 2026-10-06. They aren't legal advice; have them reviewed before launch.
