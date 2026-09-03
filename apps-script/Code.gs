// ============================================================
// BCCD Equipment Cooperative — One-Click Approval Script
// ============================================================
// Lives in the Apps Script project bound to the form-response
// Sheet (Extensions → Apps Script). This file is the source of
// truth, kept under version control in the equipment-cooperative
// repo at apps-script/Code.gs. Edit it there, then paste the
// whole file into the Apps Script editor.
//
// What it does:
//  1. When a rental request is submitted, emails the team a
//     summary with one-click Approve / Deny buttons.
//  2. Approving (or denying) via the email hits the deployed
//     web app (doGet), which updates the STATUS column and,
//     on approval, books the equipment's Google Calendar.
//  3. Editing STATUS by hand in the Sheet still books the
//     calendar too — the Sheet remains a working fallback.
//
// DEPLOYMENT (one-time, done by hand in the browser):
//  1. Paste this file into the Apps Script editor, replacing
//     the existing code. Save.
//  2. In the Sheet, add two headers after the existing columns:
//     "Token" and "Event ID". (Column W stays as "Notes".)
//  3. Run installTriggers() once from the editor. Authorize
//     when prompted.
//  4. Deploy → New deployment → Web app.
//     Execute as: Me.  Who has access: Anyone.
//     (Approvers must not have to log in.)
//  5. Submit a test request from the live site and click Approve.
// ============================================================

// ── CONFIGURATION ─────────────────────────────────────────────
// These are the only lines a non-developer should need to edit.

// Who receives the new-request email (and the payment follow-up).
var RECIPIENTS = [
  'michael.fernandez@vacd.org',
  'andrew@bccdvt.org',
  'corynb@bccdvt.org',
];

// Where the confirmation page sends you to create a payment link.
var STRIPE_DASHBOARD_URL = 'https://dashboard.stripe.com/payment-links';

// Equipment name (as it appears in the form) → calendar ID.
// Matching is case-insensitive and ignores punctuation, so minor
// wording changes on the form won't break it.
var CALENDAR_IDS = {
  'No Till Drill': '3e2343c3444827ced53c296714e533ac91bfac4310888d8eead058bc0b5bbbb8@group.calendar.google.com',
  'BCS Walk-Behind Tractor': '4ae427d7e6952676827789d6d137a3a70404a682fd57121cf7cea35d8451a966@group.calendar.google.com',
};

// ── COLUMN LOOKUP ─────────────────────────────────────────────
// Columns are found by header text, not position, so adding a
// form question doesn't silently shift every field. Each entry
// lists search terms tried in order: exact match first, then
// "header contains term" (both case-insensitive).

var HEADER_TERMS = {
  name: ['full name', 'name'],
  email: ['email'],
  org: ['farm', 'organization', 'org'],
  equipment: ['equipment'],
  training: ['training'],
  startDate: ['start date', 'start'],
  endDate: ['end date', 'end'],
  purpose: ['purpose', 'intended use'],
  fulfillment: ['fulfillment', 'pickup or delivery'],
  resident: ['resident'],
  insurance: ['certificate of insurance', 'insurance'],
  cost: ['estimated cost', 'total due', 'cost', 'total'],
  status: ['status'],
  notes: ['notes'],
  token: ['token'],
  eventId: ['event id'],
};

// Returns { name: 3, email: 4, ... } as 1-indexed column numbers.
// Missing headers are simply absent from the map — callers must
// handle that rather than assume every key exists.
function getHeaderMap(sheet) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).toLowerCase().trim(); });
  var map = {};
  Object.keys(HEADER_TERMS).forEach(function (key) {
    var terms = HEADER_TERMS[key];
    for (var t = 0; t < terms.length; t++) {
      // Exact match wins over partial so e.g. "end" can't grab
      // a header that merely contains those letters.
      var exact = headers.indexOf(terms[t]);
      if (exact !== -1) { map[key] = exact + 1; return; }
    }
    for (var t2 = 0; t2 < terms.length; t2++) {
      for (var c = 0; c < headers.length; c++) {
        if (headers[c] && headers[c].indexOf(terms[t2]) !== -1) {
          map[key] = c + 1;
          return;
        }
      }
    }
  });
  return map;
}

