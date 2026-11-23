# Trajectory Viewer

Independent Web service for reading Tuple cloud execution archives. It uses the
existing Tuple email sign-in and trajectory HTTP APIs. The browser receives an
opaque, HTTP-only session cookie. Tuple credentials and archive content are
held in memory for their respective requests and sessions.

## Run locally

From this directory, with Go 1.25 or newer and a reachable Tuple backend:

```sh
go run . -api-origin "$TRAJECTORY_API_ORIGIN" -listen 127.0.0.1:8765
```

Set `TRAJECTORY_API_ORIGIN` to the origin of the same backend used by the device
that uploaded the archives, without the `/v1` path. Open
[the local viewer](http://127.0.0.1:8765/) and sign in with that Tuple account.

For access through an HTTPS reverse proxy, pass its exact external URL via
`-public-origin`. Keep the Go listener private and terminate TLS at the proxy.
Use a trusted HTTP loopback or HTTPS origin for the Tuple API.

## Read a trajectory

Choose a run to see the execution state, archive integrity and event timeline.
Use **Prompt text** to search archived user or system messages by keyword or
phrase. The search applies the status, invocation ID and date filters and scans
all matching list pages. Each result shows the first matching model request.
Select a result to open its event. Search coverage can be limited by
metadata-only, redacted or incomplete archives. Dates use the browser's time zone.

In the timeline, filter by event type or tool name. The viewer reads all event
pages for the selected trajectory and displays matching events in sequence order.
Use **Failure events** to jump to a recorded error, or select **Failures** to see
only those events. Expand an event and select **Load archived content** to read
its payload when available. Archive integrity is reported separately.

```sh
go test -race ./...
node --test trajectory-tools.test.mjs
```

## Repeat the simulator upload check

Use a fresh iOS simulator, an empty temporary directory and the repository's
isolated integration runner from the Tuple backend checkout.

```sh
export TRAJECTORY_SMOKE_DIR="$(mktemp -d)"
python3 scripts/tests/run_isolated_integration.py \
  --output "$TRAJECTORY_SMOKE_DIR/isolated" --packages ./modules/robot \
  --run '^TestTrajectory(MySQLMigrationHTTPAndAccountBarrier|SimulatorCloudRoundTrip)$' \
  --test-timeout 45m --execute
```

In a second terminal, use the same temporary directory. From the app checkout,
run the native test against the published loopback origin.

```sh
flutter test -d "$NEW_SIMULATOR_UDID" \
  --dart-define="PINCHEE_API_ORIGIN=$(cat "$TRAJECTORY_SMOKE_DIR/api-origin")" \
  integration_test/agent_trajectory_cloud_smoke_test.dart
```

For browser acceptance, start the viewer against the same origin. The isolated
fixtures use `trajectory-smoke-primary@example.test` and
`trajectory-smoke-control@example.test` with password
`isolated-trajectory-smoke-26`. The primary account can view the synthetic
trajectory. The control account has an empty list.

After browser acceptance, run
`touch "$TRAJECTORY_SMOKE_DIR/verify"` to finish the MySQL check and stop the
isolated backend. Stop its standalone viewer with Ctrl-C.
