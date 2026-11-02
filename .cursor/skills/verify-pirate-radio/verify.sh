#!/usr/bin/env bash
# Scratch-stack lifecycle for the Pirate Radio verification skill.
# launch, doctor, and cleanup operate on output/qa/verify/state.json.
# Cleanup signals only the recorded pids after checking cmdline and env.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
STATE="$ROOT/output/qa/verify/state.json"
DB_NAME="pirate_radio_verify"

usage() {
  echo "usage: bash .cursor/skills/verify-pirate-radio/verify.sh launch|doctor|cleanup" >&2
  exit 2
}

read_field() {
  node -e '
    const fs = require("fs");
    const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2].split(".").reduce((item, key) => item?.[key], state);
    if (value === undefined || value === null) process.exit(1);
    process.stdout.write(String(value));
  ' "$STATE" "$1"
}

write_state() {
  local oidc_pid="$1"
  local serve_pid="$2"
  VERIFY_OIDC_PID="$oidc_pid" VERIFY_SERVE_PID="$serve_pid" VERIFY_STATE="$STATE" node -e '
    const fs = require("fs");
    const path = require("path");
    const env = process.env;
    const state = {
      runId: env.VERIFY_RUN_ID,
      publicUrl: env.VERIFY_PUBLIC_URL,
      serviceHost: "127.0.0.1",
      servicePort: Number(env.VERIFY_SERVICE_PORT),
      oidcIssuer: env.VERIFY_OIDC_ISSUER,
      oidcPort: Number(env.VERIFY_OIDC_PORT),
      libraryDir: env.VERIFY_LIBRARY_DIR,
      devDir: env.VERIFY_DEV_DIR,
      databaseName: "pirate_radio_verify",
      pids: { oidc: Number(env.VERIFY_OIDC_PID), serve: Number(env.VERIFY_SERVE_PID) },
      evidenceDir: env.VERIFY_EVIDENCE_DIR,
      startedAt: env.VERIFY_STARTED_AT,
    };
    fs.mkdirSync(path.dirname(env.VERIFY_STATE), { recursive: true });
    fs.writeFileSync(env.VERIFY_STATE, JSON.stringify(state, null, 2) + "\n");
  '
}

pick_port() {
  local port=""
  local attempt
  for attempt in $(seq 1 20); do
    if port=$(node -e '
      const net = require("net");
      const blocked = new Set([8123, 9443, 5432]);
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const chosen = server.address().port;
        server.close(() => {
          if (blocked.has(chosen)) process.exit(2);
          process.stdout.write(String(chosen));
        });
      });
    '); then
      printf '%s\n' "$port"
      return 0
    fi
  done
  echo "could not pick a free port" >&2
  return 1
}

ensure_postgres() {
  if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
    echo "Postgres is not ready. Running scripts/dev/start.sh"
    env -u DATABASE_URL -u PIRATE_RADIO_LIBRARY_DIR -u SERVICE_PORT -u LOCAL_OIDC_PORT \
      -u PIRATE_RADIO_PUBLIC_URL -u PIRATE_RADIO_OIDC_ISSUER -u PIRATE_RADIO_FEEDS \
      -u PIRATE_RADIO_FEED_URL -u PIRATE_RADIO_DEV_DIR \
      bash "$ROOT/scripts/dev/start.sh"
  fi
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null
  if ! sudo -u postgres psql -d postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='pirate_radio'" | grep -q 1; then
    sudo -u postgres psql -d postgres -c "CREATE ROLE pirate_radio LOGIN PASSWORD 'pirate_radio'"
  fi
}

reset_verify_db() {
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'pirate_radio_verify' AND pid <> pg_backend_pid();"
  sudo -u postgres dropdb --if-exists pirate_radio_verify
  sudo -u postgres createdb -O pirate_radio pirate_radio_verify
}

preserve_logs() {
  if [ -z "${VERIFY_DEV_DIR:-}" ] || [ -z "${VERIFY_EVIDENCE_DIR:-}" ]; then
    return 0
  fi
  mkdir -p "$VERIFY_EVIDENCE_DIR"
  if [ -f "$VERIFY_DEV_DIR/oidc.log" ]; then
    cp "$VERIFY_DEV_DIR/oidc.log" "$VERIFY_EVIDENCE_DIR/oidc.log"
  fi
  if [ -f "$VERIFY_DEV_DIR/serve.log" ]; then
    cp "$VERIFY_DEV_DIR/serve.log" "$VERIFY_EVIDENCE_DIR/serve.log"
  fi
}

