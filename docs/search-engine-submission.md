# Tasker — Search Engine and Discovery Submission Guide

**Version 1.14.3 — June 2026**

---

## Purpose

This document describes the most effective way to submit and maintain the public Tasker homepage across major search engines, search conglomerates, AI-assisted discovery tools, and social-preview ecosystems.

Tasker is best positioned as a **self-hosted, anonymous workload logger for NHS and healthcare teams**. Submission should emphasise the app's actual differentiators:

- Self-hosted Node.js + SQLite deployment
- Anonymous usernames instead of identity-linked user accounts
- No patient data or real-name workflow required
- 30-day automatic task deletion
- Analytics, interruption tracking, pending-workload snapshots, and XLSX exports
- Public DPIA and policy documentation

---

## 1. Before submitting anywhere

Complete this checklist first:

- Confirm the public production URL is final and stable
- Set `APP_URL` so canonical metadata, `robots.txt`, `sitemap.xml`, and `llms.txt` all point to the correct public origin
- Verify the homepage, `/guide`, `/help`, `/policy`, and `/dpia` are publicly reachable without login
- Verify `https://your-domain.example/robots.txt` and `https://your-domain.example/sitemap.xml` load correctly
- Verify social preview metadata with a card validator where available
- Keep the homepage messaging aligned with the real product capabilities only

---

## 2. Highest-priority submission targets

### 2.1 Google Search Console

**Why it matters:** Google remains the primary discovery layer for software evaluation, branded search, and organic long-tail traffic.

**What to do:**

1. Add the public Tasker domain as a property in Google Search Console
2. Verify ownership at the domain level if possible
3. Submit `/sitemap.xml`
4. Request indexing for:
   - `/`
   - `/guide`
   - `/help`
   - `/policy`
   - `/dpia`
5. Monitor:
   - Coverage issues
   - Canonical warnings
   - Mobile usability
   - Search queries containing terms like `anonymous task logger`, `healthcare workload tracker`, `self-hosted task logger`, and `NHS workload app`

**Best use:** primary search visibility and ongoing indexing control.

---

### 2.2 Bing Webmaster Tools

**Why it matters:** Bing indexing also feeds or influences Microsoft discovery surfaces and can improve visibility across Bing-powered search experiences.

**What to do:**

1. Add the site to Bing Webmaster Tools
2. Import the property from Google Search Console if convenient
3. Submit `/sitemap.xml`
4. Use URL inspection / submit URL for the same core public pages
5. Monitor crawl health and index coverage

**Best use:** Microsoft/Bing ecosystem coverage with low extra effort.

---

## 3. Important secondary targets

### 3.1 Apple Business Connect / Apple web discovery surfaces

Apple is not a classic software-search console for web apps in the same way as Google or Bing, but strong metadata, crawlability, and social preview hygiene improve how links appear inside Apple-controlled surfaces.

**Best action:** focus on homepage quality, structured data, and clean previews rather than expecting a dedicated submission workflow for the app itself.

### 3.2 Yandex Webmaster

Useful if international discoverability matters beyond the UK healthcare audience.

**Best action:** only prioritise this if the deployment is intended to attract non-UK search traffic.

### 3.3 Brave Search / privacy-focused engines

Brave often discovers sites via independent crawling plus broader web references.

**Best action:** ensure sitemap availability, high-quality metadata, and backlinks from trusted domains rather than expecting a large manual-submission workflow.

---

## 4. Search conglomerates and downstream discovery

### 4.1 Search engines that commonly follow Google/Bing discovery patterns

For many engines and portals, the best route is not separate manual submission but good technical hygiene plus sitemap discoverability.

This includes cases where discovery is influenced by:

- Bing-powered search relationships
- Google-indexed references and backlinks
- Open web crawling of the main public pages

**Practical rule:** prioritise Google Search Console and Bing Webmaster Tools first; these usually provide the highest return.

---

## 5. AI-crawler and answer-engine optimisation

Tasker now exposes `llms.txt`, but that file should support the homepage rather than replace it.

### Priority actions

