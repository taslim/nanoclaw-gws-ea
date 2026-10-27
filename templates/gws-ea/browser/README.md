# GWS-EA browser

The host stamps this sealed tool group when reconciling the assistant's built-in
browser. Chrome must already be installed at the standard macOS path; gws-ea
never installs it. Main always delegates work through a native per-thread
destination. Other eligible groups need an explicit stored `browser-delegate`
capability; sealed groups never gain delegation. Every errand has its own
provider state and no shared memory. The host supplies the exact capabilities,
model and CLI scope and refuses drift at session admission. The release supplies
`instructions.md` as a required project-document section. Optional web alias
identity is configured separately through `gws-ea alias --id`.
