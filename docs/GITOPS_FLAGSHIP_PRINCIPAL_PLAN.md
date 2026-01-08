 [LEGEND]

[CONTENT]
# Flagship Principal++ GitOps Plan for SentryFrogg

Status: proposal

## 0) One-line goal
Make SentryFrogg the **default GitOps control plane for AI agents**: one calm UX surface (`workspace.run(intent_type=gitops.*)`) that safely plans, proposes, syncs, verifies, and rolls back changes across **any repo + any stack** without enabling unsafe local exec.

## 1) Non-goals (to protect cognitive cheapness)
- No “150 tools”. Keep public surface to **~6 GitOps intents**.
- No “god tool” with 200 actions as the primary UX. If a tool grows, it must stay behind `workspace.run(intent_type=...)`.
- No unbounded scanning, watchers, or hidden side-effects.
- No secrets in stdout, artifacts, audit, or PR comments.
- No dependency on `mcp_local` for GitOps (unsafe local stays optional).

## 2) Flagship UX contract (what agents learn)
Agents should only need these intents (plus `help/legend`):

1. `gitops.status` (read): drift/health summary for a target
2. `gitops.plan` (read): render + diff + plan + evidence
3. `gitops.propose` (write, gated): branch/commit/PR with attached evidence
4. `gitops.sync` (write, gated): reconcile/sync via controller (ArgoCD/Flux)
5. `gitops.verify` (read): rollout + health + optional metrics checks
6. `gitops.rollback` (write, gated): revert + sync back + verify

Golden path for an agent:
```text
workspace.run(intent_type=gitops.plan, inputs={...})
workspace.run(intent_type=gitops.propose, inputs={...}, apply=true)
workspace.run(intent_type=gitops.sync, inputs={...}, apply=true)
workspace.run(intent_type=gitops.verify, inputs={...})
```

All outputs are `.context` summaries with `R:` artifact references to large payloads.

### 2.1) Operatorless autonomy (agent does the whole loop)
Constraint: the agent must be able to ship changes **without a human operator**, while still being safe.

Design:
- “Operatorless” means **no interactive prompts**, no manual approvals at runtime, and bounded self-healing.
- Prefer platform-native automation knobs instead of inventing a new orchestrator:
  - GitHub: auto-merge / merge-queue
  - GitLab: merge when pipeline succeeds
  - ArgoCD: auto-sync (optional)
  - Flux: continuous reconcile

Autopilot mode (recommended):
- Add an optional *single* public intent: `gitops.release` (still keeps the surface small).
- `gitops.release` is a state machine that orchestrates:
  `plan → propose → (CI gates) → merge → sync → verify → (rollback if needed)`
- All loops are bounded:
  - `max_attempts` for CI re-runs / transient controller errors
  - time budgets for waits (checks/sync/rollout)

Key safety invariant:
- Write steps still require `apply=true`, but **no human** is required—policy decides if the target is allowed.

## 3) The single missing primitive: a safe repo/runner tool
### Why
GitOps needs **repo-local git + render + diff + patch**. Today that implies unsafe local exec.

### Deliverable
Add **one** new MCP tool: `mcp_repo` (safe-by-default).

### Design laws (Principal++)
- **Sandbox**: all file operations are confined to `repo_root`.
- **No shell**: only `command` + `args[]` (deny `sh -c`, deny `shell: true`).
- **Allowlist**: only known binaries/subcommands (configurable per target).
- **Budgets**: per-call `timeout_ms` and output byte caps; spill into artifacts.
- **Deterministic receipts**: every meaningful operation writes artifacts:
  - `artifact://runs/<trace_id>/tool_calls/<span_id>.context`
  - plus optional `artifact://.../*.patch`, `artifact://.../*.yaml`, `artifact://.../*.json`
- **Write gating**: any repo mutation requires `apply=true`.

### `mcp_repo` actions (kept small, capability-driven)
Minimal actions to cover everything without tool explosion:

#### Read
- `repo_info`: root, git root, remotes, default branch, clean/dirty, last commits
- `git_diff`: unified diff (or diffstat) into artifact
- `render`: produce rendered manifests (helm/kustomize/plain) into artifact

#### Write (requires apply=true)
- `apply_patch`: apply a unified diff patch (artifact produced)
- `git_commit`: create commit (message template enforced)
- `git_push`: push branch (policy-gated)

#### Exec (still one action, but safe)
- `exec`: allowlisted command runner for: `git`, `kubectl`, `helm`, `kustomize`, `flux`, `argocd`

Notes:
- “Many features” live as runbooks built from these primitives.
- If a new stack appears, we add a **runbook**, not a new tool.

