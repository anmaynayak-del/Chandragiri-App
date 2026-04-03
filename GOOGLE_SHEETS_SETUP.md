# Google Sheets One-Click Upload Setup

Use this once, then the admin can click **Upload to Google Sheets** inside the app.

This version keeps raw history append-only and also creates a Google Sheets-side date report:

- `Report_Control`: type the start date, end date, farm name, and worker name
- `Range_Attendance_View`: attendance rows for that date range
- `Range_Payment_Transactions_View`: dated payment / loan events for that date range
- `Range_Worker_Summary_View`: range work summary plus current balances

Important:

- Raw history sheets are **not overwritten**
- Only `Latest_*` sheets and `Range_*` report sheets are refreshed
- Dated payment transactions are available for entries logged **after this updated app version is running**
- Older worker totals still appear in `Latest_Payments`, but old per-date payment events do not exist retroactively

## 1. Create the Google Sheet

1. Create a new Google Sheet.
2. Open **Extensions -> Apps Script**.
3. Replace the default code with this script:

```javascript
function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) ? e.postData.contents : '{}');
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const uploadId = String(payload.uploadId || Utilities.getUuid());

    if (uploadAlreadyExists_(ss, uploadId)) {
      return json_({ ok: true, duplicate: true, uploadId: uploadId, message: 'Upload already exists' });
    }

    const exportedAt = String(payload.exportedAt || new Date().toISOString());
    const triggeredBy = String(payload.triggeredBy || '');

    appendRows_(ss, 'Farms_History', [
      'uploadId', 'exportedAt', 'triggeredBy', 'id', 'name', 'location', 'capacity'
    ], (payload.farms || []).map(function (f) {
      return {
        uploadId: uploadId,
        exportedAt: exportedAt,
        triggeredBy: triggeredBy,
        id: f.id || '',
        name: f.name || '',
        location: f.location || '',
        capacity: f.capacity || ''
      };
    }));

    appendRows_(ss, 'Workers_History', [
      'uploadId', 'exportedAt', 'triggeredBy', 'id', 'name', 'role', 'dailyWage', 'overtimeCharge', 'initialDebt',
      'paidAmount', 'loanAmount', 'loanResetBaseline', 'lastSettledDate', 'settledPeriods', 'overtime',
      'phone', 'bankName', 'accountNum', 'ifsc'
    ], (payload.workers || []).map(function (w) {
      return {
        uploadId: uploadId,
        exportedAt: exportedAt,
        triggeredBy: triggeredBy,
        id: w.id || '',
        name: w.name || '',
        role: w.role || '',
        dailyWage: Number(w.dailyWage || 0),
        overtimeCharge: Number(w.overtimeCharge || 0),
        initialDebt: Number(w.initialDebt || 0),
        paidAmount: Number(w.paidAmount || 0),
        loanAmount: Number(w.loanAmount || 0),
        loanResetBaseline: Number(w.loanResetBaseline || 0),
        lastSettledDate: w.lastSettledDate || '',
        settledPeriods: w.settledPeriods || '[]',
        overtime: w.overtime || '[]',
        phone: w.phone || '',
        bankName: w.bankName || '',
        accountNum: w.accountNum || '',
        ifsc: w.ifsc || ''
      };
    }));

    appendRows_(ss, 'Payments_History', [
      'uploadId', 'exportedAt', 'triggeredBy', 'workerId', 'workerName', 'role', 'dailyWage',
      'overtimeCharge', 'overtimeDays', 'attendanceOvertimeAmount', 'extraWageEntries', 'extraWageAmount',
      'totalOvertimeAmount', 'totalDays', 'earnedAmount', 'previousWages', 'paidAmount', 'loanAmount', 'pendingAmount'
    ], (payload.payments || []).map(function (p) {
      return {
        uploadId: uploadId,
        exportedAt: exportedAt,
        triggeredBy: triggeredBy,
        workerId: p.workerId || '',
        workerName: p.workerName || '',
        role: p.role || '',
        dailyWage: Number(p.dailyWage || 0),
        overtimeCharge: Number(p.overtimeCharge || 0),
        overtimeDays: Number(p.overtimeDays || 0),
        attendanceOvertimeAmount: Number(p.attendanceOvertimeAmount || 0),
        extraWageEntries: Number(p.extraWageEntries || 0),
        extraWageAmount: Number(p.extraWageAmount || 0),
        totalOvertimeAmount: Number(p.totalOvertimeAmount || 0),
        totalDays: Number(p.totalDays || 0),
        earnedAmount: Number(p.earnedAmount || 0),
        previousWages: Number(p.previousWages || 0),
        paidAmount: Number(p.paidAmount || 0),
        loanAmount: Number(p.loanAmount || 0),
        pendingAmount: Number(p.pendingAmount || 0)
      };
    }));

    appendUniqueRows_(ss, 'Payment_Transactions_History', [
      'id', 'loggedAt', 'entryDate', 'workerId', 'workerName', 'type',
      'paidAmount', 'addedLoanAmount', 'setLoanAmount',
      'previousPaidAmount', 'newPaidAmount', 'previousLoanAmount', 'newLoanAmount',
      'settledRangeStart', 'settledRangeEnd', 'note'
    ], (payload.paymentTransactions || []).map(function (tx) {
      return {
        id: tx.id || '',
        loggedAt: tx.loggedAt || '',
        entryDate: tx.entryDate || '',
        workerId: tx.workerId || '',
        workerName: tx.workerName || '',
        type: tx.type || '',
        paidAmount: Number(tx.paidAmount || 0),
        addedLoanAmount: Number(tx.addedLoanAmount || 0),
        setLoanAmount: Number(tx.setLoanAmount || 0),
        previousPaidAmount: Number(tx.previousPaidAmount || 0),
        newPaidAmount: Number(tx.newPaidAmount || 0),
        previousLoanAmount: Number(tx.previousLoanAmount || 0),
        newLoanAmount: Number(tx.newLoanAmount || 0),
        settledRangeStart: tx.settledRangeStart || '',
        settledRangeEnd: tx.settledRangeEnd || '',
        note: tx.note || ''
      };
    }), 'id');

    appendRows_(ss, 'Attendance_History', [
      'uploadId', 'exportedAt', 'triggeredBy', 'date', 'farmId', 'farmName',
      'workerId', 'workerName', 'value', 'workType'
    ], (payload.attendance || []).map(function (a) {
      return {
        uploadId: uploadId,
        exportedAt: exportedAt,
        triggeredBy: triggeredBy,
        date: a.date || '',
        farmId: a.farmId || '',
        farmName: a.farmName || '',
        workerId: a.workerId || '',
        workerName: a.workerName || '',
        value: a.value || '',
        workType: a.workType || ''
      };
    }));

    replaceTable_(ss, 'Latest_Farms', ['id', 'name', 'location', 'capacity'], payload.farms || []);
    replaceTable_(ss, 'Latest_Workers', [
      'id', 'name', 'role', 'dailyWage', 'overtimeCharge', 'initialDebt', 'paidAmount', 'loanAmount',
      'loanResetBaseline', 'lastSettledDate', 'settledPeriods', 'overtime',
      'phone', 'bankName', 'accountNum', 'ifsc'
    ], payload.workers || []);
    replaceTable_(ss, 'Latest_Payments', [
      'workerId', 'workerName', 'role', 'dailyWage', 'overtimeCharge', 'overtimeDays',
      'attendanceOvertimeAmount', 'extraWageEntries', 'extraWageAmount', 'totalOvertimeAmount',
      'totalDays', 'earnedAmount', 'previousWages', 'paidAmount', 'loanAmount', 'pendingAmount'
    ], payload.payments || []);
    replaceTable_(ss, 'Latest_Payment_Transactions', [
      'id', 'loggedAt', 'entryDate', 'workerId', 'workerName', 'type',
      'paidAmount', 'addedLoanAmount', 'setLoanAmount',
      'previousPaidAmount', 'newPaidAmount', 'previousLoanAmount', 'newLoanAmount',
      'settledRangeStart', 'settledRangeEnd', 'note'
    ], payload.paymentTransactions || []);
    replaceTable_(ss, 'Latest_Attendance', [
      'date', 'farmId', 'farmName', 'workerId', 'workerName', 'value', 'workType'
    ], payload.attendance || []);
    replaceTable_(ss, 'Latest_Meta', ['key', 'value'], [
      { key: 'uploadId', value: uploadId },
      { key: 'source', value: String(payload.source || '') },
      { key: 'triggeredBy', value: triggeredBy },
      { key: 'exportedAt', value: exportedAt },
      { key: 'farms', value: String((payload.summary && payload.summary.farms) || 0) },
      { key: 'workers', value: String((payload.summary && payload.summary.workers) || 0) },
      { key: 'paymentsRows', value: String((payload.summary && payload.summary.paymentsRows) || 0) },
      { key: 'paymentTransactionRows', value: String((payload.summary && payload.summary.paymentTransactionRows) || 0) },
      { key: 'attendanceRows', value: String((payload.summary && payload.summary.attendanceRows) || 0) }
    ]);

    appendRows_(ss, 'SyncLog', [
      'timestamp', 'uploadId', 'triggeredBy', 'farms', 'workers', 'paymentsRows', 'paymentTransactionRows', 'attendanceRows', 'status'
    ], [{
      timestamp: new Date().toISOString(),
      uploadId: uploadId,
      triggeredBy: triggeredBy,
      farms: Number((payload.summary && payload.summary.farms) || 0),
      workers: Number((payload.summary && payload.summary.workers) || 0),
      paymentsRows: Number((payload.summary && payload.summary.paymentsRows) || 0),
      paymentTransactionRows: Number((payload.summary && payload.summary.paymentTransactionRows) || 0),
      attendanceRows: Number((payload.summary && payload.summary.attendanceRows) || 0),
      status: 'ok'
    }]);

    ensureReportSheets_(ss);
    refreshRangeReport_(ss);

    return json_({ ok: true, uploadId: uploadId, message: 'Uploaded successfully' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function onOpen() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureReportSheets_(ss);
  SpreadsheetApp.getUi()
    .createMenu('Chandragiri Reports')
    .addItem('Refresh Date Report', 'refreshDateReports')
    .addToUi();
}

function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sheet = e.range.getSheet();
    if (!sheet || sheet.getName() !== 'Report_Control') return;
    if (e.range.getColumn() !== 2) return;
    if (e.range.getRow() < 2 || e.range.getRow() > 5) return;
    refreshRangeReport_(e.source || SpreadsheetApp.getActiveSpreadsheet());
  } catch (err) {
    Logger.log(err);
  }
}

function refreshDateReports() {
  refreshRangeReport_(SpreadsheetApp.getActiveSpreadsheet());
}

function uploadAlreadyExists_(ss, uploadId) {
  const logSheet = ss.getSheetByName('SyncLog');
  if (!logSheet || logSheet.getLastRow() < 2) return false;
  const idValues = logSheet.getRange(2, 2, logSheet.getLastRow() - 1, 1).getValues().flat();
  return idValues.indexOf(uploadId) !== -1;
}

function appendRows_(ss, sheetName, headers, rows) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  ensureHeaders_(sheet, headers);
  if (!rows || !rows.length) return;
  const values = rows.map(function (r) {
    return headers.map(function (h) { return r[h] != null ? r[h] : ''; });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
}

function appendUniqueRows_(ss, sheetName, headers, rows, keyHeader) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  ensureHeaders_(sheet, headers);
  if (!rows || !rows.length) return;

  const keyIndex = headers.indexOf(keyHeader);
  if (keyIndex === -1) {
    appendRows_(ss, sheetName, headers, rows);
    return;
  }

  const existingKeys = new Set();
  if (sheet.getLastRow() > 1) {
    const existing = sheet.getRange(2, keyIndex + 1, sheet.getLastRow() - 1, 1).getValues().flat();
    existing.forEach(function (value) {
      const key = String(value || '').trim();
      if (key) existingKeys.add(key);
    });
  }

  const filteredRows = rows.filter(function (row) {
    const key = String((row && row[keyHeader]) || '').trim();
    if (!key || existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  });

  if (!filteredRows.length) return;
  appendRows_(ss, sheetName, headers, filteredRows);
}

function replaceTable_(ss, sheetName, headers, rows) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (!rows || !rows.length) return;
  const values = rows.map(function (r) {
    return headers.map(function (h) { return r[h] != null ? r[h] : ''; });
  });
  sheet.getRange(2, 1, values.length, headers.length).setValues(values);
}

function ensureHeaders_(sheet, headers) {
  const width = Math.max(sheet.getLastColumn(), headers.length);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }
  const current = sheet.getRange(1, 1, 1, width).getValues()[0].slice(0, headers.length);
  const expected = headers.map(function (h) { return String(h).trim(); });
  let needsUpdate = current.length !== expected.length;
  if (!needsUpdate) {
    for (let i = 0; i < expected.length; i++) {
      if (String(current[i]).trim() !== expected[i]) {
        needsUpdate = true;
        break;
      }
    }
  }
  if (needsUpdate) {
    sheet.getRange(1, 1, 1, width).clearContent();
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
}

function ensureReportSheets_(ss) {
  const control = getOrCreateSheet_(ss, 'Report_Control');
  getOrCreateSheet_(ss, 'Range_Attendance_View');
  getOrCreateSheet_(ss, 'Range_Payment_Transactions_View');
  getOrCreateSheet_(ss, 'Range_Worker_Summary_View');

  control.getRange('A1').setValue('Chandragiri Date Report Controls');
  control.getRange('A2').setValue('Start Date (YYYY-MM-DD)');
  control.getRange('A3').setValue('End Date (YYYY-MM-DD)');
  control.getRange('A4').setValue('Farm Name');
  control.getRange('A5').setValue('Worker Name');
  control.getRange('A7').setValue('Use "All Farms" or leave blank for every farm.');
  control.getRange('A8').setValue('Use "All Workers" or leave blank for every worker.');

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  setDefaultControlValue_(control, 'B2', today);
  setDefaultControlValue_(control, 'B3', today);
  setDefaultControlValue_(control, 'B4', 'All Farms');
  setDefaultControlValue_(control, 'B5', 'All Workers');
  control.getRange('B2:B3').setNumberFormat('yyyy-mm-dd');
  refreshControlValidations_(ss);
}

function refreshRangeReport_(ss) {
  ensureReportSheets_(ss);
  const filters = getReportFilters_(ss);
  const attendanceRows = readRows_(ss, 'Latest_Attendance').map(function (row) {
    return {
      date: normalizeDateValue_(row.date),
      farmId: String(row.farmId || ''),
      farmName: String(row.farmName || ''),
      workerId: String(row.workerId || ''),
      workerName: String(row.workerName || ''),
      value: String(row.value || ''),
      workType: String(row.workType || '')
    };
  }).filter(function (row) {
    return row.date &&
      matchesDateRange_(row.date, filters.startDate, filters.endDate) &&
      matchesNamedFilter_(row.farmName, filters.farmName, 'All Farms') &&
      matchesNamedFilter_(row.workerName, filters.workerName, 'All Workers');
  }).sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.farmName !== b.farmName) return a.farmName < b.farmName ? -1 : 1;
    return a.workerName < b.workerName ? -1 : (a.workerName > b.workerName ? 1 : 0);
  });

  replaceTable_(ss, 'Range_Attendance_View', [
    'date', 'day', 'farmId', 'farmName', 'workerId', 'workerName', 'value', 'workType'
  ], attendanceRows.map(function (row) {
    return {
      date: row.date,
      day: dayNameFromIso_(row.date),
      farmId: row.farmId,
      farmName: row.farmName,
      workerId: row.workerId,
      workerName: row.workerName,
      value: row.value,
      workType: row.workType
    };
  }));

  const transactionRows = readRows_(ss, 'Payment_Transactions_History').map(function (row) {
    return {
      id: String(row.id || ''),
      loggedAt: String(row.loggedAt || ''),
      entryDate: normalizeDateValue_(row.entryDate),
      workerId: String(row.workerId || ''),
      workerName: String(row.workerName || ''),
      type: String(row.type || ''),
      paidAmount: normalizeNumeric_(row.paidAmount),
      addedLoanAmount: normalizeNumeric_(row.addedLoanAmount),
      setLoanAmount: normalizeNumeric_(row.setLoanAmount),
      previousPaidAmount: normalizeNumeric_(row.previousPaidAmount),
      newPaidAmount: normalizeNumeric_(row.newPaidAmount),
      previousLoanAmount: normalizeNumeric_(row.previousLoanAmount),
      newLoanAmount: normalizeNumeric_(row.newLoanAmount),
      settledRangeStart: normalizeDateValue_(row.settledRangeStart),
      settledRangeEnd: normalizeDateValue_(row.settledRangeEnd),
      note: String(row.note || '')
    };
  }).filter(function (row) {
    return row.entryDate &&
      matchesDateRange_(row.entryDate, filters.startDate, filters.endDate) &&
      matchesNamedFilter_(row.workerName, filters.workerName, 'All Workers');
  }).sort(function (a, b) {
    if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? -1 : 1;
    if (a.loggedAt !== b.loggedAt) return a.loggedAt < b.loggedAt ? -1 : 1;
    return a.workerName < b.workerName ? -1 : (a.workerName > b.workerName ? 1 : 0);
  });

  replaceTable_(ss, 'Range_Payment_Transactions_View', [
    'entryDate', 'loggedAt', 'workerId', 'workerName', 'type',
    'paidAmount', 'addedLoanAmount', 'setLoanAmount',
    'previousPaidAmount', 'newPaidAmount', 'previousLoanAmount', 'newLoanAmount',
    'settledRangeStart', 'settledRangeEnd', 'note'
  ], transactionRows);

  const latestPayments = readRows_(ss, 'Latest_Payments');
  const latestWorkers = readRows_(ss, 'Latest_Workers');
  const paymentMap = {};
  latestPayments.forEach(function (row) {
    paymentMap[String(row.workerId || '')] = row;
  });
  const workerMap = {};
  latestWorkers.forEach(function (row) {
    workerMap[String(row.id || '')] = row;
  });

  const summaryByWorker = {};
  attendanceRows.forEach(function (row) {
    const key = row.workerId || row.workerName;
    if (!key) return;
    if (!summaryByWorker[key]) {
      const paymentRow = paymentMap[row.workerId] || {};
      const workerRow = workerMap[row.workerId] || {};
      summaryByWorker[key] = {
        workerId: row.workerId,
        workerName: row.workerName,
        role: String(paymentRow.role || workerRow.role || ''),
        dailyWage: normalizeNumeric_(paymentRow.dailyWage || workerRow.dailyWage),
        overtimeCharge: normalizeNumeric_(paymentRow.overtimeCharge || workerRow.overtimeCharge),
        attendanceDaysInRange: 0,
        overtimeDaysInRange: 0,
        earnedInRange: 0,
        paymentEventsInRange: 0,
        paidInRange: 0,
        loanAddedInRange: 0,
        loanSetEventsInRange: 0,
        previousWages: normalizeNumeric_(paymentRow.previousWages),
        totalPaidNow: normalizeNumeric_(paymentRow.paidAmount),
        currentLoan: normalizeNumeric_(paymentRow.loanAmount),
        pendingNow: normalizeNumeric_(paymentRow.pendingAmount)
      };
    }
    const target = summaryByWorker[key];
    const units = attendanceUnits_(row.value);
    target.attendanceDaysInRange += units;
    if (String(row.value || '').toLowerCase() === 'ot') {
      target.overtimeDaysInRange += 1;
      target.earnedInRange += target.dailyWage + target.overtimeCharge;
    } else {
      target.earnedInRange += units * target.dailyWage;
    }
  });

  transactionRows.forEach(function (row) {
    const key = row.workerId || row.workerName;
    if (!key) return;
    if (!summaryByWorker[key]) {
      const paymentRow = paymentMap[row.workerId] || {};
      const workerRow = workerMap[row.workerId] || {};
      summaryByWorker[key] = {
        workerId: row.workerId,
        workerName: row.workerName,
        role: String(paymentRow.role || workerRow.role || ''),
        dailyWage: normalizeNumeric_(paymentRow.dailyWage || workerRow.dailyWage),
        overtimeCharge: normalizeNumeric_(paymentRow.overtimeCharge || workerRow.overtimeCharge),
        attendanceDaysInRange: 0,
        overtimeDaysInRange: 0,
        earnedInRange: 0,
        paymentEventsInRange: 0,
        paidInRange: 0,
        loanAddedInRange: 0,
        loanSetEventsInRange: 0,
        previousWages: normalizeNumeric_(paymentRow.previousWages),
        totalPaidNow: normalizeNumeric_(paymentRow.paidAmount),
        currentLoan: normalizeNumeric_(paymentRow.loanAmount),
        pendingNow: normalizeNumeric_(paymentRow.pendingAmount)
      };
    }
    const target = summaryByWorker[key];
    target.paymentEventsInRange += 1;
    target.paidInRange += normalizeNumeric_(row.paidAmount);
    target.loanAddedInRange += normalizeNumeric_(row.addedLoanAmount);
    if (String(row.type || '') === 'loan_set') target.loanSetEventsInRange += 1;
  });

  const summaryRows = Object.keys(summaryByWorker).map(function (key) {
    const row = summaryByWorker[key];
    row.attendanceDaysInRange = round2_(row.attendanceDaysInRange);
    row.overtimeDaysInRange = round2_(row.overtimeDaysInRange);
    row.earnedInRange = round2_(row.earnedInRange);
    row.paidInRange = round2_(row.paidInRange);
    row.loanAddedInRange = round2_(row.loanAddedInRange);
    return row;
  }).sort(function (a, b) {
    return a.workerName < b.workerName ? -1 : (a.workerName > b.workerName ? 1 : 0);
  });

  replaceTable_(ss, 'Range_Worker_Summary_View', [
    'workerId', 'workerName', 'role', 'dailyWage', 'overtimeCharge',
    'attendanceDaysInRange', 'overtimeDaysInRange', 'earnedInRange',
    'paymentEventsInRange', 'paidInRange', 'loanAddedInRange', 'loanSetEventsInRange',
    'previousWages', 'totalPaidNow', 'currentLoan', 'pendingNow'
  ], summaryRows);
}

function getReportFilters_(ss) {
  const control = getOrCreateSheet_(ss, 'Report_Control');
  let startDate = normalizeDateValue_(control.getRange('B2').getValue());
  let endDate = normalizeDateValue_(control.getRange('B3').getValue());
  if (!startDate && endDate) startDate = endDate;
  if (!endDate && startDate) endDate = startDate;
  if (startDate && endDate && startDate > endDate) {
    const temp = startDate;
    startDate = endDate;
    endDate = temp;
  }
  return {
    startDate: startDate,
    endDate: endDate,
    farmName: String(control.getRange('B4').getDisplayValue() || '').trim() || 'All Farms',
    workerName: String(control.getRange('B5').getDisplayValue() || '').trim() || 'All Workers'
  };
}

function getOrCreateSheet_(ss, sheetName) {
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  return sheet;
}

function refreshControlValidations_(ss) {
  const control = getOrCreateSheet_(ss, 'Report_Control');
  const farmNames = uniqueStrings_(['All Farms'].concat(readRows_(ss, 'Latest_Farms').map(function (row) {
    return String(row.name || '').trim();
  })));
  const workerNames = uniqueStrings_(['All Workers'].concat(readRows_(ss, 'Latest_Workers').map(function (row) {
    return String(row.name || '').trim();
  })));

  const farmRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(farmNames.length ? farmNames : ['All Farms'], true)
    .setAllowInvalid(true)
    .build();
  const workerRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(workerNames.length ? workerNames : ['All Workers'], true)
    .setAllowInvalid(true)
    .build();

  control.getRange('B4').setDataValidation(farmRule);
  control.getRange('B5').setDataValidation(workerRule);
}

function setDefaultControlValue_(sheet, a1, value) {
  const cell = sheet.getRange(a1);
  if (String(cell.getDisplayValue() || '').trim() === '') cell.setValue(value);
}

function readRows_(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 1) return [];
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (header) {
    return String(header || '').trim();
  });
  const rawRows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  return rawRows.map(function (row) {
    const out = {};
    headers.forEach(function (header, index) {
      out[header] = row[index];
    });
    return out;
  }).filter(function (row) {
    return Object.keys(row).some(function (key) {
      return String(row[key] || '').trim() !== '';
    });
  });
}

function matchesDateRange_(dateValue, startDate, endDate) {
  if (!dateValue) return false;
  if (startDate && dateValue < startDate) return false;
  if (endDate && dateValue > endDate) return false;
  return true;
}

function matchesNamedFilter_(value, filterValue, allLabel) {
  const normalizedFilter = String(filterValue || '').trim().toLowerCase();
  if (!normalizedFilter || normalizedFilter === String(allLabel || '').trim().toLowerCase()) return true;
  return String(value || '').trim().toLowerCase() === normalizedFilter;
}

function normalizeDateValue_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) return match[3] + '-' + pad2_(match[2]) + '-' + pad2_(match[1]);
  match = text.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (match) return match[3] + '-' + pad2_(match[2]) + '-' + pad2_(match[1]);
  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return '';
}

function dayNameFromIso_(isoDate) {
  if (!isoDate) return '';
  const parts = String(isoDate).split('-');
  if (parts.length !== 3) return '';
  const dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  return Utilities.formatDate(dt, 'UTC', 'EEEE');
}

function attendanceUnits_(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'ot' || normalized === 'overtime') return 1;
  return normalizeNumeric_(normalized);
}

function normalizeNumeric_(value) {
  const num = Number(value);
  return isFinite(num) ? num : 0;
}

function round2_(value) {
  return Math.round(normalizeNumeric_(value) * 100) / 100;
}

function pad2_(value) {
  return String(value).padStart(2, '0');
}

function uniqueStrings_(values) {
  const seen = {};
  const out = [];
  (values || []).forEach(function (value) {
    const text = String(value || '').trim();
    const key = text.toLowerCase();
    if (!text || seen[key]) return;
    seen[key] = true;
    out.push(text);
  });
  return out;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

## 2. Deploy the script as Web App

1. Click **Deploy -> New deployment**.
2. Type: **Web app**.
3. Execute as: **Me**.
4. Who has access: **Anyone** (or anyone with link).
5. Click **Deploy** and copy the **Web App URL** ending with `/exec`.

## 3. Connect URL in Chandragiri app

1. Open the app as admin.
2. In the dashboard backup panel, paste the Web App URL.
3. Click **Save Sheets URL**.
4. Click **Upload to Google Sheets**.

## 4. Use the Google Sheets date selector

After upload, open these tabs in Google Sheets:

1. `Report_Control`
2. Enter:
   - `B2`: start date like `2026-03-23`
   - `B3`: end date like `2026-03-27`
   - `B4`: farm name or `All Farms`
   - `B5`: worker name or `All Workers`
3. The following sheets refresh automatically:
   - `Range_Attendance_View`
   - `Range_Payment_Transactions_View`
   - `Range_Worker_Summary_View`

## What gets overwritten and what does not

These stay append-only:

- `Farms_History`
- `Workers_History`
- `Payments_History`
- `Payment_Transactions_History`
- `Attendance_History`
- `SyncLog`

These refresh on each upload or report filter change:

- `Latest_Farms`
- `Latest_Workers`
- `Latest_Payments`
- `Latest_Payment_Transactions`
- `Latest_Attendance`
- `Latest_Meta`
- `Report_Control`
- `Range_Attendance_View`
- `Range_Payment_Transactions_View`
- `Range_Worker_Summary_View`
