#!/bin/sh
# Shared progress output for the top-level scripts (setup.sh / install.sh / recover.sh).
# One format for humans and agents: every line is self-contained and greppable.
#
#   . tools/steps.sh
#   STEPS_NAME=install                     # printed in every step header
#   step "building the kernel"             # [install 3] building the kernel
#   ok "zImage current"                    #   ok: zImage current
#   info "source volume exists"            #   - source volume exists
#   warn "p7 differs from backup"          #   warn: p7 differs from backup
#   action "unplug the Jet, hold POWER"    #   ACTION REQUIRED: unplug the Jet, hold POWER
#   die "docker not running" "start Docker Desktop and re-run"
#                                          #   FAIL: docker not running
#                                          #   -> start Docker Desktop and re-run
#
# Steps number themselves; a failed run names its step so a re-run is easy to follow.
# Colour only when stdout is a tty (plain when piped to a log or an agent).

STEPS_NAME=${STEPS_NAME:-$(basename "$0" .sh)}
STEPS_N=0
if [ -t 1 ]; then
  _c_step=$(printf '\033[1m'); _c_ok=$(printf '\033[32m'); _c_warn=$(printf '\033[33m')
  _c_fail=$(printf '\033[31;1m'); _c_act=$(printf '\033[35;1m'); _c_off=$(printf '\033[0m')
else
  _c_step=; _c_ok=; _c_warn=; _c_fail=; _c_act=; _c_off=
fi

step()   { STEPS_N=$((STEPS_N + 1)); printf '%s[%s %d] %s%s\n' "$_c_step" "$STEPS_NAME" "$STEPS_N" "$*" "$_c_off"; }
ok()     { printf '  %sok:%s %s\n' "$_c_ok" "$_c_off" "$*"; }
info()   { printf '  - %s\n' "$*"; }
warn()   { printf '  %swarn:%s %s\n' "$_c_warn" "$_c_off" "$*"; }
action() { printf '  %sACTION REQUIRED:%s %s\n' "$_c_act" "$_c_off" "$*"; }
# die "what failed" ["what to do about it"]; exit 1. Nothing destructive has half-happened:
# every script using this is safe to re-run after fixing the cause.
die() {
  printf '  %sFAIL:%s %s\n' "$_c_fail" "$_c_off" "$1" >&2
  [ -n "$2" ] && printf '  -> %s\n' "$2" >&2
  exit 1
}
