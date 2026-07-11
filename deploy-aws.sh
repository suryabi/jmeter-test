#!/usr/bin/env bash
#
# deploy-aws.sh — BriefingIQ JMeter Runner: environment setup + deploy on AWS
# (Amazon Linux 2023 EC2 instance)
#
# What it does:
#   1. Installs Node.js 22, Java 17, JMeter 5.6.x, nginx, pm2
#   2. Clones the repo (or pulls latest if already present)
#   3. Installs API + UI dependencies, installs vendored jpgc-json plugins
#   4. Builds the Angular UI for production
#   5. Points the UI at the API via nginx same-domain proxy (/api/ -> :5050)
#   6. Starts the API under pm2 (survives reboot via pm2 startup + save)
#   7. Configures nginx to serve the UI and proxy /api/ (SSE-friendly)
#
# Usage:
#   sudo bash deploy-aws.sh
#
# Re-run any time to pull latest code, rebuild, and restart services.
#
# Configure the variables below before running (or export them beforehand).

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — edit these
# ---------------------------------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/suryabi/jmeter-test.git}"
APP_DIR="${APP_DIR:-/opt/biq-runner}"
BRANCH="${BRANCH:-main}"

# Public address users will hit (EC2 public IP or a domain pointed at it).
# Used to build the UI's runnerApiUrl (same-domain /api/ proxy) and the
# nginx server_name. Point this domain's DNS (A record) at the instance's
# public IP before running. Leave PUBLIC_DOMAIN empty instead to auto-detect
# the instance's public IPv4 via the EC2 metadata service.
PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-data-populate.briefingiq.com}"

# API runtime env (see README section 9 for the full list)
API_PORT="${API_PORT:-5050}"
ALLOW_CONCURRENT_RUNS="${ALLOW_CONCURRENT_RUNS:-false}"

# Apache JMeter version to install (must satisfy plans' 5.4+ requirement)
JMETER_VERSION="${JMETER_VERSION:-5.6.3}"
JMETER_HOME="/opt/apache-jmeter-${JMETER_VERSION}"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  echo "Run this script with sudo/root: sudo bash deploy-aws.sh" >&2
  exit 1
fi

log() { echo -e "\n==> $*"; }

if [[ -z "$PUBLIC_DOMAIN" ]]; then
  log "Detecting public IP via EC2 metadata service"
  TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" || true)
  PUBLIC_DOMAIN=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
    "http://169.254.169.254/latest/meta-data/public-ipv4" || true)
  if [[ -z "$PUBLIC_DOMAIN" ]]; then
    echo "Could not auto-detect public IP. Set PUBLIC_DOMAIN=<ip-or-domain> and re-run." >&2
    exit 1
  fi
  echo "Detected: $PUBLIC_DOMAIN"
fi

RUNNER_API_URL="http://${PUBLIC_DOMAIN}/api"

# ---------------------------------------------------------------------------
# 1) System packages: Node.js 22, Java 17, git, nginx
# ---------------------------------------------------------------------------
log "Updating system packages"
dnf update -y

log "Installing git, unzip, tar, nginx"
dnf install -y git unzip tar nginx

log "Installing Node.js 22.x (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node --version)" != v22* ]]; then
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  dnf install -y nodejs
fi
node --version
npm --version

log "Installing Java 17 (Amazon Corretto)"
dnf install -y java-17-amazon-corretto-devel
java -version

log "Installing pm2 (process manager for the API)"
npm install -g pm2

# ---------------------------------------------------------------------------
# 2) Apache JMeter
# ---------------------------------------------------------------------------
if [[ ! -d "$JMETER_HOME" ]]; then
  log "Installing Apache JMeter ${JMETER_VERSION}"
  curl -fsSL -o "/tmp/jmeter-${JMETER_VERSION}.tgz" \
    "https://dlcdn.apache.org/jmeter/binaries/apache-jmeter-${JMETER_VERSION}.tgz"
  tar -xzf "/tmp/jmeter-${JMETER_VERSION}.tgz" -C /opt
  rm "/tmp/jmeter-${JMETER_VERSION}.tgz"
else
  log "JMeter ${JMETER_VERSION} already installed at ${JMETER_HOME}"
fi

# Make JMETER_HOME's java use Corretto 17 explicitly (avoids picking up an
# older JDK on PATH).
if ! grep -q "^JAVA_HOME=" "${JMETER_HOME}/bin/setenv.sh" 2>/dev/null; then
  {
    echo "JAVA_HOME=$(dirname $(dirname $(readlink -f $(which java))))"
    export JAVA_HOME_LINE=1
  } >> "${JMETER_HOME}/bin/setenv.sh" 2>/dev/null || true
fi

ln -sf "${JMETER_HOME}/bin/jmeter" /usr/local/bin/jmeter
jmeter --version || true

