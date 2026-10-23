# Contributing

The project uses MIT; included Fast-browser-link copies and adaptations are covered by the permission recorded in LICENSE, NOTICE and extension/vendor/fbl/LICENSE. The public release is being prepared. Use synthetic fixtures, not your customer data, in proposed changes.

## Development

Python 3.11+ is the runtime dependency. Node and Playwright are development-only dependencies. Install the locked dependencies with `npm ci`, then install Chromium using `npx playwright install chromium`. E2E media fixtures also need ffmpeg. Browser tests run headful and require a graphical session; Linux headless CI needs its own verified display setup.

```sh
BK_PROTECT_REAL=1 python3 -m unittest
node --test extension/tests/*.test.cjs
node --input-type=module --check < extension/background.js
node --test --test-concurrency=1 extension/e2e/*.test.mjs
npm run vendor:check
```

E2E owns ports18790/18801/18802 and uses private temporary data. Stop the local demo preview before E2E; never stop a process you do not own. For legacy real-data protection use `BK_REAL_DATA_DIR=/absolute/path/to/private/data` together with `BK_PROTECT_REAL=1`. Do not run tests against business assets.

Add a failing regression before fixing a matcher or restoration bug. Cover controlled-field rollback, ambiguous options, products sharing a URL, changed media, missing frames and unknown submission outcomes. Browser-side DOM agreement is not proof that the target platform accepted a submission.

## Assets and docs

`extension/icons/mark.svg` is the logo source. `node tools/make-icons.mjs` renders PNG sizes; `node tools/brand-preview.mjs` renders the design board. Never replace real browser acceptance with the brand board.

Update README, capabilities and installation instructions when behavior changes. Vendor files remain pinned; `npm run vendor:check` validates local hashes. Set `FBL_DIR=/path/to/native-extension` only when deliberately comparing or synchronizing an authorized upstream.

Use the public package builder to inspect candidate contents. Never commit personal config, product packages, generated snapshots, credentials or private evidence. A gitignore entry is not a historical secret-removal procedure.
