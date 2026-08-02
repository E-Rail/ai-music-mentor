# Demo v1 recovery point

The repository's existing commit `6d63c27` (`Initial project import`) is the immutable v1 recovery point. V2 was implemented in place without rewriting that commit or deleting its deterministic algorithms and fixtures.

For transition safety, v2 temporarily mounts the new router at both `/api/v1` and the former `/api` prefix. New frontend code and documentation use only `/api/v1`; the alias can be removed after saved demo sessions and scripts have migrated.

No Git tag or commit is created automatically by the implementation workflow. The maintainer can tag the existing commit as `demo-v1` when publishing history.