## 4) Context-driven routing (works on “any project”)
We already have `mcp_context` tags. Extend detection to add GitOps-relevant tags:
- `argocd` (e.g. marker files/dirs: `argocd-apps/`, `applicationset`, `argocd` manifests)
- `flux` (marker: `gotk-components.yaml`, `kustomization.toolkit.fluxcd.io`, `helmrelease` CRDs)
- `gitops` (derived: `argocd || flux`)
- `kustomize` vs `helm` already exist (`k8s`, `helm`)

Routing model:
- capabilities define `when.tags_any` and `depends_on`.
- the agent always calls `gitops.*` intents; SentryFrogg chooses the correct internal plan.

## 5) Capability graph (intents compile to an execution pipeline)
Each public intent is backed by a root capability. Dependencies stitch the pipeline:

Example (conceptual):
```text
gitops.plan
  depends_on: preflight.repo, preflight.k8s, preflight.controller
  → render (helm/kustomize)
  → diff (cluster/controller)
  → plan summary + evidence
```

Key principle: **effects aggregation** (already in IntentManager) must remain strict:
- any write in the chain ⇒ `requires_apply=true`
- dry-run by default; execution requires explicit `apply=true`

## 6) Controller integrations (no new tools)
Use `mcp_api_client` as the only HTTP primitive; implement controllers as runbooks:

### ArgoCD
- status/health/sync/rollback via ArgoCD API (or `argocd` CLI via `mcp_repo.exec` as fallback)

### Flux
- reconcile/suspend/resume + status via Kubernetes API (prefer `kubectl` JSON; CLI via `mcp_repo.exec`)

Rule:
- Prefer HTTP APIs where stable.
- Prefer `kubectl` JSON for portable health/status.
- Store big controller payloads as artifacts; return `.context` summary.

## 7) PR/MR automation (no new tools)
Implement provider adapters as **runbooks + presets** on top of `mcp_api_client`:
- GitHub: create branch (via `mcp_repo`), push, open PR, comment evidence, wait for checks
- GitLab: same for MR

Provider selection:
- detect from git remote in `mcp_repo.repo_info`.
- allow override via inputs / project target.

## 7.1) CI/CD gates (close the “delivery loop” without new tools)
GitOps becomes flagship only when it can **safely close the loop**:

- `gitops.propose` SHOULD:
  - publish evidence (plan/diff) into PR/MR,
  - detect CI provider from repo markers (`.github/workflows`, `gitlab-ci.yml`, `Jenkinsfile`, etc.),
  - wait for required checks to pass (bounded by time/output budgets),
  - optionally enable auto-merge or perform merge (policy-gated).

Implementation approach (keep tools small):
- Use `mcp_repo.repo_info` for remote detection + branch naming.
- Use `mcp_api_client` for GitHub/GitLab CI status + logs/artifacts URLs.
- Spill CI logs/artifacts into `artifact://...` and return a `.context` summary.

Result: agents do not need a separate “cicd.*” surface for the common path; it is embedded into `propose`.

## 7.2) Supply-chain integration (images, provenance, scans) without becoming a shovel
Treat supply-chain as **verifiers** and **materializers**, not new tools.

### Verifiers (read)
Run during `gitops.plan` and/or `gitops.verify` depending on policy:
- resolve image digest(s) (tag → digest) via registry HTTP API
- verify signatures/attestations if configured (prefer API-based services; CLI only via allowlisted `mcp_repo.exec` and only if present)
- fetch SBOM / scan reports (Snyk/Trivy server/Aqua/etc.) via `mcp_api_client`

### Materializers (write, gated)
When policy requires immutability:
- update manifests to pin digests instead of tags (done via `mcp_repo.apply_patch`)

Evidence outputs (artifacts-first):
- `registry.resolve.json`, `sbom.json`, `scan.json`, `attestation.json` as artifacts
- `.context` summary with the verdict + links

## 7.3) Observability gates (metrics/errors) as part of `gitops.verify`
To be “principal” in production, GitOps must answer: **did the release improve or degrade the system?**

Model this as optional, pluggable verifiers executed by `gitops.verify`:
- rollout status (k8s) and controller health (Argo/Flux)
- SLO-ish checks (latency/error rate) via Prometheus-compatible APIs
- error regressions via an error tracker API (Sentry, etc.)

Keep it tool-light:
- Use `mcp_api_client` to query metrics/error services.
- Store large time series / raw responses as artifacts; return only verdict summaries in `.context`.

Policy hooks:
- fail verification if thresholds exceeded
- auto-suggest `gitops.rollback` when verification fails

## 8) Policy + safety gates (must feel boring)

## 8) Policy + safety gates (must feel boring)
### Hard gates
- `apply=true` required for:
  - repo mutations (`apply_patch`, `git_commit`, `git_push`)
  - controller sync/rollback
- `diff-before-apply`:
  - `gitops.sync` requires an existing `gitops.plan` artifact in the same `trace_id` (or explicit override)

### Target allowlists (per project.target)
- allowed git remotes/orgs
- allowed clusters/kubeconfigs
- allowed namespaces/resources (optional but recommended)

