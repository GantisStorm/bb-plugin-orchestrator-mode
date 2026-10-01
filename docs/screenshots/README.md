# Screenshot notes

These are cropped captures of the running BB interface, taken on 1 October
2026 with this plugin installed. They contain a fictional, unsent brief:

> Plan a weather dashboard. Delegate the API client, chart components and tests
> to separate workers, then review their results.

The new-thread screenshot uses a fixture for the browser's `get_default` RPC
response: `{"ok":true,"result":{"enabled":true}}`. The rest of the page is
the actual BB composer and this plugin's actual UI code. The real plugin
setting was not changed, and no worker was created.

To refresh the captures, use an isolated browser session against the running
local BB app, open a new-thread draft and enter the fictional brief without
submitting it. Override only the browser's
`/api/v1/plugins/orchestrator-mode/rpc/get_default` response. Wait for the strip
and browser paint before capturing. Crop to the composer or menu so live
sidebar entries and playbook history remain outside the image.

Never capture a live user's conversations or project details. Close the
isolated browser session after saving the images.
