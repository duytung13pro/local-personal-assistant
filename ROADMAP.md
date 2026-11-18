# Roadmap

Carried over from the original tkinter app (user request, 2026-11-18). Items 1–3 there (smooth view
switching, modern controls, search/filters/undo/saved layout/shortcuts) are done in this version.
These are backlog items, not authorization to connect any service.

1. **Gemini as an optional worker or planner**, separately configured and explicitly selected.
   Verify official access, account eligibility, costs and usage limits first; do not assume a Google
   subscription includes API usage.
2. **Google Calendar / Tasks sync and Gmail** for the user's own account. OAuth with minimum scopes and
   OS-managed token storage. Start with previewable, user-approved one-way exports; define conflict
   handling, duplicate detection, time zones and deletion behaviour before any two-way sync. No automatic
   upload of history.
3. **Email drafting and sending.** Preview recipient, subject, body and attachments; require explicit
   approval of each outgoing email.

Keep data local on D: by default. Do not activate Gemini/Google, upload local data, send mail, request
OAuth access or purchase anything until the user asks for that specific step.