### Governance (principal-level)
Keep these as **policy fields on project targets** (not new tools):
- required approvals / CODEOWNERS expectations (enforced by PR provider)
- change windows (time-based allow/deny)
- environment locks (prevent concurrent deploys to the same target)
- required checks (CI contexts) and required evidence artifacts

### Operatorless policy profile
To enable autonomy without humans, define a policy profile per target:
- `mode: operatorless` (explicit opt-in)
- allowed write scopes (what targets/resources can be changed)
- required gates (CI pass, plan artifact present, verify pass)
- rollback strategy (auto rollback on verify failure)

Hard rule:
- If policy cannot prove safety within declared bounds, it must fail-closed (no “ask operator”).

### Secret discipline
- redact aggressively (already present)
- forbid copying `.env`, kubeconfigs, private keys into artifacts

### Identity & credentials (universal projects)
Do not add a dozen cloud tools.

Principal approach:
- Prefer **short-lived tokens** (OIDC) issued by CI/provider where possible.
- Store long-lived credentials only in Vault/profiles; keep them out of repo.
- Extend SecretRef patterns only when there is a clear, stable contract (e.g. `ref:env:*`, `ref:vault:*` already exist).

Target configuration SHOULD define where tokens come from:
- git provider token / app installation
- controller token (Argo) or kubeconfig
- registry credentials (if needed)
- observability API tokens

## 9) Evidence model (artifact-first)
For each GitOps run, produce a consistent artifact set:
- `plan.context` (human+agent readable)
- `render.yaml` (large)
- `diff.patch` (large)
- `controller.status.json` (large)
- `ci.status.json` / `ci.logs.txt` (large, when applicable)
- `supplychain.*.json` (sbom/scan/attestation, when applicable)
- `observe.metrics.json` / `observe.errors.json` (large, when applicable)
- `pr.context` (PR url + IDs)
- `verify.context` (what checks passed/failed)

Stdout remains calm `.context`:
- `A:` summary line
- `R:` links
- `E:` on errors (typed)

## 10) Testing strategy (flagship quality)
### Unit tests
- path traversal / sandbox escapes
- allowlist enforcement (`sh -c` and unknown binaries denied)
- apply gating for write actions
- artifact writing + size capping

### Integration tests (Docker)
- local git repo fixture: branch/commit/patch
- render fixtures (helm/kustomize) (skip if tools missing; gate by preflight)

### Contract tests
- tools/list schema remains OpenAI-compatible
- `.context` output always includes `[LEGEND]` + `[CONTENT]` and never leaks secrets

### Autopilot tests
- bounded wait behavior (CI wait/sync wait/rollout wait)
- bounded retries (transient failures)
- rollback path correctness (verify failure triggers rollback and evidence)

## 11) Milestones (execution order)
1) **MVP Safe Runner**: `mcp_repo` sandbox + allowlist + artifacts + apply gating
2) **GitOps Plan**: `gitops.plan` (render+diff) + evidence artifacts
3) **Propose**: branch/commit/push + GitHub PR (then GitLab)
4) **CI Gates**: required checks + bounded log/artifact capture + merge policy
5) **Verify Gates**: rollout + metrics/error verifiers (policy-thresholded)
6) **Controller Ops**: ArgoCD/Flux sync + rollback primitives (policy-gated)
7) **Hardening**: policy allowlists, diff-before-apply, change windows/locks, perf, failure modes

## 12) Success metrics
- Agent can ship a GitOps change with <5 calls and no manual glue.
- No unsafe local needed for normal GitOps workflows.
- All write operations are gated, auditable, and reproducible from artifacts.
- Outputs stay small and high-signal; large payloads always spill into artifacts.
- CI results and verify gates are visible as artifacts and summarized in `.context`.
- Operatorless: a full release can be executed end-to-end via `workspace.run(intent_type=gitops.release, apply=true)` with no interactive steps.

## 13) Implementation decomposition (атомарные шаги ≥20 минут)

Ниже — декомпозиция «до полной реализации» в текущем SentryFrogg MCP. Каждый шаг:
- рассчитан на **одну PR-итерацию** и обычно занимает **20–90 минут**;
- имеет **чёткие критерии Done**, **конкретные тесты**, и **явные блокеры**;
- должен завершаться зелёными валидаторами: `npm run check && npm test`.

### Milestone 1 — MVP Safe Runner: `mcp_repo`

#### M1.1 — Выделить общий слой артефактов (переиспользуемый менеджерами)
- **Goal**: чтобы `mcp_repo` (и другие будущие инструменты) могли писать крупные данные в `SF_CONTEXT_REPO_ROOT` так же, как это уже делает сервер.
- **Implementation**:
  - вынести логику формирования путей/каталогов/URI `artifact://...` в отдельный модуль (например `src/utils/artifacts.ts` или `src/services/ArtifactService.ts`);
  - обеспечить API уровня: `writeTextArtifact({ trace_id, span_id, filename, content }) -> { uri, abs_path, bytes }` и `writeBinaryArtifact(...)`;
  - использовать атомарную запись (через уже существующие `fsAtomic.ts`).
