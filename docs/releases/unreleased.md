# Unreleased

See [v0.1.18](v0.1.18.md) for the latest release and upgrade notes.

## CLI installation and updates

- Install TUI and Web via npm, the macOS/Linux shell script, or the Windows PowerShell script. Both scripts install a private Node.js runtime.
- Use `ohbaby update` to update and `ohbaby uninstall` to remove the program while keeping user data. Use `ohbaby update --auto on` to enable TUI startup updates.
- Before publishing, verify both installers pin the current Node 24 patch version and appear at the root of the packed `ohbaby-cli` tarball.
- After publishing, verify both version-pinned jsDelivr installer URLs and run a fresh installation on the supported platforms.
