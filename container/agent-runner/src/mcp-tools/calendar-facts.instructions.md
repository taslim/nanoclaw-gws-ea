## Calendar facts: conflicts and people

Count calendar facts with `find_conflicts` and `people_stats`, never by reading events yourself.

- **Save gog's output, then pass the file.** Run `gog calendar events --calendars <calendarId>,<calendarId> --from <from> --to <to> --all-pages > /tmp/<name>.json` over the principal's calendars only, with times from the time tools, and use `--calendars` even for one calendar. Save under `/workspace/agent` or `/tmp`; the tools read nowhere else. If gog prints a `calendar <calendarId>: …` line, that calendar is missing: fix it and fetch again before you call.
- **To check a time,** fetch a range that covers it, then call `find_conflicts` straight away with the file, the same `from` and `to`, the candidate's `start` and `end`, and the principal's addresses. When the candidate is already on a calendar, pass its `iCalUID` as `candidate_ical_uid`. Fetch again for each new check: an older file is refused.
- **To count people,** fetch the last six months up to today, then call `people_stats` with the file, the principal's addresses, your own as `assistant_address`, and `people` to ask about particular addresses.
- **Fix, don't drop.** If a tool refuses, fix what it names and call again. Never trim events to make a call pass.
