# Third-party notices

Claude Codex is an independent project. It is not affiliated with or endorsed by OpenAI or Anthropic. Their product names identify compatible services and software; the application icon is original to this project.

- [CLIProxyAPI 8.0.32](https://github.com/router-for-me/CLIProxyAPI/tree/v8.0.32): MIT. The build downloads the official release, verifies its SHA-256, and includes its LICENSE in the app.
- [Node.js 22.23.3](https://nodejs.org/dist/v22.23.3/): MIT and bundled dependency notices. The build downloads the official distribution, verifies its SHA-256, and includes the complete Node LICENSE in the app.
- [bcrypt.js 3.0.3](https://github.com/dcodeIO/bcrypt.js): BSD-3-Clause. The package and its LICENSE are included in the app. Installation uses the pinned npm lockfile with lifecycle scripts disabled.

Claude Desktop is not distributed by this project. The optional isolated-installation feature verifies an installed Anthropic-signed application and creates a local copy on the user's own Mac. It preserves that bundle's signature. The launcher is part of Claude Codex.

Sparkle 2.10.0 is included from the pinned official release in `dependencies.json`. The build verifies its archive and extracted cache, embeds its framework, and re-signs its nested executables. The unmodified upstream license and external component notices are included in `Resources/Sparkle-LICENSE.txt`.

The update policy and release tooling adapt the MIT-licensed Insonia project by Henrick Clemente and contributors. Its license follows.

MIT License

Copyright (c) 2026 Henrick Clemente and Insonia contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
