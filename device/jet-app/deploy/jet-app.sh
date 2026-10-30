#!/bin/sh
# On-device control: /opt/jet-app/deploy/jet-app.sh start|stop|restart|status
# Logs (JSON lines) go to /tmp/jet-app.log; the pid file is /tmp/jet-app.pid.
APP=/opt/jet-app; LOG=/tmp/jet-app.log; PID=/tmp/jet-app.pid
pid() { [ -f $PID ] && kill -0 "$(cat $PID)" 2>/dev/null && cat $PID; }
case "$1" in
  start)
    [ -n "$(pid)" ] && { echo "already running pid $(pid)"; exit 0; }
    [ -f /android-data/mainline/jet-app.env ] && . /android-data/mainline/jet-app.env
    # a wrapper waits on node and logs how it ended: a death by signal (status > 128) prints
    # nothing of its own, and that has happened
    setsid nohup sh -c "node $APP/src/main.js >> $LOG 2>&1 & echo \$! > $PID; wait \$!; s=\$?; echo \"{\\\"t\\\":\\\"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\\\",\\\"level\\\":\\\"warn\\\",\\\"name\\\":\\\"jet-app.sh\\\",\\\"msg\\\":\\\"node exited\\\",\\\"status\\\":\$s}\" >> $LOG" >/dev/null 2>&1 &
    sleep 2; echo "started pid $(pid)"; tail -3 $LOG ;;
  stop)   p=$(pid); [ -n "$p" ] && kill "$p" && echo "stopped $p"; rm -f $PID ;;
  restart) $0 stop; sleep 1; $0 start ;;
  status) p=$(pid); [ -n "$p" ] && { echo "running pid $p"; grep VmRSS /proc/$p/status; } || echo "not running"; tail -3 $LOG 2>/dev/null ;;
  *) echo "usage: $0 start|stop|restart|status"; exit 1 ;;
esac
