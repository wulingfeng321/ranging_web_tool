#!/usr/bin/env bash
# Run as root. Briefly stops the service for a consistent SQLite + raw-file backup.
set -euo pipefail
test "$(id -u)" = 0
install -d -m 700 /var/backups/ranging-studio
umask 077
backup="/var/backups/ranging-studio/backup-$(date -u +%Y%m%dT%H%M%S)-$$.tar.gz"
was_active=0
if systemctl is-active --quiet ranging-studio; then was_active=1; fi
restore_service() {
    if [ "$was_active" = 1 ]; then systemctl start ranging-studio; fi
}
trap restore_service EXIT
systemctl stop ranging-studio
tar -czf "$backup" -C / var/lib/ranging-studio var/lib/ranging-studio-settings etc/ranging-studio \
    etc/nginx/ranging-studio.htpasswd etc/nginx/sites-available/ranging-studio \
    etc/systemd/system/ranging-studio.service opt/ranging-studio/current
printf 'Backup created: %s\n' "$backup"
