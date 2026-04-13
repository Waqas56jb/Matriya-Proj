import React from 'react';
import DataGrid from 'react-data-grid';
import 'react-data-grid/lib/styles.css';

/** Excel-style column letters (A, B, … Z, AA, …). */
function excelColumnLetters(indexZeroBased) {
  let n = indexZeroBased + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetToGridModel(matrixRows) {
  if (!matrixRows || matrixRows.length === 0) {
    return { columns: [], rows: [] };
  }
  const colCount = Math.max(...matrixRows.map((r) => (Array.isArray(r) ? r.length : 0)));
  const columns = Array.from({ length: colCount }, (_, j) => ({
    key: `c${j}`,
    name: excelColumnLetters(j),
    width: 108,
    minWidth: 64,
    resizable: true,
    sortable: false
  }));
  const rows = matrixRows.map((r, i) => {
    const row = { id: i };
    for (let j = 0; j < colCount; j++) {
      const v = Array.isArray(r) && r[j] != null ? r[j] : '';
      row[`c${j}`] = String(v);
    }
    return row;
  });
  return { columns, rows };
}

/**
 * Read-only spreadsheet-style preview for parsed Excel (react-data-grid).
 * @param {{ sheets: { name: string, rows: string[][] }[], sheetTabsLabel?: string }} props
 */
export function LabExcelSpreadsheet({ sheets, sheetTabsLabel }) {
  const [active, setActive] = React.useState(0);
  const safeIndex = Math.min(Math.max(0, active), Math.max(0, (sheets?.length || 1) - 1));
  const sheet = sheets?.[safeIndex];

  React.useEffect(() => {
    setActive(0);
  }, [sheets]);

  const { columns, rows } = React.useMemo(() => sheetToGridModel(sheet?.rows), [sheet]);

  const gridHeight = React.useMemo(() => {
    const header = 34;
    const rowH = 28;
    const maxRows = 45;
    const bodyRows = Math.min(rows.length, maxRows);
    return Math.min(520, header + Math.max(4, bodyRows) * rowH + 8);
  }, [rows.length]);

  if (!sheets || sheets.length === 0 || !sheet) return null;

  return (
    <div
      className="lab-excel-spreadsheet-root"
      dir="ltr"
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid #c5c5c5',
        background: '#f3f3f3',
        boxShadow: 'inset 0 1px 0 #fff'
      }}
    >
      <div
        style={{
          flex: 1,
          minHeight: 120,
          background: '#fff',
          borderBottom: '1px solid #c5c5c5'
        }}
      >
        {columns.length > 0 && rows.length > 0 ? (
          <DataGrid
            className="rdg-light lab-excel-rdg"
            columns={columns}
            rows={rows}
            rowKeyGetter={(r) => r.id}
            rowHeight={28}
            headerRowHeight={32}
            style={{ height: gridHeight, width: '100%' }}
            defaultColumnOptions={{ resizable: true, sortable: false }}
          />
        ) : (
          <div style={{ padding: 16, color: '#666', fontSize: 13 }}>—</div>
        )}
      </div>
      {sheets.length > 1 && (
        <div
          role="tablist"
          aria-label={sheetTabsLabel || 'Sheets'}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 2,
            padding: '6px 8px',
            background: 'linear-gradient(180deg, #e8e8e8 0%, #d8d8d8 100%)',
            borderTop: '1px solid #b4b4b4'
          }}
        >
          {sheets.map((s, i) => {
            const selected = i === safeIndex;
            return (
              <button
                key={`${s.name}-${i}`}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActive(i)}
                style={{
                  padding: '4px 12px',
                  fontSize: 12,
                  fontFamily: 'Segoe UI, Tahoma, Arial, sans-serif',
                  border: '1px solid #a0a0a0',
                  borderBottom: selected ? '1px solid #fff' : undefined,
                  marginBottom: selected ? -1 : 0,
                  borderRadius: '3px 3px 0 0',
                  background: selected ? '#fff' : 'linear-gradient(180deg, #ececec 0%, #dcdcdc 100%)',
                  cursor: 'pointer',
                  maxWidth: 200,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {s.name || `Sheet${i + 1}`}
              </button>
            );
          })}
        </div>
      )}
      {sheets.length === 1 && sheet.name && (
        <div
          style={{
            padding: '5px 10px',
            fontSize: 12,
            color: '#444',
            background: 'linear-gradient(180deg, #e8e8e8 0%, #dedede 100%)',
            borderTop: '1px solid #b4b4b4',
            fontFamily: 'Segoe UI, Tahoma, Arial, sans-serif'
          }}
        >
          {sheet.name}
        </div>
      )}
    </div>
  );
}