// ── TRIGGER SETUP — run once by hand from the editor ─────────
function installTriggers() {
  // Remove only OUR triggers (including the old onStatusChange
  // handler this script replaces) so re-running never duplicates
  // them and never touches unrelated triggers.
  var ours = ['onFormSubmit', 'onEditHandler', 'onStatusChange'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (ours.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('onFormSubmit')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onFormSubmit()
    .create();

  ScriptApp.newTrigger('onEditHandler')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();

  Logger.log('Triggers installed: onFormSubmit + onEditHandler. ' +
    'Now deploy as a web app (Execute as: Me, Access: Anyone) if you have not already.');
}

// ── NEW REQUEST → APPROVAL EMAIL ─────────────────────────────
function onFormSubmit(e) {
  if (!e || !e.range) {
    throw new Error('onFormSubmit must be run by the form-submit trigger, ' +
      'not by hand from the editor. Run installTriggers() and submit a test request instead.');
  }
  // Errors below deliberately propagate: Apps Script emails the
  // script owner on trigger failure, which is how we find out.

  var sheet = e.range.getSheet();
  var row = e.range.getRow();
  var col = getHeaderMap(sheet);

  if (!col.token) {
    throw new Error('No "Token" header found in row 1. Add a "Token" column to the Sheet (see deployment steps).');
  }

  var token = Utilities.getUuid();
  sheet.getRange(row, col.token).setValue(token);

  // Status values are written in title case to match the Sheet's
  // dropdown validation options (Pending / Approved / Denied);
  // all reads uppercase before comparing, so either case works.
  if (col.status && !sheet.getRange(row, col.status).getValue()) {
    sheet.getRange(row, col.status).setValue('Pending');
  }

  sendApprovalEmail(sheet, row, col, token);
}

function sendApprovalEmail(sheet, row, col, token) {
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var data = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  var get = function (key) { return col[key] ? data[col[key] - 1] : ''; };

  var name = get('name');
  var equipment = get('equipment');
  var dates = formatCell(get('startDate')) + ' to ' + formatCell(get('endDate'));

  var url = ScriptApp.getService().getUrl();
  if (!url) {
    throw new Error('Web app is not deployed yet. Deploy → New deployment → Web app, then submit again.');
  }
  var approveUrl = url + '?row=' + row + '&action=approve&token=' + token;
  var denyUrl = url + '?row=' + row + '&action=deny&token=' + token;

  // The key facts needed to make the call, in reading order.
  var decisionFields = [
    ['Name', name],
    ['Farm / Org', get('org')],
    ['Equipment', equipment],
    ['Dates', dates],
    ['Fulfillment', get('fulfillment')],
    ['Bennington Resident', formatCell(get('resident'))],
    ['Training Status', get('training')],
    ['Certificate of Insurance', formatCell(get('insurance'))],
    ['Total', formatMoney(parseCost(get('cost')))],
  ];

  var decisionRows = decisionFields
    .filter(function (f) { return String(f[1]).trim() !== ''; })
    .map(function (f) {
      return '<tr>' +
        '<td style="padding:6px 16px 6px 0;color:#6B7E71;font-size:14px;white-space:nowrap;vertical-align:top;">' + escapeHtml(f[0]) + '</td>' +
        '<td style="padding:6px 0;color:#1B2A1F;font-size:15px;font-weight:600;">' + escapeHtml(String(f[1])) + '</td>' +
        '</tr>';
    }).join('');

  // Everything else, so the email is the complete record. Skip
  // empty cells (handles seeding columns being blank on BCS
  // requests) and internal bookkeeping columns.
  var shownCols = [col.name, col.org, col.equipment, col.fulfillment, col.resident,
    col.training, col.insurance, col.cost, col.startDate, col.endDate,
    col.status, col.token, col.eventId];
  var detailRows = '';
  for (var c = 0; c < headers.length; c++) {
    var val = data[c];
    if (String(val).trim() === '' || shownCols.indexOf(c + 1) !== -1) continue;
    detailRows += '<tr>' +
      '<td style="padding:4px 16px 4px 0;color:#8a9a8f;font-size:13px;white-space:nowrap;vertical-align:top;">' + escapeHtml(String(headers[c])) + '</td>' +
      '<td style="padding:4px 0;color:#4a5a4f;font-size:13px;">' + escapeHtml(formatCell(val)) + '</td>' +
      '</tr>';
  }

  var htmlBody =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:8px;">' +
    '<h2 style="color:#1B2A1F;font-size:20px;margin:0 0 4px;">New equipment request</h2>' +
    '<p style="color:#6B7E71;font-size:14px;margin:0 0 16px;">Submitted ' + formatCell(data[0]) + '</p>' +
    '<table style="border-collapse:collapse;margin-bottom:24px;">' + decisionRows + '</table>' +
    '<div style="margin-bottom:28px;">' +
    '<a href="' + approveUrl + '" style="display:inline-block;background:#2D6A4F;color:#ffffff;font-size:17px;font-weight:bold;text-decoration:none;padding:16px 40px;border-radius:8px;margin:0 12px 12px 0;">Approve</a>' +
    '<a href="' + denyUrl + '" style="display:inline-block;background:#6c757d;color:#ffffff;font-size:17px;font-weight:bold;text-decoration:none;padding:16px 40px;border-radius:8px;margin:0 0 12px 0;">Deny</a>' +
    '</div>' +
    (detailRows
      ? '<p style="color:#6B7E71;font-size:13px;margin:0 0 6px;font-weight:bold;">Full request</p>' +
        '<table style="border-collapse:collapse;margin-bottom:24px;">' + detailRows + '</table>'
      : '') +
    '<hr style="border:none;border-top:1px solid #D4CFC5;margin:20px 0;">' +
    '<p style="color:#8a9a8f;font-size:12px;line-height:1.6;margin:0 0 8px;">' +
    'If the buttons don’t work, use these links:<br>' +
    'Approve: ' + approveUrl + '<br>' +
    'Deny: ' + denyUrl + '</p>' +
    '<p style="color:#8a9a8f;font-size:12px;margin:0;">' +
    'The approve link acts as a credential — please don’t forward this email.</p>' +
    '</div>';

  MailApp.sendEmail({
    to: RECIPIENTS.join(','),
    subject: 'New equipment request — ' + name + ' — ' + equipment,
    htmlBody: htmlBody,
    // Plain-text fallback for clients that strip HTML.
    body: 'New equipment request from ' + name + ' (' + equipment + ', ' + dates + ').\n\n' +
      'Approve: ' + approveUrl + '\n' +
      'Deny: ' + denyUrl + '\n\n' +
      'Do not forward this email — the links act as credentials.',
  });
}

// ── ONE-CLICK APPROVE / DENY ENDPOINT ────────────────────────
function doGet(e) {
  var p = (e && e.parameter) || {};
  var row = parseInt(p.row, 10);
  var action = String(p.action || '').toLowerCase();

  if (!row || row < 2 || !p.token || (action !== 'approve' && action !== 'deny')) {
    return page('Invalid link.', 'This link is missing information. Please use the buttons in the request email.');
  }

  var sheet = getResponseSheet();
  var col = getHeaderMap(sheet);
  if (row > sheet.getLastRow()) {
    return page('Request not found.', 'Row ' + row + ' does not exist in the response sheet.');
  }
  if (!col.token || !col.status) {
    return page('Sheet not set up.', 'Could not find the Token or STATUS column. Check the header row in the Sheet.');
  }

  var storedToken = String(sheet.getRange(row, col.token).getValue()).trim();
  if (!storedToken || storedToken !== String(p.token).trim()) {
    return page('This link is not valid.', 'It may be from an older email for this request.');
  }

  // Never act twice: a second click, or a mail client prefetching
  // the link, must not double-book the calendar.
  var status = String(sheet.getRange(row, col.status).getValue()).toUpperCase().trim();
  if (status === 'APPROVED' || status === 'DENIED') {
    return page('Already ' + status.toLowerCase() + '.',
      'This request was already ' + status.toLowerCase() + '. No action taken.');
  }

  var get = function (key) { return col[key] ? sheet.getRange(row, col[key]).getValue() : ''; };
  var name = get('name');
  var equipment = get('equipment');
  var dates = formatCell(get('startDate')) + ' – ' + formatCell(get('endDate'));

  if (action === 'deny') {
    sheet.getRange(row, col.status).setValue('Denied');
    return page('Denied.',
      'The request from <strong>' + escapeHtml(String(name)) + '</strong> for the ' +
      escapeHtml(String(equipment)) + ' (' + escapeHtml(dates) + ') has been marked DENIED. ' +
      'No calendar event was created.');
  }

  // Approve.
  sheet.getRange(row, col.status).setValue('Approved');
  try {
    createBookingForRow(sheet, row, col);
  } catch (err) {
    return page('Approved, but booking failed.',
      'The request was marked APPROVED, but the calendar event could not be created:<br><br>' +
      '<strong>' + escapeHtml(err.message) + '</strong><br><br>' +
      'To retry after fixing the problem: in the Sheet, clear the STATUS cell for row ' + row +
      ', then set it to APPROVED again.');
  }

  var total = parseCost(get('cost'));
  var renterEmail = String(get('email'));

  if (total > 0) {
    // The task must survive Michael closing the tab, so it also
    // lands in the inbox.
    MailApp.sendEmail({
      to: RECIPIENTS.join(','),
      subject: 'Payment needed — ' + name + ' — ' + formatMoney(total),
      htmlBody:
        '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;padding:8px;">' +
        '<p style="font-size:15px;color:#1B2A1F;">The request from <strong>' + escapeHtml(String(name)) +
        '</strong> was approved. Next step:</p>' +
        '<p style="font-size:16px;color:#1B2A1F;">Create a Stripe payment link for <strong>' + formatMoney(total) +
        '</strong> and send it to <strong>' + escapeHtml(renterEmail) + '</strong>.</p>' +
        '<p><a href="' + STRIPE_DASHBOARD_URL + '" style="display:inline-block;background:#2D6A4F;color:#fff;font-size:15px;font-weight:bold;text-decoration:none;padding:12px 28px;border-radius:8px;">Open Stripe payment links</a></p>' +
        '</div>',
      body: 'Approved: ' + name + '. Create a Stripe payment link for ' + formatMoney(total) +
        ' and send it to ' + renterEmail + '.\n' + STRIPE_DASHBOARD_URL,
    });

    return page('Approved.',
      '<strong>' + escapeHtml(String(equipment)) + '</strong> is booked ' + escapeHtml(dates) +
      ' and the calendar is updated.' +
      '<br><br><strong>Next step:</strong> create a Stripe payment link for ' +
      '<strong style="font-size:22px;">' + formatMoney(total) + '</strong> and send it to<br>' +
      '<span style="font-size:18px;">' + escapeHtml(renterEmail) + '</span>' +
      '<br><br><a href="' + STRIPE_DASHBOARD_URL + '" style="display:inline-block;background:#2D6A4F;color:#fff;font-size:17px;font-weight:bold;text-decoration:none;padding:16px 32px;border-radius:8px;">Open Stripe payment links</a>' +
      '<br><br><span style="color:#6B7E71;font-size:14px;">This has also been emailed to you.</span>');
  }

  return page('Approved.',
    '<strong>' + escapeHtml(String(equipment)) + '</strong> is booked ' + escapeHtml(dates) + '.' +
    '<br><br>No payment needed — Bennington County residents rent free. Nothing else to do.');
}

// ── CALENDAR BOOKING ─────────────────────────────────────────
// The single booking path, used both by doGet (email approval)
// and onEditHandler (manual Sheet approval). Kept identical to
// the original onEdit script's behavior, except that it throws
// on problems instead of logging silently, and writes the event
// ID to a dedicated "Event ID" column when one exists.
function createBookingForRow(sheet, row, col) {
  col = col || getHeaderMap(sheet);
  var get = function (key) { return col[key] ? sheet.getRange(row, col[key]).getValue() : ''; };

  var name = get('name');
  var email = get('email');
  var equipment = String(get('equipment'));
  var startDate = new Date(get('startDate'));
  var endDate = new Date(get('endDate'));

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    throw new Error('Row ' + row + ' has an unreadable start or end date.');
  }

  // Tolerant calendar lookup: ignore case and punctuation so
  // "No-Till Drill" still matches "No Till Drill".
  var normalize = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); };
  var calId = null;
  Object.keys(CALENDAR_IDS).forEach(function (key) {
    if (normalize(key) === normalize(equipment)) calId = CALENDAR_IDS[key];
  });
  if (!calId) {
    throw new Error('No calendar is configured for equipment "' + equipment + '". ' +
      'Check the CALENDAR_IDS list at the top of the script.');
  }

  var calendar = CalendarApp.getCalendarById(calId);
  if (!calendar) {
    throw new Error('Could not open calendar ' + calId + '. ' +
      'Make sure this Google account has access to it.');
  }

  // Google all-day events treat the end date as exclusive, so add
  // a day to make the event span the rental's last day inclusive.
  var endDatePlusOne = new Date(endDate);
  endDatePlusOne.setDate(endDatePlusOne.getDate() + 1);

  var title = name + ' — ' + equipment;
  var description = [
    'Renter: ' + name,
    'Email: ' + email,
    'Equipment: ' + equipment,
    'Dates: ' + formatDate(startDate) + ' to ' + formatDate(endDate),
    'Fulfillment: ' + get('fulfillment'),
    'Bennington County Resident: ' + formatCell(get('resident')),
    'Estimated Cost: ' + formatCell(get('cost')),
  ].join('\n');

  var event = calendar.createAllDayEvent(title, startDate, endDatePlusOne, {
    description: description,
  });

  if (col.eventId) {
    sheet.getRange(row, col.eventId).setValue(event.getId());
  } else if (col.notes) {
    // No "Event ID" column yet — fall back to the old behavior of
    // appending to Notes so the ID is never lost.
    var existing = sheet.getRange(row, col.notes).getValue();
    sheet.getRange(row, col.notes).setValue(
      (existing ? existing + ' | ' : '') + 'Cal Event ID: ' + event.getId());
  } else {
    Logger.log('No "Event ID" or "Notes" column found; event ID not recorded: ' + event.getId());
  }

  Logger.log('Created calendar event for ' + name + ' (' + equipment + ')');
  return event;
}

