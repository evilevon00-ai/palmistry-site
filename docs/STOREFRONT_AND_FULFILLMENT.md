# Storefront and fulfillment

## Review scope and identity

- Mission: `palmistry-production-2026-09-14`.
- Work item: `palmistry-121-storefront-funnel-007` (issue #121).
- Attempt: `e8c1a931-b397-425e-bb71-7301de1fc093`.
- Designated branch: `corp-ops/attempt/e8c1a931-b397-425e-bb71-7301de1fc093`.
- Ownership generation: `1`.
- Status: proposed repository diff; incomplete asset requirement and unverified build. No checkout, Git state, commit, push, deployment, or live fulfillment was verified.

## Repository implementation

`src/products.ts` is the single source for the three approved offers, prices in USD, purchase CTA labels, and Stripe Payment Links. `ProductCard.astro` renders those values on `/store/` and `/guide/thank-you/`. There are no other paid offers in this catalog. No paid content, product-detail promises, or source attributions are added.

The guide is presented as the Quick Start Guide. Its existing Kit endpoint, email field, submission behavior, download filename, PDF URL, cover art, and lesson links remain intact. Copy explains the retained Starter Guide name in the existing PDF/email. The thank-you page retains its noindex and Pagefind exclusion attributes. Header navigation gains one Store link.

`/order/success/` and `/order/error/` are static, noindex utility pages with `data-pagefind-ignore`. They never confirm payment, read a session identifier, unlock content, or report a purchase event. Direct access to either URL grants nothing.

## Blocked requirements and validation

The supplied context contains no source bytes or source paths for the three approved emblem SVGs. Consequently, this diff does not create `src/assets/store/emblem-journal.svg`, `src/assets/store/emblem-handbook.svg`, or `src/assets/store/emblem-quickstart.svg`, and does not reference missing assets. Completing the asset requirement needs the approved originals, copied byte-for-byte and compared by hash; substitute or regenerated artwork is not authorized.

The environment is read-only with no shell, and the task permits only supplied context. Git startup/synchronization, patch application, production build, audits, and browser inspection could not run. A passing production build is not claimed.

Before accepting this patch, an authorized implementation environment must run `git diff --check`, `npm run build`, `npm run content-audit`, and `npm run audit:all`; inspect all five affected page routes and header navigation at mobile and desktop widths; verify keyboard focus and checkout destinations; and exercise Kit success, failure, and direct-download behavior without changing the integration.

The supplied changelog describes a centralized indexability policy outside this task's allowed paths. Its current implementation was not supplied. Verify that both new order routes are excluded from sitemap and Pagefind output and accepted by the indexability audit. If that requires policy/configuration changes, those changes require a separate authorized scope; do not weaken the audit or remove noindex to obtain a pass.

## Future secure fulfillment design — not implemented

Keep paid files in private object storage, outside `public/`, source assets imported into the site, and generated output. A separately authorized server-side fulfillment service should verify Stripe webhook signatures against the raw request body, enforce timestamp tolerance, and confirm the expected account and live/test environment.

Resolve purchased line items against a server-controlled allowlist of Stripe Price IDs and entitlements. Verify payment is actually paid, including delayed-payment outcomes, before granting access. Never derive entitlement from the return URL, a browser-provided product/price, or an unverified checkout session identifier.

Persist webhook event deduplication and order entitlement atomically. Queue delivery with retries and an auditable failure state; duplicate or out-of-order events must not duplicate grants or emails. Establish refund/dispute revocation and support recovery policies before launch. Deliver short-lived signed download URLs only after authorization, with expiry, rate limits, and a secure reissue flow. Avoid customer data and bearer download tokens in logs or analytics.

Suggested future server-only environment placeholders: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_JOURNAL`, `STRIPE_PRICE_ID_HANDBOOK`, `STRIPE_PRICE_ID_BUNDLE`, `FULFILLMENT_DATABASE_URL`, `PRIVATE_STORAGE_BUCKET`, `PRIVATE_STORAGE_ENDPOINT`, `PRIVATE_STORAGE_ACCESS_KEY_ID`, `PRIVATE_STORAGE_SECRET_ACCESS_KEY`, `DELIVERY_EMAIL_API_KEY`, `DELIVERY_EMAIL_FROM`, and `DOWNLOAD_SIGNING_SECRET`. `SITE_ORIGIN` should hold the verified canonical HTTPS origin. These names are documentation only; no values or environment files are introduced. Never expose secrets through `PUBLIC_` variables or client bundles.

## Redirect and deployment notes

After separate approval and verification of the production origin, the intended post-payment destination for each approved Payment Link is `${SITE_ORIGIN}/order/success/`. The help/error destination is `${SITE_ORIGIN}/order/error/`. These are configuration templates, not literal dashboard values. No session query parameter is needed by these static pages.

Stripe dashboard configuration and its supported cancellation/error behavior were not inspected or changed. Do not assume Payment Links support a configurable error redirect; verify the supported behavior before wiring one. The error page can serve as a help destination without claiming an automatic redirect exists.

The storefront requires no new runtime secrets, dependencies, analytics vendor, webhook, or server route. Existing tracking attributes identify CTA clicks only and are not proof of payment.

Before any separately authorized release, verify checkout prices/currency against the catalog, receipt/support information, existing fulfillment for all three offers, and delivery recovery. The new pages implement no fulfillment, so they are not evidence that delivery works. Confirm that build output contains no paid files or secrets and that utility-route exclusions hold. Preserve independent review, exact-SHA merge controls, protected-write restrictions, and human deployment/account gates.
