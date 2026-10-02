# claude-code-mods

Mods for [Claude Code](https://claude.com/claude-code), packaged as a plugin marketplace.

## Install

In Claude Code:

```
/plugin marketplace add mrzzmrzz/claude-code-mods
/plugin install token-weather@claude-code-mods
```

## Mods

### token-weather

A live forecast of your context window, shown in the band above the prompt and updated after every turn:

```
Cloudy  67% 134.4k / 200k  ▂▃▄▅▆█  ▲ +98.3k last turn  95 tok/s  cache 96% 58:12
```

| Fill | Forecast (color) |
| --- | --- |
| < 25% | Clear (yellow) |
| 25–49% | Cloudy (cyan) |
| 50–74% | Showers (blue) |
| 75–89% | Storm (magenta) |
| ≥ 90% | Compact soon (red) |

- The sparkline covers the last 12 turns, scaled to the highest of them.
- `tok/s` is the last turn's output tokens (thinking included) over the time from each request's start to its response's end.
- `cache 96%` is the last turn's prompt-cache hit rate: cache reads over all input tokens.
- `58:12` counts down to when the prompt cache expires: the last main-loop request's start plus the cache TTL. It turns yellow under 5 minutes and reads `expired` after.

### Options

| Option | Values | Default |
| --- | --- | --- |
| `cacheTtl` | `5m`, `1h` | `1h` |

The API's usage figures don't say which TTL a session runs on, so set it to match yours: `1h` on most Claude subscriptions, `5m` on the API default or in usage overage.

## Developing

Load a mod straight from this checkout, with hot reload on save:

```
claude --plugin-dir ./plugins/token-weather
```

Check one before committing:

```
claude plugin validate ./plugins/token-weather
```
