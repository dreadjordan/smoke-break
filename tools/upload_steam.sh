#!/bin/bash
# Builds the macOS Steam version of Smoke Break and uploads it to Steam with SteamPipe. Set STEAM_APP_ID, STEAM_DEPOT_ID and STEAM_ACCOUNT first.
# Set STEAMCMD if steamcmd isn't on the PATH. The upload only creates a build: choosing which branch it goes live on happens in Steamworks.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${STEAM_APP_ID:?Set STEAM_APP_ID to the app ID from Steamworks}"
: "${STEAM_DEPOT_ID:?Set STEAM_DEPOT_ID to the macOS depot ID from Steamworks}"
: "${STEAM_ACCOUNT:?Set STEAM_ACCOUNT to your Steam build account name}"

npm run --silent dist:steam

output_directory="$PWD/dist/steam"
build_script="$output_directory/app_build.vdf"
version=$(node -p "require('./package.json').version")

cat > "$build_script" <<VDF
"AppBuild"
{
  "AppID" "$STEAM_APP_ID"
  "Desc" "Smoke Break $version"
  "ContentRoot" "$output_directory/mac-arm64"
  "BuildOutput" "$output_directory/steampipe"
  "Depots"
  {
    "$STEAM_DEPOT_ID"
    {
      "FileMapping"
      {
        "LocalPath" "*"
        "DepotPath" "."
        "Recursive" "1"
      }
    }
  }
}
VDF

"${STEAMCMD:-steamcmd}" +login "$STEAM_ACCOUNT" +run_app_build "$build_script" +quit
