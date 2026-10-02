# Reliability and recovery

This extension automates a browser UI, not the WhatsApp Business API. It cannot
guarantee delivery or exactly-once sending. Browser shutdown, layout changes,
network loss, and user interaction can interrupt a send.

## Implemented safeguards

- One service-worker queue serializes storage mutations and scheduled sends.
  Alarm timestamps identify the due occurrence; duplicate/stale callbacks cannot
  consume the next occurrence. The content script also refuses overlapping sends.
- A durable attempt marker is saved before dispatch. On worker restart, a
  dispatched attempt becomes **unconfirmed**, never automatically retried.
  An interrupted pre-dispatch preparation is safe to restore.
- Worker initialization, browser startup, and installation reconcile schedules
  with Chrome alarms. Missing or wrongly timed alarms are restored; orphaned
  scheduler alarms are removed. Other extensions' or unrelated alarms are untouched.
- Existing composer drafts are not changed or sent. A chat change or trusted user
  interaction aborts preparation. An already-dispatched send cannot be recalled.
- A send is counted only after a newly observed outgoing message ID with matching
  text appears in the target chat and the composer clears. This is **local
  outgoing observation**, not server acceptance, delivery, or read confirmation.
  Older send counts predate this stronger check and cannot be verified retroactively.

## Recovery policy

Chrome must be running and WhatsApp logged in. There is a fixed **60-second
lateness grace window** to tolerate ordinary alarm/queue delays. Later one-time
jobs become **missed**. Later recurring jobs skip missed occurrences and advance
to one future occurrence, never a catch-up burst.

Pre-send readiness timeouts get at most **two automatic retries**, after 30 and
60 seconds. The retry time has its own 60-second lateness window. Login-required
failures pause immediately. Draft conflicts and layout/verification failures also
require manual action; no automatic retry occurs after an uncertain send.
Terminal failures pause recurrence.

The popup shows failure reasons, retry counts/times, and missed-run details.
**Retry / resume in 1 min** explicitly schedules a recoverable job in the future.
First log in and save/remove any unsent draft. For **unconfirmed** jobs, check the
actual WhatsApp chat, then choose **Reviewed: skip uncertain run**. That action
never resends or increments the confirmed count; recurring jobs continue at the
next future occurrence. A replacement one-time message must be deliberately
created after review.

Stopping/editing/deleting a queued job prevents its old dispatch. An in-progress
send is cancelled on a best-effort basis before Enter; a message already dispatched
cannot be recalled. Cancellation after composition can leave unsent text for review.
Clear Done preserves failed, missed, uncertain, stopped, and active schedules.

## Tests

Run `node self-check.js` (Node 22 or newer recommended). Tests use isolated VM
contexts, mocked Chrome APIs, a controlled clock, and minimal DOM fixtures.
They do not log into WhatsApp or send real messages.

Before release, manually validate using consenting test recipients:

1. Fresh install/update, reload existing WhatsApp tabs, then capture a chat.
2. Plain text, emoji, multiline, and formatted messages; verify exact text and
   the observed-outgoing status, never assuming delivery.
3. Existing drafts, duplicate chat names, chat switching, and concurrent schedules.
4. Browser restart, missing alarms, sleep beyond the grace window, logged-out
   sessions, and disconnected/slow WhatsApp.
5. Stop/edit/delete during preparation and during observation; verify no blind retry.

## Known limitations

DOM selectors and synthetic keyboard/input behavior need live compatibility
validation. Missing stable message IDs, formatted text whose rendered content
differs from the source, or changed markup fail conservatively as unconfirmed
rather than claiming success. Matching visible outgoing IDs/text is not a
server-side idempotency guarantee. Recipient identity is still name-based;
duplicate-name search results are rejected, but a captured name is not a stable
WhatsApp contact ID. Do not use this extension for critical or unattended
high-volume messaging until those constraints are acceptable.