# ---------------------------------------------------------------------------
# 3) Fetch application code
# ---------------------------------------------------------------------------
# Root owns nothing here after the first run (APP_DIR is chown'd to
# biqrunner below), so tell git it's fine for root to operate in it anyway.
git config --global --add safe.directory "$APP_DIR"

if [[ -d "$APP_DIR/.git" ]]; then
  log "Repo already present at $APP_DIR — pulling latest $BRANCH"
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  log "Cloning $REPO_URL into $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

# Non-root ownership so npm/pm2 don't run as root day-to-day.
id -u biqrunner >/dev/null 2>&1 || useradd -r -m -s /usr/sbin/nologin biqrunner
chown -R biqrunner:biqrunner "$APP_DIR"

# JMeter was extracted as root above; the biqrunner user needs write access
# to lib/ext to install the vendored jpgc-json plugin jars, and needs to run
# jmeter itself at runtime.
chown -R biqrunner:biqrunner "$JMETER_HOME"

# ---------------------------------------------------------------------------
# 4) Install dependencies (API + UI)
# ---------------------------------------------------------------------------
log "Installing API dependencies"
sudo -u biqrunner -H bash -c "cd '$APP_DIR' && npm install"

log "Installing UI dependencies"
sudo -u biqrunner -H bash -c "cd '$APP_DIR/ui' && npm install"

log "Installing vendored jpgc-json JMeter plugins"
export JMETER_HOME
sudo -u biqrunner -H bash -c "cd '$APP_DIR' && JMETER_HOME='$JMETER_HOME' npm run install:jmeter-plugins" \
  || echo "WARNING: vendored plugin install failed/skipped — if plans/BIQ.jmx needs jpgc-json, install manually (see README section 2, 'JMeter plugins')."

log "Running prerequisite validation"
sudo -u biqrunner -H bash -c "cd '$APP_DIR' && JMETER_HOME='$JMETER_HOME' npm run validate" || true

# ---------------------------------------------------------------------------
# 5) Build the Angular UI for production
# ---------------------------------------------------------------------------
log "Writing ui/src/environments/environment.prod.ts (runnerApiUrl=${RUNNER_API_URL})"
cat > "$APP_DIR/ui/src/environments/environment.prod.ts" <<EOF
export const environment = {
  production: true,
  runnerApiUrl: '${RUNNER_API_URL}'
};
EOF
chown biqrunner:biqrunner "$APP_DIR/ui/src/environments/environment.prod.ts"

log "Building UI (production)"
sudo -u biqrunner -H bash -c "cd '$APP_DIR/ui' && npm run build"

UI_DIST="$APP_DIR/ui/dist/biq-runner-ui/browser"
if [[ ! -d "$UI_DIST" ]]; then
  echo "ERROR: expected build output not found at $UI_DIST" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 6) Start the API under pm2
# ---------------------------------------------------------------------------
log "Starting API with pm2"
sudo -u biqrunner -H bash -c "
  cd '$APP_DIR'
  export PORT=$API_PORT
  export ALLOW_CONCURRENT_RUNS=$ALLOW_CONCURRENT_RUNS
  export RUNS_DIR='$APP_DIR/runs'
  export PLANS_DIR='$APP_DIR/plans'
  export JMETER_BIN='${JMETER_HOME}/bin/jmeter'
  pm2 delete biq-runner-api 2>/dev/null || true
  pm2 start server.js --name biq-runner-api \
    --update-env
  pm2 save
"

# Enable pm2 on boot (runs as biqrunner)
env PATH=$PATH:/usr/bin pm2 startup systemd -u biqrunner --hp "/home/biqrunner" | tail -n1 | bash || true
sudo -u biqrunner -H bash -c "pm2 save"

# ---------------------------------------------------------------------------
# 7) Configure nginx: serve UI, proxy /api/ -> API, SSE-friendly
# ---------------------------------------------------------------------------
log "Configuring nginx"
cat > /etc/nginx/conf.d/biq-runner.conf <<EOF
server {
    listen 80;
    server_name ${PUBLIC_DOMAIN};

    root ${UI_DIST};
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:${API_PORT}/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_set_header Connection '';
    }
}
EOF

# Default nginx.conf on AL2023 may have its own server block on :80 — disable it.
if [[ -f /etc/nginx/nginx.conf ]]; then
  sed -i '/^\s*server\s*{/,/^\s*}\s*$/{/listen\s*80/d}' /etc/nginx/conf.d/*.conf 2>/dev/null || true
fi

nginx -t
systemctl enable nginx
systemctl restart nginx

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
log "Deployment complete"
cat <<EOF

  UI:          http://${PUBLIC_DOMAIN}/
  API health:  http://${PUBLIC_DOMAIN}/api/health

  App dir:     ${APP_DIR}
  API process: pm2 status biq-runner-api   (logs: pm2 lo