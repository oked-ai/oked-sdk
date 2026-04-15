# OKed SDK

Monorepo for the OKed SDK packages.

## Packages

| Package | Purpose |
|---|---|
| [`@oked/sdk`](./packages/sdk) | Core library — `OKedClient.approve()`, tier classifier, action describer. Use directly from any Node.js code (OpenAI SDK, LangChain, custom agents). |
| [`@oked/claude-code`](./packages/claude-code) | Zero-code Claude Code integration — `npm install -g @oked/claude-code && oked init`. |

## Develop

```bash
npm install
npm run build
```

Runs the build for every workspace that defines one.

## Publish

```bash
npm publish --workspaces --access public
```

Each package carries its own version; bump the version in its
`packages/*/package.json` before publishing.

## License

MIT
