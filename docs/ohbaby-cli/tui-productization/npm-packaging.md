# NPM Packaging Smoke

## Decision

Development stays on the pnpm workspace. The user-facing npm package is `ohbaby-cli`, and its global binary is `ohbaby`.

The publishable package graph is:

- `ohbaby-cli` depends on `ohbaby-agent`, `ohbaby-server`, and `ohbaby-sdk`.
- `ohbaby-server` depends on `ohbaby-agent` and `ohbaby-sdk`.
- `ohbaby-agent` depends on `ohbaby-sdk` and `ohbaby-llm`.
- `ohbaby-sdk` and `ohbaby-llm` have no runtime workspace dependency.
- `ohbaby-llm` provides the independent LLM public API; its only export path is the package root.

Workspace packages should be publishable npm packages, with `dist` as the shipped artifact. Development manifests keep `workspace:*` dependencies, and the publish artifact is produced with pnpm's pack/publish semantics so those workspace ranges are rewritten to package versions in the generated tarballs:

- `ohbaby-cli` depends on the published `ohbaby-agent`, `ohbaby-server`, and `ohbaby-sdk` package versions.
- `ohbaby-server` depends on the published `ohbaby-agent` and `ohbaby-sdk` package versions.
- `ohbaby-agent` depends on the published `ohbaby-sdk` and `ohbaby-llm` package versions.

External runtime dependencies still resolve through npm during installation. The packed smoke test verifies the npm-facing artifact by installing the locally packed package graph into a temporary global prefix.

For a public release, publish the same version of all five public packages in dependency order: `ohbaby-sdk`, `ohbaby-llm`, `ohbaby-agent`, `ohbaby-server`, then `ohbaby-cli`. End users only install `ohbaby-cli`:

```bash
npm install -g ohbaby-cli
ohbaby
```

## Risks

- `workspace:*` dependencies are valid for pnpm development but invalid in a package consumed by npm if raw manifests are packed with npm directly. The smoke test uses pnpm pack so the tarball manifests contain npm-compatible version ranges.
- Bundling workspace packages under pnpm's isolated node linker can pull symlinked dependency trees into the tarball or fail during pack. This task avoids bundling and treats all five workspace library/CLI packages as publishable packages.
- `private: true` blocks publishing even when `npm pack` succeeds, so publishable packages must remove package-level private markers.
- The smoke test must not publish packages or require provider credentials. It validates local workspace tarballs while npm resolves third-party runtime dependencies as it would during a normal global install.
- The global install test runs in a temporary prefix so it does not alter the developer machine's global npm installation.

The root build selects `./packages/**` with `--sort`, so `ohbaby-llm` participates automatically before its dependents; CLI packaging runs after the sorted build. Package versions remain `0.1.16` for this extraction. This document describes release preparation, not a completed npm publication.

## Verification

The packaging smoke test will:

1. Pack `ohbaby-sdk`, `ohbaby-llm`, `ohbaby-agent`, `ohbaby-server`, and `ohbaby-cli` into a temporary directory with `pnpm pack --json`.
2. Assert packed file lists do not contain `node_modules` or parent-directory paths, and packed manifests have no remaining `workspace:` dependencies. `ohbaby-agent` must name the concrete `ohbaby-llm` version.
3. Serve those tarballs through a temporary local registry and install only `ohbaby-cli@<version>` with `npm install -g --prefix <temp-prefix> --registry <local-registry>` from an isolated directory, with `NODE_PATH` cleared.
4. Import the installed `ohbaby-cli`, `ohbaby-agent`, and `ohbaby-server` packages and assert the public exports exist.
5. Run the installed `ohbaby --help` and assert the yargs command surface.
6. Run the installed `ohbaby --version` and assert it matches the `ohbaby-cli` package version.

The smoke intentionally imports `ohbaby-cli` without rendering the TUI, then uses `--help` and `--version` for the binary. Those paths do not load provider keys, start an interactive TUI, or contact network services.
