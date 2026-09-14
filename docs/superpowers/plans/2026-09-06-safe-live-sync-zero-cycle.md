# Safe Live Sync and Zero Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely synchronize shared inventory state, add optional cycle counters to zero schedules, show compact memos, and edit master entries from the inventory tab.

**Architecture:** The API treats `updated_at` as an optimistic-concurrency version. The client retains its last synchronized snapshots, polls a lightweight version endpoint every two seconds, and only automatically merges changes to independent keyed records.

**Tech Stack:** Cloudflare Pages Functions, D1, browser JavaScript, Node assert/vm tests.

**Spec:** `docs/superpowers/specs/2026-09-06-safe-live-sync-zero-cycle-design.md`

## Global Constraints

- Use only existing Pages, Functions, and D1 services.
- Keep the stable existing Pages URL; deploy to the existing project only.
- Do not persist `dailyUsage`.
- Do not add `전주기`, `다음주기`, `치료 완료`, or replacement status copy.
- Preserve the existing uncommitted user changes and update both HTML copies.

### Task 1: Conditional API versions

**Files:** `functions/api/state.js`, `tests/state-api-version.test.mjs`

- [ ] Add tests for unchanged `since` GET returning 304, missing version PUT returning 428, stale PUT returning 409 with latest data, and a matching PUT returning 200.
- [ ] Run `node tests/state-api-version.test.mjs` and observe the expected failure against unconditional current saves.
- [ ] Add `since` handling to GET and `base_updated_at` conditional `UPDATE ... WHERE updated_at = ?` to PUT. Only write history/statistics after that update succeeds.
- [ ] Run `node tests/state-api-version.test.mjs` and confirm it passes.

### Task 2: Client merge and automatic refresh

**Files:** `public/index.html`, `항암제_재고관리.html`, `tests/live-sync-merge.test.cjs`

- [ ] Add tests for merging different zero IDs, conflicting same zero ID, delete-vs-edit, different master codes, and same `dailyData` date conflict.
- [ ] Run `node tests/live-sync-merge.test.cjs` and observe the expected missing-helper failure.
- [ ] Add snapshot/version variables, pure three-way merge helpers, serialized conditional saves, 409 retry only without conflicts, 2-second version polling, focus/visibility immediate refresh, and deferral while inputs are active.
- [ ] Run `node tests/live-sync-merge.test.cjs` and confirm it passes.

### Task 3: Optional zero schedule cycles

**Files:** `public/index.html`, `항암제_재고관리.html`, `tests/zero-next-date.test.cjs`

- [ ] Add tests for valid `3/6` labels, incomplete labels staying hidden, manual edits, automatic next-cycle increase, promoted future cycle increase, and no future events after the final cycle is fully checked.
- [ ] Run `node tests/zero-next-date.test.cjs` and observe failure.
- [ ] Add optional `cycleCurrent`/`cycleTotal` form inputs and validation; display a small label only when both values are valid; increment on schedule advance/promotion; stop future event creation only once the last configured cycle has completed.
- [ ] Run `node tests/zero-next-date.test.cjs` and confirm it passes.

### Task 4: Compact memo preview

**Files:** `public/index.html`, `항암제_재고관리.html`, `tests/zero-next-date.test.cjs`

- [ ] Add a failing assertion that an existing memo renders exactly one compact clickable preview and no preview is rendered for empty memo.
- [ ] Add the one-line ellipsis preview beneath the patient name; reuse the existing editor toggle and do not duplicate memo text in calendar cells.
- [ ] Run `node tests/zero-next-date.test.cjs` and confirm it passes.

### Task 5: Inventory-tab master editing

**Files:** `public/index.html`, `항암제_재고관리.html`, `tests/master-inventory-filter.test.cjs`

- [ ] Add tests proving inventory-row master add and exclusion do not mutate inventory data.
- [ ] Add an administrator-only compact editor and per-row exclusion control that operate on the current type's master list only.
- [ ] Run `node tests/master-inventory-filter.test.cjs` and confirm it passes.

### Task 6: Review, deploy, and verify stable URL

**Files:** all changed files

- [ ] Run all test files, `node --check functions/api/state.js`, and `git diff --check`.
- [ ] Request CodeRabbit review when a CodeRabbit connector is available; otherwise run the mandated independent local reviewer and resolve Critical/Important findings.
- [ ] Deploy with `wrangler pages deploy public` without creating a new Pages project or changing domains.
- [ ] Fetch the existing stable URL from the Wrangler output and verify the page plus `/api/state?type=chemo` respond.
