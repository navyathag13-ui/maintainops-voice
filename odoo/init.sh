#!/usr/bin/env bash
# Creates the "voice" database with Maintenance, Inventory and Employees installed
# (no demo data), then starts Odoo. Login for this local test instance: admin / admin.
set -euo pipefail
cd "$(dirname "$0")"
docker compose up -d odoo-db
docker compose run --rm odoo odoo -d voice -i maintenance,stock,hr_maintenance --without-demo=all --stop-after-init
docker compose up -d odoo