- **Done criteria**:
  - при наличии `SF_CONTEXT_REPO_ROOT` артефакты записываются **только** под этим корнем;
  - любые попытки path traversal (включая `..`, абсолютные пути, UNC) приводят к fail-closed ошибке;
  - формат URI стабилен (по плану: `artifact://runs/<trace_id>/...`).
- **Tests**:
  - добавить `tests/artifacts.test.ts`: корректный путь, запрет traversal, запись/чтение, права доступа (минимум 0600 для файлов).
- **Blockers**:
  - требуется согласовать единый «layout» артефактов (каталоги/имена) между сервером и менеджерами.

#### M1.2 — Скелет `RepoManager` + регистрация в DI/ToolExecutor + schema
- **Goal**: добавить новый MCP tool `mcp_repo` (пока без полной функциональности), чтобы можно было итеративно наращивать поведение.
- **Implementation**:
  - создать `src/managers/RepoManager.ts` со switch по `action` и базовой валидацией аргументов;
  - зарегистрировать менеджер в `src/bootstrap/ServiceBootstrap.ts` и подключить в `ToolExecutor` (как остальные менеджеры);
  - добавить `mcp_repo` в `tools/list` schema в `sentryfrogg_server.ts` (OpenAI-совместимый inputSchema).
- **Done criteria**:
  - `tools/list` содержит `mcp_repo` с минимальным набором полей `action`, `repo_root`, `output?` (без “semantic fields”);
  - вызов `mcp_repo` с неизвестным `action` возвращает детерминированную ошибку;
  - ничего не использует `mcp_local`.
- **Tests**:
  - `tests/schema-openai-compat.test.ts`: `mcp_repo` присутствует и schema валидна;
  - новый `tests/repo-manager.test.ts`: unknown action → error.
- **Blockers**:
  - требуется определить, где брать `repo_root` по умолчанию (из `project.repo_root`/`context.root`/`args.repo_root`).

#### M1.3 — Sandbox: нормализация путей + запрет выхода за `repo_root`
- **Goal**: обеспечить «железный» sandbox для любых файловых операций `mcp_repo`.
- **Implementation**:
  - добавить утилиту `resolveRepoPath(repo_root, rel)`:
    - всегда `path.resolve(repo_root, rel)`;
    - запрет `..`/абсолютных путей/пустых путей;
    - при необходимости — детект symlink-escape (через `realpath`) для операций чтения/записи.
  - покрыть операции, которые будут нужны дальше: чтение файлов (для render), запись артефактов, применение patch.
- **Done criteria**:
  - любые попытки обратиться к `/etc/passwd`, `../secret`, `C:\Windows\...` и т.п. fail-closed;
  - при наличии symlink внутри repo, ведущего наружу, доступ наружу также запрещён.
- **Tests**:
  - `tests/repo-sandbox.test.ts`: traversal, absolute path, symlink escape.
- **Blockers**:
  - symlink-политика: решить, разрешаем ли чтение symlink внутри repo, если realpath остаётся внутри repo.

#### M1.4 — `mcp_repo.exec`: allowlist + no-shell + budgets + spill-to-artifacts
- **Goal**: безопасный runner, пригодный для `git`, `kubectl`, `helm`, `kustomize`, `argocd`, `flux`.
- **Implementation**:
  - `exec` принимает только `{ command: string, args: string[] }`, всегда `shell=false`;
  - denylist: `sh`, `bash`, `cmd`, `powershell`, а также любые попытки передать `-c`/`/c` в args для shell-like команд;
  - allowlist команд определяется конфигом (на старте — env или `project.targets[*].policy.repo.allowlist`);
  - таймаут (`timeout_ms`) + лимит stdout/stderr (например `max_bytes`) с проливом в артефакт.
- **Done criteria**:
  - `mcp_repo.exec` детерминированно отклоняет неизвестную команду и любые shell-паттерны;
  - stdout/stderr > лимита не возвращается inline и сохраняется в артефакты;
  - `duration_ms`, `exit_code`, `timed_out` всегда присутствуют.
- **Tests**:
  - `tests/repo-exec-allowlist.test.ts`: deny/allow; `sh -c` отклоняется;
  - `tests/repo-exec-budgets.test.ts`: большой stdout → artifact ref.
- **Blockers**:
  - нужна единая политика «что именно allowlisted по умолчанию» (минимум `git`).

