#!/bin/sh
# Install work/jet-app.tgz into the Jet's Alpine chroot (/opt/jet-app) and restart jet-app.
# Uses tools/jsh.sh conventions: JET_HOST overrides jet.local.
set -e
cd "$(dirname "$0")/../../.."
HOST=${JET_HOST:-jet.local}
SSH="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8"
scp -O -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR work/jet-app.tgz "root@$HOST:/tmp/jet-app.tgz"
$SSH "root@$HOST" 'set -e; /opt/jet-app/deploy/jet-app.sh stop 2>/dev/null || true; rm -rf /opt/jet-app.new; mkdir -p /opt/jet-app.new; tar xzf /tmp/jet-app.tgz -C /opt/jet-app.new; chown -R 0:0 /opt/jet-app.new; rm -rf /opt/jet-app.old; [ -d /opt/jet-app ] && mv /opt/jet-app /opt/jet-app.old; mv /opt/jet-app.new /opt/jet-app; rm -f /tmp/jet-app.tgz; /opt/jet-app/deploy/jet-app.sh start'