// ── MANUAL SHEET FALLBACK ────────────────────────────────────
// Setting STATUS to APPROVED by hand in the Sheet still books
// the calendar. Note: this trigger does NOT fire when the script
// itself writes APPROVED (Apps Script edits don't trigger
// onEdit), which is why doGet calls createBookingForRow directly.
function onEditHandler(e) {
  var sheet = e.source.getActiveSheet();
  var range = e.range;
  var col = getHeaderMap(sheet);

  if (!col.status || range.getColumn() !== col.status) return;
  if (range.getRow() <= 1) return;

  var row = range.getRow();
  var newStatus = String(range.getValue()).toUpperCase().trim();
  if (newStatus !== 'APPROVED') return;

  // Don't double-book if an event was already created for this row.
  if (col.eventId && String(sheet.getRange(row, col.eventId).getValue()).trim() !== '') return;

  createBookingForRow(sheet, row, col);
}

// ── HELPERS ──────────────────────────────────────────────────

// doGet has no edit event to tell it which tab the request is
// on, so find the form-linked tab by name ("Form Responses 1")
// and fall back to the first tab.
function getResponseSheet() {
  var ss = SpreadsheetApp.getActive();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().toLowerCase().indexOf('form responses') !== -1) {
      return sheets[i];
    }
  }
  return sheets[0];
}

