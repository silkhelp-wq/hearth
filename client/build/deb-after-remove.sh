#!/bin/bash
# Clean up any leftover Hearth files after a deb/pacman removal.
# User settings live in the browser-profile dir; we leave those unless purging.
rm -rf /opt/Hearth/resources/app-update.yml 2>/dev/null || true
exit 0