#### M1.5 — Git primitives: `repo_info`, `git_diff`, `apply_patch`, `git_commit`, `git_push`
- **Goal**: покрыть весь GitOps workflow минимальными git-примитивами.
- **Implementation**:
  - `repo_info`: git root, remote urls, default branch (best-effort), dirty/clean, current branch, last N commits;
  - `git_diff`: diffstat + full diff в артефакт;
  - `apply_patch`: применить unified diff patch в sandbox (и вернуть итоговый diffstat);
  - `git_commit`: коммит с шаблоном сообщения; запрет пустых коммитов; возврат sha;
  - `git_push`: push в remote/branch, policy-gated.
  - **Write gating**: любые мутации требуют `apply=true` (см. также M2.2 про проброс apply в runbook inputs).
- **Done criteria**:
  - на временном репозитории можно: создать изменение → `apply_patch` → `git_commit` → `git_push` в локальный bare remote;
  - без `apply=true` любые write-action возвращают fail-closed;
  - большие diff’ы уходят в артефакты.
- **Tests**:
  - `tests/repo-git-primitives.test.ts`: init temp repo + bare remote; сценарий commit/push;
  - `tests/repo-write-gating.test.ts`: без apply=true мутации запрещены.
- **Blockers**:
  - требуется наличие `git` в окружении тестов/CI.

### Milestone 2 — GitOps Plan/Status: `gitops.status`, `gitops.plan`

#### M2.1 — Расширить Context markers: `argocd`, `flux`, `gitops`
- **Goal**: корректные `context.tags` для маршрутизации GitOps.
- **Implementation**:
  - добавить в `src/services/ContextService.ts` маркеры:
    - `argocd`: `applicationset`, `argocd` manifests, `argocd-apps/`;
    - `flux`: `gotk-components.yaml`, `kustomization.toolkit.fluxcd.io`, `helmrelease` CRDs;
  - добавить derived tags: `gitops = argocd || flux` (либо на уровне tags derivation).
- **Done criteria**:
  - на fixture-деревьях контекста теги выставляются детерминированно;
  - `workspace.summary` начинает предлагать gitops-capabilities только когда теги совпадают.
- **Tests**:
  - расширить `tests/context-service.test.ts`: фикстуры директорий с маркерами → ожидаемые tags.
- **Blockers**:
  - нужно согласовать «минимальные маркеры», чтобы не было ложных срабатываний.

#### M2.2 — Проброс `apply` в runbook input + контекстная резолюция capability (routing)
- **Goal**: (1) tool-level write gating работает под `mcp_intent`/`workspace.run`; (2) один public intent может иметь несколько реализаций по `when`.
- **Implementation**:
  - **apply**: при `IntentManager.execute` добавлять `apply` в `step.inputs` (или в общий input), чтобы runbook мог прокидывать `apply: {{ input.apply }}` в `mcp_repo` write actions;
  - **routing**: расширить `CapabilityService.findByIntent(...)`/`IntentManager.resolveCapability(...)`:
    - собрать все capabilities с `intent == <intentType>`;
    - выбрать ту, у которой `when` матчится с `intent.inputs.context` (через `matchesWhen`);
    - при неоднозначности — детерминированный tie-break (например сортировка по name).
- **Done criteria**:
  - `mcp_repo.apply_patch` вызывается из runbook только когда внешний intent был `apply=true`;
  - можно завести две capabilities с одним intent (например `gitops.plan.argocd` и `gitops.plan.flux`) и видеть, что выбирается корректная по tags.
- **Tests**:
  - `tests/intent-manager.test.ts`: проверка, что `input.apply` доступен внутри runbook input;
  - новый `tests/capability-routing.test.ts`: две capabilities с разными `when` → выбирается ожидаемая.
- **Blockers**:
  - требуется определить и зафиксировать поведение при «нет совпадений when» (fail или fallback).

#### M2.3 — `mcp_repo.render`: kustomize/helm/plain + артефакты
- **Goal**: единый render primitive для `gitops.plan`.
- **Implementation**:
  - `render` action в `mcp_repo`:
    - `type: kustomize | helm | plain` (или autodetect по `context.tags`);
    - на выход — `render.yaml` артефакт;
    - ограничение размера inline результата.
  - валидации: инструменты должны быть allowlisted, иначе fail-closed с понятной ошибкой.
- **Done criteria**:
  - для kustomize overlay/helm chart возвращается стабильный `artifact://.../render.yaml`;
  - при отсутствии бинаря (helm/kubectl) — понятный диагностический error без падения всего процесса (в рамках политики).
- **Tests**:
  - `tests/repo-render.test.ts`: минимальный plain render (без внешних бинарей);
  - опционально: kustomize/helm тесты с условным skip, если бинарь отсутствует.
- **Blockers**:
  - наличие `kubectl`/`kustomize`/`helm` в CI (если хотим не-skip).

