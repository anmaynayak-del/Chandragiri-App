# Google Sheets One-Click Upload Setup

Use this once, then the admin can click `Upload to Google Sheets` inside the app.

This setup matches the current v5.7.0 payload and writes four clean sheets:

- `Workers`
- `Attendance`
- `Payments_Paid`
- `Payments_Unpaid`

## 1. Create the Google Sheet

1. Create a new Google Sheet.
2. Open `Extensions -> Apps Script`.
3. Replace the default code with this script:

```javascript
function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) ? e.postData.contents : '{}');
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheets = payload.sheets || {};

    function getSheet(name) {
      let sh = ss.getSheetByName(name);
      if (!sh) sh = ss.insertSheet(name);
      sh.clearContents();
      return sh;
    }

    function writeSheet(name, rows) {
      const sh = getSheet(name);
      if (!rows || !rows.length) return;

      const headers = Object.keys(rows[0]);
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.getRange(2, 1, rows.length, headers.length).setValues(
        rows.map(function (row) {
          return headers.map(function (header) {
            return row[header] == null ? '' : row[header];
          });
        })
      );

      sh.getRange(1, 1, 1, headers.length)
        .setBackground('#1a73e8')
        .setFontColor('#ffffff')
        .setFontWeight('bold');
      sh.autoResizeColumns(1, headers.length);
    }

    writeSheet('Workers', sheets.Workers || []);
    writeSheet('Attendance', sheets.Attendance || []);
    writeSheet('Payments_Paid', sheets.Payments_Paid || []);
    writeSheet('Payments_Unpaid', sheets.Payments_Unpaid || []);

    return ContentService
      .createTextOutput(JSON.stringify({
        status: 'ok',
        uploadId: payload.uploadId || '',
        rows: payload.summary || {}
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({
        status: 'error',
        message: String(err && err.message ? err.message : err)
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

## 2. Deploy the script

1. Click `Deploy -> New deployment`.
2. Choose `Web app`.
3. Set access to `Anyone`.
4. Copy the `/exec` URL.

## 3. Add the URL inside Chandragiri

1. Open the dashboard as an admin.
2. Paste the Apps Script Web App URL into `Save Sheets URL`.
3. Click `Save Sheets URL`.
4. Click `Upload to Google Sheets`.

## Sheet meanings

- `Workers`: one row per worker with current pending payment and number of farms worked.
- `Attendance`: one row per attendance entry with wage, earned total, cycle ID, and payment status.
- `Payments_Paid`: one row per worker paid in each completed payment cycle.
- `Payments_Unpaid`: one row per worker still pending in the current active cycle.

## Important notes

- Empty sheets are cleared on every upload so old rows do not linger.
- The app now sends data inside `payload.sheets`, not the older `payload.farms / payload.workers / payload.payments` layout.
- If you were using the older Apps Script, replace it fully with the version above.
