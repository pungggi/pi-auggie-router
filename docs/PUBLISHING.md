# Publishing `pi-auggie-router`

Tag-driven CI publish with npm provenance.

```bash
npm version patch -m "release: %s"   # or minor / major
git push origin main --follow-tags
gh run watch
```

## Auth (one-time) — Trusted Publisher / OIDC

1. npmjs.com → `pi-auggie-router` → **Settings → Trusted Publisher**
2. Add GitHub Actions:
   - **Organization or user:** `pungggi`
   - **Repository:** `pi-auggie-router`
   - **Workflow filename:** `release.yml`
3. Do **not** set an empty `NPM_TOKEN` secret (omit it for pure OIDC).

Fallback: Classic **Automation** token as `NPM_TOKEN` repo secret.

## Notes

- Manual `npm publish` is blocked (`prepublishOnly` requires `CI=1`).
- Build runs in CI before publish (`clean` + `tsc`).