#### M2.4 — Реализовать `gitops.status` и `gitops.plan` (capabilities + runbooks + evidence)
- **Goal**: обеспечить «golden path» `gitops.plan` с артефактами и спокойным `.context` выводом.
- **Implementation**:
  - добавить capabilities в `capabilities.json`:
    - `gitops.status.*` (read)
    - `gitops.plan.*` (read)
  - добавить runbooks в `runbooks.json`, использующие `mcp_repo.repo_info`, `mcp_repo.render`, `mcp_repo.exec(kubectl diff)`;
  - вернуть `.context` summary + `R:` ссылки на `render.yaml`, `diff.patch`, `plan.context`.
- **Done criteria**:
  - `workspace.run(intent_type=gitops.plan, ...)` в dry-run режиме формирует план (IntentManager.preview) без side-effects;
  - `workspace.run(..., apply=true)` **не требуется** (это read intent), но артефакты формируются;
  - крупные payload’ы всегда в артефактах, stdout остаётся коротким.
- **Tests**:
  - `tests/gitops-plan.test.ts`: собрать in-memory ToolExecutor stub (или реальный RepoManager на temp repo) и проверить:
    - артефакты созданы;
    - stdout не содержит гигантских кусков yaml/diff.
- **Blockers**:
  - нужен договор о формате `plan.context` (минимальные поля, ссылки, summary).

### Milestone 3 — Propose: `gitops.propose` (branch/commit/push + PR/MR)

#### M3.1 — Репозиторный workflow: branch naming + push в локальный remote (e2e)
- **Goal**: гарантировать, что Git primitives покрывают реальный «propose» путь.
- **Implementation**:
  - добавить в `mcp_repo` поддержку:
    - create/switch branch (если решим выделить отдельный action, или через `exec git switch -c` с allowlist);
    - «deterministic branch name» helper (например `sf/<intent>/<timestamp>-<shortid>`).
- **Done criteria**:
  - тестовый сценарий: temp repo → branch → patch → commit → push → remote содержит ветку и commit.
- **Tests**:
  - расширить `tests/repo-git-primitives.test.ts`: branch+push path.
- **Blockers**:
  - нужна политика именования веток и стратегия конфликтов.

#### M3.2 — Git provider detection (GitHub/GitLab) по remote URL
- **Goal**: автоматом выбирать runbook GitHub vs GitLab.
- **Implementation**:
  - в `mcp_repo.repo_info` добавить нормализованный provider сигнал (`github|gitlab|unknown`) + owner/repo;
  - добавить override через input (если repo unusual).
- **Done criteria**:
  - ssh/https remotes корректно распознаются;
  - provider/owner/repo используются downstream runbooks без дополнительных парсеров.
- **Tests**:
  - `tests/repo-remote-detect.test.ts`: таблица URL → ожидаемый provider/owner/repo.
