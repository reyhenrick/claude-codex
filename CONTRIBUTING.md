# Contributing to Claude Codex

Bug reports, translations, documentation improvements and focused code changes are welcome. Check existing issues before opening a new one, describe the expected behavior and include reproducible steps. Remove account details and credentials from diagnostics and images.

## Build and verify

Use macOS 26 or later, Xcode or Command Line Tools with the macOS 26 SDK, Node.js 22 or later, and Python 3.12 or later.

```sh
npm --prefix Bridge ci --ignore-scripts
./Scripts/test.sh
./build.sh
```

The build always produces a universal app for Apple silicon and Intel at `build/Claude Codex.app`. Dependencies are pinned and verified against SHA-256 checksums. Build output is signed ad hoc and is not notarized by Apple. Building does not replace an installed app or publish a release.

The tests use synthetic accounts and responses. They cover the bridge, account policies, migration, language catalogs, update policies and signatures. They do not prove every live provider operation, imported conversation or hardware configuration. Report the checks actually performed and any limitations.

For packaging and signing, see the [technical reference (Português)](docs/TECHNICAL_GUIDE_pt-BR.md). Keep credentials and private signing keys out of source code, logs and command-line arguments. Release publishing remains a separate maintainer operation.

## Readmes and translations

`README.md` is the English entry point. The matching readmes in `docs/readme/` cover Portuguese (Brazil), Spanish, French, German and Italian. Keep their language navigation, download links, sections and behavior descriptions aligned. Use the button labels from `Resources/<language>.lproj/Localizable.strings`.

The detailed Portuguese reference preserves the original technical documentation. Link to it with its language identified. Documentation must distinguish account limits from credits, optional resets from defaults, and local portable history from resumable sessions.

## Reproduce the real interface screenshots

```sh
python3 Scripts/documentation-app.py en
```

Build the app first, then use this command to run a separate copy of the actual compiled application. It runs the production executable in a separately signed bundle with a distinct identifier. The existing `--staging` mode connects only to a read-only loopback fixture with two `example.com` accounts from `Scripts/documentation/accounts.json`. Replace `en` with `pt`, `es`, `fr`, `de` or `it` for each language.

Take a real screenshot of the app’s window, using the operating system’s window capture or a computer-use screenshot tool. Keep the original captures outside the repository as `panel-<language>.jpg`. The README assets were captured from the running app; do not substitute SwiftUI image exports, drawings or generated interface images.

The fixture accepts account reads and refreshes and rejects all account-changing requests. The app’s staging mode skips the production service and updater and disables real installation setup. No account files or credentials are copied. The script records its process IDs and stops only its own processes when the documentation app closes. Do not connect a real account or enable login startup in this documentation instance.

With all six original captures in one folder, crop their outer frame using Python and Pillow:

```sh
python3 Scripts/crop-readme-screenshots.py /path/to/original-captures
```

The crop removes 16 pixels from each edge of the 840 × 1300 window captures, preserving every remaining pixel and saving 808 × 1268 PNGs in `docs/assets/`. The script checks the input sizes and verifies the output pixels. Check each screenshot at its README display size, including long translations and both GitHub page backgrounds. Confirm that the accounts are synthetic and that images, captions and relative links resolve in every language. The fixture deliberately uses fixed illustrative dates and amounts.

## Keep changes focused

Inspect the current contracts before editing shared behavior. Preserve the original Claude installation, require authorization for credit use and automatic resets, and keep ambiguous provider outcomes visible. Review the diff and run checks appropriate to the change.

The project is licensed under [MIT](LICENSE). Contributions use the same license. Claude Codex is independent of OpenAI and Anthropic.