launch() {
  VERIFY_LAUNCH_OK=0
  trap 'status=$?; if [ "$VERIFY_LAUNCH_OK" != 1 ]; then preserve_logs || true; "$0" cleanup || true; fi; exit "$status"' EXIT
  if [ -f "$STATE" ]; then
    echo "state exists at $STATE. Run cleanup before launch." >&2
    exit 1
  fi
  unset XAI_API_KEY X_API_BEARER_TOKEN HA_LONG_LIVED_TOKEN HOMELAB_FUNCTIONS_TOKEN CURSOR_API_KEY HA_URL PIRATE_RADIO_SERVICE_TOKEN PIRATE_RADIO_SEED_DYNAMIC PIRATE_RADIO_REAUTH_URL
  cd "$ROOT"
  npm run build
  VERIFY_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  VERIFY_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  VERIFY_DEV_DIR="/tmp/pirate-radio-verify-$VERIFY_RUN_ID"
  VERIFY_LIBRARY_DIR="$VERIFY_DEV_DIR/library"
  VERIFY_EVIDENCE_DIR="$ROOT/output/qa/verify/$VERIFY_RUN_ID"
  mkdir -p "$VERIFY_DEV_DIR" "$VERIFY_LIBRARY_DIR" "$VERIFY_EVIDENCE_DIR"
  export VERIFY_RUN_ID VERIFY_STARTED_AT VERIFY_DEV_DIR VERIFY_LIBRARY_DIR VERIFY_EVIDENCE_DIR
  VERIFY_SERVICE_PORT="$(pick_port)"
  VERIFY_OIDC_PORT="$(pick_port)"
  if [ "$VERIFY_SERVICE_PORT" = "$VERIFY_OIDC_PORT" ]; then
    VERIFY_OIDC_PORT="$(pick_port)"
  fi
  # shellcheck source=scripts/dev/env.sh
  source "$ROOT/scripts/dev/env.sh"
  export NODE_ENV=development
  export PIRATE_RADIO_DEV_STACK=1
  export PIRATE_RADIO_DEV_HOST=localhost
  export LOCAL_OIDC_HOST=localhost
  export LOCAL_OIDC_PORT="$VERIFY_OIDC_PORT"
  export LOCAL_OIDC_CLIENT_ID=pirate-radio-local
  export LOCAL_OIDC_SUBJECT=demo-reader-subject
  export LOCAL_OIDC_USERNAME=demo.reader
  export LOCAL_OIDC_NAME="Demo Reader"
  export LOCAL_OIDC_EMAIL=demo.reader@example.com
  export PIRATE_RADIO_OIDC_ISSUER="https://localhost:${VERIFY_OIDC_PORT}"
  export PIRATE_RADIO_OIDC_CLIENT_ID=pirate-radio-local
  export PIRATE_RADIO_OIDC_CLIENT_SECRET=local-secret
  export SERVICE_HOST=127.0.0.1
  export SERVICE_PORT="$VERIFY_SERVICE_PORT"
  export PIRATE_RADIO_PUBLIC_URL="http://localhost:${VERIFY_SERVICE_PORT}"
  export PIRATE_RADIO_DEV_DIR="$VERIFY_DEV_DIR"
  export PIRATE_RADIO_LIBRARY_DIR="$VERIFY_LIBRARY_DIR"
  export PIRATE_RADIO_STATE_PATH="$VERIFY_LIBRARY_DIR/state.json"
  export DATABASE_URL="postgres://pirate_radio:pirate_radio@127.0.0.1:5432/${DB_NAME}"
  export PIRATE_RADIO_POLL_INTERVAL_MS=86400000
  export PIRATE_RADIO_ENABLE_ALIGNMENT=false
  export PWR_HEADLESS=true
  unset PIRATE_RADIO_FEED_URL
  export PIRATE_RADIO_FEEDS
  PIRATE_RADIO_FEEDS="$(node -e 'process.stdout.write(JSON.stringify([{id:"verify-fixture",name:"Verify Fixture",type:"pirate-wires",url:process.argv[1]}]))' "${PIRATE_RADIO_OIDC_ISSUER}/feed.xml")"
  export VERIFY_PUBLIC_URL="$PIRATE_RADIO_PUBLIC_URL"
  export VERIFY_SERVICE_PORT VERIFY_OIDC_PORT
  export VERIFY_OIDC_ISSUER="$PIRATE_RADIO_OIDC_ISSUER"
  write_state 0 0
  ensure_postgres
  reset_verify_db
  node scripts/dev/seed.mjs
  node -e '
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const slugs = manifest.items.map((item) => item.slug).sort();
    const expected = ["notes-on-shipping-audio", "regulators-discover-the-data-center", "return-of-the-generalist-engineer"];
    if (JSON.stringify(slugs) !== JSON.stringify(expected)) {
      console.error("seed manifest slugs: " + slugs.join(", "));
      process.exit(1);
    }
  ' "$VERIFY_LIBRARY_DIR/index.json"
  node scripts/dev/local-oidc.mjs >"$VERIFY_DEV_DIR/oidc.log" 2>&1 &
  local oidc_pid=$!
  write_state "$oidc_pid" 0
  local ready=0
  local _
  for _ in $(seq 1 30); do
    if ! kill -0 "$oidc_pid" 2>/dev/null; then
      echo "local OIDC exited before discovery" >&2
      cat "$VERIFY_DEV_DIR/oidc.log" >&2 || true
      exit 1
    fi
    if curl -skf -o /dev/null "$PIRATE_RADIO_OIDC_ISSUER/.well-known/openid-configuration"; then
      ready=1
      break
    fi
    sleep 0.5
  done
  if [ "$ready" != 1 ]; then
    echo "OIDC discovery was not ready" >&2
    exit 1
  fi
  node dist/src/cli.js serve >"$VERIFY_DEV_DIR/serve.log" 2>&1 &
  local serve_pid=$!
  write_state "$oidc_pid" "$serve_pid"
  ready=0
  for _ in $(seq 1 45); do
    if ! kill -0 "$serve_pid" 2>/dev/null; then
      echo "serve exited before it was ready" >&2
      cat "$VERIFY_DEV_DIR/serve.log" >&2 || true
      exit 1
    fi
    if grep -q "listening on 127.0.0.1:${SERVICE_PORT}" "$VERIFY_DEV_DIR/serve.log" \
      && grep -q "baselined .*verify-fixture" "$VERIFY_DEV_DIR/serve.log" \
      && curl -fsS "http://localhost:${SERVICE_PORT}/health" | grep -q '"ok":true'; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" != 1 ]; then
    echo "serve was not ready" >&2
    cat "$VERIFY_DEV_DIR/serve.log" >&2 || true
    exit 1
  fi
  doctor
  cat >"$VERIFY_EVIDENCE_DIR/launch.txt" <<EOF
runId $VERIFY_RUN_ID
publicUrl $PIRATE_RADIO_PUBLIC_URL
oidcIssuer $PIRATE_RADIO_OIDC_ISSUER
oidcPid $oidc_pid
servePid $serve_pid
libraryDir $VERIFY_LIBRARY_DIR
evidenceDir $VERIFY_EVIDENCE_DIR
EOF
  VERIFY_LAUNCH_OK=1
  echo "launch ok $PIRATE_RADIO_PUBLIC_URL"
}

