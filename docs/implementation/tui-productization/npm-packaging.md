# NPM Packaging Smoke

## Decision

Development stays on the pnpm workspace. The user-facing npm package is `ohbaby-agent`, and its global binary remains `ohbaby`.

The publishable package graph is:

- `ohbaby-agent` depends on `ohbaby-tui` and `ohbaby-sdk`.
- `ohbaby-tui` depends on `ohbaby-sdk`.
- `ohbaby-sdk` has no runtime workspace dependency.

Workspace packages should be publishable npm packages, with `dist` as the shipped artifact. Development manifests keep `workspace:*` dependencies, and the publish artifact is produced with pnpm's pack/publish semantics so those workspace ranges are rewritten to package versions in the generated tarballs:

- `ohbaby-agent` depends on the packed `ohbaby-tui` and `ohbaby-sdk` packages.
- `ohbaby-tui` depends on the packed `ohbaby-sdk` package.

External runtime dependencies still resolve through npm during installation. The packed smoke test verifies the npm-facing artifact by installing the locally packed package graph into a temporary global prefix.

## Risks

- `workspace:*` dependencies are valid for pnpm development but invalid in a package consumed by npm if raw manifests are packed with npm directly. The smoke test uses pnpm pack so the tarball manifests contain npm-compatible version ranges.
- Bundling workspace packages under pnpm's isolated node linker can pull symlinked dependency trees into the tarball or fail during pack. This task avoids bundling and treats `ohbaby-sdk` and `ohbaby-tui` as publishable packages.
- `private: true` blocks publishing even when `npm pack` succeeds, so publishable packages must remove package-level private markers.
- The smoke test must not publish packages or require provider credentials. It validates local workspace tarballs while npm resolves third-party runtime dependencies as it would during a normal global install.
- The global install test runs in a temporary prefix so it does not alter the developer machine's global npm installation.

## Verification

The packaging smoke test will:

1. Pack `ohbaby-sdk`, `ohbaby-tui`, and `ohbaby-agent` into a temporary directory with `pnpm pack --json`.
2. Assert packed file lists do not contain `node_modules` or parent-directory paths.
3. Install those tarballs with `npm install -g --prefix <temp-prefix>`.
4. Run the installed `ohbaby --help` and assert the usage output.
5. Run the installed `ohbaby --version` and assert it matches the package version.

The smoke intentionally uses `--help` and `--version` only. Those paths do not load provider keys, start an interactive TUI, or contact network services.
