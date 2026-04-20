# How to submit this work

Use **different channels for different audiences**. You almost never pick *only* “PR **or** email”—they solve different jobs.

## Inside a team / open-source repo (Musashi maintainers)

1. **Branch** — short name, e.g. `feat/roadmap-docs-health-readiness`.
2. **Pull request** — describe *what* changed and *why*, link related issues. This is the **official record** of code review and CI.
3. **Optional Slack / DM** — one line when the PR matters urgently (“PR up for roadmap + health readiness—needs review”).
4. **Email** — use when policy requires it (security, legal, external partner). Not a substitute for the PR.

## Job application or internship (you’re the owner of the repo)

1. **Repo link** on résumé / form (GitHub visibility: **Public** or **Source-available** as appropriate).
2. **Cover letter or “Additional information”** — 3–5 bullets: problem, architecture, tradeoffs, tests you run (`pnpm test:ci`, `pnpm interview:check`). No need for a separate “submission email” unless the posting asks for one.
3. **Optional follow-up email** after a referral or recruiter call—attach or link the same repo; keep it short.

## Professor / course submission

Follow the course LMS first (Canvas, Gradescope). If they allow a link, add the repo URL + commit SHA. Offer a **ZIP export** only if required—prefer link + README instructions.

---

## Pre-submit verification (run locally)

```bash
pnpm test:ci          # required gate
pnpm interview:check  # CI + pitch prompts
```

Against a **deployed** API (optional but strong before claiming “production tested”):

```bash
pnpm test:agent
```

If `test:agent` hits **curl timeouts** on `*.vercel.app`, cold starts or network spikes are common. Retry once, or:

```bash
MUSASHI_TEST_TIMEOUT_MS=45000 pnpm test:agent
```

See [TESTING.md](./TESTING.md) for preview URLs and env vars.

---

## Quick decision table

| Situation | Use PR? | Use email? |
|-----------|---------|------------|
| Merging code into shared repo | **Yes** | Only if org requires |
| Applying to company with no repo access | No | **Yes** (application + link in CV) |
| Showing project to mentor | Link + short message | Optional thank-you |
| Course project | Per syllabus | Per syllabus |

---

## Ship checklist (before you open the PR or send the link)

1. `pnpm test:ci` passes.
2. `pnpm interview:check` passes (same as CI + talking points).
3. Optionally `pnpm test:agent` against the URL reviewers will hit (production or preview).
4. README points to [`SUBMISSION.md`](./SUBMISSION.md) and [`TESTING.md`](./TESTING.md)—done in-repo.
5. PR description: **what / why / how to verify** (copy the commands above).
