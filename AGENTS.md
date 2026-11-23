# General working agreements

## Git workflow

- Work directly on `main`. Do not create separate branches, worktrees or pull
  requests unless Steve explicitly requests an exception.
- Inspect the working tree before edits and synchronize with `origin/main` using
  a fast-forward when possible. Preserve existing changes.
- Prepare and validate changes, then show the concrete result. Commit and push
  directly to `origin/main` only when Steve confirms those changes.

## Local builds and publication

- Server images are built and verified on the development computer with
  `scripts/release-local.py` (`pnpm release:check|release:prepare|release:publish`);
  see [local releases](docs/LOCAL_RELEASES.md). Do not restore automatic image
  publication in GitHub Actions.
- GitHub stores the source (mirrored as a pull mirror in Gitea). The private Docker
  image lives in the local Gitea Container Registry
  (`100.81.25.109:30008/n7steve/muxplorer`).
- TrueNAS consumes `100.81.25.109:30008/n7steve/muxplorer:latest` via
  `scripts/muxplorer-autoupdate.sh`.
- Never publish a preview (`--preview`) or bypass tests/acceptance checks.
