#!/usr/bin/env bash
# SCA-gate voor NuGet: faalt bij een High/Critical-lek dat NIET in .sca-accepted.txt staat.
# Gebruik: sca-nuget-gate.sh <dotnet-json-rapport> <lijst-met-aanvaarde-advisories>
set -euo pipefail

REPORT="$1"
ACCEPTED="$2"

# 1. Alle High/Critical-lekken uit het rapport halen (direct + transitief).
#    Eén regel per lek: "<advisory-url> <pakket> <versie> <severity>"
jq -r '
  .projects[].frameworks[]?
  | (.topLevelPackages[]?, .transitivePackages[]?)
  | .id as $id | .resolvedVersion as $v
  | .vulnerabilities[]?
  | select(.severity == "High" or .severity == "Critical")
  | "\(.advisoryurl) \($id) \($v) \(.severity)"
' "$REPORT" | sort -u > critical.txt

# 2. De aanvaarde lijst opschonen: commentaar (#) en lege regels weg.
grep -v '^\s*#' "$ACCEPTED" | grep -v '^\s*$' > accepted.txt || true

# 3. Wat is kritiek EN niet aanvaard? Dat is een NIEUWE kritieke bevinding.
NEW=$(grep -v -F -f accepted.txt critical.txt || true)

echo "Kritieke lekken gevonden:  $(wc -l < critical.txt)"
echo "Waarvan aanvaard:          $(( $(wc -l < critical.txt) - $(printf '%s' "$NEW" | grep -c . || true) ))"

if [ -n "$NEW" ]; then
  echo "::error::Nieuwe kritieke NuGet-bevinding(en) die niet in .sca-accepted.txt staan:"
  echo "$NEW"
  exit 1
fi
echo "Geen nieuwe kritieke NuGet-bevindingen."