doctor() {
  if [ ! -f "$STATE" ]; then
    echo "no verify state at $STATE" >&2
    exit 1
  fi
  VERIFY_STATE="$STATE" node -e '
    const fs = require("fs");
    const { execFileSync } = require("child_process");
    const state = JSON.parse(fs.readFileSync(process.env.VERIFY_STATE, "utf8"));
    const problems = [];
    function fail(message) { problems.push(message); }
    const url = new URL(state.publicUrl);
    if (url.protocol !== "http:" || url.hostname !== "localhost" || Number(url.port) !== state.servicePort) {
      fail("publicUrl must be http://localhost:<servicePort>");
    }
    if (state.servicePort === 8123 || state.oidcPort === 9443 || state.servicePort === 5432) {
      fail("refusing shared dev ports");
    }
    if (state.databaseName !== "pirate_radio_verify") fail("databaseName is not pirate_radio_verify");
    if (!String(state.libraryDir).startsWith("/tmp/pirate-radio-verify-")) fail("libraryDir is not a scratch library");
    if (!String(state.devDir).startsWith("/tmp/pirate-radio-verify-")) fail("devDir is not a scratch directory");
    function procText(pid, file) {
      return fs.readFileSync(`/proc/${pid}/${file}`);
    }
    function checkPid(pid, needle, envPairs) {
      if (!pid) { fail("missing pid for " + needle); return; }
      if (!fs.existsSync(`/proc/${pid}`)) { fail("pid " + pid + " is not alive"); return; }
      const command = procText(pid, "cmdline").toString("utf8").replaceAll("\0", " ");
      if (!command.includes(needle)) fail("pid " + pid + " cmdline does not include " + needle + ": " + command.trim());
      const env = procText(pid, "environ").toString("utf8").split("\0");
      for (const pair of envPairs) {
        if (!env.includes(pair)) fail("pid " + pid + " env missing " + pair.split("=")[0]);
      }
    }
    checkPid(state.pids.oidc, "local-oidc.mjs", ["PIRATE_RADIO_DEV_DIR=" + state.devDir]);
    checkPid(state.pids.serve, "dist/src/cli.js", [
      "PIRATE_RADIO_DEV_DIR=" + state.devDir,
      "SERVICE_PORT=" + state.servicePort,
    ]);
    const serveCommand = state.pids.serve && fs.existsSync(`/proc/${state.pids.serve}`)
      ? procText(state.pids.serve, "cmdline").toString("utf8").replaceAll("\0", " ")
      : "";
    if (!serveCommand.includes("serve")) fail("serve pid cmdline does not include serve");
    const logPath = state.devDir + "/serve.log";
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    if (!log.includes("listening on 127.0.0.1:" + state.servicePort)) fail("serve log has no listening line");
    if (!log.includes("verify-fixture")) fail("serve log has no verify-fixture baseline");
    try {
      const health = execFileSync("curl", ["-fsS", "http://127.0.0.1:" + state.servicePort + "/health"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const localHealth = execFileSync("curl", ["-fsS", state.publicUrl + "/health"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (!health.includes("\"ok\":true") || !localHealth.includes("\"ok\":true")) fail("health body was not ok");
    } catch (error) {
      fail("health request failed");
    }
    try {
      execFileSync("curl", ["-skf", "-o", "/dev/null", state.oidcIssuer + "/.well-known/openid-configuration"], { stdio: "ignore" });
    } catch (error) {
      fail("OIDC discovery failed");
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(state.libraryDir + "/index.json", "utf8"));
      const slugs = new Set(manifest.items.map((item) => item.slug));
      for (const slug of ["return-of-the-generalist-engineer", "regulators-discover-the-data-center", "notes-on-shipping-audio"]) {
        if (!slugs.has(slug)) fail("manifest missing " + slug);
      }
    } catch (error) {
      fail("could not read scratch index.json");
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(problem);
      process.exit(1);
    }
    console.log("doctor ok " + state.publicUrl);
  '
}

kill_matching() {
  local pid="$1"
  local needle="$2"
  local env_pair="$3"
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then
    return 0
  fi
  if [ ! -d "/proc/$pid" ]; then
    echo "pid $pid already exited"
    return 0
  fi
  local command
  command=$(tr '\0' ' ' < "/proc/$pid/cmdline")
  case "$command" in
    *"$needle"*) ;;
    *)
      echo "refusing to kill $pid because cmdline does not include $needle" >&2
      return 1
      ;;
  esac
  if ! tr '\0' '\n' < "/proc/$pid/environ" | grep -Fqx "$env_pair"; then
    echo "refusing to kill $pid because its environment does not match this run" >&2
    return 1
  fi
  kill -TERM "$pid"
  local _
  for _ in $(seq 1 25); do
    if [ ! -d "/proc/$pid" ]; then
      return 0
    fi
    sleep 0.2
  done
  kill -KILL "$pid"
  sleep 0.2
  if [ -d "/proc/$pid" ]; then
    echo "pid $pid did not exit" >&2
    return 1
  fi
}

cleanup() {
  if [ ! -f "$STATE" ]; then
    echo "nothing to clean"
    exit 0
  fi
  local oidc_pid serve_pid dev_dir evidence_dir
  oidc_pid=$(read_field pids.oidc)
  serve_pid=$(read_field pids.serve)
  dev_dir=$(read_field devDir)
  evidence_dir=$(read_field evidenceDir)
  local database_name
  database_name=$(read_field databaseName)
  if [ "$database_name" != "$DB_NAME" ]; then
    echo "refusing to drop $database_name" >&2
    exit 1
  fi
  case "$dev_dir" in
    /tmp/pirate-radio-verify-[A-Za-z0-9T-]*) ;;
    *)
      echo "refusing to delete $dev_dir" >&2
      exit 1
      ;;
  esac
  case "$dev_dir" in
    *..*) echo "refusing to delete $dev_dir" >&2; exit 1 ;;
  esac
  case "$evidence_dir" in
    "$ROOT"/output/qa/verify/[A-Za-z0-9T-]*) ;;
    *)
      echo "refusing unexpected evidence dir $evidence_dir" >&2
      exit 1
      ;;
  esac
  kill_matching "$serve_pid" "cli.js serve" "PIRATE_RADIO_DEV_DIR=$dev_dir"
  kill_matching "$oidc_pid" "local-oidc.mjs" "PIRATE_RADIO_DEV_DIR=$dev_dir"
  sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'pirate_radio_verify' AND pid <> pg_backend_pid();"
  sudo -u postgres dropdb --if-exists pirate_radio_verify
  rm -rf "$dev_dir"
  rm -f "$STATE"
  if [ ! -d "$evidence_dir" ]; then
    echo "evidence dir missing after cleanup: $evidence_dir" >&2
    exit 1
  fi
  echo "cleanup done. evidence remains at $evidence_dir"
}

command_name="${1:-}"
case "$command_name" in
  launch) launch ;;
  doctor) doctor ;;
  cleanup) cleanup ;;
  *) usage ;;
esac