- **Blockers**:
  - нужно определить минимальный набор форматов URL (git@, https://, self-hosted gitlab).

#### M3.3 — GitHub PR propose (runbook) + контрактные тесты через локальный HTTP server
- **Goal**: `gitops.propose` создаёт PR + публикует evidence (links) без ручного оператора.
- **Implementation**:
  - новый runbook `gitops.propose.github`:
    - `mcp_repo.*` для ветки/коммита/push;
    - `mcp_api_client.request` для:
      - create PR,
      - post comment с `artifact://...` ссылками,
      - включение auto-merge (policy-gated, optional).
  - capability `gitops.propose` маршрутизирует на `gitops.propose.github` при provider=github.
- **Done criteria**:
  - PR url + ids возвращаются в `.context` как `R:`;
  - любые токены редактируются/не попадают в stdout/artifacts.
- **Tests**:
  - `tests/gitops-propose-github.test.ts`: поднять локальный `http.createServer()` как fake GitHub API:
    - проверить payload запросов;
    - проверить, что runbook возвращает PR url.
- **Blockers**:
  - требуется определить auth contract для GitHub (api_profile + Bearer token).

#### M3.4 — GitLab MR propose (runbook) + тесты с fake GitLab
- **Goal**: parity с GitHub.
- **Implementation**: аналогично M3.3, но с GitLab endpoints.
- **Done criteria**: MR url + ids; evidence comment.
- **Tests**:
  - `tests/gitops-propose-gitlab.test.ts`: fake server + контракт запросов.
- **Blockers**:
  - различия GitLab self-hosted URL/path; нужен нормализатор.

### Milestone 4 — CI gates (embedded into `gitops.propose`)

#### M4.1 — CI detection + required checks policy
- **Goal**: определить провайдера CI и список required contexts.
- **Implementation**:
  - использовать `ContextService` маркеры (`.github/workflows`, `gitlab-ci.yml`) + provider;
  - добавить policy на target: `required_checks: [..]`, `max_wait_ms`, `max_attempts`.
- **Done criteria**:
  - `gitops.propose` знает, какие чеки ждать, и сколько времени.
- **Tests**:
  - `tests/ci-detect.test.ts`: fixture repo layout → ожидаемый ci provider.
- **Blockers**:
  - требуются соглашения по именам check contexts (GitHub) / job names (GitLab).

#### M4.2 — Wait-for-checks state machine (bounded) + лог-артефакты
- **Goal**: закрыть delivery loop до merge.
- **Implementation**:
  - реализовать polling (в коде, не в runbook DSL) как helper (например `src/core/waiter.ts`):
    - backoff,
    - `timeout_ms`,
    - `max_attempts`.
  - `gitops.propose` после PR/MR:
    - опрашивает CI статус через `mcp_api_client`;
    - при fail — сохраняет diagnostics/log URLs в артефакты.
- **Done criteria**:
  - при “pending → success” propose завершается success;
  - при “pending → failure” propose завершается fail-closed и прикладывает артефакт с summary.
- **Tests**:
  - `tests/gitops-ci-wait.test.ts`: fake API, управляемые ответы по времени (можно через ускоренный таймер и короткие интервалы).
- **Blockers**:
  - требуется договор о том, где брать логи (URL’ы) и что именно сохранять.

#### M4.3 — Merge policy (auto-merge / merge queue) + enforcement
- **Goal**: операторless merge при выполненных gate’ах.
- **Implementation**:
  - политика target: `mode: operatorless`, `merge: auto|manual|queue`;
  - GitHub/GitLab adapters включают auto-merge или делают merge вызовом API.
- **Done criteria**:
  - в operatorless mode merge делается автоматически при success checks;
  - если политика запрещает merge — выполнение останавливается (no side effects).
- **Tests**:
  - расширить `tests/gitops-propose-github.test.ts`/`gitlab`: проверка “merge denied” vs “merge allowed”.
- **Blockers**:
  - требуется чётко описать минимальный policy schema и где он хранится (projects.json).

### Milestone 5 — Verify gates: rollout + observability

#### M5.1 — Kubernetes rollout verifier (read) + артефакты
- **Goal**: `gitops.verify` умеет подтверждать rollout.
- **Implementation**:
  - runbook `gitops.verify.k8s.rollout`:
    - `kubectl rollout status`/`kubectl get ... -o json` через `mcp_repo.exec`;
    - сохранение сырого json в артефакт;
    - возврат короткого verdict.
- **Done criteria**:
  - verifier возвращает `pass|fail|unknown` (в зависимости от политики) и ссылки на артефакты;
  - при ошибке kubectl — понятная диагностика.
- **Tests**:
  - `tests/gitops-verify-rollout.test.ts`: stub `mcp_repo.exec` (ToolExecutor with fake) → ожидаемый verdict.
- **Blockers**:
  - нужно определить “что именно проверяем” (deployments vs rollouts/argo-rollouts).

#### M5.2 — Prometheus/SLO verifier через `mcp_api_client`
- **Goal**: количественная оценка регрессий.
- **Implementation**:
  - runbook `gitops.verify.metrics`:
    - `mcp_api_client.request` к Prometheus API;
    - thresholds в policy (`error_rate_max`, `p95_latency_max`, окна времени);
    - raw responses → артефакты.
- **Done criteria**:
  - при превышении thresholds verifier fail;
  - `.context` возвращает именно verdict + ссылку на raw.
- **Tests**:
  - `tests/gitops-verify-metrics.test.ts`: fake Prometheus server, разные ответы → pass/fail.
- **Blockers**:
  - нужен контракт: где хранится Prometheus base_url/token (api_profile / target field).

#### M5.3 — Error-regression verifier (Sentry-like API) через `mcp_api_client`
- **Goal**: автоматически ловить рост ошибок после deploy.
- **Implementation**:
  - runbook `gitops.verify.errors`:
    - запрос агрегированных метрик ошибок;
    - thresholds (`new_issues_max`, `error_events_delta_max`).
- **Done criteria**:
  - корректный fail при регрессии; артефакты с raw payload.
- **Tests**:
  - `tests/gitops-verify-errors.test.ts`: fake server, pass/fail.
- **Blockers**:
  - конкретика API error tracker (эндпойнты/модель) должна быть зафиксирована или вынесена в пресеты.

### Milestone 6 — Controller ops: `gitops.sync`, `gitops.rollback`

#### M6.1 — ArgoCD sync/status/rollback primitives
- **Goal**: поддержка ArgoCD без новых tools.
- **Implementation**:
  - runbooks:
    - `gitops.argocd.status` (read),
    - `gitops.argocd.sync` (write, apply-gated),
    - `gitops.argocd.rollback` (write, apply-gated);
  - предпочтительно через HTTP API (`mcp_api_client`), CLI fallback через `mcp_repo.exec`.
- **Done criteria**:
  - `gitops.sync`/`gitops.rollback` в operatorless режиме могут инициировать sync/rollback;
  - крупные ответы ArgoCD → артефакты.
- **Tests**:
  - `tests/argocd-runbooks.test.ts`: fake ArgoCD server, happy/fail paths.
- **Blockers**:
  - нужна auth схема ArgoCD (api_profile/vault) и список required endpoints.

#### M6.2 — Flux reconcile/status primitives
- **Goal**: поддержка Flux через Kubernetes API.
- **Implementation**:
  - runbooks:
    - `gitops.flux.status`, `gitops.flux.sync`/`reconcile`, `gitops.flux.rollback` (если применимо);
  - реализация через `kubectl` json + `mcp_repo.exec`.
- **Done criteria**:
  - reconcile запускается только при apply=true;
  - статус отдаёт детерминированный verdict.
- **Tests**:
  - `tests/flux-runbooks.test.ts`: ToolExecutor stub + проверка args.
- **Blockers**:
  - требуется зафиксировать «какие CRD проверяем» (Kustomization/HelmRelease/GitRepository).

#### M6.3 — Root intents: `gitops.sync` и `gitops.rollback` + diff-before-apply
- **Goal**: единый UX для sync/rollback, включающий hard gate “diff-before-apply”.
- **Implementation**:
  - capabilities: `gitops.sync.*`, `gitops.rollback.*` с `effects.requires_apply=true`;
  - enforce “diff-before-apply”:
    - хранить reference на последний `gitops.plan` artifact в `StateService` в рамках `trace_id`/session;
    - `gitops.sync` проверяет наличие plan evidence или explicit override.
- **Done criteria**:
  - `gitops.sync` без prior plan → fail-closed;
  - с plan → разрешает controller sync.
- **Tests**:
  - `tests/gitops-diff-before-apply.test.ts`: state seeded → allow/deny.
- **Blockers**:
  - нужно решить: план привязан к `trace_id` или к project/target (и TTL).

### Milestone 7 — Hardening + operatorless `gitops.release`

#### M7.1 — Policy engine: allowlists, change windows, locks (fail-closed)
- **Goal**: сделать безопасность «скучной»: всё запрещено, пока явно не разрешено policy.
- **Implementation**:
  - описать policy schema в `projects.json` (без отдельного инструмента):
    - `mode: operatorless`,
    - allowlist remotes/orgs,
    - allowlist namespaces/resources,
    - change windows,
    - environment lock.
  - enforcement точки:
    - `mcp_repo.git_push`,
    - `gitops.sync/rollback`,
    - CI merge.
- **Done criteria**:
  - при отсутствии policy для target любые write операции fail-closed;
  - lock предотвращает параллельные release в один target.
- **Tests**:
  - `tests/gitops-policy.test.ts`: набор policy-кейсов allow/deny, включая lock.
- **Blockers**:
  - нужен формат хранения lock (StateService persistent vs file vs remote).

#### M7.2 — `gitops.release`: state machine (plan→propose→merge→sync→verify→rollback)
- **Goal**: один intent закрывает весь loop без человека.
- **Implementation**:
  - реализовать `gitops.release` как отдельную capability+runbook **или** как специальный кодовый orchestrator (предпочтительно кодом, т.к. нужны ожидания/ретраи);
  - bounded waits/retries:
    - CI checks wait,
    - controller sync wait,
    - rollout/metrics waits,
    - `max_attempts` + `timeout_ms` на каждый этап.
  - при verify failure — авто-запуск `gitops.rollback` (policy-driven).
- **Done criteria**:
  - один вызов `workspace.run(intent_type=gitops.release, apply=true)`:
    - создаёт PR/MR,
    - дожидается CI,
    - мержит,
    - синкает,
    - верифицирует,
    - при провале — делает rollback,
    - всегда оставляет артефакты на каждом этапе.
- **Tests**:
  - `tests/gitops-release-autopilot.test.ts`: полностью на stubbed ToolExecutor + fake HTTP servers, с детерминированными “pending→success/fail” сценариями.
- **Blockers**:
  - требуется выбрать архитектуру orchestrator (внутри IntentManager vs отдельный Manager/Service) и зафиксировать контракт входов/выходов.

#### M7.3 — End-to-end smoke (без настоящих облаков): demo repo + fake providers
- **Goal**: CI-проверяемый e2e без доступа к реальным GitHub/Argo/Prometheus.
- **Implementation**:
  - добавить/расширить `integration/smoke.ts`:
    - создать temp repo + bare remote,
    - поднять fake GitHub/GitLab/CI/Argo/Prometheus servers,
    - прогнать `gitops.release` и проверить финальные артефакты.
- **Done criteria**:
  - `npm run smoke` проходит локально и в CI среде (без внешнего интернета);
  - smoke проверяет ключевой инвариант: «large payload → artifact, stdout → calm context».
- **Tests**:
  - smoke сам по себе (как интеграционный тест), плюс короткие unit тесты для общих helper’ов.
- **Blockers**:
  - время выполнения smoke: нужно удержать в разумных пределах (например <30–60s).
