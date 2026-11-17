# Makes test/fixtures/openpyxl-resaved.xlsx: a workbook Beeline's own writer made (src/app/xlsx.ts), opened and
# saved again by openpyxl after somebody typed into one cell and filled one empty cell. openpyxl rewrites the whole
# package (its own theme, document properties, styles and sheet XML). It is NOT a file written by Excel,
# LibreOffice Calc or Google Sheets, which have not been tried.
#
#   node --import tsx test/fixtures/write-for-resave.mts /tmp/written.xlsx
#   uv run --quiet --with openpyxl python -I test/fixtures/make-openpyxl-resaved.py /tmp/written.xlsx test/fixtures/openpyxl-resaved.xlsx
import sys

from openpyxl import load_workbook

book = load_workbook(sys.argv[1])
sheet = book["specimens"]
sheet["B3"] = "Philomath"  # typed over a cell that held "Corvallis"
sheet["E3"] = "a note"  # typed into a cell that was empty
book.save(sys.argv[2])
