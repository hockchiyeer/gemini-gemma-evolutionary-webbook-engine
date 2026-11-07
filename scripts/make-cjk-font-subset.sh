#!/usr/bin/env bash
# Builds src/assets/fonts/NotoSansSC-Subset.ttf from a full Noto Sans SC TrueType file.
# Usage: scripts/make-cjk-font-subset.sh path/to/NotoSansSC-Regular.ttf
# Requires: pip install fonttools brotli
set -euo pipefail
SRC="${1:?path to NotoSansSC-Regular.ttf (static TrueType, not .otf)}"
mkdir -p src/assets/fonts
pyftsubset "$SRC" \
  --unicodes="U+0020-007E,U+00A0-024F,U+2000-206F,U+2100-214F,U+2190-21FF,U+2200-22FF,U+2460-24FF,U+25A0-25FF,U+2700-27BF,U+3000-303F,U+3040-30FF,U+3100-312F,U+31F0-31FF,U+3200-32FF,U+3300-33FF,U+4E00-9FFF,U+FF00-FFEF" \
  --layout-features='*' --no-hinting --desubroutinize \
  --output-file=src/assets/fonts/NotoSansSC-Subset.ttf
ls -lh src/assets/fonts/NotoSansSC-Subset.ttf
