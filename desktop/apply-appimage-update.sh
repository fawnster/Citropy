#!/bin/sh
# After the running process exits, optionally replace the AppImage, then reopen it.
# electron-updater's AppImage install launches the new file while the old FUSE
# mount is still alive, so the new process dies and the window just closes.
# Settings restart has the same problem if it relaunches the extracted binary.
set -eu

say() { printf '%s\n' "$*"; }

[ -n "${CITROPY_APPIMAGE:-}" ] || { say "CITROPY_APPIMAGE is missing."; exit 1; }
if [ -n "${CITROPY_UPDATE_FILE:-}" ]; then
  [ -f "$CITROPY_UPDATE_FILE" ] || { say "The downloaded update is missing: $CITROPY_UPDATE_FILE"; exit 1; }
fi

if [ -n "${CITROPY_PARENT_PID:-}" ]; then
  count=0
  while kill -0 "$CITROPY_PARENT_PID" 2>/dev/null; do
    count=$((count + 1))
    [ "$count" -lt 60 ] || break
    sleep 1
  done
  # Give the old FUSE mount a moment to go away after the process exits.
  sleep 1
fi

dest="$CITROPY_APPIMAGE"
if [ -n "${CITROPY_UPDATE_FILE:-}" ]; then
  src="$CITROPY_UPDATE_FILE"
  tmp="$dest.new"
  rm -f "$tmp"
  copied=0
  i=0
  while [ "$i" -lt 15 ]; do
    if cp "$src" "$tmp" && chmod 755 "$tmp" && mv -f "$tmp" "$dest"; then
      copied=1
      break
    fi
    rm -f "$tmp"
    i=$((i + 1))
    sleep 1
  done
  [ "$copied" = 1 ] || { say "Could not replace $dest with the downloaded update."; exit 1; }
  chmod 755 "$dest"
fi

unset APPDIR APPIMAGE ARGV0 OWD APPIMAGE_SILENT_INSTALL APPIMAGE_EXIT_AFTER_INSTALL
unset CITROPY_DESKTOP_TOKEN CITROPY_URL CITROPY_UI_URL CITROPY_HOST
unset CITROPY_PARENT_PID CITROPY_UPDATE_FILE CITROPY_RELAUNCH CITROPY_APPIMAGE

if command -v setsid >/dev/null 2>&1; then
  setsid "$dest" </dev/null >/dev/null 2>&1 &
else
  nohup "$dest" >/dev/null 2>&1 &
fi
if [ -n "${src:-}" ]; then
  say "Replaced $dest and relaunched Citropy."
else
  say "Relaunched $dest."
fi
