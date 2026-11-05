---
title: Privacy policy
description: What the watchlog.io website and the Cloud waitlist collect, why, for how long, and what the self-hosted WatchLog software sends to us (nothing).
---

# Privacy policy

Last updated: {{updated}}. This policy covers the website at watchlog.io, run by {{operator}}.

## The website

- **No cookies, no analytics, no tracking.** The site sets no cookies and runs no analytics or advertising scripts. Fonts and images are served from watchlog.io itself, so loading a page makes no requests to anyone else.
- **Server logs.** Like any web server, ours records each request: your IP address, the page, the time, the browser's user agent and the referring page. We use these logs only to keep the site running and secure, and delete them after 14 days.
- **Cloudflare.** Requests to watchlog.io pass through Cloudflare, which delivers the site and protects it from attacks. Cloudflare processes your IP address for that purpose; see [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).

## The Cloud waitlist

When you join the waitlist we store:

- your email address;
- when you signed up, and when you confirmed it;
- where you came from: the `utm_source`, `utm_medium` and `utm_campaign` of the page you signed up on, and the address of the page that linked to us, without its query string;
- a salted hash of your IP address, never the address itself. It limits how often one visitor can sign up and helps us spot abuse;
- hashes of the confirmation and unsubscribe links in our email.

**Why:** to send you one email to confirm your address now, and one when WatchLog Cloud opens. Nothing else: no newsletter, and we never sell or share your address. The source tells us which posts brought people to the waitlist.

**Where:** in a database on our own server, readable only by the WatchLog team through an admin panel behind a password and two-factor authentication. Email goes out through our own mail server.

**How long:** an address that isn't confirmed is deleted after 30 days. A confirmed one stays until you unsubscribe or ask us to delete it. Nightly backups are kept for 30 days, so a deleted address is gone from them within 30 days too.

**Unsubscribe or delete:** every email has an unsubscribe link, which removes your entry at once. To ask for your data or its deletion without the link, write to [{{contactEmail}}](mailto:{{contactEmail}}).

You agree to this when you confirm your address, and you can withdraw at any time by unsubscribing.

## The WatchLog software

When you self-host WatchLog, it sends nothing to us: no telemetry and no usage data. Agents send metrics, Kubernetes object summaries and events only to your own WatchLog server. They never read Secrets, ConfigMap data, environment variables or request payloads. The [security page](/security/) lists everything the agent can access.

WatchLog Cloud, when it opens, will have its own privacy terms.

## Your rights

You can ask us what we hold about you (server logs, and your waitlist entry if you joined), and ask us to correct or delete it. Write to [{{contactEmail}}](mailto:{{contactEmail}}). If you are in the EU or the UK, you can also complain to your data protection authority.

## Changes

When this policy changes, the date at the top changes too.
