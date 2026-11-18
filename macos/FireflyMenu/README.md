# Firefly menu bar app (optional)

A status dot in the macOS menu bar: green running, orange paused, red unreachable.
It shows pending approvals, pauses and resumes the agent, and opens the dashboard or the
chat (**Open chat**, ⌘C in the menu) in your browser.

```sh
make menubar-config                         # in the Firefly folder: writes the URL + token
cd macos/FireflyMenu && swift build -c release
.build/release/FireflyMenu &                # or add it to Login Items
```

Requires macOS 13+ and the Xcode command line tools. It talks only to the local
dashboard API (127.0.0.1), using the dashboard token.

Not compiled in the build environment (no Swift toolchain there); build it on the Mac.
