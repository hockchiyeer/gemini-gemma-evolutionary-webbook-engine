#!/usr/bin/env bash
# Builds src/assets/fonts/NotoSansSC-Subset.ttf from a full Noto Sans SC TrueType file.
# Usage: scripts/make-cjk-font-subset.sh path/to/NotoSansSC-Regular.ttf   (or the variable NotoSansSC[wght].ttf)
# Requires: pip install fonttools brotli
#
# jsPDF embeds the WHOLE font file in every High-Res PDF, so the file must be small and static:
#  - a variable font is first frozen at weight 400 (otherwise jsPDF would draw its default instance, which is Thin 100,
#    and the 7 MB gvar table would be shipped for nothing);
#  - layout tables (GPOS/GSUB/...) are dropped because jsPDF does not shape text.
# Result: about 7.6 MB instead of 17.7 MB.
set -euo pipefail
SRC="${1:?path to NotoSansSC-Regular.ttf or NotoSansSC[wght].ttf (TrueType/glyf, not .otf)}"
mkdir -p src/assets/fonts
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
python3 - "$SRC" "$TMP/static.ttf" <<'PY'
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
font = TTFont(sys.argv[1])
if 'fvar' in font:
    font = instancer.instantiateVariableFont(font, {'wght': 400}, inplace=False)
font.save(sys.argv[2])
PY
pyftsubset "$TMP/static.ttf" \
  --unicodes="U+0020-007E,U+00A0-024F,U+2000-206F,U+2100-214F,U+2190-21FF,U+2200-22FF,U+2460-24FF,U+25A0-25FF,U+2700-27BF,U+3000-303F,U+3040-30FF,U+3100-312F,U+31F0-31FF,U+3200-32FF,U+3300-33FF,U+4E00-9FFF,U+FF00-FFEF" \
  --layout-features='' --no-hinting --desubroutinize \
  --drop-tables+=GPOS,GSUB,BASE,GDEF,STAT,vhea,vmtx,gasp \
  --output-file=src/assets/fonts/NotoSansSC-Subset.ttf
ls -lh src/assets/fonts/NotoSansSC-Subset.ttf