// "105", 105, or "$105.00" → 105. Anything unparseable → 0.
function parseCost(value) {
  var n = parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function formatMoney(n) {
  return '$' + (n % 1 === 0 ? String(n) : n.toFixed(2));
}

function formatDate(date) {
  return (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear();
}

// Render any sheet cell value for display (dates → M/D/YYYY,
// booleans → Yes/No, everything else as text).
function formatCell(value) {
  if (value instanceof Date) return formatDate(value);
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  // The React form submits "Option 1" for checked checkboxes
  // (resident, insurance, tractor operator) — show it as Yes.
  if (value === 'Option 1') return 'Yes';
  return String(value);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Minimal phone-friendly page for doGet responses: large text,
// generous spacing.
function page(title, bodyHtml) {
  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html><head>' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml(title) + ' — BCCD Equipment</title></head>' +
    '<body style="font-family:Arial,Helvetica,sans-serif;background:#F7F5F0;margin:0;padding:24px;">' +
    '<div style="max-width:480px;margin:40px auto;background:#fff;border:1px solid #D4CFC5;border-radius:12px;padding:32px 28px;">' +
    '<h1 style="color:#1B2A1F;font-size:26px;margin:0 0 16px;">' + escapeHtml(title) + '</h1>' +
    '<p style="color:#1B2A1F;font-size:17px;line-height:1.7;margin:0;">' + bodyHtml + '</p>' +
    '</div>' +
    '<p style="text-align:center;color:#8a9a8f;font-size:13px;">BCCD Equipment Cooperative</p>' +
    '</body></html>');
}
