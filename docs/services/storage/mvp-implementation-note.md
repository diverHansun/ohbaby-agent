# Storage MVP Implementation Note

The storage service is a local file object store for large blobs, debug
artifacts, task output, and snapshot payloads. Structured session/message/run
state belongs in `services/database`.

Current concurrency contract:

- Single-object writes use temporary-file-plus-rename atomic replacement.
- `updateJson()` is serialized by absolute target path across all
  `createStorage()` instances in the same Node.js process.
- The MVP does not implement cross-process file locks. Multiple backend
  processes writing the same storage root are outside the supported deployment
  shape for now.
- Multi-object consistency is not a storage responsibility. Callers that need
  metadata plus artifact consistency should write artifacts first, then commit
  database pointers, and clean up orphaned artifacts on failure.
