[LEGEND]
POLICY = A rule set that constrains agent behavior.

[CONTENT]
Contract: Policy v1

## Purpose
Define [POLICY]: the rule set that constrains agent behavior and defines stop conditions.

## Scope
- In scope: budgets, stop conditions, change protocol invariants, approval rules.
- Out of scope: project-specific technical architecture decisions.

## Interface
Policy object (all fields optional unless noted):
- mode: "operatorless" (required for write intents / repo writes).
- allow.intents: list of allowed intent types (deny by default when set).
- allow.merge: boolean (gate for gitops.propose/gitops.release merge=true).
- repo.allowed_remotes: list of allowed git remotes (e.g. ["origin"]).
- kubernetes.allowed_namespaces: list of allowed namespaces for kubectl write.
- change_windows: list of UTC windows { days, start, end } (deny outside).
- lock.enabled, lock.ttl_ms: write lock settings.

Policy profiles (project-level):
- project.policy_profiles.{name}: policy object.
- target.policy: policy object OR profile name.
- inputs.policy_profile / inputs.policy_profile_name: profile name.

## Errors
- Missing policy for GitOps write: denied (POLICY_REQUIRED).
- Non-operatorless mode: denied (POLICY_MODE_REQUIRED).
- Remote/namespace not allowed: denied (POLICY_DENIED_REMOTE / POLICY_DENIED_NAMESPACE).
- Outside change window: denied (POLICY_CHANGE_WINDOW).

## Examples
```text
policy:
  change_protocol: contracts-first
  stop_conditions:
    - secrets_required
    - irreversible_migration
```

Project policy profiles + target reference:
```text
project:
  policy_profiles:
    autonomy:
      mode: operatorless
      repo:
        allowed_remotes: [origin]
  targets:
    prod:
      policy: autonomy
```

Intent input selecting a profile:
```text
inputs:
  policy_profile_name: autonomy
```