- Keep `llms.txt` factual, short, and free of marketing exaggeration
- Ensure the homepage states the same core claims as `llms.txt`
- Keep `/policy`, `/dpia`, and `/help` crawlable because answer engines value verifiable supporting documents
- Maintain structured data on the homepage so models and search engines can extract consistent product facts
- Avoid unsupported phrases like “fully compliant” unless the exact compliance basis is documented

### Best submission approach

There is usually **no universal manual submit button** for AI answer engines.

The strongest approach is:

1. Maintain a crawlable homepage with strong semantics
2. Provide supporting trust documents (`/policy`, `/dpia`, `/help`, `/guide`)
3. Publish `llms.txt`
4. Earn citations and backlinks from credible healthcare, digital transformation, or privacy-focused sources

---

## 6. Social and sharing ecosystems

### LinkedIn, Slack, Teams, Facebook, X, Discord

These platforms usually rely on Open Graph and Twitter Card metadata rather than a submission console.

**What to do:**

- Test the homepage URL in platform validators where available
- Keep the headline and description stable
- Use the dedicated social preview asset consistently
- Ensure the preview copy matches the landing page positioning

**Recommended launch uses:**

- Share the homepage from a founder/admin account
- Share a short explainer post linking directly to `/guide` when targeting practical adopters
- Share privacy and governance proof points alongside the main homepage when targeting NHS or governance stakeholders

---

## 7. Directory and marketplace opportunities

These are optional, but they can help with backlinks and discovery if executed carefully.

### High-fit directories

- Open-source/self-hosted software directories
- Privacy-focused software directories
- Healthcare digital innovation showcases
- NHS digital transformation community spaces
- PWA or web-app showcases

### Submission rule

Only submit where the listing can describe Tasker accurately as:

> A self-hosted, anonymous workload logger for NHS and healthcare teams.

Avoid categories that imply Tasker is:

- an EPR or clinical record
- a rostering suite
- a staff surveillance platform
- a generic consumer to-do app

---

## 8. Backlink strategy with the best expected return

For Tasker, backlinks from relevant contexts will likely outperform mass-directory submissions.

Prioritise outreach to:

- Healthcare productivity and operational improvement blogs
- NHS transformation communities
- Digital governance / privacy-by-design communities
- Open-source and self-hosting newsletters
- PWA and lightweight tooling roundups

Best supporting angles:

- anonymous workload evidence for healthcare teams
- self-hosted alternative to cloud time trackers
- privacy-first operational analytics
- lightweight tooling for service-improvement pilots

---

## 9. Submission order of operations

Use this order for the highest-value rollout:

1. Launch the production homepage with correct `APP_URL`
2. Validate the homepage metadata, social preview, `robots.txt`, `sitemap.xml`, and `llms.txt`
3. Submit to Google Search Console
4. Submit to Bing Webmaster Tools
5. Request indexing for core public pages
6. Publish launch posts on LinkedIn and other relevant channels
7. Submit to a small number of high-fit directories
8. Start backlink outreach to healthcare/privacy/open-source communities
9. Review query data after indexing and refine copy only where supported by the product

---

## 10. Ongoing maintenance

Review monthly:

- Index coverage in Google and Bing
- Search queries reaching the homepage
- CTR on branded and non-branded queries
- Crawl errors on `robots.txt`, `sitemap.xml`, and public docs
- Social preview rendering after each release
- Consistency between homepage copy, `llms.txt`, README, policy, and DPIA

Whenever Tasker positioning changes, update these assets together:

- Homepage metadata and structured data
- `llms.txt`
- `README.md`
- `/guide`, `/help`, `/policy`, `/dpia` where needed
- This document

---

## Recommended summary

If only a small amount of time is available, do this:

1. Keep the public homepage technically strong and factually precise
2. Submit the site to Google Search Console and Bing Webmaster Tools
3. Maintain `sitemap.xml`, `robots.txt`, and `llms.txt`
4. Win a few strong backlinks from relevant healthcare, privacy, and open-source sources

For Tasker, that is the highest-yield path to sustainable search and AI-era discoverability.
