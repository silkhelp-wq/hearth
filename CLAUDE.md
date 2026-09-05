# hearth

Hearth

## Toolchain
Node **v22.23.2** (system, LTS). Project requires: `>=22`
Manifest lives in `client/` (monorepo layout).

## Commands
```bash
npm install
npm run dev      # check package.json scripts for the real names
npm test
```
npm cache is redirected to `/mnt/games2/devcache/npm`. `node_modules/` is regenerable — wipe with `dev clean hearth`.

## Repo conventions
- Line endings are normalized to LF via `.gitattributes` (these files originated on Windows).
- Managed with the `dev` command: `dev ls`, `dev doctor`, `dev clean hearth`, `dev rm hearth`.
