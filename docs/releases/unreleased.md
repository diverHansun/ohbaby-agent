# Unreleased

See [v0.1.19](v0.1.19.md) for the latest release and upgrade notes.

## Installer progress

- The macOS, Linux, and Windows installers now show four numbered stages: checking the current installation, downloading Node.js, installing ohbaby, and activating the new version. In a terminal, the Node.js download shows a progress bar with its size. When the installer process’s standard error is redirected, it skips progress redraws. In Windows PowerShell, adding `2>` to `Invoke-Expression` redirects the PowerShell error stream while console progress remains visible.
- After a successful install, the installer prints one line saying whether ohbaby was installed, updated, or was already installed. It also shows the launcher location, what happened to PATH, and the command to start ohbaby. On Windows, the summary gives a PowerShell command that runs the installed launcher directly, including after an update in a child process.
- `ohbaby uninstall` now prints one numbered line per step and marks each one `done` or `failed`. On Windows, it then shows the commands to delete the installation directory.
- Before publishing, run a fresh install and an update with both scripts on a real Windows, macOS, and Linux terminal. Check that the progress bar clears and that the cursor comes back after Ctrl-C.
