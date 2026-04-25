# Privacy policy — Tab Obituary


**Effective date:** 2026-04-24
**Last updated:** 2026-04-24

### Who we are

Tab Obituary is an independent project built and operated by a single person. There is no company, no investors, no growth team. Questions and takedown requests go to the contact address at the bottom of this page, and are answered by the same person who wrote the code.

### What this policy covers

This policy describes the Tab Obituary Chrome extension and the backend that delivers its weekly email. It tells you what is collected, where it lives, who sees it, and how to make it stop.

### What the extension collects locally, inside your browser

The extension records events as you browse:

- Tab lifecycle events: when a tab is opened, navigated, activated, or closed.
- The URL and page title of each tab at the time of the event.
- Timestamps in your local timezone.
- An active-time counter per tab, incremented only when that tab is focused, the Chrome window is the OS-active window, and your mouse or keyboard has produced input in the last 60 seconds.

All of this is written to IndexedDB inside your Chrome profile. It stays on your machine. Page contents, form data, and DOM text are never read or stored.

Incognito windows are not captured. Domains on your blocklist are not captured.

### What leaves the browser, when, and how

Data leaves your browser only when both of the following are true:

1. You have enabled the weekly email.
2. You have explicitly turned on the cloud AI option (`cloudAiOptIn: true`).

Under those conditions, once a week, the extension sends the backend a weekly payload containing:

- Per-URL records: URL, page title, active-time in milliseconds, and per-event timestamps.
- Your extension-local user ID (a UUID generated at install).
- An encrypted bearer token.

The backend passes URLs, titles, and active-time totals to the LLM for narrative generation, renders the resulting email, and sends it through Resend. The weekly payload is not retained on the server after the email is delivered.

If you have not opted into cloud AI, the extension still sends weekly reports, but they are computed locally using deterministic summaries (no narrative generation). No URLs or titles leave your browser in that mode.

### What we never collect

- No third-party analytics, no Mixpanel, no Amplitude, no Google Analytics, no Segment.
- No tracking pixels in the email, other than the standard open-tracking pixel that Resend embeds (disclosed here so it is not a surprise).
- No DOM scraping, no page content, no form values, no clipboard reads.
- No personal information beyond the email address you provide.
- No payment information.
- No browsing data from incognito mode.

### Sub-processors

When you opt in to cloud AI and the weekly email, the following service providers handle data on our behalf:

- **DeepSeek V3.2 via fal.ai / OpenRouter.** Generates the narrative text. Receives URLs, page titles, and active-time totals for the week. Does not receive your email address, your extension user ID, or your IP address (the backend sits between you and the model). Retention of API inputs is governed by the provider; we do not store or retrain on your data.
- **Cloudflare Workers + KV.** Hosts the backend API. Receives HTTPS requests from your browser and stores your user record (UUID, email, timezone, plan, opt-in flags). Receives request metadata as part of normal web hosting.
- **Resend.** Delivers the weekly email. Receives your email address and the rendered HTML of each email.

No other third parties receive your data. We do not sell data, we do not share data for advertising, and we do not train models on your browsing.

### Data retention

- **Server-side user record:** retained until you delete your account. Contains UUID, email, timezone, opt-in flags, and hashed/encrypted token material.
- **Weekly payloads on the server:** deleted after the email is rendered and sent. Not archived.
- **Weekly summaries for week-over-week comparisons:** stored in IndexedDB on your device only. Never sent to the server.
- **Outbound request log:** stored in IndexedDB on your device only. Lets you audit what the extension has sent.
- **Email delivery logs on Resend:** retained per Resend's standard retention.

### Your rights

- **Export your data.** One click in the options page downloads a JSON file of every event the extension has ever logged on your install. That file is the exact audit trail.
- **Delete your account.** One click wipes the IndexedDB database, revokes your bearer token, and tells the backend to delete your user record. There is no undo. We do not keep backups.
- **Unsubscribe from emails.** Every email contains an unsubscribe link. Clicking it stops future sends without deleting your account.
- **Pause tracking.** A toggle in the popup stops the event logger immediately.

### International users and GDPR

Tab Obituary practices data minimization as a core principle: the extension is engineered so that page contents never leave your browser, and the backend holds as little as possible about you. If you are in the EU or UK, you have rights of access, rectification, erasure, and portability under GDPR and UK GDPR; the Export and Delete controls described above fulfill these rights in a self-service way. We do not sell personal data across borders, because we do not sell data at all.

### Children

Tab Obituary is not intended for users under 13 and is not designed to serve them. Do not install the extension on an account used by a child.

### Changes to this policy

If this policy changes in a way that affects how your data is handled, the effective date above will change and a short summary of the change will be posted on the project's public page. If the change is material and we have your email on file, we will send a notice email at least 30 days before the change takes effect, and you can delete your account during the notice window if you disagree.

### Contact

Questions, concerns, or takedown requests: **teams@socialcap.uk**.

---

