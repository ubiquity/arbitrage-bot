# `@ubiquity/ts-template`

This template repository includes support for the following:

- TypeScript
- Environment Variables
- Conventional Commits
- Automatic deployment to Cloudflare Pages

## On-demand arbitrage API

`POST /api/arbitrage` triggers the bot on demand. `yarn build` bundles a Cloudflare Pages advanced-mode worker into
`static/_worker.js`, so the existing deployment artifact includes the API alongside the static site. Other routes still serve static assets.
The `yarn start` static preview does not execute Pages workers; exercise the endpoint in a Pages runtime.

This checkout does not contain a trading strategy. The endpoint delegates to a bot service configured in the Cloudflare Pages environment:

- `ARBITRAGE_BOT_URL`: the HTTPS endpoint that runs the bot when it receives a POST request.
- `ARBITRAGE_BOT_TOKEN` (optional secret): sent to that service as a bearer token, never to the browser.

Without a valid bot URL, the endpoint returns `503` and does not attempt a trade. A successful upstream response returns
`200 {"status":"triggered"}`; upstream HTTP or network failures return `502` without exposing internal details. The bot service remains
responsible for trade decisions, transaction signing, and preventing duplicate/concurrent trades. The API does not retry failed triggers.

The UI at `https://uusd.ubq.fi` (or a same-origin UI) can invoke it on a visit:

```typescript
const response = await fetch("https://<your-pages-host>/api/arbitrage", { method: "POST" });
if (!response.ok) throw new Error("Unable to trigger arbitrage");
```

The endpoint supports CORS preflight and rejects other browser origins. CORS is not authentication: this is a public trigger, so apply
appropriate rate limits at the deployment or bot service. GET, HEAD, and other unsupported methods return `405` without invoking the bot.
No timer, scheduled job, or static asset request invokes the bot.

## Testing

### Cypress

To test with Cypress Studio UI, run

```shell
yarn cy:open
```

Otherwise, to simply run the tests through the console, run

```shell
yarn cy:run
```

### Jest

To start Jest tests, run

```shell
yarn test
```

## Sync any repository to latest `ts-template`

A bash function that can do this for you:

```bash
sync-branch-to-template() {
  local branch_name
  branch_name=$(git rev-parse --abbrev-ref HEAD)
  local original_remote
  original_remote=$(git remote show | head -n 1)

  # Add the template remote
  git remote add template https://github.com/ubiquity/ts-template

  # Fetch from the template remote
  git fetch template development

  if [ "$branch_name" != "HEAD" ]; then
    # Create a new branch and switch to it
    git checkout -b "chore/merge-${branch_name}-template"

    # Merge the changes from the template remote
    git merge template/development --allow-unrelated-histories

    # Switch back to the original branch
    git checkout "$branch_name"

    # Push the changes to the original remote
    git push "$original_remote" HEAD:"$branch_name"
  else
    echo "You are in a detached HEAD state. Please checkout a branch first."
  fi

  # Remove the template remote
  # git remote remove template
}
```
