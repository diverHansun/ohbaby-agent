# Unreleased

The backend and SDK now support opening a temporary Side Chat, forking a session at an AI answer, and rewinding to a user prompt with an optional replacement.

**Database upgrade.** Migration `029_message_rewind` retains rewound turns and marks them as hidden. After upgrading, use a version that supports migration 029 to open sessions you have rewound. An older version can display those turns again and send them to the model.

See [v0.1.17](v0.1.17.md) and its [migration details](v0.1.17-migration.md) for the previous release.
