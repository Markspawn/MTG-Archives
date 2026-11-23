# ChatGPT batch review connector

Brian requested individual connections so each user's ChatGPT can review all of that user's open scan batches. An administrator may explicitly authorize reviewing open batches for every user. The connector uses the same acquisition rules as the application and never treats a model-supplied user ID as authority.

## First delivery

Expose an authenticated MCP server in the web application. Users link their MTG Archives account through OAuth authorization code with S256 PKCE. Normal grants cover the linked user's open batches. All-user access needs an explicit administrator grant, made while Admin Mode is active; role/account/password changes, expiration or revocation invalidate access. Grant scope is checked again on every operation.

Tools list open batches with bounded pagination, list unconfirmed physical cards, return actual source images and recognition evidence, search exact catalog printings, and save supported confirmations. Pagination bounds request size, not total batch/card access. Exclude closed/cancelled/trashed/deleted batches and ignored/excluded/already-added cards. New scans are visible on subsequent reads; an active scanner does not prevent reviewing already-saved cards.

Work remains on demand in the user's ChatGPT conversation. The connector does not run a background model or promise that a single conversation can finish an unlimited collection without continuation. Return stable progress and per-card outcomes so a conversation can continue without duplicating confirmations.

Confirmation policy is being discussed: the working default follows Brian's original request to review and confirm cards. Save clear exact-printing decisions, leave uncertainty pending, and keep Inventory addition separate. Existing confirmed choices are never overwritten. Foil/condition/opener use visible batch defaults when appropriate rather than fabricated visual certainty. A matching name/artwork alone does not establish the exact printing.

AI confirmations retain the linked actor, source photo/digest/generation/revision, connector identity and explanation. They are identified as assistant reviews, never silently recorded as human ground truth. Existing actor/owner/printing/language/finish/stale-source/transaction/replay protections remain. Concurrent human edits win through revision checks. Card text and OCR are untrusted data, not instructions.

Settings → Connections shows setup details, own versus all-user scope, expiration and revocation. Private photo bytes are supplied through authorized tools; images are not made public. The connector has no Inventory commit, deletion, scanner-control, account-management or arbitrary database tool.

## Delivery boundaries

One feature branch/PR; no merge, production installation change or physical operation is authorized by this request. Test authentication/replay/revocation/account-role changes, cross-user access including admin opt-in, real private image delivery, open-batch pagination, stale/concurrent review saves, AI attribution and source/stock conservation. Verify actual OAuth/consent/settings desktop and phone flows in an isolated local runtime; distinguish controlled protocol tests from a real ChatGPT account-link acceptance test.

References: [OpenAI MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server), [authentication](https://developers.openai.com/plugins/build/auth), [MCP tools](https://developers.openai.com/plugins/build/mcp-server).

## Installation and linking

The existing application keeps working with the connector disabled. To enable this optional feature, configure the web service with `SCAN_CONNECTOR_ENABLED=1` and `APP_BASE_URL=https://your-installation.example.com` (origin only). Use an HTTPS endpoint reachable by the ChatGPT host, or supported private connectivity. Preserve the ordinary main-channel stop/pull/start workflow; no image pin, OCR/model change or extra recognition replica is needed. The additive migration runs through the ordinary application startup. Older installed Compose Manager files must pass the optional enable flag through to `web`; adding it is connector setup, not a prerequisite for ordinary application updates.

In Settings → Connections, copy the MCP URL into ChatGPT's custom MCP server setup. Select OAuth and supply the public, predefined client ID `mtg-archives-chatgpt`; there is no client secret. This implementation intentionally uses predefined registration rather than anonymous dynamic client registration or fetching arbitrary client metadata URLs. Supported callback URLs are the official `https://chatgpt.com/connector_platform_oauth_redirect` and `https://chatgpt.com/connector/oauth/<callback-id>` forms. The authorization page preserves sign-in return context and denies framing.

Each person signs in to their own MTG Archives account on the authorization page. Read access and optional confirmation are shown explicitly. All-user permission is unchecked by default and requires both administrator status and active Admin Mode at consent. Requesting `allUsers=true` with an administrator's own-only connection prompts additional authorization; a normal account cannot obtain it. Turning off browser Admin Mode later does not revoke an independently authorized OAuth grant; use Connections → Revoke access. Grants expire after 30 days; access tokens last at most 15 minutes and refresh tokens rotate. Reusing an authorization code or rotated refresh token revokes its grant family. Password, role, account, installation-origin changes and database restore also invalidate old connector authority.

The tools are `list_open_batches`, `list_batch_cards`, `get_card_review`, `search_printings`, `get_printing_reference` and `confirm_card`. Batches use a stable batch-number cursor and initial upper boundary, so confirmation-driven updates cannot reorder and skip later batches. Scan pages include physical position zero. Actual private image bytes are returned only after authentication; source and reference tickets bind image delivery to the connection, source revision and exact printing. Server checks preserve existing saved reviews and the visible batch finish/condition/opener defaults. If those defaults are missing or the printing is ambiguous, leave the card pending for the user.

## Evidence and acceptance

Focused policy/provenance tests and actual fresh PostgreSQL checks pass for user isolation, explicit admin cross-owner confirmation, image proofs/defaults, stale/replaced-source and saved-human-choice rejection, duplicate concurrent saves, code/refresh replay, revocation, live account/role/password changes, stable pagination and restore rollback/fencing with original/stock conservation. The first harness import accidentally ran a second fixture; the CLI entry guards are corrected and that failure is retained. Dependency audit comparison with main195ab07c reports no new advisories.

Production build, source-bound local HTTPS browser/MCP/consent/settings review and required final-head CI remain pending at this documentation checkpoint. A controlled OAuth callback/reference-image fixture is not a real ChatGPT account-link acceptance or recognition accuracy measurement. Publishing source does not enable the optional feature or deploy it to production.
