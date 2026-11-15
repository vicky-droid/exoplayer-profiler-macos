#!/bin/bash
# Build the ExoProfiler Mac app (.app) + distributable DMG.
# Usage: ./build_app.sh
set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(tr -d ' \t\r\n' < VERSION)"
APP_NAME="ExoProfiler"
DMG_NAME="${APP_NAME}-${VERSION}.dmg"

echo "==> ExoProfiler build v${VERSION}"

if ! python3 -c "import PyInstaller" 2>/dev/null; then
  echo "==> Installing PyInstaller..."
  pip3 install pyinstaller
fi
if ! python3 -c "import webview" 2>/dev/null; then
  echo "==> Installing pywebview (in-app window)..."
  pip3 install pywebview
fi

echo "==> Cleaning old build..."
rm -rf build dist dmg-staging "${APP_NAME}"-*.dmg

echo "==> Building .app with PyInstaller..."
python3 -m PyInstaller "${APP_NAME}.spec" --noconfirm

APP_PATH="dist/${APP_NAME}.app"
if [ ! -d "$APP_PATH" ]; then
  echo "ERROR: build failed, $APP_PATH not found"
  exit 1
fi

echo "==> Staging DMG contents..."
mkdir -p dmg-staging
cp -R "$APP_PATH" dmg-staging/
ln -s /Applications dmg-staging/Applications

echo "==> Creating ${DMG_NAME}..."
hdiutil create -volname "${APP_NAME} ${VERSION}" \
  -srcfolder dmg-staging -ov -format UDZO "${DMG_NAME}" >/dev/null

rm -rf dmg-staging
echo ""
echo "Done."
echo "  App: ${APP_PATH}"
echo "  DMG: $(pwd)/${DMG_NAME}"
echo ""
echo "Share ${DMG_NAME} with the team. They drag ExoProfiler.app to Applications and double-click."
