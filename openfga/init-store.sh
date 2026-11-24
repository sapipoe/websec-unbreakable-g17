#!/usr/bin/env bash
# opdracht 4: maakt EENMALIG de OpenFGA-store "unbreakable" aan met het model uit model.fga.
#
# NIET in de pipeline zetten: OpenFGA laat meerdere stores met dezelfde naam toe,
# dus elke deploy zou er een nieuwe (lege) store bijmaken.
#
# Gebruik, op de server, nadat de stack draait (docker compose -p unbreakable up -d):
#   read -rs OPENFGA_PRESHARED_KEY && export OPENFGA_PRESHARED_KEY   # sleutel plakken, niet zichtbaar
#   ./openfga/init-store.sh
#
# Het script draait de officiële CLI (openfga/cli) in een container op het interne netwerk
# unbreakable_authz, want OpenFGA heeft bewust geen publieke poort.
# Daarna: het store-ID en het model-ID invullen in docs/openfga.md.

set -euo pipefail

FGA_CLI_IMAGE="openfga/cli:v0.9.0"
NETWORK="unbreakable_authz"
API_URL="http://openfga:8080"
STORE_NAME="unbreakable"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fout() {
  echo "FOUT: $*" >&2
  exit 1
}

# 1. De sleutel komt uit de omgeving, nooit uit dit bestand.
if [ -z "${OPENFGA_PRESHARED_KEY:-}" ]; then
  fout "OPENFGA_PRESHARED_KEY is niet gezet. Gebruik dezelfde waarde als de GitHub secret:
  read -rs OPENFGA_PRESHARED_KEY && export OPENFGA_PRESHARED_KEY"
fi

[ -f "$SCRIPT_DIR/model.fga" ] || fout "model.fga niet gevonden in $SCRIPT_DIR"

docker network inspect "$NETWORK" >/dev/null 2>&1 \
  || fout "netwerk $NETWORK bestaat niet. Draait de stack (docker compose -p unbreakable up -d)?"

# De sleutel gaat via de omgeving naar de container (-e FGA_API_TOKEN zonder waarde),
# zodat hij niet in de proceslijst (ps) of in de shell history staat.
export FGA_API_TOKEN="$OPENFGA_PRESHARED_KEY"

fga() {
  docker run --rm \
    --network "$NETWORK" \
    -e FGA_API_URL="$API_URL" \
    -e FGA_API_TOKEN \
    -v "$SCRIPT_DIR/model.fga:/model/model.fga:ro" \
    "$FGA_CLI_IMAGE" "$@"
}

# 2. Bestaat de store al? Dan stoppen, anders krijgen we twee stores met dezelfde naam.
#    (Dit controleert meteen of de sleutel klopt: een foute sleutel geeft hier een fout.)
stores="$(fga store list)" || fout "kan de stores niet opvragen. Is openfga healthy en klopt de sleutel?"
if printf '%s' "$stores" | grep -Eq "\"name\": *\"$STORE_NAME\""; then
  echo "$stores"
  fout "er bestaat al een store \"$STORE_NAME\" (zie hierboven). Er is niets aangemaakt."
fi

# 3. Store aanmaken en meteen het model erin schrijven.
result="$(fga store create --name "$STORE_NAME" --model /model/model.fga)" \
  || fout "store aanmaken mislukt"

store_id="$(printf '%s' "$result" | grep -Eo '"id": *"[^"]+"' | head -n1 | cut -d'"' -f4)"
model_id="$(printf '%s' "$result" | grep -Eo '"authorization_model_id": *"[^"]+"' | head -n1 | cut -d'"' -f4)"

[ -n "$store_id" ] && [ -n "$model_id" ] || { echo "$result"; fout "kon de ID's niet uit het antwoord halen"; }

echo "Store \"$STORE_NAME\" aangemaakt."
echo "  store-ID: $store_id"
echo "  model-ID: $model_id"
echo "Vul deze twee waarden in docs/openfga.md in. Ze zijn niet geheim."
