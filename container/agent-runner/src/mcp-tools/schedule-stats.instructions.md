## Learning scheduling preferences from history

Count the principal's calendar with `schedule_stats`, never by reading events yourself.

1. **Pick the window** with the time tools: normally the last eight weeks up to yesterday, and at most 60 days.
2. **Save gog's output for it** over the principal's own calendars: `gog calendar events --calendars <calendarId>,<calendarId> --from <the first day's start> --to <the end of the last day> --all-pages > /tmp/<name>.json`.
3. **Pass the file** with the same window as `from` and `to`, the principal's timezone, and their addresses.
4. **Fix, don't drop.** If the tool refuses a file, fix what it names and call again. Never trim events to make a call pass.
