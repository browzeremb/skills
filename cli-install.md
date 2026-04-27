# Installing the `browzer` CLI

All skills in this plugin assume the `browzer` CLI is installed and on `PATH`. The CLI is a single static **Go** binary — no Node, no `node_modules`, no runtime dependencies.

## Install

Pick the channel that fits your machine:

```bash
# 1. curl | sh (works on macOS, Linux, WSL)
curl -fsSL https://browzeremb.com/install.sh | sh

# 2. Homebrew (macOS + Linuxbrew)
brew install browzeremb/tap/browzer

# 3. Scoop (Windows)
scoop bucket add browzeremb https://github.com/browzeremb/scoop-bucket
scoop install browzer

# 4. go install (any platform with Go ≥ 1.25)
go install github.com/browzeremb/browzer-cli/cmd/browzer@latest
```

No Node.js required.

## Authenticate

Interactive (device flow, opens a browser):

```bash
browzer login
```

Non-interactive (CI / agents):

```bash
BROWZER_API_KEY=brz_xxx browzer login --key "$BROWZER_API_KEY"
```

Point at a non-default server:

```bash
BROWZER_SERVER=http://localhost:8080 browzer login   # local prod-parity gateway
```

## Verify

```bash
browzer status --json
browzer --version
```

## Uninstall

```bash
browzer logout                                          # drop stored credentials FIRST
brew uninstall browzeremb/tap/browzer                   # Homebrew
scoop uninstall browzer                                 # Scoop
rm "$(command -v browzer)"                              # curl|sh / go install
```
