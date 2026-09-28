---
name: regen-pr
description: Regenerate the committed app bundle on a pull request that could not do it itself, usually a Dependabot bump of a bundled dependency failing "Generated artifacts in sync".
argument-hint: "<pr-number>"
disable-model-invocation: true
---

# Regenerate a pull request's generated files

Pull request: #$ARGUMENTS

`pnpm gen:app` inlines what the app imports, so a bump of a bundled dependency changes
`src/lib/app-bundle.generated.ts`. Dependabot does not run repository code, so its pull
request fails CI until a maintainer regenerates. The reasoning, and why this is not a
workflow, is in the header of `scripts/regen-pr.ts`.

## 1. Review first

Regenerating installs and bundles the new dependency version. Read the pull request's diff
and the dependency's changelog before running anything. Pushing to a Dependabot branch stops
Dependabot rebasing it, so this is the last step before merge.

## 2. Regenerate locally

```sh
pnpm regen:pr $ARGUMENTS
```

It works in a throwaway worktree under the system temp directory, commits there, and prints
the diff. The current checkout is not touched. Show the user the diff summary.

## 3. Push only when the user says so

```sh
pnpm regen:pr $ARGUMENTS --push
```

Ask before running this. It pushes to the pull request branch with the active `gh` account.
Then confirm CI goes green on the pull request (`gh pr checks $ARGUMENTS`).
